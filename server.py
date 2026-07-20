#!/usr/bin/env python3
"""Local web app for DSE market analysis. Stdlib only — no dependencies.

Run:  python3 server.py  [port]     (default 8765)
Then open http://localhost:8765
"""

import json
import os
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import analysis as analysis_mod
import sync as sync_mod
from dse_common import (AGM_JSON, ANALYSIS_JSON, PORTFOLIO_JSON,
                        PROFILES_JSON, RIGHTS_JSON, ROOT, load_history, load_json,
                        load_potential, save_json)

STATIC_DIR = os.path.join(ROOT, "static")

_state = {
    "history": None,          # {ticker: [row dicts sorted by date]}
    "analysis": None,
    "profiles": None,
    "potential": None,        # {ticker: [(date, close), ...]} projected future

    "update": {"running": False, "message": "", "pct": 0, "done": False, "error": None},
    "lock": threading.Lock(),
}


def get_history(reload=False):
    with _state["lock"]:
        if _state["history"] is None or reload:
            _state["history"] = load_history()
        return _state["history"]


def get_analysis(reload=False):
    with _state["lock"]:
        if _state["analysis"] is None or reload:
            _state["analysis"] = load_json(ANALYSIS_JSON, {"tickers": {}, "overview": {}})
        return _state["analysis"]


def get_profiles(reload=False):
    with _state["lock"]:
        if _state["profiles"] is None or reload:
            _state["profiles"] = load_json(PROFILES_JSON, {}) or {}
        return _state["profiles"]


def get_potential(reload=False):
    with _state["lock"]:
        if _state["potential"] is None or reload:
            _state["potential"] = load_potential()
        return _state["potential"]


def series_for(ticker, max_points=None, ohlc=False):
    """dates/closes/volumes for a ticker, optionally with open/high/low too
    (needed for candlestick/OHLC-bar charts) — High/Low fall back to the
    close and Open falls back to 0 (treated as "missing") when unavailable,
    same convention as analysis.py's build_series()."""
    rows = get_history().get(ticker, [])
    dates, closes, vols = [], [], []
    opens, highs, lows = [], [], []
    for r in rows:
        try:
            c = float(r["CloseP"])
            if c <= 0:
                c = float(r["LTP"])
            if c <= 0:
                continue
            dates.append(r["Date"])
            closes.append(c)
            vols.append(float(r["Volume"] or 0))
            if ohlc:
                try:
                    o = float(r.get("OpenP") or 0)
                    h = float(r.get("High") or 0)
                    l = float(r.get("Low") or 0)
                except (ValueError, TypeError):
                    o = h = l = 0.0
                opens.append(o if o > 0 else c)
                highs.append(h if h > 0 else c)
                lows.append(l if 0 < l <= (h if h > 0 else c) else c)
        except (ValueError, KeyError):
            continue
    if max_points and len(closes) > max_points:
        step = len(closes) / max_points
        idx = sorted({min(int(i * step), len(closes) - 1) for i in range(max_points)} | {len(closes) - 1})
        dates = [dates[i] for i in idx]
        closes = [closes[i] for i in idx]
        vols = [vols[i] for i in idx]
        if ohlc:
            opens = [opens[i] for i in idx]
            highs = [highs[i] for i in idx]
            lows = [lows[i] for i in idx]
    if ohlc:
        return dates, closes, vols, opens, highs, lows
    return dates, closes, vols


