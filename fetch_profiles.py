#!/usr/bin/env python3
"""Scrape company fundamentals for every DSE ticker into data/profiles.json.

Slow (~1-2s per company page); run in background. Also pulls trailing P/E for
all companies in one request from latest_PE.php.
"""

import random
import re
import sys
import time

from dse_common import (PE_URL, PROFILES_JSON, TAG_RE, fetch, load_json,
                        load_tickers, save_json)


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

    # Basic EPS: first numeric token after "Earnings Per Share (EPS)" then "Basic"
    for i, t in enumerate(tokens):
        if t == "Earnings Per Share (EPS)":
            for j in range(i, min(i + 6, len(tokens))):
                if tokens[j] == "Basic":
                    v = num(tokens[j + 1]) if j + 1 < len(tokens) else None
                    if v is not None:
                        p["eps_basic"] = v
                    break
            break

    # Latest shareholding split (the last "Sponsor/Director:" block is most recent)
    holds = {}
    for i, t in enumerate(tokens):
        if t == "Sponsor/Director:":
            block = {}
            labels = {"Sponsor/Director:": "sponsor", "Govt:": "govt",
                      "Institute:": "institute", "Foreign:": "foreign", "Public:": "public"}
            j = i
            while j < min(i + 12, len(tokens) - 1):
                if tokens[j] in labels:
                    v = num(tokens[j + 1])
                    if v is not None:
                        block[labels[tokens[j]]] = v
                j += 1
            if block:
                holds = block
    if holds:
        p["holding"] = holds

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


def main():
    cache = load_tickers()
    tickers = cache["tickers"]
    profiles = load_json(PROFILES_JSON, {}) or {}
    existing = profiles.get("companies", {})

    print(f"Fetching trailing P/E for all instruments ...")
    try:
        pe_map = fetch_trailing_pe()
        print(f"  got P/E for {len(pe_map)} instruments")
    except Exception as e:
        print(f"  P/E fetch failed: {e}")
        pe_map = profiles.get("pe", {})

    companies = dict(existing)
    todo = [t for t in tickers if "--refresh" in sys.argv or t not in companies
            or "name" not in companies.get(t, {})]
    print(f"Fetching {len(todo)} company profiles ...")
    for i, (ticker) in enumerate(sorted(todo), 1):
        url = tickers[ticker]
        try:
            html = fetch(url)
            companies[ticker] = parse_profile(html)
            print(f"[{i}/{len(todo)}] {ticker}: {companies[ticker].get('sector')} "
                  f"cat={companies[ticker].get('category')}")
        except Exception as e:
            print(f"[{i}/{len(todo)}] {ticker}: FAILED ({e})")
        if i % 20 == 0:  # checkpoint so a crash doesn't lose progress
            save_json(PROFILES_JSON, {"companies": companies, "pe": pe_map,
                                      "updated_at": time.strftime("%Y-%m-%d %H:%M:%S")})
        time.sleep(0.6 + random.random() * 0.5)

    save_json(PROFILES_JSON, {"companies": companies, "pe": pe_map,
                              "updated_at": time.strftime("%Y-%m-%d %H:%M:%S")})
    print(f"\nDone. {len(companies)} profiles saved to {PROFILES_JSON}")


if __name__ == "__main__":
    main()
