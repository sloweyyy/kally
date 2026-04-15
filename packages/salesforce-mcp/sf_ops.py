#!/usr/bin/env python3
"""
sf_ops.py — Salesforce read + write operations for the runbook skill.
Auth is a module-level singleton — token acquired once and reused across all ops.

Read usage:
  python3 scripts/sf_ops.py --case 00045231
  python3 scripts/sf_ops.py --get-case 00045231        # scheduling only: Id, CaseNumber, Subject, ContactEmail, Contact.Name
  python3 scripts/sf_ops.py --mode on-hold --email teammate@example.com
  python3 scripts/sf_ops.py --mode on-hold --email teammate@example.com --output file

Write usage:
  python3 scripts/sf_ops.py --update-status --case-id 500RA000016XSzLYAW --status "Pending"
  python3 scripts/sf_ops.py --update-eta --case-id 500RA000016XSzLYAW --eta "April 1, 2026" --fix-version "11.1.0"
  python3 scripts/sf_ops.py --update-jira-link --case-id 500RA000016XSzLYAW --jira-key KSR-9761
"""

import argparse
import json
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone

import requests
from dotenv import load_dotenv

# Load .env from project root (one level up from scripts/)
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

INSTANCE_URL   = os.getenv('SALESFORCE_INSTANCE_URL', '').rstrip('/')
CLIENT_ID      = os.getenv('SALESFORCE_CLIENT_ID', '')
CLIENT_SECRET  = os.getenv('SALESFORCE_CLIENT_SECRET', '')
SF_USERNAME    = os.getenv('SALESFORCE_USERNAME', '')
SF_PASSWORD    = os.getenv('SALESFORCE_PASSWORD', '')
API_VERSION    = 'v59.0'
SESSION_FILE   = '/tmp/sf_session.json'
SESSION_TTL    = 6600  # seconds — SF tokens last ~2h; cache for 110min to stay safe

MODE_STATUSES = {
    'on-hold': [
        'On-Hold Bug Report',
        'On-Hold Feature Suggestion',
        'On-Hold Collaboration',
        'On-Hold (Dev is Verifying)',
        'On-Hold (User Request)',
        'On-hold (Bug-fix-planning)',
        'On-hold (Feature-request in planning)',
    ],
    'on-hold-bug':       ['On-Hold Bug Report', 'On-hold (Bug-fix-planning)'],
    'on-hold-feature':   ['On-Hold Feature Suggestion', 'On-hold (Feature-request in planning)'],
    'on-hold-collab':    ['On-Hold Collaboration'],
    'on-hold-verifying': ['On-Hold (Dev is Verifying)'],
    'on-hold-user':      ['On-Hold (User Request)'],
    'open':    ['Open'],
    'active':  ['On-Hold Collaboration', 'On-Hold (Dev is Verifying)', 'On-Hold (User Request)', 'Open'],
    'pending': ['Awaiting your reply'],
}

CASE_FIELDS = (
    "Id, CaseNumber, Subject, Status__c, ContactEmail, ContactId, Contact.Name, "
    "CreatedDate, Priority, Owner.Name, Owner.Email, OwnerId, IsClosed, AccountId, "
    "Account.Name, Account.ARR__c, Account.FY26_Team__c, "
    "K1_Account_Id__c, Number_of_affected_users__c, LastModifiedDate, "
    "Description__c, Environment__c, Organization_ID__c, "
    "Jira__c, ETA__c, Fix_Version__c, Fix_version_ETA__c, Expiration_date__c, "
    "Katalon_Studio_or_Runtime_Engine_vrs_New__c, "
    "Katalon_studio_or_runtime_Engine_version__c, "
    "Execution_Log__c, Error_Log__c"
)

SCHEDULE_CASE_FIELDS  = "Id, CaseNumber, Subject, ContactEmail, Contact.Name"
TRANSCRIPT_CASE_FIELDS = "Id, CaseNumber, ContactId, Jira__c, Account.ARR__c"

FEED_FIELDS  = "Id, Body, Visibility, CreatedDate, CreatedBy.Name, CreatedBy.Email, Type, CommentCount"

def segments_to_text(segments):
    """Extract plain text from Chatter messageSegments.
    - Text → as-is
    - Mention → @Name (preserves who was tagged)
    - Link → url or 'label (url)' (preserves inline links)
    - Markup/other → skipped
    """
    parts = []
    for seg in segments:
        t = seg.get('type')
        if t == 'Text':
            parts.append(seg.get('text', ''))
        elif t == 'Mention':
            name = seg.get('name') or seg.get('text', '')
            parts.append(f'@{name}')
        elif t == 'Link':
            url = seg.get('url', '')
            label = seg.get('text', '')
            parts.append(f'{label} ({url})' if label and label != url else url)
    return ''.join(parts).strip()