def run_update_job(codes=None):
    st = _state["update"]
    try:
        def progress(msg, pct):
            st["message"] = msg
            if pct is not None:
                st["pct"] = pct
        summary = sync_mod.run_sync(progress=progress, codes=codes)
        # Fetch Data only writes to local files: scrape → CSV/json, then compute
        # analysis.json from the fresh history. It deliberately does NOT touch the
        # in-memory cache the API serves — clicking "Update Data" reloads those
        # files into memory and renders them (see reload_from_disk / /api/reload).
        # analysis_mod.run_analysis() always processes every ticker regardless of
        # `codes` — cross-ticker signals (beta, market breadth, spike/margin
        # scans, Top 20 diversification) need the full universe to stay correct,
        # so a scoped fetch can't skip this step, only the network calls above it.
        st["message"] = "Re-running analysis and saving to disk..."
        analysis_mod.run_analysis()
        st["pct"] = 100
        live = (f" + {summary['live_rows']} live prices ({summary['live_time']})"
                if summary.get("live_rows") else "")
        news = (f", {summary['announcements_added']} new announcements"
                if summary.get("announcements_added") else "")
        scope = f" (scoped: {', '.join(codes)})" if codes else ""
        st["message"] = (f"Fetched & saved to disk{scope}. +{summary['rows_added'] + summary['backfill_rows']} archive rows"
                         f"{live}{news} (prev last date {summary['previous_last_date']}). "
                         f"Click Update Data to render it.")
        st["done"] = True
    except Exception as e:
        st["error"] = str(e)
        st["message"] = f"Fetch failed: {e}"
    finally:
        st["running"] = False


def reload_from_disk():
    """Load the latest local files (written by Fetch Data) into the in-memory
    caches the API serves. This is what "Update Data" triggers — no network."""
    get_history(reload=True)
    get_profiles(reload=True)
    get_potential(reload=True)
    get_analysis(reload=True)


# ================= PORTFOLIO (trade journal + exit engine) =================
TRAIL_ATR_MULT = 2.5       # trailing stop = highest close since buy − 2.5×ATR
BREAKEVEN_TRIGGER = 5.0    # after +5%, the stop never sits below your entry
TIME_STOP_GAIN = 2.0       # "thesis failed" if below +2% past the horizon
DEFAULT_HORIZON_SESSIONS = 25  # fallback when a holding's ticker has no analysis (delisted/missing)


def load_portfolio():
    pf = load_json(PORTFOLIO_JSON, None)
    if not isinstance(pf, dict):
        pf = {}
    pf.setdefault("holdings", [])
    pf.setdefault("closed", [])
    return pf


def closes_since(code, buy_date):
    rows = get_history().get(code) or []
    out = []
    for r in rows:
        if r["Date"] < buy_date:
            continue
        try:
            c = float(r["CloseP"])
            if c <= 0:
                c = float(r["LTP"])
            if c > 0:
                out.append(c)
        except (ValueError, KeyError):
            continue
    return out


def pearson_correlation(dates_a, closes_a, dates_b, closes_b, window=120):
    """Pearson correlation of daily returns between two price series, over
    the last `window` common trading sessions."""
    da, db = dict(zip(dates_a, closes_a)), dict(zip(dates_b, closes_b))
    common = sorted(set(da) & set(db))
    if len(common) < 30:
        return None
    common = common[-(window + 1):]
    xs, ys = [], []
    for i in range(1, len(common)):
        d0, d1 = common[i - 1], common[i]
        if da[d0] > 0 and db[d0] > 0:
            xs.append(da[d1] / da[d0] - 1)
            ys.append(db[d1] / db[d0] - 1)
    if len(xs) < 25:
        return None
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    if vx <= 0 or vy <= 0:
        return None
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return round(cov / (vx ** 0.5 * vy ** 0.5), 2)


def portfolio_diversification(codes):
    """Pairwise daily-return correlation among current holdings — flags
    concentration risk: several 'different' picks that actually move
    together are one bet wearing multiple tickers, not real diversification."""
    if len(codes) < 2:
        return {"pairs": [], "concentration_risk": False}
    series = {}
    for c in set(codes):
        dates, closes, _ = series_for(c)
        if len(closes) >= 30:
            series[c] = (dates, closes)
    pairs = []
    ordered = sorted(series)
    for i in range(len(ordered)):
        for j in range(i + 1, len(ordered)):
            a, b = ordered[i], ordered[j]
            corr = pearson_correlation(*series[a], *series[b])
            if corr is not None:
                pairs.append({"a": a, "b": b, "corr": corr})
    pairs.sort(key=lambda p: -p["corr"])
    return {"pairs": pairs, "concentration_risk": any(p["corr"] >= 0.7 for p in pairs)}


