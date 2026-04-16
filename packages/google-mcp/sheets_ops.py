#!/usr/bin/env python3
"""
sheets_ops.py — Google Sheets operations for OT evidence management.

Auth: service-account JSON key via GOOGLE_APPLICATION_CREDENTIALS env var.

Operations:
  --list-tabs         List tab names in the spreadsheet
  --get-range         Read a range (A1 notation)
  --update-range      Overwrite cells in a specific A1 range
  --find-employee     Find employee's row for a specific OT date
  --read-ot-summary   Read OT sheet as structured date-group summary
"""

import argparse
import json
import os
import sys
from datetime import datetime

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
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
    _service = build("sheets", "v4", credentials=creds, cache_discovery=False)
    return _service


# ── Generic operations ────────────────────────────────────────────────


def list_tabs(spreadsheet_id):
    svc = get_service()
    meta = (
        svc.spreadsheets()
        .get(spreadsheetId=spreadsheet_id, fields="sheets.properties.title")
        .execute()
    )
    return [s["properties"]["title"] for s in meta.get("sheets", [])]


def get_range(spreadsheet_id, range_a1):
    svc = get_service()
    resp = (
        svc.spreadsheets()
        .values()
        .get(
            spreadsheetId=spreadsheet_id,
            range=range_a1,
            valueRenderOption="FORMATTED_VALUE",
        )
        .execute()
    )
    return resp.get("values", [])


def update_range(spreadsheet_id, range_a1, row_data):
    svc = get_service()
    body = {"values": [row_data]}
    resp = (
        svc.spreadsheets()
        .values()
        .update(
            spreadsheetId=spreadsheet_id,
            range=range_a1,
            valueInputOption="USER_ENTERED",
            body=body,
        )
        .execute()
    )
    return resp.get("updatedRange", "")


# ── OT-specific operations ───────────────────────────────────────────


def _parse_date(s):
    """Parse common OT date formats into a date object."""
    for fmt in ("%d/%b/%Y", "%d/%B/%Y", "%d/%m/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s.strip(), fmt).date()
        except ValueError:
            continue
    return None


def _dates_match(a, b):
    da, db = _parse_date(a), _parse_date(b)
    if da and db:
        return da == db
    return a.strip().lower() == b.strip().lower()


def find_employee(spreadsheet_id, tab_name, employee_name, target_date):
    """Find an employee's row in the OT sheet for a specific date.

    The sheet uses date groups: whenever column D has a non-empty value
    that's a date, it starts a new group.  Subsequent rows inherit that
    date until the next non-empty D appears.
    """
    rows = get_range(spreadsheet_id, f"'{tab_name}'!A:F")
    current_date = None

    for i, row in enumerate(rows):
        # Pad to 6 columns
        row += [""] * (6 - len(row))

        col_d = str(row[3]).strip()
        if col_d and col_d not in ("OT Date", ""):
            current_date = col_d

        col_c = str(row[2]).strip()
        if not col_c or not current_date:
            continue

        if col_c.lower() == employee_name.lower() and _dates_match(
            current_date, target_date
        ):
            rn = i + 1  # 1-indexed
            return {
                "found": True,
                "row_number": rn,
                "ot_date": current_date,
                "current_ticket_task": row[4],
                "current_ref": row[5],
                "range_e": f"'{tab_name}'!E{rn}",
                "range_f": f"'{tab_name}'!F{rn}",
                "range_ef": f"'{tab_name}'!E{rn}:F{rn}",
            }

    # Not found — return all rows for that employee for context
    all_rows = []
    current_date = None
    for i, row in enumerate(rows):
        row += [""] * (6 - len(row))
        col_d = str(row[3]).strip()
        if col_d and col_d not in ("OT Date", ""):
            current_date = col_d
        col_c = str(row[2]).strip()
        if col_c.lower() == employee_name.lower():
            all_rows.append(
                {
                    "row_number": i + 1,
                    "ot_date": current_date or "",
                    "ticket_task": row[4],
                    "ref": row[5],
                }
            )

    return {
        "found": False,
        "employee_name": employee_name,
        "target_date": target_date,
        "all_rows": all_rows,
        "hint": (
            f"No row for '{employee_name}' on '{target_date}'. "
            "Available dates shown in all_rows."
        ),
    }


def read_ot_summary(spreadsheet_id, tab_name):
    """Return a structured summary: list of date groups, each with employee rows."""
    rows = get_range(spreadsheet_id, f"'{tab_name}'!A:F")
    date_groups = []
    current_group = None
    current_date = None

    for i, row in enumerate(rows):
        row += [""] * (6 - len(row))
        col_a, col_b, col_c = (
            str(row[0]).strip(),
            str(row[1]).strip(),
            str(row[2]).strip(),
        )
        col_d, col_e, col_f = (
            str(row[3]).strip(),
            str(row[4]).strip(),
            str(row[5]).strip(),
        )

        # Skip header/example rows
        if col_a in ("No.", "No", "") and col_b in (
            "Employee ID Number",
            "Please refer to BambooHR",
            "",
        ):
            continue
        if col_a == "ex":
            continue

        # New date group when col D has a date-like value
        if col_d and col_d != "OT Date" and _parse_date(col_d):
            current_date = col_d
            current_group = {"ot_date": current_date, "employees": []}
            date_groups.append(current_group)

        # Employee data row
        if col_c and current_group is not None:
            current_group["employees"].append(
                {
                    "no": col_a,
                    "employee_id": col_b,
                    "name": col_c,
                    "ticket_task": col_e,
                    "ref": col_f,
                    "row_number": i + 1,
                    "has_evidence": bool(col_e),
                }
            )

    return date_groups


# ── CLI entrypoint ───────────────────────────────────────────────────


def main():
    p = argparse.ArgumentParser()
    grp = p.add_mutually_exclusive_group(required=True)
    grp.add_argument("--list-tabs", action="store_true")
    grp.add_argument("--get-range", action="store_true")
    grp.add_argument("--update-range", action="store_true")
    grp.add_argument("--find-employee", action="store_true")
    grp.add_argument("--read-ot-summary", action="store_true")

    p.add_argument("--spreadsheet-id", required=True)
    p.add_argument("--sheet-name")
    p.add_argument("--range", dest="range_a1")
    p.add_argument("--row", help="JSON array of cell values")
    p.add_argument("--employee-name")
    p.add_argument("--target-date")

    args = p.parse_args()

    try:
        if args.list_tabs:
            tabs = list_tabs(args.spreadsheet_id)
            print(json.dumps({"success": True, "tabs": tabs}))

        elif args.get_range:
            if not args.range_a1:
                _fail("--range required")
            values = get_range(args.spreadsheet_id, args.range_a1)
            print(json.dumps({"success": True, "values": values}))

        elif args.update_range:
            if not args.range_a1 or not args.row:
                _fail("--range and --row required")
            row_data = json.loads(args.row)
            updated = update_range(args.spreadsheet_id, args.range_a1, row_data)
            print(json.dumps({"success": True, "updated_range": updated}))

        elif args.find_employee:
            if not args.sheet_name or not args.employee_name or not args.target_date:
                _fail("--sheet-name, --employee-name, and --target-date required")
            result = find_employee(
                args.spreadsheet_id,
                args.sheet_name,
                args.employee_name,
                args.target_date,
            )
            print(json.dumps({"success": True, **result}))

        elif args.read_ot_summary:
            if not args.sheet_name:
                _fail("--sheet-name required")
            groups = read_ot_summary(args.spreadsheet_id, args.sheet_name)
            print(json.dumps({"success": True, "date_groups": groups}))

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
