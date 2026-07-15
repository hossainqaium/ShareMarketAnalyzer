#!/usr/bin/env python3
"""Fetch & categorize DSE company announcements (old_news.php).

Each announcement is tagged with the company's own trading code, so no name
matching is needed here (unlike the AGM/EGM PDF). We classify each into a
category that matters for analysis — some are hard stops (trading halted),
some are red flags (audit concerns, exchange queries on abnormal price
moves), some are positive catalysts (dividend declared, strong Q results,
better credit rating) — and store everything (raw + category) per ticker so
the analysis and UI can both use it.
"""

import re
import time
import urllib.parse

from dse_common import ANNOUNCEMENTS_JSON, NEWS_URL, TAG_RE, fetch, load_json, save_json

ROW_RE = re.compile(r"<tr>(.*?)</tr>", re.DOTALL)
TH_RE = re.compile(r"<th[^>]*>(.*?)</th>", re.DOTALL)
TD_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.DOTALL)

# (category, regex) — first match wins, ordered most-specific first.
CATEGORY_RULES = [
    ("trading-halt", re.compile(r"halt of trading", re.I)),
    ("audit-concern", re.compile(r"qualified opinion|emphasis of matter|going concern", re.I)),
    ("exchange-query", re.compile(r"^query|query response", re.I)),
    ("category-change", re.compile(r"category change", re.I)),
    ("suspension", re.compile(r"suspension for record date|suspension of trading", re.I)),
    ("resumption", re.compile(r"resumption after record date|resumption of trading", re.I)),
    ("dividend", re.compile(r"dividend declaration|dividend disbursement", re.I)),
    ("rights-issue", re.compile(r"right share|rights issu", re.I)),
    ("financials", re.compile(r"q[1-4] financials|half.?yearly|annual financ|financial statements", re.I)),
    ("credit-rating", re.compile(r"credit rating result", re.I)),
    ("board-meeting", re.compile(r"board meeting schedule", re.I)),
    ("record-date", re.compile(r"record date", re.I)),
    ("nav", re.compile(r"daily nav", re.I)),
]

# categories worth keeping per-ticker; everything else (NAV noise, generic DSE
# admin notices, authorized-representative churn) is dropped to keep the file small
KEEP_CATEGORIES = {
    "trading-halt", "audit-concern", "exchange-query", "category-change",
    "suspension", "resumption", "dividend", "rights-issue", "financials",
    "credit-rating", "board-meeting", "record-date", "other",
}
DROP_CATEGORIES = {"nav"}


def categorize(title):
    for cat, pat in CATEGORY_RULES:
        if pat.search(title):
            return cat
    if title.strip().upper().startswith("DSE NEWS") or title.strip().upper().startswith("DSENEWS"):
        return None  # exchange-wide admin notice, not company-specific signal
    return "other"


def parse_news_page(html):
    """Parse old_news.php's 'table-news' block: repeating (Trading Code,
    News Title, News, Post Date) records separated by <hr/> rows."""
    idx = html.find("table-news")
    if idx == -1:
        return []
    seg = html[idx:]
    records = []
    cur = {}
    for row_html in ROW_RE.findall(seg):
        ths = TH_RE.findall(row_html)
        tds = TD_RE.findall(row_html)
        if not tds:
            # separator row (<hr/> or &nbsp; spacer) marks the end of a record
            if cur.get("ticker") and cur.get("title"):
                records.append(cur)
            cur = {}
            continue
        label = TAG_RE.sub("", ths[0]).strip() if ths else ""
        value = TAG_RE.sub(" ", tds[0]).replace("&nbsp;", " ").strip()
        value = re.sub(r"\s+", " ", value)
        if label.startswith("Trading Code"):
            if cur.get("ticker") and cur.get("title"):
                records.append(cur)
            cur = {"ticker": value}
        elif label.startswith("News Title"):
            cur["title"] = value
        elif label.startswith("News:"):
            cur["text"] = value
        elif label.startswith("Post Date"):
            cur["date"] = value
    if cur.get("ticker") and cur.get("title"):
        records.append(cur)
    return records


def fetch_announcements(start_date, end_date):
    params = {"startDate": start_date, "endDate": end_date, "criteria": 4, "archive": "news"}
    url = f"{NEWS_URL}?{urllib.parse.urlencode(params)}"
    return parse_news_page(fetch(url))


def merge_announcements(start_date, end_date, keep_days=60):
    """Fetch a date range, categorize, and merge into data/announcements.json,
    deduplicated per ticker by (date, title, text). Drops entries older than
    keep_days so the file doesn't grow forever."""
    store = load_json(ANNOUNCEMENTS_JSON, {}) or {}
    by_ticker = store.get("by_ticker", {})

    raw = fetch_announcements(start_date, end_date)
    added = 0
    for r in raw:
        cat = categorize(r.get("title", ""))
        if cat is None or cat in DROP_CATEGORIES:
            continue
        ticker = r["ticker"]
        entry = {"date": r.get("date", ""), "title": r["title"],
                 "text": r.get("text", ""), "category": cat}
        lst = by_ticker.setdefault(ticker, [])
        key = (entry["date"], entry["title"], entry["text"])
        if not any((e["date"], e["title"], e["text"]) == key for e in lst):
            lst.append(entry)
            added += 1

    cutoff = None
    try:
        import datetime
        cutoff = (datetime.date.today() - datetime.timedelta(days=keep_days)).isoformat()
    except Exception:
        pass
    if cutoff:
        for t in list(by_ticker):
            by_ticker[t] = [e for e in by_ticker[t] if e["date"] >= cutoff]
            by_ticker[t].sort(key=lambda e: e["date"])
            if not by_ticker[t]:
                del by_ticker[t]

    save_json(ANNOUNCEMENTS_JSON, {"by_ticker": by_ticker,
                                   "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S")})
    return added, len(by_ticker)


if __name__ == "__main__":
    import datetime
    import sys
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 7
    end = datetime.date.today()
    start = end - datetime.timedelta(days=days)
    added, tickers = merge_announcements(start.isoformat(), end.isoformat())
    print(f"Fetched {start} -> {end}: +{added} announcements across {tickers} tickers stored.")