def strip_html(text):
    """Remove HTML tags and decode common entities from SF rich-text fields."""
    if not text:
        return text
    entities = {
        '&amp;': '&', '&lt;': '<', '&gt;': '>',
        '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
    }
    for entity, char in entities.items():
        text = text.replace(entity, char)
    text = re.sub(r'<[^>]+>', '', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def strip_attributes(obj):
    """Recursively remove SF 'attributes' metadata keys from nested dicts/lists."""
    if isinstance(obj, dict):
        return {k: strip_attributes(v) for k, v in obj.items() if k != 'attributes'}
    if isinstance(obj, list):
        return [strip_attributes(i) for i in obj]
    return obj


_REMINDER_RE = re.compile(r'^(\d+(?:st|nd|rd|th) Reminder)', re.IGNORECASE)

def truncate_auto_reminders(feed):
    """Replace auto-reminder boilerplate bodies with a compact label.
    Detects posts where Body starts with '1st Reminder:', '2nd Reminder:', etc.
    Preserves Id, CreatedDate, CreatedBy for timeline accuracy.
    """
    result = []
    for item in feed:
        body = item.get('Body') or ''
        m = _REMINDER_RE.match(body)
        if m:
            item = dict(item)
            item['Body'] = f"[{m.group(1)} — auto]"
        result.append(item)
    return result


def dedup_feed(feed):
    """Remove duplicate feed items: same normalized body posted within 60 seconds.
    Keeps the first occurrence (feed is already sorted ASC by CreatedDate).
    """
    seen = {}  # normalized_body -> first_created_dt
    result = []
    for item in feed:
        body = re.sub(r'\s+', ' ', (item.get('Body') or '').strip().lower())
        try:
            created = datetime.fromisoformat(
                (item.get('CreatedDate') or '').replace('Z', '+00:00')
            )
        except ValueError:
            result.append(item)
            continue
        if body in seen:
            delta = abs((created - seen[body]).total_seconds())
            if delta <= 60:
                continue  # duplicate within 60s window — drop
        seen[body] = created
        result.append(item)
    return result


def cap_feed_bodies(feed, full_count=3, cap=200):
    """Keep last `full_count` items at full body; cap older items at `cap` chars.
    Feed must be sorted ASC (oldest first) before calling.
    """
    cutoff = max(0, len(feed) - full_count)
    result = []
    for i, item in enumerate(feed):
        if i < cutoff:
            body = item.get('Body') or ''
            if len(body) > cap:
                item = dict(item)
                item['Body'] = body[:cap] + '…'
        result.append(item)
    return result


EMAIL_FIELDS = "Id, Subject, FromName, FromAddress, ToAddress, MessageDate, Status, Incoming, TextBody"

# Module-level token singleton — acquired once per process, reused for all calls.
_TOKEN = None


def error_exit(msg):
    print(json.dumps({"error": msg}))
    sys.exit(1)


def validate_env():
    missing = [k for k, v in {
        'SALESFORCE_INSTANCE_URL':  INSTANCE_URL,
        'SALESFORCE_CLIENT_ID':     CLIENT_ID,
        'SALESFORCE_CLIENT_SECRET': CLIENT_SECRET,
        'SALESFORCE_USERNAME':      SF_USERNAME,
        'SALESFORCE_PASSWORD':      SF_PASSWORD,
    }.items() if not v]
    if missing:
        error_exit(f"Missing .env vars: {', '.join(missing)} — copy .env.example and fill in credentials")


def _cache_disabled():
    """Per-user calls disable the cache — the shared session file would
    leak one user's token to the next call. Set KALLY_SF_NO_CACHE=1 from
    the MCP layer when processing a per-user-creds request."""
    return os.environ.get('KALLY_SF_NO_CACHE') == '1'


def _load_session():
    """Return cached token if present and not expired, else None."""
    if _cache_disabled():
        return None
    try:
        with open(SESSION_FILE) as f:
            s = json.load(f)
        expires_at = datetime.fromisoformat(s['expires_at'])
        if datetime.now(timezone.utc) < expires_at:
            return s['token']
    except (FileNotFoundError, KeyError, ValueError):
        pass
    return None


def _save_session(token):
    if _cache_disabled():
        return
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=SESSION_TTL)
    try:
        with open(SESSION_FILE, 'w') as f:
            json.dump({'token': token, 'expires_at': expires_at.isoformat()}, f)
    except OSError:
        pass  # non-fatal — next call will just re-auth


def sf_auth():
    cached = _load_session()
    if cached:
        return cached
    resp = requests.post(f"{INSTANCE_URL}/services/oauth2/token", data={
        'grant_type':    'password',
        'client_id':     CLIENT_ID,
        'client_secret': CLIENT_SECRET,
        'username':      SF_USERNAME,
        'password':      SF_PASSWORD,
    })
    if resp.status_code != 200:
        error_exit(f"SF auth failed: {resp.status_code} — {resp.text}")
    token = resp.json().get('access_token')
    if not token:
        error_exit("SF auth: no access_token in response")
    _save_session(token)
    return token