def agm_view():
    """Flatten the AGM/EGM and rights-entitlement PDF notices into per-ticker
    rows enriched with sector/category/price, for the AGM/EGM/Record tab."""
    agm = load_json(AGM_JSON, {}) or {}
    rights = load_json(RIGHTS_JSON, {}) or {}
    ana = get_analysis().get("tickers", {})

    def meta(ticker):
        a = ana.get(ticker) or {}
        return {"sector": a.get("sector"), "category": a.get("category"), "price": a.get("price")}

    agm_rows = [{"ticker": t, **meta(t), **e}
                for t, entries in (agm.get("by_ticker") or {}).items() for e in entries]
    rights_rows = [{"ticker": t, **meta(t), **e}
                   for t, entries in (rights.get("by_ticker") or {}).items() for e in entries]
    return {
        "agm": agm_rows, "agm_fetched_at": agm.get("fetched_at"),
        "agm_total": agm.get("total_rows"), "agm_matched": agm.get("matched_count"),
        "rights": rights_rows, "rights_fetched_at": rights.get("fetched_at"),
        "rights_total": rights.get("total_rows"), "rights_matched": rights.get("matched_count"),
    }


def portfolio_view():
    pf = load_portfolio()
    full = get_analysis()
    ana = full.get("tickers", {})
    mg = full.get("margin", {})
    mg_t = mg.get("tickers", {})
    higher_now = set()
    for w in ("3m", "2y"):
        for e in (mg.get("windows", {}).get(w, {}) or {}).get("higher", []):
            higher_now.add(e["code"])

    holdings, alerts_all = [], []
    invested = value = 0.0
    for h in pf["holdings"]:
        code = h["code"]
        m = ana.get(code) or {}
        cs = closes_since(code, h["buy_date"])
        price = m.get("price") or (cs[-1] if cs else h["buy_price"])
        qty = h["qty"]
        pnl_pct = (price / h["buy_price"] - 1) * 100 if h["buy_price"] else 0.0
        sessions_held = max(0, len(cs) - 1)
        horizon_s = m.get("horizon_days") or DEFAULT_HORIZON_SESSIONS
        flags = set(m.get("flags") or [])

        # exit engine: static stop / ATR trailing stop / break-even, take the highest
        hi_since = max(cs + [h["buy_price"]]) if cs else h["buy_price"]
        cand = []
        if m.get("stop_price"):
            cand.append((m["stop_price"], "static"))
        if m.get("atr14"):
            cand.append((hi_since - TRAIL_ATR_MULT * m["atr14"], "trailing"))
        if pnl_pct >= BREAKEVEN_TRIGGER:
            cand.append((h["buy_price"], "break-even"))
        eff_stop, stop_rule = max(cand) if cand else (None, None)

        alerts = []

        def alert(kind, level, en, bn):
            alerts.append({"kind": kind, "level": level, "en": en, "bn": bn})

        if flags & {"trading-halt", "audit-concern"}:
            alert("hard-risk", "bad",
                  "Hard risk flag (halt/audit) — plan an exit as soon as trading allows",
                  "গুরুতর ঝুঁকি-চিহ্ন (হল্ট/অডিট) — লেনদেন সম্ভব হলেই বেরিয়ে আসার পরিকল্পনা করুন")
        if eff_stop and price <= eff_stop:
            alert("stop-hit", "bad",
                  f"Below your {stop_rule} stop ({eff_stop:.1f}) — exit to cap the loss",
                  f"আপনার {stop_rule} স্টপের ({eff_stop:.1f}) নিচে — ক্ষতি সীমিত করতে বিক্রি করুন")
        if m.get("target_price") and price >= m["target_price"]:
            alert("target-hit", "good",
                  f"Target {m['target_price']:.1f} reached — book profit, at least partially",
                  f"লক্ষ্যমূল্য {m['target_price']:.1f} অর্জিত — অন্তত আংশিক মুনাফা তুলুন")
        fall = mg_t.get(code, {}).get("fall_score")
        if code in higher_now and (fall or 0) >= 50:
            alert("fall-risk", "warn",
                  f"Entered the Higher Margin zone with fall risk {fall:.0f}/100 — profit-taking zone",
                  f"Higher Margin অঞ্চলে ঢুকেছে, পতনের ঝুঁকি {fall:.0f}/100 — মুনাফা তোলার জায়গা")
        if "bearish-divergence" in flags:
            alert("divergence", "warn",
                  "Bearish RSI divergence — the rally is losing internal strength",
                  "বিয়ারিশ RSI ডাইভারজেন্স — ঊর্ধ্বগতির ভেতরের শক্তি কমছে")
        if m.get("candle_pattern") in ("shooting-star", "bearish-engulfing"):
            cp = m["candle_pattern"].replace("-", " ")
            alert("candle", "warn",
                  f"{cp.title()} candle today — a classic reversal warning at these levels",
                  f"আজ {cp} ক্যান্ডেল — এই স্তরে ক্লাসিক পতনের সংকেত")
        if "gap-fade" in flags:
            alert("gap-fade", "warn",
                  "Gapped up today but fully faded back below yesterday's close — a trap for chasers, not a hold signal",
                  "আজ গ্যাপ-আপ হয়েও গতকালের ক্লোজের নিচে ফিরে গেছে — ধরে রাখার সংকেত নয়")
        if "near-key-resistance" in flags:
            alert("key-resistance", "warn",
                  f"At a resistance level rejected {m.get('key_resistance_touches')}× before (at {m.get('key_resistance')}) — consider taking profit here",
                  f"একটি রেজিস্ট্যান্স স্তরে যা আগে {m.get('key_resistance_touches')}বার প্রত্যাখ্যাত হয়েছে — এখানে মুনাফা তোলার কথা ভাবুন")
        if (m.get("macd_hist") or 0) < 0 and (m.get("macd_slope") or 0) < 0:
            alert("momentum", "warn",
                  "MACD negative and falling — momentum has turned against you",
                  "MACD নেগেটিভ ও কমছে — গতি এখন আপনার বিপক্ষে")
        if "spike-fade-risk" in flags:
            alert("spike-fade", "warn",
                  "Spiked today without backing — consider selling into the strength",
                  "আজ সমর্থন ছাড়া স্পাইক করেছে — বাড়তি দামেই বিক্রির কথা ভাবুন")
        if "spike-down-risk" in flags:
            alert("spike-down", "bad",
                  "Dropped hard recently with signs the decline continues — reassess this holding now",
                  "সম্প্রতি ব্যাপক পড়েছে এবং পতন চলতে থাকার লক্ষণ আছে — এই হোল্ডিং এখনই পুনর্মূল্যায়ন করুন")
        if sessions_held > horizon_s and pnl_pct < TIME_STOP_GAIN:
            alert("time-stop", "warn",
                  f"Time stop: {sessions_held} sessions held (plan was ~{horizon_s}) and still flat — the thesis isn't working",
                  f"টাইম স্টপ: {sessions_held} সেশন ধরে রেখেছেন (পরিকল্পনা ছিল ~{horizon_s}), লাভ নেই — ধারণাটি কাজ করছে না")
        dtr = m.get("days_to_record_date")
        if dtr is not None and 0 < dtr <= 5:
            alert("record-date", "info",
                  f"Record date {m.get('upcoming_record_date')} in {dtr}d — holding through it captures the dividend",
                  f"রেকর্ড ডেট {m.get('upcoming_record_date')}, {dtr} দিন বাকি — ধরে রাখলে লভ্যাংশ পাবেন")

        invested += qty * h["buy_price"]
        value += qty * price
        holdings.append({
            **h, "price": round(price, 2), "ycp": m.get("ycp"), "value": round(qty * price, 2),
            "pnl": round(qty * (price - h["buy_price"]), 2),
            "pnl_pct": round(pnl_pct, 2),
            "sessions_held": sessions_held, "horizon_sessions": horizon_s,
            "target_price": m.get("target_price"),
            "eff_stop": round(eff_stop, 2) if eff_stop else None,
            "stop_rule": stop_rule,
            "verdict": m.get("verdict"), "sector": m.get("sector"),
            "beta": m.get("beta"),
            "alerts": alerts,
        })
        for a in alerts:
            if a["level"] in ("bad", "warn"):
                alerts_all.append({**a, "code": code})

    closed = pf["closed"]
    realized = sum(c["qty"] * (c["sell_price"] - c["buy_price"]) for c in closed)
    wins = sum(1 for c in closed if c["sell_price"] > c["buy_price"])

    weighted_beta = None
    betas = [(h["beta"], h["value"]) for h in holdings if h.get("beta") is not None and h["value"]]
    if betas and value:
        weighted_beta = round(sum(b * v for b, v in betas) / sum(v for _, v in betas), 2)

    return {
        "holdings": holdings,
        "closed": sorted(closed, key=lambda c: c.get("sell_date") or "", reverse=True),
        "alerts": alerts_all,
        "diversification": portfolio_diversification([h["code"] for h in pf["holdings"]]),
        "summary": {
            "invested": round(invested, 2), "value": round(value, 2),
            "unrealized": round(value - invested, 2),
            "unrealized_pct": round((value / invested - 1) * 100, 2) if invested else None,
            "realized": round(realized, 2),
            "closed_trades": len(closed),
            "closed_win_rate": round(100 * wins / len(closed)) if closed else None,
            "portfolio_beta": weighted_beta,
        },
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # quiet

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")  # never let the browser serve a stale API response
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, rel):
        path = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not path.startswith(STATIC_DIR) or not os.path.isfile(path):
            self.send_error(404)
            return
        ctype = {"html": "text/html", "js": "application/javascript",
                 "css": "text/css"}.get(path.rsplit(".", 1)[-1], "application/octet-stream")
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(parsed.query))
        route = parsed.path

        if route == "/":
            return self.send_file("index.html")
        if route.startswith("/static/"):
            return self.send_file(route[len("/static/"):])

        if route == "/api/summary":
            return self.send_json(get_analysis())

        if route == "/api/charts":
            page = max(1, int(q.get("page", 1)))
            per = min(200, int(q.get("per", 100)))
            sort = q.get("sort", "alpha")
            search = (q.get("q") or "").strip().upper()
            codes_param = q.get("codes")
            ana = get_analysis()["tickers"]
            if codes_param:
                # explicit shortlist fetch: bypass paging/search/sort, keep requested order
                requested = [c.strip() for c in codes_param.split(",") if c.strip()]
                codes = [c for c in requested if c in ana]
                chunk = codes
                page, per, total = 1, len(codes) or 1, len(codes)
            else:
                codes = list(ana.keys())
                if search:
                    codes = [c for c in codes if search in c.upper()
                            or search in (ana[c].get("sector") or "").upper()]
                if sort == "short":
                    codes.sort(key=lambda c: -ana[c]["score_short"])
                elif sort == "long":
                    codes.sort(key=lambda c: -ana[c]["score_long"])
                else:
                    codes.sort()
                total = len(codes)
                chunk = codes[(page - 1) * per: page * per]
            n_candles = 60  # compact recent window for the optional candlestick card view
            items = []
            for c in chunk:
                dates, closes, _ = series_for(c, max_points=150)
                full_dates, full_closes, _, full_opens, full_highs, full_lows = series_for(c, ohlc=True)
                items.append({
                    "code": c,
                    "dates": dates,
                    "closes": [round(v, 2) for v in closes],
                    "cdates": full_dates[-n_candles:],
                    "copen": [round(v, 2) for v in full_opens[-n_candles:]],
                    "chigh": [round(v, 2) for v in full_highs[-n_candles:]],
                    "clow": [round(v, 2) for v in full_lows[-n_candles:]],
                    "cclose": [round(v, 2) for v in full_closes[-n_candles:]],
                    "price": ana[c]["price"],
                    "ycp": ana[c].get("ycp"),
                    "r_1y": ana[c].get("r_1y"),
                    "r_2y": ana[c].get("r_2y"),
                    "score_short": ana[c]["score_short"],
                    "score_long": ana[c]["score_long"],
                })
            return self.send_json({"page": page, "per": per, "total": total,
                                   "pages": (total + per - 1) // per, "items": items})

        if route == "/api/potential":
            page = max(1, int(q.get("page", 1)))
            per = min(200, int(q.get("per", 100)))
            sort = q.get("sort", "alpha")
            search = (q.get("q") or "").strip().upper()
            codes_param = q.get("codes")
            ana = get_analysis()["tickers"]
            potential = get_potential()
            if codes_param:
                requested = [c.strip() for c in codes_param.split(",") if c.strip()]
                codes = [c for c in requested if c in ana and c in potential]
                chunk = codes
                page, per, total = 1, len(codes) or 1, len(codes)
            else:
                codes = [c for c in ana if c in potential]
                if search:
                    codes = [c for c in codes if search in c.upper()
                            or search in (ana[c].get("sector") or "").upper()]
                if sort == "short":
                    codes.sort(key=lambda c: -ana[c]["score_short"])
                elif sort == "long":
                    codes.sort(key=lambda c: -ana[c]["score_long"])
                else:
                    codes.sort()
                total = len(codes)
                chunk = codes[(page - 1) * per: page * per]
            items = []
            for c in chunk:
                full_dates, full_closes, _ = series_for(c)
                yr = full_dates[-250:]
                yc = full_closes[-250:]
                if len(yc) > 80:
                    step = len(yc) / 80
                    idx = sorted({min(int(i * step), len(yc) - 1) for i in range(80)} | {len(yc) - 1})
                    yr = [yr[i] for i in idx]
                    yc = [yc[i] for i in idx]
                fut = potential[c]
                fd = [d for d, _ in fut]
                fc = [v for _, v in fut]
                if len(fc) > 80:
                    step = len(fc) / 80
                    idx = sorted({min(int(i * step), len(fc) - 1) for i in range(80)} | {len(fc) - 1})
                    fd = [fd[i] for i in idx]
                    fc = [fc[i] for i in idx]
                proj_6m = (fc[-1] / yc[-1] - 1) * 100 if yc and yc[-1] and fc else None
                items.append({
                    "code": c,
                    "past_dates": yr, "past_closes": [round(v, 2) for v in yc],
                    "fut_dates": fd, "fut_closes": fc,
                    "price": ana[c]["price"],
                    "ycp": ana[c].get("ycp"),
                    "proj_6m": round(proj_6m, 1) if proj_6m is not None else None,
                    "score_short": ana[c]["score_short"],
                    "score_long": ana[c]["score_long"],
                    "r_1w": ana[c].get("r_1w"), "r_1m": ana[c].get("r_1m"), "r_2m": ana[c].get("r_2m"),
                    "pred_1w_price": ana[c].get("pred_1w_price"), "pred_1w_pct": ana[c].get("pred_1w_pct"),
                    "pred_1m_price": ana[c].get("pred_1m_price"), "pred_1m_pct": ana[c].get("pred_1m_pct"),
                })
            return self.send_json({"page": page, "per": per, "total": total,
                                   "pages": (total + per - 1) // per, "items": items})

        if route == "/api/history":
            ticker = q.get("ticker", "")
            ana = get_analysis()["tickers"].get(ticker)
            if not ana:
                return self.send_json({"error": "unknown ticker"}, 404)
            dates, closes, vols, opens, highs, lows = series_for(ticker, ohlc=True)
            sma20 = rolling_sma(closes, 20)
            sma50 = rolling_sma(closes, 50)
            rsi_series = rolling_rsi(closes, 14)
            prof = get_profiles().get("companies", {}).get(ticker, {})
            return self.send_json({"ticker": ticker, "dates": dates, "closes": closes,
                                   "volumes": vols, "opens": opens, "highs": highs, "lows": lows,
                                   "sma20": sma20, "sma50": sma50,
                                   "rsi": rsi_series, "analysis": ana, "profile": prof})

        if route == "/api/update/status":
            return self.send_json(_state["update"])

        if route == "/api/portfolio":
            return self.send_json(portfolio_view())

        if route == "/api/agm":
            return self.send_json(agm_view())

        self.send_error(404)

    def read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(length).decode()) if length else {}
        except (ValueError, json.JSONDecodeError):
            return {}

    def do_POST(self):
        route = urllib.parse.urlparse(self.path).path
        if route == "/api/portfolio/add":
            b = self.read_json_body()
            code = (b.get("code") or "").strip().upper()
            try:
                buy_price = float(b.get("buy_price") or 0)
                qty = int(b.get("qty") or 0)
            except (ValueError, TypeError):
                buy_price, qty = 0, 0
            if code not in get_analysis().get("tickers", {}):
                return self.send_json({"ok": False, "error": f"Unknown ticker: {code}"}, 400)
            if buy_price <= 0 or qty < 1:
                return self.send_json({"ok": False, "error": "Need a positive price and quantity"}, 400)
            import time as _time
            from datetime import date as _date
            pf = load_portfolio()
            pf["holdings"].append({
                "id": str(int(_time.time() * 1000)),
                "code": code, "qty": qty, "buy_price": round(buy_price, 2),
                "buy_date": b.get("buy_date") or _date.today().isoformat(),
            })
            save_json(PORTFOLIO_JSON, pf)
            return self.send_json({"ok": True})

        if route == "/api/portfolio/sell":
            b = self.read_json_body()
            try:
                sell_price = float(b.get("sell_price") or 0)
            except (ValueError, TypeError):
                sell_price = 0
            if sell_price <= 0:
                return self.send_json({"ok": False, "error": "Need a positive sell price"}, 400)
            from datetime import date as _date
            pf = load_portfolio()
            h = next((x for x in pf["holdings"] if x["id"] == b.get("id")), None)
            if not h:
                return self.send_json({"ok": False, "error": "Holding not found"}, 404)
            pf["holdings"].remove(h)
            pf["closed"].append({**h, "sell_price": round(sell_price, 2),
                                 "sell_date": b.get("sell_date") or _date.today().isoformat()})
            save_json(PORTFOLIO_JSON, pf)
            return self.send_json({"ok": True})

        if route == "/api/portfolio/delete":
            # removes a record by id from holdings or the closed-trades ledger
            b = self.read_json_body()
            pf = load_portfolio()
            found = False
            for key in ("holdings", "closed"):
                before = len(pf[key])
                pf[key] = [x for x in pf[key] if x.get("id") != b.get("id")]
                if len(pf[key]) != before:
                    found = True
            if not found:
                return self.send_json({"ok": False, "error": "Record not found"}, 404)
            save_json(PORTFOLIO_JSON, pf)
            return self.send_json({"ok": True})

        if route == "/api/update":
            st = _state["update"]
            if st["running"]:
                return self.send_json({"started": False, "reason": "already running"})
            body = self.read_json_body() or {}
            codes = [c.strip().upper() for c in (body.get("codes") or []) if c and c.strip()]
            codes = codes or None  # empty list means "no scope" == full update
            _state["update"] = {"running": True, "message": "Starting...", "pct": 0,
                                "done": False, "error": None}
            threading.Thread(target=run_update_job, kwargs={"codes": codes}, daemon=True).start()
            return self.send_json({"started": True, "codes": codes})

        if route == "/api/reload":
            reload_from_disk()
            ov = get_analysis().get("overview", {})
            return self.send_json({"ok": True, "market_date": ov.get("market_date"),
                                   "tickers_analyzed": ov.get("tickers_analyzed")})
        self.send_error(404)


def rolling_sma(vals, n):
    out = [None] * len(vals)
    s = 0.0
    for i, v in enumerate(vals):
        s += v
        if i >= n:
            s -= vals[i - n]
        if i >= n - 1:
            out[i] = round(s / n, 2)
    return out


def rolling_rsi(vals, n=14):
    out = [None] * len(vals)
    if len(vals) < n + 1:
        return out
    avg_g = avg_l = 0.0
    for i in range(1, len(vals)):
        d = vals[i] - vals[i - 1]
        g, l = max(d, 0), max(-d, 0)
        if i <= n:
            avg_g += g / n
            avg_l += l / n
            if i == n:
                out[i] = round(100 - 100 / (1 + avg_g / avg_l), 1) if avg_l else 100.0
        else:
            avg_g = (avg_g * (n - 1) + g) / n
            avg_l = (avg_l * (n - 1) + l) / n
            out[i] = round(100 - 100 / (1 + avg_g / avg_l), 1) if avg_l else 100.0
    return out


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    get_history()
    get_analysis()
    get_profiles()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"DSE Analyzer running at http://localhost:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
