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
from dse_common import (ANALYSIS_JSON, POTENTIAL_CSV, PROFILES_JSON, ROOT,
                        load_history, load_json)

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
            import csv as _csv
            data = {}
            if os.path.exists(POTENTIAL_CSV):
                with open(POTENTIAL_CSV) as f:
                    reader = _csv.DictReader(f)
                    for r in reader:
                        try:
                            data.setdefault(r["Ticker"], []).append(
                                (r["Date"], float(r["CloseP"])))
                        except (ValueError, KeyError):
                            continue
            _state["potential"] = data
        return _state["potential"]


def series_for(ticker, max_points=None):
    rows = get_history().get(ticker, [])
    dates, closes, vols = [], [], []
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
        except (ValueError, KeyError):
            continue
    if max_points and len(closes) > max_points:
        step = len(closes) / max_points
        idx = sorted({min(int(i * step), len(closes) - 1) for i in range(max_points)} | {len(closes) - 1})
        dates = [dates[i] for i in idx]
        closes = [closes[i] for i in idx]
        vols = [vols[i] for i in idx]
    return dates, closes, vols


def run_update_job():
    st = _state["update"]
    try:
        def progress(msg, pct):
            st["message"] = msg
            if pct is not None:
                st["pct"] = pct
        summary = sync_mod.run_sync(progress=progress)
        st["message"] = "Reloading data & re-running analysis..."
        get_history(reload=True)
        get_profiles(reload=True)
        get_potential(reload=True)
        analysis_mod.run_analysis()
        get_analysis(reload=True)
        st["pct"] = 100
        live = (f" + {summary['live_rows']} live prices ({summary['live_time']})"
                if summary.get("live_rows") else "")
        news = (f", {summary['announcements_added']} new announcements"
                if summary.get("announcements_added") else "")
        st["message"] = (f"Done. +{summary['rows_added'] + summary['backfill_rows']} archive rows"
                         f"{live}{news} (prev last date {summary['previous_last_date']}).")
        st["done"] = True
    except Exception as e:
        st["error"] = str(e)
        st["message"] = f"Update failed: {e}"
    finally:
        st["running"] = False


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # quiet

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
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
            items = []
            for c in chunk:
                dates, closes, _ = series_for(c, max_points=150)
                items.append({
                    "code": c,
                    "dates": dates,
                    "closes": [round(v, 2) for v in closes],
                    "price": ana[c]["price"],
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
                    "proj_6m": round(proj_6m, 1) if proj_6m is not None else None,
                    "score_short": ana[c]["score_short"],
                    "score_long": ana[c]["score_long"],
                })
            return self.send_json({"page": page, "per": per, "total": total,
                                   "pages": (total + per - 1) // per, "items": items})

        if route == "/api/history":
            ticker = q.get("ticker", "")
            ana = get_analysis()["tickers"].get(ticker)
            if not ana:
                return self.send_json({"error": "unknown ticker"}, 404)
            dates, closes, vols = series_for(ticker)
            sma20 = rolling_sma(closes, 20)
            sma50 = rolling_sma(closes, 50)
            rsi_series = rolling_rsi(closes, 14)
            prof = get_profiles().get("companies", {}).get(ticker, {})
            return self.send_json({"ticker": ticker, "dates": dates, "closes": closes,
                                   "volumes": vols, "sma20": sma20, "sma50": sma50,
                                   "rsi": rsi_series, "analysis": ana, "profile": prof})

        if route == "/api/update/status":
            return self.send_json(_state["update"])

        self.send_error(404)

    def do_POST(self):
        route = urllib.parse.urlparse(self.path).path
        if route == "/api/update":
            st = _state["update"]
            if st["running"]:
                return self.send_json({"started": False, "reason": "already running"})
            _state["update"] = {"running": True, "message": "Starting...", "pct": 0,
                                "done": False, "error": None}
            threading.Thread(target=run_update_job, daemon=True).start()
            return self.send_json({"started": True})
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