def get_token():
    """Return the module-level token, initializing it on first call."""
    global _TOKEN
    if _TOKEN is None:
        validate_env()
        _TOKEN = sf_auth()
    return _TOKEN


def auth_headers():
    return {'Authorization': f'Bearer {get_token()}', 'Content-Type': 'application/json'}


def run_soql(query):
    resp = requests.get(
        f"{INSTANCE_URL}/services/data/{API_VERSION}/query/",
        headers=auth_headers(),
        params={'q': query}
    )
    if resp.status_code != 200:
        error_exit(f"SOQL failed ({resp.status_code}): {resp.text[:300]}")
    return resp.json()



def fetch_case(case_num):
    result = run_soql(f"SELECT {CASE_FIELDS} FROM Case WHERE CaseNumber = '{case_num}' LIMIT 1")
    records = result.get('records', [])
    if not records:
        error_exit(f"Case {case_num} not found")
    return records[0]


def fetch_case_for_scheduling(case_num):
    """Minimal fetch for scheduling: only Id, CaseNumber, Subject, ContactEmail, Contact.Name."""
    result = run_soql(f"SELECT {SCHEDULE_CASE_FIELDS} FROM Case WHERE CaseNumber = '{case_num}' LIMIT 1")
    records = result.get('records', [])
    if not records:
        error_exit(f"Case {case_num} not found")
    return records[0]


def fetch_case_for_transcript(case_num):
    """Minimal fetch for meeting-transcript: Id, CaseNumber, ContactId, Jira__c, Account.ARR__c."""
    result = run_soql(f"SELECT {TRANSCRIPT_CASE_FIELDS} FROM Case WHERE CaseNumber = '{case_num}' LIMIT 1")
    records = result.get('records', [])
    if not records:
        error_exit(f"Case {case_num} not found")
    return records[0]


def fetch_feed(case_id):
    """Fetch 10 most recent AllUsers CaseFeed posts (DESC). InternalUsers excluded — never needed."""
    result = run_soql(
        f"SELECT {FEED_FIELDS} FROM CaseFeed "
        f"WHERE ParentId = '{case_id}' AND Visibility = 'AllUsers' "
        f"ORDER BY CreatedDate DESC LIMIT 10"
    )
    return result.get('records', [])


def fetch_user_emails(user_ids):
    """Batch-fetch User emails by Id. Returns {user_id: email} map."""
    if not user_ids:
        return {}
    id_list = ', '.join(f"'{uid}'" for uid in user_ids)
    result = run_soql(f"SELECT Id, Email FROM User WHERE Id IN ({id_list})")
    return {r['Id']: r.get('Email', '') for r in result.get('records', [])}


def fetch_chatter_comments_light(feed_item_id, limit=2):
    """Fetch only the last N chatter comments from a threaded feed item.
    Reuses fetch_user_emails and segments_to_text — no duplicate normalization.
    """
    resp = requests.get(
        f"{INSTANCE_URL}/services/data/{API_VERSION}/chatter/feed-elements/{feed_item_id}/capabilities/comments/items",
        headers=auth_headers(),
        params={'pageSize': 25}
    )
    if resp.status_code != 200:
        return []
    items = resp.json().get('items', [])
    items = items[-limit:]  # last N only

    user_ids = list({item['user']['id'] for item in items if item.get('user', {}).get('id')})
    email_map = fetch_user_emails(user_ids)

    comments = []
    for item in items:
        user = item.get('user') or {}
        user_id = user.get('id', '')
        segments = (item.get('body') or {}).get('messageSegments', [])
        plain_text = segments_to_text(segments) or (item.get('body') or {}).get('text', '')
        comments.append({
            'Id': item.get('id'),
            'Body': plain_text,
            'Visibility': 'AllUsers',
            'CreatedDate': item.get('createdDate'),
            'CreatedBy': {'Name': user.get('name'), 'Email': email_map.get(user_id, '')},
            'Type': 'FeedComment',
            'CommentCount': 0,
            'ParentFeedItemId': feed_item_id,
        })
    return comments


def fetch_feed_light(case_id):
    """Light fetch: find threaded root post, return last 2 Chatter comments + emails.
    Confirmed pattern (SF00046279): conversation lives as FeedComments under root TextPost.
    Falls back to last 2 feed posts if no threaded root found.
    """
    feed = fetch_feed(case_id)  # reuse existing LIMIT 10 — needed to find root post Id
    for item in feed:
        if item.get('CommentCount', 0) > 0:
            return fetch_chatter_comments_light(item['Id'], limit=2)
    return feed[-2:] if len(feed) >= 2 else feed


