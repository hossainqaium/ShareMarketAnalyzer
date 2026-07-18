#!/usr/bin/env python3
"""Shared helpers for DSE scraping: HTTP fetch, HTML table parsing, ticker cache."""

import json
import os
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://www.dsebd.org"
ALPHA_URL = f"{BASE}/latest_share_price_alpha.php"
ARCHIVE_URL = f"{BASE}/day_end_archive.php"
COMPANY_URL = f"{BASE}/displayCompany.php"
PE_URL = f"{BASE}/latest_PE.php"
HOME_URL = f"{BASE}/"
MARKET_STATS_URL = f"{BASE}/market-statistics.php"
NEWS_URL = f"{BASE}/old_news.php"
AGM_PDF_URL = f"{BASE}/Company_AGM_EGM.pdf"
RIGHTS_PDF_URL = f"{BASE}/Company_RecordDate_RightsEntitlement.pdf"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")
HISTORY_CSV = os.path.join(ROOT, "dse_2y_history.csv")
POTENTIAL_CSV = os.path.join(ROOT, "potential_dse_6m_history.csv")
TICKERS_JSON = os.path.join(DATA_DIR, "tickers.json")
SYNC_STATE_JSON = os.path.join(DATA_DIR, "sync_state.json")
MARKET_HISTORY_JSON = os.path.join(DATA_DIR, "market_history.json")
ANNOUNCEMENTS_JSON = os.path.join(DATA_DIR, "announcements.json")
AGM_JSON = os.path.join(DATA_DIR, "agm_notices.json")
RIGHTS_JSON = os.path.join(DATA_DIR, "rights_entitlement.json")
PROFILES_JSON = os.path.join(DATA_DIR, "profiles.json")
ANALYSIS_JSON = os.path.join(DATA_DIR, "analysis.json")
PORTFOLIO_JSON = os.path.join(DATA_DIR, "portfolio.json")
REC_HISTORY_JSON = os.path.join(DATA_DIR, "rec_history.json")
FUNDAMENTALS_HISTORY_JSON = os.path.join(DATA_DIR, "fundamentals_history.json")

CSV_HEADER = ["Ticker", "Date", "LTP", "High", "Low", "OpenP", "CloseP", "YCP",
              "Trades", "ValueMn", "Volume"]

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

ROW_RE = re.compile(r"<tr>(.*?)</tr>", re.DOTALL)
CELL_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.DOTALL)
TAG_RE = re.compile(r"<[^>]+>")


