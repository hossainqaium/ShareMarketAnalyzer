#!/usr/bin/env python3
"""Walk-forward backtest of the price-forecast models against real history.

forecast.py's project() (the deterministic drift+seasonal curve shown in the UI
as "AI Pred.") is already graded live: every "Update Data" snapshots its 1w/1m
prediction into data/rec_history.json, and analysis.py's snapshot_and_grade()
scores those snapshots once enough calendar days pass. That's honest, but slow
to accumulate — weeks of real time to build up a few hundred graded samples.

This script gets the same kind of honest answer in seconds instead of weeks by
replaying history: at many points across the last ~2 years, per share, it
hides everything after that point, asks each candidate model to forecast
forward, then compares the forecast to the REAL price that already happened
on that future date (which sat untouched in dse_2y_history.csv the whole
time). No future data ever reaches a model at prediction time — the only
"cheating" a walk-forward backtest can't rule out is that market regime
persists (2 calm years won't reveal how a model behaves in a crash), which is
why this is a sanity check, not proof of future performance.

Three models are compared, all deterministic and stdlib-only (no ML, no
external packages, consistent with the rest of this project):

  naive  - random walk: tomorrow's price = today's price (flat line). The
           mandatory baseline; a model that can't beat this isn't adding
           anything.
  drift  - random walk WITH drift: extrapolates the average daily log-return
           over the trailing lookback window in a straight line. The classic
           textbook time-series baseline, one step up from naive.
  app_model - forecast.py's project(): the drift+seasonal curve actually
           shown in the app as "AI Pred." Reused directly (not
           reimplemented) so the backtest grades the exact code that ships.

Run standalone: `python3 backtest.py` (prints a summary table and writes
data/backtest_results.json). Also callable as run_backtest(progress=...) —
server.py wires that into a "Run backtest" button.
"""

import math
import time

from dse_common import BACKTEST_JSON, load_history, save_json
from forecast import (clean_closes, drift_forecast, naive_forecast,
                      project as app_model_forecast)

HORIZONS = {"1w": 5, "1m": 21}       # trading days ahead, same convention as analysis.py's RC_HORIZONS
MIN_LOOKBACK = 250                    # trading days of history required before the first origin (~1 year)
STEP_DAYS = 10                        # walk the origin forward this many trading days each time
MAX_HORIZON = max(HORIZONS.values())


MODELS = {
    "naive": lambda closes, h: naive_forecast(closes, h),
    "drift": lambda closes, h: drift_forecast(closes, h),
    "app_model": lambda closes, h: app_model_forecast(closes, horizon=h),
}


def walk_forward(history, progress=lambda msg, pct: None):
    """Returns ({model: {horizon_label: [(predicted_pct, actual_pct), ...]}}, tickers_used)."""
    pairs = {name: {h: [] for h in HORIZONS} for name in MODELS}
    tickers = sorted(history)
    used = 0
    for i, ticker in enumerate(tickers):
        closes = clean_closes(history[ticker])
        n = len(closes)
        if n < MIN_LOOKBACK + MAX_HORIZON + 1:
            continue
        used += 1
        origin = MIN_LOOKBACK - 1  # closes[:origin+1] is what a model may see
        while origin + MAX_HORIZON < n:
            known = closes[:origin + 1]
            base = known[-1]
            if base > 0:
                for name, fn in MODELS.items():
                    fc = fn(known, MAX_HORIZON)
                    if not fc:
                        continue
                    for h_label, nd in HORIZONS.items():
                        actual_price = closes[origin + nd]
                        if actual_price <= 0:
                            continue
                        predicted_pct = (fc[nd - 1] / base - 1) * 100
                        actual_pct = (actual_price / base - 1) * 100
                        pairs[name][h_label].append((predicted_pct, actual_pct))
            origin += STEP_DAYS
        if used % 50 == 0:
            progress(f"Backtested {used}/{len(tickers)} shares...", 10 + int(80 * i / len(tickers)))
    return pairs, used


def agg(pairs):
    n = len(pairs)
    if not n:
        return None
    mae = sum(abs(a - p) for p, a in pairs) / n
    rmse = math.sqrt(sum((a - p) ** 2 for p, a in pairs) / n)
    same_dir = sum(1 for p, a in pairs if (p > 0) == (a > 0))
    return {
        "n": n,
        "mae_pct": round(mae, 2),
        "rmse_pct": round(rmse, 2),
        "direction_accuracy": round(100 * same_dir / n),
        "avg_predicted_pct": round(sum(p for p, _ in pairs) / n, 2),
        "avg_actual_pct": round(sum(a for _, a in pairs) / n, 2),
    }


def run_backtest(progress=lambda msg, pct: None):
    progress("Loading 2-year history for walk-forward backtest...", 0)
    history = load_history()
    progress(f"Walk-forward testing {len(history)} shares (naive / drift / app model)...", 5)
    pairs, used = walk_forward(history, progress=progress)

    models_out = {name: {h: agg(v) for h, v in hs.items()} for name, hs in pairs.items()}
    always_up = {}
    for h in HORIZONS:
        ref = pairs["naive"][h]  # same origins/actuals for every model, any one will do
        always_up[h] = round(100 * sum(1 for _, a in ref if a > 0) / len(ref)) if ref else None

    total_samples = sum(len(v) for v in pairs["naive"].values())
    out = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "method": (
            f"Walk-forward: every {STEP_DAYS} trading days per share, each model sees only the price "
            f"history strictly before that point and forecasts {HORIZONS['1w']}/{HORIZONS['1m']} sessions "
            "ahead; the forecast is compared to the real price that already happened on that date. No "
            "future data ever reaches a model at prediction time."
        ),
        "universe": {"tickers_used": used, "tickers_total": len(history),
                     "step_days": STEP_DAYS, "min_lookback_days": MIN_LOOKBACK,
                     "total_samples": total_samples},
        "horizons_days": HORIZONS,
        "always_up_baseline": always_up,
        "models": models_out,
    }
    save_json(BACKTEST_JSON, out)
    progress(f"Backtest complete: {used} shares, {total_samples} samples per model.", 100)
    return out


if __name__ == "__main__":
    result = run_backtest(progress=lambda m, p: print(m))
    print()
    print(f"{'model':<10} {'horizon':<8} {'n':>6} {'MAE%':>7} {'RMSE%':>7} {'dir.acc%':>9} {'pred avg%':>10} {'actual avg%':>12}")
    for name, hs in result["models"].items():
        for h, a in hs.items():
            if not a:
                print(f"{name:<10} {h:<8} (no samples)")
                continue
            print(f"{name:<10} {h:<8} {a['n']:>6} {a['mae_pct']:>7.2f} {a['rmse_pct']:>7.2f} "
                  f"{a['direction_accuracy']:>9} {a['avg_predicted_pct']:>10.2f} {a['avg_actual_pct']:>12.2f}")
    print(f"\nalways-up baseline: {result['always_up_baseline']}")
