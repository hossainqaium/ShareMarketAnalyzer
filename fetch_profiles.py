#!/usr/bin/env python3
"""Scrape company fundamentals for every DSE ticker into data/profiles.json.

Slow (~1-2s per company page); run in background. Also pulls trailing P/E for
all companies in one request from latest_PE.php.
"""

import random
import re
import sys
import time
from datetime import date, datetime

from dse_common import (FUNDAMENTALS_HISTORY_JSON, PE_URL, PROFILES_JSON,
                        TAG_RE, fetch, load_json, load_tickers, save_json)

HOLDING_HISTORY_KEEP = 24   # ~2 years of monthly snapshots
EPS_INTERIM_KEEP = 12       # ~2-3 years of distinct interim readings


def to_text_tokens(html):
    text = TAG_RE.sub("|", html).replace("&nbsp;", " ").replace("&amp;", "&")
    return [t.strip() for t in text.split("|") if t.strip()]


def token_after(tokens, key, offset=1):
    for i, t in enumerate(tokens):
        if t == key and i + offset < len(tokens):
            return tokens[i + offset]
    return None


def num(s):
    if s is None:
        return None
    s = s.replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


MONTH_NUM = {"Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
             "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12}


def parse_as_on_date(label):
    """'Share Holding Percentage\\n [as on Dec 31, 2025 (year ended)]' -> ISO date."""
    m = re.search(r"as on (\w{3})\s+(\d{1,2}),\s*(\d{4})", label)
    if not m:
        return None
    mon = MONTH_NUM.get(m.group(1))
    if not mon:
        return None
    try:
        return date(int(m.group(3)), mon, int(m.group(2))).isoformat()
    except ValueError:
        return None


def parse_holding_snapshots(tokens):
    """Every dated shareholding-split block on the page (usually the latest
    ~3 months) as (date, {sponsor, govt, institute, foreign, public})."""
    labels = {"Sponsor/Director:": "sponsor", "Govt:": "govt", "Institute:": "institute",
              "Foreign:": "foreign", "Public:": "public"}
    out = []
    for i, t in enumerate(tokens):
        if not t.startswith("Share Holding Percentage"):
            continue
        d = parse_as_on_date(t)
        if not d:
            continue
        block = {}
        j = i + 1
        while j < min(i + 13, len(tokens) - 1) and not tokens[j].startswith("Share Holding Percentage"):
            if tokens[j] in labels:
                v = num(tokens[j + 1])
                if v is not None:
                    block[labels[tokens[j]]] = v
            j += 1
        if block:
            out.append((d, block))
    return out


def parse_nav_and_eps_annual(tokens):
    """Year -> {eps_co_basic, nav, profit_mn} from the audited annual
    'Financial Performance' table. That table has 12 leaf columns (Basic/
    Diluted EPS, EPS-continuing-ops, NAV Per Share, Profit&OCI — each
    Original/Restated); column 4 is EPS-continuing-ops Basic Original,
    column 7 is NAV Per Share Original, column 11 is Profit for the year.
    A later, unrelated table on the page ('Details of Financial Statement')
    happens to also produce 12-dash-or-numeric runs after a year token, so
    the scan stops the moment the year sequence stops strictly ascending —
    that marks having left the intended table."""
    anchor = "Financial Performance as per Audited Financial Statements as per IFRS/IAS or BFRS/BAS"
    try:
        idx = tokens.index(anchor)
    except ValueError:
        return {}
    out = {}
    this_year = date.today().year
    last_year = None
    i, stop = idx, min(len(tokens), idx + 400)
    while i < stop and len(out) < 8:
        t = tokens[i]
        if (re.fullmatch(r"(19|20)\d{2}", t) and this_year - 15 <= int(t) <= this_year
                and i + 12 < len(tokens)):
            y = int(t)
            if last_year is not None and y <= last_year:
                break
            vals = tokens[i + 1:i + 13]
            if all(v == "-" or num(v) is not None for v in vals):
                g = lambda j: num(vals[j]) if vals[j] != "-" else None
                out[y] = {"eps_co_basic": g(3), "nav": g(6), "profit_mn": g(10)}
                last_year = y
                i += 13
                continue
        i += 1
    return out


def parse_interim_eps(tokens):
    """First two non-dash 'Basic' EPS figures reported in the Interim
    Financial Performance table — this fiscal year's most recently reported
    quarters, left to right. Doesn't assume which column means which
    quarter, since that varies by each company's fiscal year-end."""
    try:
        idx = tokens.index("Earnings Per Share (EPS)")
    except ValueError:
        return None
    j = idx + 1
    while j < min(idx + 6, len(tokens)) and tokens[j] != "Basic":
        j += 1
    if j >= len(tokens) or tokens[j] != "Basic":
        return None
    vals = tokens[j + 1:j + 7]
    nums = [num(v) for v in vals if v != "-" and num(v) is not None]
    return nums[:2] or None


def parse_profile(html):
    tokens = to_text_tokens(html)
    p = {}
    p["name"] = token_after(tokens, "Company Name:")
    p["sector"] = token_after(tokens, "Sector")
    p["category"] = token_after(tokens, "Market Category")
    p["listing_year"] = num(token_after(tokens, "Listing Year"))
    p["paid_up_capital_mn"] = num(token_after(tokens, "Paid-up Capital (mn)"))
    p["outstanding_shares"] = num(token_after(tokens, "Total No. of Outstanding Securities"))
    p["reserve_mn"] = num(token_after(tokens, "Reserve & Surplus without OCI (mn)"))
    p["instrument_type"] = token_after(tokens, "Type of Instrument")
    p["cash_dividend"] = token_after(tokens, "Cash Dividend")
    p["stock_dividend"] = token_after(tokens, "Bonus Issue (Stock Dividend)")

    # Basic EPS: first numeric token after "Earnings Per Share (EPS)" then
    # "Basic" — this is the latest REPORTED QUARTER's EPS (not annual); kept
    # for backward compatibility (only its sign is used as a profitability
    # gate elsewhere). eps_annual below is the real one for P/E math.
    iv = parse_interim_eps(tokens)
    if iv:
        p["eps_basic"] = iv[0]

    annual = parse_nav_and_eps_annual(tokens)
    years_with_data = [y for y, v in annual.items()
                       if v.get("nav") is not None or v.get("eps_co_basic") is not None]
    if years_with_data:
        row = annual[max(years_with_data)]
        if row.get("eps_co_basic") is not None:
            p["eps_annual"] = row["eps_co_basic"]
            p["eps_annual_year"] = max(years_with_data)
        if row.get("nav") is not None:
            p["nav_per_share"] = row["nav"]

    # Latest shareholding split (the last dated block is most recent); the
    # full list is stashed for main() to accumulate into fundamentals_history
    snaps = parse_holding_snapshots(tokens)
    if snaps:
        p["holding"] = snaps[-1][1]
    p["_holding_snapshots"] = snaps
    p["_interim_eps"] = iv

    # Latest cash dividend % (first entry like "30% 2025")
    if p.get("cash_dividend"):
        m = re.match(r"([\d.]+)%", p["cash_dividend"])
        if m:
            p["last_cash_dividend_pct"] = float(m.group(1))
    return p


def fetch_trailing_pe():
    """One-shot trailing P/E for all instruments from latest_PE.php."""
    html = fetch(PE_URL)
    header_idx = html.find("shares-table")
    if header_idx == -1:
        return {}
    tokens = to_text_tokens(html[header_idx:])
    pes = {}
    # rows look like: <n> CODE closeP ycp pe1 pe2 pe3 pe4 [pe5 pe6 trailing...]
    i = 0
    while i < len(tokens) - 4:
        if re.fullmatch(r"\d+", tokens[i]) and re.fullmatch(r"[A-Z0-9&().\-]+", tokens[i + 1]) \
                and num(tokens[i + 2]) is not None:
            code = tokens[i + 1]
            pe = num(tokens[i + 4])  # P/E 1 (Basic, latest unaudited)
            if pe is not None and pe > 0:
                pes[code] = pe
            i += 5
        else:
            i += 1
    return pes


def merge_holding_history(fh, ticker, snapshots):
    """Append newly-seen dated holding snapshots (deduped by date), oldest
    first, capped to the most recent HOLDING_HISTORY_KEEP entries — this is
    how a multi-year institutional-holding trend builds up over repeated
    scrapes, since any single page only shows the latest ~3 months."""
    entry = fh.setdefault(ticker, {})
    hist = entry.setdefault("holding", [])
    seen = {h["date"] for h in hist}
    for d, block in snapshots:
        if d not in seen:
            hist.append({"date": d, **block})
            seen.add(d)
    hist.sort(key=lambda h: h["date"])
    entry["holding"] = hist[-HOLDING_HISTORY_KEEP:]


def merge_eps_history(fh, ticker, values):
    """Append a new interim-EPS reading only if it differs from the last
    stored one — avoids bloating with identical entries between a company's
    actual quarterly reports, so consecutive DISTINCT entries mark real
    earnings momentum."""
    if not values:
        return
    entry = fh.setdefault(ticker, {})
    hist = entry.setdefault("eps_interim", [])
    if hist and hist[-1]["values"] == values:
        return
    hist.append({"scraped": date.today().isoformat(), "values": values})
    entry["eps_interim"] = hist[-EPS_INTERIM_KEEP:]


def main():
    cache = load_tickers()
    tickers = cache["tickers"]
    profiles = load_json(PROFILES_JSON, {}) or {}
    existing = profiles.get("companies", {})
    fund_hist = load_json(FUNDAMENTALS_HISTORY_JSON, {}) or {}

    print(f"Fetching trailing P/E for all instruments ...")
    try:
        pe_map = fetch_trailing_pe()
        print(f"  got P/E for {len(pe_map)} instruments")
    except Exception as e:
        print(f"  P/E fetch failed: {e}")
        pe_map = profiles.get("pe", {})

    companies = dict(existing)
    todo = [t for t in tickers if "--refresh" in sys.argv or t not in companies
            or "name" not in companies.get(t, {}) or "nav_per_share" not in companies.get(t, {})]
    print(f"Fetching {len(todo)} company profiles ...")

    def checkpoint():
        save_json(PROFILES_JSON, {"companies": companies, "pe": pe_map,
                                  "updated_at": time.strftime("%Y-%m-%d %H:%M:%S")})
        save_json(FUNDAMENTALS_HISTORY_JSON, fund_hist)

    for i, (ticker) in enumerate(sorted(todo), 1):
        url = tickers[ticker]
        try:
            html = fetch(url)
            p = parse_profile(html)
            snaps, iv = p.pop("_holding_snapshots"), p.pop("_interim_eps")
            merge_holding_history(fund_hist, ticker, snaps)
            merge_eps_history(fund_hist, ticker, iv)
            companies[ticker] = p
            print(f"[{i}/{len(todo)}] {ticker}: {p.get('sector')} cat={p.get('category')} "
                  f"nav={p.get('nav_per_share')}")
        except Exception as e:
            print(f"[{i}/{len(todo)}] {ticker}: FAILED ({e})")
        if i % 20 == 0:  # checkpoint so a crash doesn't lose progress
            checkpoint()
        time.sleep(0.6 + random.random() * 0.5)

    checkpoint()
    print(f"\nDone. {len(companies)} profiles saved to {PROFILES_JSON}")


if __name__ == "__main__":
    main()