def fetch_chatter_comments(feed_item_id):
    """Fetch FeedComments via Chatter REST API for a feed item with CommentCount > 0.
    Returns list of normalized comment dicts compatible with the feed[] format.
    """
    resp = requests.get(
        f"{INSTANCE_URL}/services/data/{API_VERSION}/chatter/feed-elements/{feed_item_id}/capabilities/comments/items",
        headers=auth_headers(),
        params={'pageSize': 7}
    )
    if resp.status_code != 200:
        return []
    items = resp.json().get('items', [])
    if not items:
        return []

    # Collect user IDs for batch email lookup
    user_ids = list({item['user']['id'] for item in items if item.get('user', {}).get('id')})
    email_map = fetch_user_emails(user_ids)

    comments = []
    for item in items:
        user = item.get('user') or {}
        user_id = user.get('id', '')
        segments = (item.get('body') or {}).get('messageSegments', [])
        plain_text = segments_to_text(segments) or (item.get('body') or {}).get('text', '')
        comments.append({
            'Id': item.get('id'),
            'Body': plain_text,
            'Visibility': 'AllUsers',
            'CreatedDate': item.get('createdDate'),
            'CreatedBy': {
                'Name': user.get('name'),
                'Email': email_map.get(user_id, ''),
            },
            'Type': 'FeedComment',
            'CommentCount': 0,
            'ParentFeedItemId': feed_item_id,
        })
    return comments


def fetch_main_feed_item_id(case_id):
    """Fetch the oldest AllUsers CaseFeed post ID — needed for FeedComment inserts."""
    result = run_soql(
        f"SELECT Id FROM CaseFeed "
        f"WHERE ParentId = '{case_id}' AND Visibility = 'AllUsers' "
        f"ORDER BY CreatedDate ASC LIMIT 1"
    )
    records = result.get('records', [])
    return records[0]['Id'] if records else None


def fetch_emails(case_id):
    result = run_soql(
        f"SELECT {EMAIL_FIELDS} FROM EmailMessage "
        f"WHERE ParentId = '{case_id}' ORDER BY MessageDate DESC LIMIT 3"
    )
    return result.get('records', [])



def fetch_bulk_cases(mode, email):
    statuses = MODE_STATUSES.get(mode)
    if not statuses:
        error_exit(f"Unknown mode '{mode}'. Valid: on-hold, active, open, pending")
    status_list = ', '.join(f"'{s}'" for s in statuses)
    result = run_soql(
        f"SELECT {CASE_FIELDS} FROM Case "
        f"WHERE Status__c IN ({status_list}) "
        f"AND Owner.Email = '{email}' AND IsClosed = false "
        f"ORDER BY CreatedDate ASC"
    )
    return result.get('records', [])


def sf_patch(case_id, payload):
    """PATCH a Case record. Returns HTTP status code."""
    resp = requests.patch(
        f"{INSTANCE_URL}/services/data/{API_VERSION}/sobjects/Case/{case_id}",
        headers=auth_headers(),
        json=payload
    )
    return resp.status_code


def write_post_comment_bulk(entries):
    """Post comments to multiple cases from a list of {case_id, comment_body} dicts."""
    results = []
    for entry in entries:
        case_id = entry.get('case_id')
        body    = entry.get('comment_body')
        if not case_id or not body:
            results.append({"case_id": case_id, "success": False, "error": "missing case_id or comment_body"})
            continue
        feed_item_id = fetch_main_feed_item_id(case_id)
        if not feed_item_id:
            results.append({"case_id": case_id, "success": False, "error": "no AllUsers feed item found"})
            continue
        resp = requests.post(
            f"{INSTANCE_URL}/services/data/{API_VERSION}/sobjects/FeedComment/",
            headers=auth_headers(),
            json={"FeedItemId": feed_item_id, "CommentBody": body}
        )
        data = resp.json() if resp.content else {}
        ok = resp.status_code in (200, 201) and data.get('success', False)
        results.append({
            "case_id": case_id,
            "success": ok,
            "id": data.get('id'),
            "feed_item_id": feed_item_id,
            "error": None if ok else str(data)
        })
    print(json.dumps(results))


def write_update_status(case_id, status):
    code = sf_patch(case_id, {"Status": status})
    if code == 204:
        print(json.dumps({"success": True, "status": status}))
    else:
        error_exit(f"update_status failed: HTTP {code}")


def write_update_eta(case_id, eta=None, fix_version=None):
    # Fix_version_ETA__c is read-only for API profile (formula/workflow-computed) — never write it.
    # Write ETA__c and Fix_Version__c independently; at least one must be provided.
    payload = {}
    if eta:
        payload["ETA__c"] = eta
    if fix_version:
        payload["Fix_Version__c"] = fix_version
    code = sf_patch(case_id, payload)
    if code == 204:
        print(json.dumps({"success": True, "eta": eta, "fix_version": fix_version}))
    else:
        error_exit(f"update_eta failed: HTTP {code}")


