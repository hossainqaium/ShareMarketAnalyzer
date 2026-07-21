#!/usr/bin/env python3
"""Potential-future price projection for every DSE share.

Writes potential_dse_6m_history.csv: one projected daily close per share per
future trading day (~125 sessions ≈ 6 months ahead), regenerated on every
"Update Data" so projections always start from the latest real price and the
freshest 2 years of history.

The projection is DETERMINISTIC — same history in, same curve out — and built
from three transparent components, no AI and no randomness:

1. Drift: blended momentum of the last 60/120/250 sessions (weights .5/.3/.2),
   capped at ±0.15%/day, and exponentially damped (half-life ~87 sessions) —
   trends persist but fade; nothing compounds to absurdity.
2. Seasonal shape: the last year's prices are detrended (log-linear fit) and
   the smoothed residual pattern is replayed at HALF amplitude. This is what
   makes the future line visually comparable to the previous year, which is
   the point of the side-by-side chart.
3. Continuity anchor: the curve starts exactly at the last real close.

This is a statistical *shape*, not a promise — the UI labels it as potential.
"""

import csv
import math
import time
from datetime import date, timedelta

from dse_common import POTENTIAL_CSV, load_history, load_potential

HORIZON = 125          # future trading sessions to project (~6 months)
DRIFT_CAP = 0.0015     # max |daily drift| (≈ ±45%/yr before damping)
DAMP = 125.0           # drift e-folding, in sessions
SEASON_SCALE = 0.5     # replay last year's detrended wiggle at half strength


def future_trading_days(start, n):
    """n DSE trading days (Sun–Thu; Fri=4/Sat=5 closed) strictly after start."""
    out, cur = [], start
    while len(out) < n:
        cur += timedelta(days=1)
        if cur.weekday() not in (4, 5):
            out.append(cur.isoformat())
    return out


def clean_closes(rows):
    closes = []
    for r in rows:
        try:
            c = float(r["CloseP"])
            if c <= 0:
                c = float(r["LTP"])
            if c > 0:
                closes.append(c)
        except (ValueError, KeyError):
            continue
    return closes


def naive_forecast(closes, horizon):
    """Random walk: every future day predicted flat at the last known close.
    The mandatory baseline — see backtest.py — and also shown next to AI
    Pred. in the Suggestions table so the app model can be sanity-checked
    at a glance, not just in the graded Report card."""
    return [closes[-1]] * horizon


def drift_forecast(closes, horizon, lookback=250):
    """Random walk with drift: extrapolate the trailing average daily
    log-return in a straight line. The classic textbook time-series
    baseline, one step up from naive_forecast."""
    n = len(closes)
    lb = min(lookback, n - 1)
    if lb < 20 or closes[-1] <= 0 or closes[-1 - lb] <= 0:
        return None
    daily = math.log(closes[-1] / closes[-1 - lb]) / lb
    last = closes[-1]
    return [last * math.exp(daily * t) for t in range(1, horizon + 1)]


def project(closes, horizon=HORIZON):
    """Deterministic future closes from a share's history (see module doc)."""
    n = len(closes)
    if n < 30 or closes[-1] <= 0:
        return None
    last = closes[-1]

    def daily_logret(days):
        if n <= days or closes[-1 - days] <= 0:
            return None
        return math.log(closes[-1] / closes[-1 - days]) / days

    parts = [(daily_logret(60), 0.5), (daily_logret(120), 0.3), (daily_logret(250), 0.2)]
    num = sum(d * w for d, w in parts if d is not None)
    den = sum(w for d, w in parts if d is not None)
    drift = max(-DRIFT_CAP, min(DRIFT_CAP, num / den if den else 0.0))

    # last year's detrended, smoothed shape
    m = min(250, n)
    logs = [math.log(c) for c in closes[-m:]]
    xbar = (m - 1) / 2
    ybar = sum(logs) / m
    sxx = sum((i - xbar) ** 2 for i in range(m))
    slope = (sum((i - xbar) * (logs[i] - ybar) for i in range(m)) / sxx) if sxx else 0.0
    resid = [logs[i] - (ybar + slope * (i - xbar)) for i in range(m)]
    smooth = []
    for i in range(m):
        lo, hi = max(0, i - 5), min(m, i + 6)
        smooth.append(sum(resid[lo:hi]) / (hi - lo))

    out = []
    cum = 0.0
    for t in range(1, horizon + 1):
        cum += drift * math.exp(-t / DAMP)
        season = SEASON_SCALE * (smooth[(t - 1) % m] - smooth[0])
        out.append(round(last * math.exp(cum + season), 2))
    return out


def run_forecast(progress=lambda msg, pct: None, codes=None):
    """codes=None regenerates every share's projection (the normal full Fetch
    Data path). A codes list scopes the (re)computation to just those tickers
    — used by the Fetch Shortlisted/Portfolio/Compare buttons — and preserves
    every other ticker's existing projection untouched rather than dropping it."""
    scope = f"{len(codes)} selected shares" if codes else "all shares"
    progress(f"Projecting potential 6-month future for {scope}...", None)
    history = load_history()
    today = date.today()
    dates = future_trading_days(today, HORIZON)

    keep = {}
    if codes:
        # scoped run: start from what's already on disk for every OTHER ticker
        for ticker, rows in load_potential().items():
            if ticker not in codes:
                keep[ticker] = rows
        universe = sorted(c for c in codes if c in history)
    else:
        universe = sorted(history)

    written = 0
    with open(POTENTIAL_CSV, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Ticker", "Date", "CloseP"])
        for ticker, rows in keep.items():
            for d, p in rows:
                w.writerow([ticker, d, p])
        for ticker in universe:
            closes = clean_closes(history[ticker])
            proj = project(closes)
            if not proj:
                continue
            for d, p in zip(dates, proj):
                w.writerow([ticker, d, p])
            written += 1
    summary = {"tickers_projected": written, "horizon_days": HORIZON,
               "generated_at": time.strftime("%Y-%m-%d %H:%M:%S")}
    progress(f"Projected {written} shares, {HORIZON} sessions each.", None)
    return summary


if __name__ == "__main__":
    print(run_forecast(progress=lambda m, p: print(m)))
