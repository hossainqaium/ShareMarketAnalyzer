#!/usr/bin/env python3
"""Fetch DSE company news from amarstock.com into news.csv.

amarstock renders the same DSE announcements as a clean server-side list of
`row single_news` blocks — each block is (date, time, trading code, title,
body). We parse those, categorise every item with the SAME rules the DSE
old_news feed uses (fetch_news.categorize) so downstream analysis treats both
sources identically, and store them in news.csv.

Efficiency, as requested: the FIRST fetch (empty store) pulls the 7-day page to
seed history; every later fetch pulls only the lightweight today page, and we
append ONLY rows we haven't already stored (dedup key = date+code+title+text),
so we never re-parse or re-store news we already have.

The per-ticker view of this store is merged into the analysis news channel
(see analysis.py) so fresh news flows into scoring, suggestions and the Why
column automatically.

Callable as run_news_fetch(progress=...) — server.py's "News Fetch" button and
sync.py's Update Data flow both invoke it.
"""

import csv
import re
import time
from datetime import date, datetime, timedelta

from dse_common import (AMARSTOCK_7DAY_URL, AMARSTOCK_TODAY_URL, NEWS_CSV,
                        NEWS_CSV_HEADER, TAG_RE, fetch, load_news)
from fetch_news import categorize

KEEP_DAYS = 45   # trim news older than this so the file doesn't grow forever

# One `single_news` block: date + time (unclosed <p> tags), then code/title/body.
BLOCK_RE = re.compile(
    r'single_news.*?columns date"><p>([^<]+)<p>([^<]+)</div>'
    r'.*?<h3>([^<]*)</h3>\s*<h4>([^<]*)</h4>\s*<p>(.*?)</div>',
    re.DOTALL)


def _clean(html_fragment):
    text = TAG_RE.sub(" ", html_fragment).replace("&nbsp;", " ").replace("&amp;", "&")
    return re.sub(r"\s+", " ", text).strip()


def parse_amarstock_news(html):
    """Return [{Date, Time24, PostedTime, Code, Category, Title, Text}, ...]
    for every parseable news block on an amarstock news page."""
    out = []
    for raw_date, raw_time, code, title, body in BLOCK_RE.findall(html):
        code = _clean(code).upper()
        title = _clean(title)
        if not code or not title:
            continue
        try:
            iso = datetime.strptime(raw_date.strip(), "%b %d, %Y").date().isoformat()
        except ValueError:
            continue
        posted = _clean(raw_time)
        try:
            t24 = datetime.strptime(posted, "%I:%M %p").strftime("%H:%M")
        except ValueError:
            t24 = ""
        out.append({
            "Date": iso, "Time24": t24, "PostedTime": posted,
            "Code": code, "Category": categorize(title) or "notice",
            "Title": title, "Text": _clean(body),
        })
    return out


def run_news_fetch(progress=lambda msg, pct: None):
    """Fetch the right amarstock page (7-day to seed, today to poll), append
    only unseen rows to news.csv, trim old rows, and return a summary dict."""
    existing = load_news()
    first_time = len(existing) == 0
    url = AMARSTOCK_7DAY_URL if first_time else AMARSTOCK_TODAY_URL
    scope = "last 7 days" if first_time else "today"
    progress(f"Fetching {scope} DSE news from amarstock...", None)

    html = fetch(url)
    parsed = parse_amarstock_news(html)

    seen = {(r.get("Date"), r.get("Code"), r.get("Title"), r.get("Text")) for r in existing}
    added = []
    for p in parsed:
        key = (p["Date"], p["Code"], p["Title"], p["Text"])
        if key in seen:
            continue
        seen.add(key)
        added.append(p)

    combined = existing + added
    cutoff = (date.today() - timedelta(days=KEEP_DAYS)).isoformat()
    combined = [r for r in combined if r.get("Date", "") >= cutoff]
    combined.sort(key=lambda r: (r.get("Date", ""), r.get("Time24", "")), reverse=True)

    tmp = NEWS_CSV + ".tmp"
    with open(tmp, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=NEWS_CSV_HEADER)
        w.writeheader()
        for r in combined:
            w.writerow({k: r.get(k, "") for k in NEWS_CSV_HEADER})
    import os
    os.replace(tmp, NEWS_CSV)

    summary = {"added": len(added), "total": len(combined),
               "source": "7-day" if first_time else "today",
               "parsed": len(parsed),
               "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S")}
    progress(f"News: +{len(added)} new ({scope}), {len(combined)} stored.", None)
    return summary


if __name__ == "__main__":
    print(run_news_fetch(progress=lambda m, p: print(m)))