def write_post_comment(case_id, comment_body):
    """Post a FeedComment to the oldest AllUsers CaseFeed item for the case."""
    feed_item_id = fetch_main_feed_item_id(case_id)
    if not feed_item_id:
        error_exit(f"No AllUsers CaseFeed item found for case {case_id} — cannot post comment")
    resp = requests.post(
        f"{INSTANCE_URL}/services/data/{API_VERSION}/sobjects/FeedComment/",
        headers=auth_headers(),
        json={"FeedItemId": feed_item_id, "CommentBody": comment_body}
    )
    data = resp.json() if resp.content else {}
    if resp.status_code in (200, 201) and data.get('success'):
        print(json.dumps({"success": True, "id": data.get('id'), "feed_item_id": feed_item_id}))
    else:
        error_exit(f"post_comment failed: HTTP {resp.status_code} — {data}")


def write_log_call(case_id, who_id, activity_date, description):
    """Log a Call Task via the NewTask Quick Action + PATCH Status.

    Uses NewTask (not Log_a_Call) so SF shows 'Task created' in the Chatter
    feed (TaskSubtype=Task). Log_a_Call sets TaskSubtype=Call which shows
    'Call logged' — wrong appearance.

    Two-step:
      1. POST /quickActions/NewTask → creates Task + CreateRecordEvent feed entry
      2. PATCH Status=Completed (NewTask doesn't accept Status field)
    """
    record = {
        "Subject": "Call",
        "ActivityDate": activity_date,
        "Description": description,
    }
    if who_id:
        record["WhoId"] = who_id
    resp = requests.post(
        f"{INSTANCE_URL}/services/data/{API_VERSION}/quickActions/NewTask",
        headers=auth_headers(),
        json={"contextId": case_id, "record": record},
    )
    data = resp.json() if resp.content else {}
    if not (resp.status_code in (200, 201) and data.get('success')):
        error_exit(f"log_call failed: HTTP {resp.status_code} — {data}")
    task_id = data.get('id')
    # Mark as Completed — NewTask creates Open by default
    patch = requests.patch(
        f"{INSTANCE_URL}/services/data/{API_VERSION}/sobjects/Task/{task_id}",
        headers=auth_headers(),
        json={"Status": "Completed"},
    )
    if patch.status_code != 204:
        error_exit(f"log_call: task created ({task_id}) but Status patch failed: HTTP {patch.status_code}")
    print(json.dumps({"success": True, "id": task_id, "feed_item_ids": data.get('feedItemIds', [])}))


def write_post_internal_note(case_id, body, mention_user_id=None):
    """Post an internal-only FeedItem. Visible to agents only — not client-facing.
    If mention_user_id is provided, uses Chatter Connect API to @mention the user
    (triggers SF notification). Otherwise falls back to sobjects/FeedItem/.
    """
    if mention_user_id:
        payload = {
            "feedElementType": "FeedItem",
            "subjectId": case_id,
            "visibility": "InternalUsers",
            "body": {
                "messageSegments": [
                    {"type": "Mention", "id": mention_user_id},
                    {"type": "Text", "text": "\n" + body}
                ]
            }
        }
        resp = requests.post(
            f"{INSTANCE_URL}/services/data/{API_VERSION}/chatter/feed-elements",
            headers=auth_headers(),
            json=payload
        )
        data = resp.json() if resp.content else {}
        if resp.status_code in (200, 201) and data.get('id'):
            print(json.dumps({"success": True, "id": data.get('id')}))
        else:
            error_exit(f"post_internal_note (mention) failed: HTTP {resp.status_code} — {data}")
    else:
        resp = requests.post(
            f"{INSTANCE_URL}/services/data/{API_VERSION}/sobjects/FeedItem/",
            headers=auth_headers(),
            json={"ParentId": case_id, "Body": body,
                  "Visibility": "InternalUsers", "Type": "TextPost"}
        )
        data = resp.json() if resp.content else {}
        if resp.status_code in (200, 201) and data.get('success'):
            print(json.dumps({"success": True, "id": data.get('id')}))
        else:
            error_exit(f"post_internal_note failed: HTTP {resp.status_code} — {data}")


