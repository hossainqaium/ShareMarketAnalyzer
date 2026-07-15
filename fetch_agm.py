#!/usr/bin/env python3
"""Fetch & parse DSE's Company AGM/EGM and Record Date Information PDF.

This single PDF (refreshed by DSE every few days) lists, per company: the
upcoming/last AGM or EGM, its purpose (often a dividend declaration with the
percentage), and the crucial Record Date — the cutoff for owning the share to
qualify for that dividend. Buying before the record date captures the
dividend; the price typically drops by roughly the dividend amount on the
ex-date, so this date matters for timing a purchase.

Company names in the PDF are full legal names, not ticker codes, so we match
them against the full names captured in data/profiles.json (see
fetch_profiles.py's "name" field) via dse_common.match_company_name.

Requires pdfplumber (`pip install pdfplumber`) — the one non-stdlib
dependency in this project, because parsing a real PDF table reliably needs
it; everything else here stays stdlib.
"""

import datetime
import re
import time

from dse_common import (AGM_JSON, AGM_PDF_URL, PROFILES_JSON, build_name_index,
                        fetch, load_json, match_company_name, save_json)

DATE_RE = re.compile(r"(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{2,4})")
PCT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*%\s*(Cash|Stock|Bonus)?", re.I)


def parse_date(text):
    if not text:
        return None
    m = DATE_RE.search(text)
    if not m:
        return None
    day, mon, yr = m.groups()
    yr = ("20" + yr) if len(yr) == 2 else yr
    try:
        return datetime.datetime.strptime(f"{day}-{mon}-{yr}", "%d-%b-%Y").date().isoformat()
    except ValueError:
        return None


def parse_dividend(purpose):
    """Extract total cash/stock dividend % and a normalized label from the
    free-text purpose column, e.g. '5% Cash and 5% Stock Dividend' -> 10, mixed."""
    if not purpose:
        return None, None
    if re.search(r"no\s+dividend", purpose, re.I):
        return 0.0, "none"
    parts = PCT_RE.findall(purpose)
    if not parts:
        return None, None
    total = sum(float(p) for p, _ in parts)
    kinds = {k.lower() for _, k in parts if k}
    label = "mixed" if len(kinds) > 1 else (kinds.pop() if kinds else "cash")
    return total, label


def download_pdf(dest_path):
    import urllib.request
    req = urllib.request.Request(AGM_PDF_URL, headers={"User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"})
    import ssl
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp, open(dest_path, "wb") as f:
        f.write(resp.read())


def parse_agm_pdf(path):
    import pdfplumber
    rows = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables():
                for row in table:
                    if not row or not row[0]:
                        continue
                    name = row[0].replace("\n", " ").strip()
                    if name in ("Name of the Company",) or "Dhaka Stock Exchange" in name \
                            or name.startswith("Last Updated"):
                        continue
                    cells = [(c or "").replace("\n", " ").strip() for c in row]
                    while len(cells) < 7:
                        cells.append("")
                    rows.append({
                        "company_name": cells[0],
                        "year_end": cells[1],
                        "purpose": cells[2],
                        "agm_date_text": cells[3],
                        "record_date_text": cells[4],
                        "venue": cells[5],
                        "time": cells[6],
                    })
    return rows


def build_agm_notices(pdf_path):
    profiles = load_json(PROFILES_JSON, {}) or {}
    name_index = build_name_index(profiles.get("companies", {}))
    raw_rows = parse_agm_pdf(pdf_path)

    by_ticker = {}
    unmatched = []
    for r in raw_rows:
        ticker = match_company_name(r["company_name"], name_index)
        div_pct, div_kind = parse_dividend(r["purpose"])
        entry = {
            "company_name": r["company_name"],
            "purpose": r["purpose"],
            "dividend_pct": div_pct,
            "dividend_kind": div_kind,
            "agm_date_text": r["agm_date_text"],
            "agm_date": parse_date(r["agm_date_text"]),
            "record_date_text": r["record_date_text"],
            "record_date": parse_date(r["record_date_text"]),
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
    pdf_path = os.path.join(DATA_DIR, "Company_AGM_EGM.pdf")
    print("Downloading AGM/EGM PDF...")
    download_pdf(pdf_path)
    print("Parsing and matching to tickers...")
    result = build_agm_notices(pdf_path)
    save_json(AGM_JSON, result)
    print(f"Matched {result['matched_count']}/{result['total_rows']} rows to tickers "
         f"({len(result['unmatched'])} unmatched).")
    if result["unmatched"]:
        print("Unmatched company names (need profile name backfill or fuzzier match):")
        for u in result["unmatched"][:15]:
            print(" -", u["company_name"])


if __name__ == "__main__":
    main()
