#!/usr/bin/env python3
"""Fetch & parse DSE's Record Date for Right Entitlement Others PDF.

This PDF (refreshed by DSE every few days) lists companies with an approved
rights share issue: the ratio, issue price, Record Date (the cutoff for
owning the share to qualify for the rights entitlement) and the subscription
window during which eligible holders apply for their rights shares.

Company names are full legal names, matched against data/profiles.json via
dse_common.match_company_name — same approach as fetch_agm.py.

Requires pdfplumber, already a dependency for fetch_agm.py.
"""

import datetime
import re
import time

from dse_common import (PROFILES_JSON, RIGHTS_JSON, RIGHTS_PDF_URL,
                        build_name_index, load_json, match_company_name,
                        save_json)
from fetch_agm import parse_date as parse_date_mon

# Unlike the AGM/EGM PDF (dates like "29-Jul-26"), this PDF's table dates are
# numeric day-month-year, e.g. "04-08-26" -> 2026-08-04.
NUM_DATE_RE = re.compile(r"(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})")


def parse_date(text):
    if not text:
        return None
    m = NUM_DATE_RE.search(text)
    if m:
        day, mon, yr = m.groups()
        yr = ("20" + yr) if len(yr) == 2 else yr
        try:
            return datetime.date(int(yr), int(mon), int(day)).isoformat()
        except ValueError:
            return None
    return parse_date_mon(text)


def download_pdf(dest_path):
    import ssl
    import urllib.request
    req = urllib.request.Request(RIGHTS_PDF_URL, headers={"User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"})
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp, open(dest_path, "wb") as f:
        f.write(resp.read())


def parse_rights_pdf(path):
    import pdfplumber
    rows = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables():
                for row in table:
                    if not row or not row[0]:
                        continue
                    name = row[0].replace("\n", " ").strip()
                    if name in ("Name of The Company",) or "Dhaka Stock Exchange" in name \
                            or name.startswith("Last Updated") or name.startswith("Record Date"):
                        continue
                    cells = [(c or "").replace("\n", " ").strip() for c in row]
                    while len(cells) < 7:
                        cells.append("")
                    rows.append({
                        "company_name": cells[0],
                        "ratio_text": cells[1],
                        "issue_price_text": cells[2],
                        "record_date_text": cells[3],
                        "sub_open_text": cells[4],
                        "sub_close_text": cells[5],
                        "remarks": cells[6],
                    })
    return rows


def build_rights_notices(pdf_path):
    profiles = load_json(PROFILES_JSON, {}) or {}
    name_index = build_name_index(profiles.get("companies", {}))
    raw_rows = parse_rights_pdf(pdf_path)

    by_ticker = {}
    unmatched = []
    for r in raw_rows:
        ticker = match_company_name(r["company_name"], name_index)
        entry = {
            "company_name": r["company_name"],
            "ratio_text": r["ratio_text"],
            "issue_price_text": r["issue_price_text"],
            "record_date_text": r["record_date_text"],
            "record_date": parse_date(r["record_date_text"]),
            "sub_open_text": r["sub_open_text"],
            "sub_open": parse_date(r["sub_open_text"]),
            "sub_close_text": r["sub_close_text"],
            "sub_close": parse_date(r["sub_close_text"]),
            "remarks": r["remarks"],
        }
        if ticker:
            by_ticker.setdefault(ticker, []).append(entry)
        else:
            unmatched.append(entry)

    return {
        "by_ticker": by_ticker,
        "unmatched": unmatched,
        "total_rows": len(raw_rows),
        "matched_count": len(raw_rows) - len(unmatched),
        "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


def main():
    import os
    from dse_common import DATA_DIR
    pdf_path = os.path.join(DATA_DIR, "Company_RecordDate_RightsEntitlement.pdf")
    print("Downloading Rights Entitlement PDF...")
    download_pdf(pdf_path)
    print("Parsing and matching to tickers...")
    result = build_rights_notices(pdf_path)
    save_json(RIGHTS_JSON, result)
    print(f"Matched {result['matched_count']}/{result['total_rows']} rows to tickers "
         f"({len(result['unmatched'])} unmatched).")
    if result["unmatched"]:
        print("Unmatched company names (need profile name backfill or fuzzier match):")
        for u in result["unmatched"][:15]:
            print(" -", u["company_name"])


if __name__ == "__main__":
    main()