def write_post_internal_note_bulk(entries):
    """Post internal FeedItems (InternalUsers) to multiple cases from a list of {case_id, comment_body, mention_user_id?} dicts."""
    results = []
    for entry in entries:
        case_id         = entry.get('case_id')
        body            = entry.get('comment_body')
        mention_user_id = entry.get('mention_user_id')
        if not case_id or not body:
            results.append({"case_id": case_id, "success": False, "error": "missing case_id or comment_body"})
            continue
        if mention_user_id:
            payload = {
                "feedElementType": "FeedItem",
                "subjectId": case_id,
                "visibility": "InternalUsers",
                "body": {
                    "messageSegments": [
                        {"type": "Mention", "id": mention_user_id},
                        {"type": "Text", "text": "\n" + body}
                    ]
                }
            }
            resp = requests.post(
                f"{INSTANCE_URL}/services/data/{API_VERSION}/chatter/feed-elements",
                headers=auth_headers(),
                json=payload
            )
            data = resp.json() if resp.content else {}
            ok = resp.status_code in (200, 201) and bool(data.get('id'))
            results.append({"case_id": case_id, "success": ok, "id": data.get('id'), "error": None if ok else str(data)})
        else:
            resp = requests.post(
                f"{INSTANCE_URL}/services/data/{API_VERSION}/sobjects/FeedItem/",
                headers=auth_headers(),
                json={"ParentId": case_id, "Body": body,
                      "Visibility": "InternalUsers", "Type": "TextPost"}
            )
            data = resp.json() if resp.content else {}
            ok = resp.status_code in (200, 201) and data.get('success', False)
            results.append({"case_id": case_id, "success": ok, "id": data.get('id'), "error": None if ok else str(data)})
    print(json.dumps(results))


def write_update_jira_link(case_id, issue_key):
    result = run_soql(f"SELECT Id, Jira__c FROM Case WHERE Id = '{case_id}' LIMIT 1")
    records = result.get('records', [])
    if not records:
        error_exit(f"Case {case_id} not found")
    current = records[0].get('Jira__c') or ''
    new_url = f"https://katalon.atlassian.net/browse/{issue_key}"
    updated = f"{current} / {new_url}" if current else new_url
    code = sf_patch(case_id, {"Jira__c": updated})
    if code == 204:
        print(json.dumps({"success": True, "jira_field": updated}))
    else:
        error_exit(f"update_jira_link failed: HTTP {code}")


def list_attachments(case_id):
    """Return ContentDocumentLink records for a case, flattened to one entry per attachment.
    Each entry includes: content_document_id, version_id, title, ext, size_bytes, created_date.
    """
    q = (
        "SELECT ContentDocumentId, "
        "ContentDocument.Title, ContentDocument.FileExtension, ContentDocument.ContentSize, "
        "ContentDocument.LatestPublishedVersionId, ContentDocument.CreatedDate "
        f"FROM ContentDocumentLink WHERE LinkedEntityId='{case_id}'"
    )
    result = run_soql(q)
    items = []
    for rec in result.get('records', []):
        cd = rec.get('ContentDocument') or {}
        items.append({
            "content_document_id": rec.get('ContentDocumentId'),
            "version_id": cd.get('LatestPublishedVersionId'),
            "title": cd.get('Title'),
            "ext": (cd.get('FileExtension') or '').lower() or None,
            "size_bytes": cd.get('ContentSize'),
            "created_date": cd.get('CreatedDate'),
        })
    # Sort newest first
    items.sort(key=lambda x: x.get('created_date') or '', reverse=True)
    return items


def get_attachment(version_id, save_to):
    """Download a ContentVersion's VersionData to save_to. Returns size in bytes."""
    url = f"{INSTANCE_URL}/services/data/{API_VERSION}/sobjects/ContentVersion/{version_id}/VersionData"
    r = requests.get(url, headers=auth_headers())
    if r.status_code != 200:
        error_exit(f"get_attachment failed: HTTP {r.status_code} — {r.text[:200]}")
    try:
        with open(save_to, 'wb') as f:
            f.write(r.content)
    except OSError as e:
        error_exit(f"get_attachment: cannot write to {save_to}: {e}")
    return len(r.content)


def output_result(data, output_mode):
    if output_mode == 'file':
        path = f"/tmp/runbook_{date.today().isoformat()}.json"
        try:
            with open(path, 'w') as f:
                json.dump(data, f, indent=2)
            print(path)
        except OSError as e:
            sys.stderr.write(f"Warning: file write failed ({e}), using stdout\n")
            print(json.dumps(data, indent=2))
    else:
        print(json.dumps(data, indent=2))


