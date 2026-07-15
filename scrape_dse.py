#!/usr/bin/env python3
"""Scrape 2 years of daily price history for every share listed on DSE."""

import csv
import random
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta

BASE = "https://www.dsebd.org"
ALPHA_URL = f"{BASE}/latest_share_price_alpha.php"
ARCHIVE_URL = f"{BASE}/day_end_archive.php"
OUTPUT_CSV = "dse_2y_history.csv"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

ROW_RE = re.compile(r"<tr>(.*?)</tr>", re.DOTALL)
CELL_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.DOTALL)
TAG_RE = re.compile(r"<[^>]+>")


def fetch(url, retries=3):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as resp:
                return resp.read().decode("utf-8", errors="ignore")
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
            time.sleep(2 * attempt)
    raise last_err


def clean_cell(html):
    text = TAG_RE.sub("", html)
    return text.strip().replace(",", "")


def get_tickers():
    html = fetch(ALPHA_URL)
    tickers = sorted(set(re.findall(r'displayCompany\.php\?name=([^"]+)', html)))
    return tickers


def parse_archive_table(html):
    header_idx = html.find("shares-table")
    if header_idx == -1:
        return []
    idx = html.find("<tbody>", header_idx)
    end = html.find("</tbody>", idx)
    if idx == -1 or end == -1:
        return []
    body = html[idx:end]
    rows = []
    for row_html in ROW_RE.findall(body):
        cells = [clean_cell(c) for c in CELL_RE.findall(row_html)]
        if len(cells) < 11:
            continue
        # cells: #, DATE, TRADING CODE, LTP, HIGH, LOW, OPENP, CLOSEP, YCP, TRADE, VALUE(mn), VOLUME
        rows.append(cells[1:])
    return rows


def main():
    end_date = date.today()
    start_date = end_date - timedelta(days=365 * 2)
    start_str = start_date.isoformat()
    end_str = end_date.isoformat()

    print(f"Fetching ticker list from {ALPHA_URL} ...")
    tickers = get_tickers()
    print(f"Found {len(tickers)} tickers.")

    all_rows = []
    skipped = []

    with open(OUTPUT_CSV, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(
            [
                "Ticker",
                "Date",
                "LTP",
                "High",
                "Low",
                "OpenP",
                "CloseP",
                "YCP",
                "Trades",
                "ValueMn",
                "Volume",
            ]
        )

        for i, ticker in enumerate(tickers, 1):
            params = {
                "startDate": start_str,
                "endDate": end_str,
                "inst": ticker,
                "archive": "data",
            }
            url = f"{ARCHIVE_URL}?{urllib.parse.urlencode(params)}"
            try:
                html = fetch(url)
                rows = parse_archive_table(html)
            except Exception as e:
                print(f"[{i}/{len(tickers)}] {ticker}: FAILED ({e})")
                skipped.append(ticker)
                time.sleep(1 + random.random())
                continue

            for cells in rows:
                trading_date, trading_code, ltp, high, low, openp, closep, ycp, trade, value_mn, volume = cells
                writer.writerow(
                    [trading_code, trading_date, ltp, high, low, openp, closep, ycp, trade, value_mn, volume]
                )
            all_rows.extend(rows)
            print(f"[{i}/{len(tickers)}] {ticker}: {len(rows)} rows")

            time.sleep(0.8 + random.random() * 0.6)

    print()
    print("Done.")
    print(f"Tickers processed: {len(tickers) - len(skipped)}/{len(tickers)}")
    print(f"Total rows written: {len(all_rows)}")
    if skipped:
        print(f"Skipped tickers ({len(skipped)}): {', '.join(skipped)}")
    print(f"Output: {OUTPUT_CSV}")


if __name__ == "__main__":
    sys.exit(main())