def fetch(url, retries=3, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as resp:
                return resp.read().decode("utf-8", errors="ignore")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_err = e
            time.sleep(2 * attempt)
    raise last_err


def clean_cell(html):
    text = TAG_RE.sub("", html).replace("&nbsp;", " ")
    return text.strip().replace(",", "")


def parse_archive_table(html):
    """Parse rows out of a day_end_archive.php response.

    Returns list of [date, code, ltp, high, low, openp, closep, ycp, trade, value_mn, volume].
    """
    header_idx = html.find("shares-table")
    if header_idx == -1:
        return []
    idx = html.find("<tbody>", header_idx)
    end = html.find("</tbody>", idx)
    if idx == -1 or end == -1:
        return []
    rows = []
    for row_html in ROW_RE.findall(html[idx:end]):
        cells = [clean_cell(c) for c in CELL_RE.findall(row_html)]
        if len(cells) >= 12:
            # #, DATE, TRADING CODE, LTP, HIGH, LOW, OPENP, CLOSEP, YCP, TRADE, VALUE(mn), VOLUME
            rows.append(cells[1:12])
    return rows


def fetch_archive(start_date, end_date, inst="All Instrument"):
    params = {"startDate": start_date, "endDate": end_date,
              "inst": inst, "archive": "data"}
    url = f"{ARCHIVE_URL}?{urllib.parse.urlencode(params)}"
    return parse_archive_table(fetch(url))


def parse_live_page(html):
    """Parse latest_share_price_alpha.php: intraday prices as of right now.

    Returns (page_date 'YYYY-MM-DD' or None, page_time str,
             rows [[code, ltp, high, low, closep, ycp, trade, value_mn, volume], ...]).
    The page updates during the trading session, so this is the only source of
    today's prices before the day-end archive is posted after close."""
    import datetime
    m = re.search(r"On(?:&nbsp;|\s)*([A-Z][a-z]{2} \d{1,2}, \d{4})\s*(at [^<]*)?", html)
    page_date, page_time = None, ""
    if m:
        try:
            page_date = datetime.datetime.strptime(m.group(1), "%b %d, %Y").date().isoformat()
            page_time = (m.group(2) or "").strip()
        except ValueError:
            pass
    header_idx = html.find("shares-table")
    if header_idx == -1:
        return page_date, page_time, []
    idx = html.find("<tbody>", header_idx)
    end = html.find("</tbody>", idx)
    rows = []
    if idx != -1 and end != -1:
        for row_html in ROW_RE.findall(html[idx:end]):
            cells = [clean_cell(c) for c in CELL_RE.findall(row_html)]
            if len(cells) >= 11:
                # #, CODE, LTP, HIGH, LOW, CLOSEP, YCP, CHANGE, TRADE, VALUE(mn), VOLUME
                code = cells[1]
                rows.append([code] + cells[2:7] + cells[8:11])
    return page_date, page_time, rows


def _num(s):
    if s is None:
        return None
    s = s.replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def parse_home_snapshot(html):
    """Parse the DSE homepage 'Market Update' widget: DSEX/DSES/DS30/DSMEX
    index levels + daily change, and headline turnover + advance/decline.

    Returns a dict or {} if the widget isn't found (layout changed)."""
    text = TAG_RE.sub("|", html.replace("&nbsp;", " "))
    text = re.sub(r"[|\s]*\|[|\s]*", "|", text)

    out = {}
    m = re.search(r"Last update on ([A-Za-z]+ \d{1,2}, \d{4} at [\d:apAPM ]+)", text)
    if m:
        out["as_of_text"] = m.group(1).strip()

    # index names are split across inline tags: "DSE|X|Index", "D|SME|X|Index"
    idx_pat = re.compile(
        r"(DSEX|DSES|DS30|DSMEX|DSE\|X|DSE\|S|D\|SME\|X)[\|\s]*Index\|([\d,]+\.\d+)\|(-?[\d,]+\.\d+)\|(-?[\d,]+\.\d+)%")
    indices = {}
    name_map = {"DSE|X": "DSEX", "DSE|S": "DSES", "D|SME|X": "DSMEX"}
    for name, level, chg, chg_pct in idx_pat.findall(text):
        name = name_map.get(name, name)
        indices[name] = {"level": _num(level), "change": _num(chg), "change_pct": _num(chg_pct)}
    out["indices"] = indices

    m = re.search(r"Total Trade\|Total Volume\|Total Value in Taka \(mn\)\|"
                 r"(\d[\d,]*)\|(\d[\d,]*)\|([\d,]+\.\d+)", text)
    if m:
        out["total_trades"] = _num(m.group(1))
        out["total_volume"] = _num(m.group(2))
        out["total_value_mn"] = _num(m.group(3))

    m = re.search(r"Issues Advanced\|Issues declined\|Issues Unchanged\|"
                 r"(\d+)\|(\d+)\|(\d+)", text)
    if m:
        out["advanced"] = int(m.group(1))
        out["declined"] = int(m.group(2))
        out["unchanged"] = int(m.group(3))
    return out


def parse_market_statistics(html):
    """Parse market-statistics.php's preformatted daily report: per-category
    breadth (All/A/B/N/Z/MF) and market capitalisation breakdown."""
    text = TAG_RE.sub("\n", html)
    out = {"categories": {}, "market_cap": {}}

    for cat in ("All", "A", "B", "N", "Z", "MUTUAL FUND (MF)"):
        m = re.search(re.escape(cat) + r" Category" if cat != "MUTUAL FUND (MF)" else re.escape(cat),
                      text)
        if not m:
            continue
        seg = text[m.end(): m.end() + 400]
        adv = re.search(r"ISSUES ADVANCED\s*:\s*(\d+)", seg)
        dec = re.search(r"ISSUES DECLINED\s*:\s*(\d+)", seg)
        unch = re.search(r"ISSUES UNCHANGED\s*:\s*(\d+)", seg)
        tot = re.search(r"TOTAL ISSUES TRADED\s*:\s*(\d+)", seg)
        if adv and dec and unch and tot:
            key = "MF" if cat.startswith("MUTUAL") else cat
            out["categories"][key] = {
                "advanced": int(adv.group(1)), "declined": int(dec.group(1)),
                "unchanged": int(unch.group(1)), "total": int(tot.group(1)),
            }

    m = re.search(r"1\.\s*EQUITY\s*:\s*([\d,]+\.\d+)", text)
    if m:
        out["market_cap"]["equity_taka"] = _num(m.group(1))
    m = re.search(r"2\.\s*MUTUAL FUND\s*:\s*([\d,]+\.\d+)", text)
    if m:
        out["market_cap"]["mutual_fund_taka"] = _num(m.group(1))
    m = re.search(r"3\.\s*DEBT SECURITIES\s*:\s*([\d,]+\.\d+)", text)
    if m:
        out["market_cap"]["debt_taka"] = _num(m.group(1))
    m = re.search(r"TOTAL\s*:\s*([\d,]+\.\d+)", text)
    if m:
        out["market_cap"]["total_taka"] = _num(m.group(1))
    return out


_CORP_SUFFIX_RE = re.compile(
    r"\b(limited|ltd|plc|public\s+limited\s+company|company|co|corporation|corp|inc)\b\.?", re.I)


def normalize_company_name(name):
    """Strip corporate suffixes/punctuation so 'Marico Bangladesh Limited' and
    'Marico Bangladesh Ltd.' compare equal. Used to match AGM/EGM PDF company
    names (full legal names) against our ticker profiles (also full names)."""
    if not name:
        return ""
    s = name.lower()
    s = re.sub(r"&amp;|&", " and ", s)
    s = _CORP_SUFFIX_RE.sub(" ", s)
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def build_name_index(companies):
    """{ticker: normalized full name} from profiles.json's companies dict."""
    idx = {}
    for ticker, prof in companies.items():
        norm = normalize_company_name(prof.get("name"))
        if norm:
            idx[ticker] = norm
    return idx


def match_company_name(raw_name, name_index):
    """Best-effort raw AGM/EGM PDF company name -> ticker. Exact normalized
    match first, then containment, then token-overlap (Jaccard) with a
    conservative threshold. Returns None rather than guessing badly."""
    norm = normalize_company_name(raw_name)
    if not norm:
        return None
    for ticker, idx_norm in name_index.items():
        if idx_norm == norm:
            return ticker
    tokens = set(norm.split())
    best_ticker, best_score = None, 0.0
    for ticker, idx_norm in name_index.items():
        idx_tokens = set(idx_norm.split())
        if not idx_tokens:
            continue
        if norm in idx_norm or idx_norm in norm:
            score = 0.95
        else:
            inter = tokens & idx_tokens
            union = tokens | idx_tokens
            score = len(inter) / len(union) if union else 0
        if score > best_score:
            best_ticker, best_score = ticker, score
    return best_ticker if best_score >= 0.6 else None


def fetch_ticker_list():
    """Scrape the alpha listing page for the current set of tickers + URLs."""
    html = fetch(ALPHA_URL)
    names = sorted(set(re.findall(r'displayCompany\.php\?name=([^"]+)', html)))
    return {t: f"{COMPANY_URL}?name={urllib.parse.quote(t)}" for t in names}


def load_json(path, default=None):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return default


def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, path)


def load_tickers(refresh=False):
    """Return the ticker cache {tickers: {code: url}, fetched_at}. Scrape only if
    missing or refresh requested — this is what lets sync skip the listing page."""
    cache = load_json(TICKERS_JSON)
    if cache and not refresh:
        return cache
    tickers = fetch_ticker_list()
    cache = {"tickers": tickers, "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S")}
    save_json(TICKERS_JSON, cache)
    return cache


def load_history():
    """Read the history CSV into {ticker: [(date, row-dict), ...]} sorted by date asc."""
    import csv
    data = {}
    if not os.path.exists(HISTORY_CSV):
        return data
    with open(HISTORY_CSV) as f:
        reader = csv.DictReader(f)
        for r in reader:
            data.setdefault(r["Ticker"], []).append(r)
    for rows in data.values():
        rows.sort(key=lambda r: r["Date"])
    return data