def main():
    parser = argparse.ArgumentParser(description='SF read + write operations for the runbook skill')
    group = parser.add_mutually_exclusive_group(required=True)
    # Read ops
    group.add_argument('--case',           help='Case number, e.g. 00045231')
    group.add_argument('--get-case',            help='Case number — scheduling only: Id, CaseNumber, Subject, ContactEmail, Contact.Name')
    group.add_argument('--get-case-transcript', help='Case number — transcript only: Id, CaseNumber, ContactId, Jira__c, Account.ARR__c')
    group.add_argument('--mode',           choices=['on-hold', 'on-hold-bug', 'on-hold-feature', 'on-hold-collab', 'on-hold-verifying', 'on-hold-user', 'open', 'active', 'pending'], help='Bulk fetch mode')
    # Write ops
    group.add_argument('--post-comment',        action='store_true', help='Post FeedComment to a case')
    group.add_argument('--post-internal-note',  action='store_true', help='Post internal FeedItem (InternalUsers only) to a case')
    group.add_argument('--update-status',       action='store_true', help='PATCH Case Status')
    group.add_argument('--update-eta',     action='store_true', help='PATCH ETA / Fix Version fields')
    group.add_argument('--update-jira-link', action='store_true', help='Read + append Jira__c field')
    group.add_argument('--log-call',         action='store_true', help='Create a completed Call Task on a Case')
    group.add_argument('--list-attachments', action='store_true', help='List ContentDocumentLink attachments on a Case (--case-id required)')
    group.add_argument('--get-attachment',   action='store_true', help='Download ContentVersion data (--version-id and --save-to required)')
    group.add_argument('--soql',             help='Run arbitrary SOQL query and print JSON result (read-only)')
    # Shared args
    parser.add_argument('--email',         help='Owner email (required for --mode)')
    parser.add_argument('--output',        choices=['stdout', 'file'], default='stdout')
    parser.add_argument('--fetch-mode',    choices=['light', 'full'], default='full',
                        help='light: last 2 Chatter comments + emails, no description/logs. full: current behavior.')
    parser.add_argument('--clear-session', action='store_true', help='Force re-auth by deleting cached token')
    # Write-specific args
    parser.add_argument('--case-id',       help='18-char SF Case Id (required for write ops)')
    parser.add_argument('--comment-body',  help='Comment text inline (--post-comment single case)')
    parser.add_argument('--comment-file',  help='Path to .txt file containing comment body')
    parser.add_argument('--bulk-file',     help='Path to JSON file: [{case_id, comment_body}, ...]')
    parser.add_argument('--status',        help='Status value for --update-status')
    parser.add_argument('--eta',           help='ETA string for --update-eta, e.g. "April 1, 2026"')
    parser.add_argument('--fix-version',   help='Fix version for --update-eta, e.g. "11.1.0"')
    parser.add_argument('--jira-key',      help='Jira issue key for --update-jira-link, e.g. KSR-9761')
    parser.add_argument('--mention-user-id', help='SF User Id to @mention in internal note (triggers notification)')
    parser.add_argument('--who-id',        help='18-char Contact Id for WhoId on Task (--log-call)')
    parser.add_argument('--activity-date', help='Task date YYYY-MM-DD for --log-call')
    parser.add_argument('--version-id',    help='18-char ContentVersion Id (required for --get-attachment)')
    parser.add_argument('--save-to',       help='Local file path to save the attachment (required for --get-attachment)')
    args = parser.parse_args()

    if args.mode and not args.email:
        error_exit("--email is required when using --mode")
    if args.post_comment:
        if not args.bulk_file and not args.case_id:
            error_exit("--post-comment requires --case-id (single) or --bulk-file (bulk)")
        if not args.bulk_file and not (args.comment_body or args.comment_file):
            error_exit("--post-comment requires --comment-body or --comment-file")
    if args.post_internal_note:
        if not args.bulk_file and not args.case_id:
            error_exit("--post-internal-note requires --case-id (single) or --bulk-file (bulk)")
        if not args.bulk_file and not (args.comment_body or args.comment_file):
            error_exit("--post-internal-note requires --comment-body or --comment-file")
    if args.update_status and not (args.case_id and args.status):
        error_exit("--update-status requires --case-id and --status")
    if args.update_eta and not (args.case_id and (args.eta or args.fix_version)):
        error_exit("--update-eta requires --case-id and at least --eta or --fix-version")
    if args.update_jira_link and not (args.case_id and args.jira_key):
        error_exit("--update-jira-link requires --case-id and --jira-key")
    if args.log_call:
        if not (args.case_id and args.activity_date):
            error_exit("--log-call requires --case-id and --activity-date")
        if not (args.comment_body or args.comment_file):
            error_exit("--log-call requires --comment-body or --comment-file for description")
    if args.list_attachments and not args.case_id:
        error_exit("--list-attachments requires --case-id")
    if args.get_attachment and not (args.version_id and args.save_to):
        error_exit("--get-attachment requires --version-id and --save-to")

    if args.clear_session:
        try:
            os.remove(SESSION_FILE)
        except FileNotFoundError:
            pass
        print(json.dumps({"cleared": True}))
        return

    if args.soql:
        result = run_soql(args.soql)
        result = strip_attributes(result)
        output_result(result, args.output)
        return

    # Write ops — get_token() lazy-inits on first function call
    if args.log_call:
        description = open(args.comment_file).read() if args.comment_file else args.comment_body
        write_log_call(args.case_id, args.who_id, args.activity_date, description)
        return
    if args.post_internal_note:
        if args.bulk_file:
            with open(args.bulk_file) as f:
                entries = json.load(f)
            write_post_internal_note_bulk(entries)
        else:
            body = open(args.comment_file).read() if args.comment_file else args.comment_body
            write_post_internal_note(args.case_id, body, mention_user_id=args.mention_user_id)
        return
    if args.post_comment:
        if args.bulk_file:
            with open(args.bulk_file) as f:
                entries = json.load(f)
            write_post_comment_bulk(entries)
        else:
            body = open(args.comment_file).read() if args.comment_file else args.comment_body
            write_post_comment(args.case_id, body)
        return
    if args.update_status:
        write_update_status(args.case_id, args.status)
        return
    if args.update_eta:
        write_update_eta(args.case_id, args.eta, args.fix_version)
        return
    if args.update_jira_link:
        write_update_jira_link(args.case_id, args.jira_key)
        return
    if args.list_attachments:
        items = list_attachments(args.case_id)
        output_result({"case_id": args.case_id, "count": len(items), "attachments": items}, args.output)
        return
    if args.get_attachment:
        size = get_attachment(args.version_id, args.save_to)
        print(json.dumps({"success": True, "version_id": args.version_id, "saved_to": args.save_to, "size_bytes": size}))
        return

    if args.get_case:
        case   = fetch_case_for_scheduling(args.get_case)
        result = strip_attributes({"case": case})
        output_result(result, args.output)
        return

    if args.get_case_transcript:
        case   = fetch_case_for_transcript(args.get_case_transcript)
        result = strip_attributes({"case": case})
        output_result(result, args.output)
        return

    if args.case:
        case     = fetch_case(args.case)
        case_id  = case['Id']
        emails   = fetch_emails(case_id)

        if args.fetch_mode == 'light':
            feed = fetch_feed_light(case_id)
            feed = truncate_auto_reminders(feed)
            feed = dedup_feed(feed)
            feed = cap_feed_bodies(feed)
            case['Description__c']   = None
            case['Execution_Log__c'] = None
            case['Error_Log__c']     = None
        else:
            feed = fetch_feed(case_id)

            # Fetch FeedComments via Chatter API for each AllUsers post with threaded replies
            all_comments = []
            for item in feed:
                if item.get('CommentCount', 0) > 0:
                    all_comments.extend(fetch_chatter_comments(item['Id']))

            if all_comments:
                seen = {item['Id'] for item in feed}
                for c in all_comments:
                    if c['Id'] not in seen:
                        feed.append(c)
                        seen.add(c['Id'])
                feed.sort(key=lambda x: x.get('CreatedDate', ''))

            feed = truncate_auto_reminders(feed)
            feed = dedup_feed(feed)
            feed = cap_feed_bodies(feed)
            case['Description__c'] = strip_html(case.get('Description__c'))

        result = strip_attributes({"case": case, "feed": feed, "emails": emails})

    else:  # --mode bulk
        cases = fetch_bulk_cases(args.mode, args.email)
        if not cases:
            result = {"mode": args.mode, "count": 0, "cases": []}
        else:
            enriched = []
            for c in cases:
                case_id = c['Id']
                emails  = fetch_emails(case_id)

                if args.fetch_mode == 'light':
                    feed = fetch_feed_light(case_id)
                    feed = truncate_auto_reminders(feed)
                    feed = dedup_feed(feed)
                    feed = cap_feed_bodies(feed)
                    c['Description__c']   = None
                    c['Execution_Log__c'] = None
                    c['Error_Log__c']     = None
                else:
                    feed = fetch_feed(case_id)

                    # Fetch FeedComments via Chatter API for each AllUsers post with threaded replies
                    all_comments = []
                    for item in feed:
                        if item.get('CommentCount', 0) > 0:
                            all_comments.extend(fetch_chatter_comments(item['Id']))
                    if all_comments:
                        seen = {item['Id'] for item in feed}
                        for comm in all_comments:
                            if comm['Id'] not in seen:
                                feed.append(comm)
                                seen.add(comm['Id'])
                        feed.sort(key=lambda x: x.get('CreatedDate', ''))

                    feed = truncate_auto_reminders(feed)
                    feed = dedup_feed(feed)
                    feed = cap_feed_bodies(feed)
                    c['Description__c'] = strip_html(c.get('Description__c'))

                enriched.append(strip_attributes({"case": c, "feed": feed, "emails": emails}))
            result = {"mode": args.mode, "count": len(enriched), "cases": enriched}

    output_result(result, args.output)


if __name__ == '__main__':
    main()
