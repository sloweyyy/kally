#!/usr/bin/env python3
"""
drive_ops.py — Google Drive operations for OT evidence management.

Auth: service-account JSON key via GOOGLE_APPLICATION_CREDENTIALS env var.

Operations:
  --create-folder   Create a folder under a parent
  --upload-file     Upload a local file to a folder
  --upload-base64   Upload base64-encoded content (for Slack images)
  --list-files      List files in a folder
  --get-link        Get web link for a file/folder
"""

import argparse
import base64
import json
import mimetypes
import os
import sys
import tempfile

SCOPES = ["https://www.googleapis.com/auth/drive"]
_service = None


def get_service():
    global _service
    if _service is not None:
        return _service

    creds_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "")
    if not creds_path or not os.path.isfile(creds_path):
        print(
            json.dumps(
                {
                    "success": False,
                    "error": "GOOGLE_APPLICATION_CREDENTIALS not set or file not found",
                }
            )
        )
        sys.exit(1)

    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    creds = service_account.Credentials.from_service_account_file(
        creds_path, scopes=SCOPES
    )
    _service = build("drive", "v3", credentials=creds, cache_discovery=False)
    return _service


def create_folder(parent_id, folder_name):
    svc = get_service()
    metadata = {
        "name": folder_name,
        "mimeType": "application/vnd.google-apps.folder",
        "parents": [parent_id],
    }
    folder = (
        svc.files()
        .create(body=metadata, fields="id, webViewLink", supportsAllDrives=True)
        .execute()
    )
    return folder.get("id"), folder.get("webViewLink")


def upload_file(folder_id, file_path, file_name=None):
    from googleapiclient.http import MediaFileUpload

    svc = get_service()
    name = file_name or os.path.basename(file_path)
    mime = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
    metadata = {"name": name, "parents": [folder_id]}
    media = MediaFileUpload(file_path, mimetype=mime, resumable=False)
    f = (
        svc.files()
        .create(
            body=metadata, media_body=media, fields="id, webViewLink",
            supportsAllDrives=True,
        )
        .execute()
    )
    return f.get("id"), f.get("webViewLink")


def upload_base64(folder_id, file_name, mime_type, b64_data):
    """Decode base64 content to a temp file and upload to Drive."""
    from googleapiclient.http import MediaFileUpload

    raw = base64.b64decode(b64_data)
    suffix = mimetypes.guess_extension(mime_type) or ""
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        tmp.write(raw)
        tmp.close()
        svc = get_service()
        metadata = {"name": file_name, "parents": [folder_id]}
        media = MediaFileUpload(tmp.name, mimetype=mime_type, resumable=False)
        f = (
            svc.files()
            .create(
                body=metadata, media_body=media, fields="id, webViewLink",
                supportsAllDrives=True,
            )
            .execute()
        )
        return f.get("id"), f.get("webViewLink")
    finally:
        os.unlink(tmp.name)


def list_files(folder_id):
    svc = get_service()
    q = f"'{folder_id}' in parents and trashed = false"
    resp = (
        svc.files()
        .list(
            q=q,
            fields="files(id, name, mimeType, webViewLink, createdTime)",
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
            orderBy="createdTime desc",
            pageSize=100,
        )
        .execute()
    )
    return resp.get("files", [])


def get_link(file_id):
    svc = get_service()
    meta = (
        svc.files()
        .get(fileId=file_id, fields="id, name, webViewLink", supportsAllDrives=True)
        .execute()
    )
    return meta.get("webViewLink"), meta.get("name")


# ── CLI ──────────────────────────────────────────────────────────────


def main():
    p = argparse.ArgumentParser()
    grp = p.add_mutually_exclusive_group(required=True)
    grp.add_argument("--create-folder", action="store_true")
    grp.add_argument("--upload-file", action="store_true")
    grp.add_argument("--upload-base64", action="store_true")
    grp.add_argument("--list-files", action="store_true")
    grp.add_argument("--get-link", action="store_true")

    p.add_argument("--parent-id")
    p.add_argument("--name")
    p.add_argument("--folder-id")
    p.add_argument("--file-path")
    p.add_argument("--file-name")
    p.add_argument("--file-id")
    p.add_argument("--mime-type")
    # base64 data passed via stdin to avoid arg-length limits
    p.add_argument(
        "--base64-stdin",
        action="store_true",
        help="Read base64 data from stdin",
    )

    args = p.parse_args()

    try:
        if args.create_folder:
            if not args.parent_id or not args.name:
                _fail("--parent-id and --name required")
            fid, url = create_folder(args.parent_id, args.name)
            print(json.dumps({"success": True, "folder_id": fid, "folder_url": url}))

        elif args.upload_file:
            if not args.folder_id or not args.file_path:
                _fail("--folder-id and --file-path required")
            if not os.path.isfile(args.file_path):
                _fail(f"File not found: {args.file_path}")
            fid, url = upload_file(args.folder_id, args.file_path, args.file_name)
            print(json.dumps({"success": True, "file_id": fid, "file_url": url}))

        elif args.upload_base64:
            if not args.folder_id or not args.file_name or not args.mime_type:
                _fail("--folder-id, --file-name, and --mime-type required")
            if args.base64_stdin:
                b64 = sys.stdin.read().strip()
            else:
                _fail("--base64-stdin is required (pipe data via stdin)")
            fid, url = upload_base64(args.folder_id, args.file_name, args.mime_type, b64)
            print(json.dumps({"success": True, "file_id": fid, "file_url": url}))

        elif args.list_files:
            if not args.folder_id:
                _fail("--folder-id required")
            files = list_files(args.folder_id)
            print(json.dumps({"success": True, "files": files, "count": len(files)}))

        elif args.get_link:
            if not args.file_id:
                _fail("--file-id required")
            url, name = get_link(args.file_id)
            print(json.dumps({"success": True, "file_url": url, "name": name}))

    except Exception as e:
        _handle_error(e)


def _fail(msg):
    print(json.dumps({"success": False, "error": msg}))
    sys.exit(1)


def _handle_error(e):
    try:
        from googleapiclient.errors import HttpError

        if isinstance(e, HttpError):
            err = json.loads(e.content.decode("utf-8")) if e.content else {}
            print(
                json.dumps(
                    {
                        "success": False,
                        "error": err.get("error", {}).get("message", str(e)),
                        "status": e.resp.status,
                    }
                )
            )
            sys.exit(1)
    except ImportError:
        pass
    print(json.dumps({"success": False, "error": str(e)}))
    sys.exit(1)


if __name__ == "__main__":
    main()
