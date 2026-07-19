#!/usr/bin/env python3
"""Rule-based share analysis engine for DSE data. No AI, no tokens — pure math.

Reads dse_2y_history.csv + data/profiles.json, computes technical indicators
and two composite scores per share:

  score_short (1-2 week horizon):
    momentum 30% | trend alignment 20% | volume surge 20% | RSI zone 15% | MACD 15%
  score_long (1-2 month horizon):
    trend quality 25% | fundamentals 25% | 52w-range position 20%
    | consistency 15% | momentum quality 15%

Writes data/analysis.json consumed by the web UI. Every score comes with
human-readable reasons and risk flags so a pick can be judged, not just trusted.
"""

import math
import time
from datetime import date, datetime, timedelta

from dse_common import (AGM_JSON, ANALYSIS_JSON, ANNOUNCEMENTS_JSON,
                        FUNDAMENTALS_HISTORY_JSON, MARKET_HISTORY_JSON,
                        PROFILES_JSON, REC_HISTORY_JSON, load_history,
                        load_json, load_potential, load_tickers, save_json)

NEWS_LOOKBACK_DAYS = 30
CRITICAL_NEWS_CATEGORIES = {"trading-halt", "audit-concern"}

MIN_LIQUIDITY_MN = 5.0     # avg daily traded value (mn BDT) to qualify for picks
TRADING_DAYS = {"1w": 5, "2w": 10, "1m": 21, "2m": 42, "3m": 63, "6m": 126, "1y": 250}

SPIKE_MIN_PCT = 3.0        # DSE circuit is ±10%, so 3%+ in a day is a jolt (either direction)
SPIKE_LOOKBACK = 2         # sessions scanned: today and yesterday only — a short, actionable list
SPIKE_MIN_VOL_RATIO = 2.0  # that day's volume vs the 30-day average — the "abnormal volume" gate
SPIKE_CLOSE_CONFIRM = 0.5  # close position within that day's own H-L range must back the move's direction


def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def sma(vals, n):
    if len(vals) < n:
        return None
    return sum(vals[-n:]) / n


def rsi(closes, n=14):
    if len(closes) < n + 1:
        return None
    gains, losses = [], []
    for i in range(1, len(closes)):
        d = closes[i] - closes[i - 1]
        gains.append(max(d, 0))
        losses.append(max(-d, 0))
    avg_g = sum(gains[:n]) / n
    avg_l = sum(losses[:n]) / n
    for i in range(n, len(gains)):
        avg_g = (avg_g * (n - 1) + gains[i]) / n
        avg_l = (avg_l * (n - 1) + losses[i]) / n
    if avg_l == 0:
        return 100.0
    return 100 - 100 / (1 + avg_g / avg_l)


def ema_series(vals, n):
    if not vals:
        return []
    k = 2 / (n + 1)
    out = [vals[0]]
    for v in vals[1:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def macd_hist_series(closes):
    """Full MACD(12,26,9) histogram series."""
    if len(closes) < 35:
        return []
    e12 = ema_series(closes, 12)
    e26 = ema_series(closes, 26)
    macd_line = [a - b for a, b in zip(e12, e26)]
    signal = ema_series(macd_line, 9)
    return [m - s for m, s in zip(macd_line, signal)]


def backtest_macd(closes, fwd=21, win_thresh=2.0):
    """How did buying this share on past MACD bullish crosses work out?

    Entry = histogram crossing above zero; outcome = return `fwd` trading days
    later; win = gain above `win_thresh`%. Past performance ≠ future, but it
    shows how well the share historically follows its signals."""
    hist = macd_hist_series(closes)
    trades = []
    for i in range(35, len(hist) - fwd):
        if hist[i] > 0 and hist[i - 1] <= 0 and closes[i] > 0:
            trades.append((closes[i + fwd] / closes[i] - 1) * 100)
    if not trades:
        return None
    wins = sum(1 for r in trades if r > win_thresh)
    return {"n": len(trades), "win_rate": round(100 * wins / len(trades)),
            "avg_return": round(sum(trades) / len(trades), 1)}


def pct_return(closes, days):
    if len(closes) <= days or closes[-1 - days] == 0:
        return None
    return (closes[-1] / closes[-1 - days] - 1) * 100


def stdev(vals):
    if len(vals) < 2:
        return None
    m = sum(vals) / len(vals)
    return math.sqrt(sum((v - m) ** 2 for v in vals) / (len(vals) - 1))


def bollinger_pos(closes):
    """Position of price within the 20-day ±2σ Bollinger band, 0..1."""
    if len(closes) < 20:
        return None
    win = closes[-20:]
    mid = sum(win) / 20
    sd = stdev(win)
    if not sd:
        return 0.5
    lo, hi = mid - 2 * sd, mid + 2 * sd
    return clamp((closes[-1] - lo) / (hi - lo))


def higher_lows(closes, win=20, n=3):
    """True if the lows of the last n windows are strictly rising."""
    if len(closes) < win * n:
        return False
    lows = [min(closes[-(i + 1) * win: len(closes) - i * win]) for i in range(n)]
    lows.reverse()
    return all(lows[i] < lows[i + 1] for i in range(len(lows) - 1))


def up_streak(closes):
    s = 0
    for i in range(len(closes) - 1, 0, -1):
        if closes[i] > closes[i - 1]:
            s += 1
        else:
            break
    return s


def build_series(rows):
    """Extract clean (dates, closes, volumes, values_mn, highs, lows, opens)
    skipping non-traded days. High/Low fall back to the close when missing;
    Open is 0 for a live intraday row (DSE doesn't publish it until day-end —
    candle/gap logic below skips a session with no real open)."""
    dates, closes, vols, vals, highs, lows, opens = [], [], [], [], [], [], []
    for r in rows:
        try:
            close = float(r["CloseP"])
            if close <= 0:
                close = float(r["LTP"])
            if close <= 0:
                continue
            dates.append(r["Date"])
            closes.append(close)
            vols.append(float(r["Volume"] or 0))
            vals.append(float(r["ValueMn"] or 0))
            try:
                h = float(r.get("High") or 0)
                l = float(r.get("Low") or 0)
                o = float(r.get("OpenP") or 0)
            except (ValueError, TypeError):
                h = l = o = 0.0
            highs.append(h if h > 0 else close)
            lows.append(l if 0 < l <= (h if h > 0 else close) else close)
            opens.append(o if o > 0 else 0.0)
        except (ValueError, KeyError):
            continue
    return dates, closes, vols, vals, highs, lows, opens


def atr(highs, lows, closes, n=14):
    """Wilder Average True Range — the real daily trading range including
    gaps, from High/Low data (better risk unit than close-only volatility)."""
    if len(closes) < n + 1:
        return None
    trs = []
    for i in range(1, len(closes)):
        trs.append(max(highs[i] - lows[i],
                       abs(highs[i] - closes[i - 1]),
                       abs(lows[i] - closes[i - 1])))
    a = sum(trs[:n]) / n
    for t in trs[n:]:
        a = (a * (n - 1) + t) / n
    return a


def detect_divergence(closes):
    """RSI divergence over the last ~60 sessions, only if the second extreme
    is fresh (last 10 sessions). Bearish: price higher high but RSI lower
    high from overbought. Bullish: price lower low but RSI higher low from
    oversold. One of the most reliable early turn warnings."""
    n = len(closes)
    if n < 45:
        return None
    win = closes[-60:]
    w = len(win)
    peaks = [i for i in range(3, w - 3) if win[i] == max(win[i - 3:i + 4])]
    troughs = [i for i in range(3, w - 3) if win[i] == min(win[i - 3:i + 4])]

    def rsi_at(i):
        return rsi(closes[:n - w + i + 1][-80:])

    def last_two(idx):
        out = []
        for i in reversed(idx):
            if not out or out[-1] - i >= 5:
                out.append(i)
            if len(out) == 2:
                break
        return (out[1], out[0]) if len(out) == 2 else None

    p = last_two(peaks)
    if p and p[1] >= w - 10 and win[p[1]] > win[p[0]] * 1.01:
        ra, rb = rsi_at(p[0]), rsi_at(p[1])
        if ra is not None and rb is not None and ra > 60 and rb < ra - 3:
            return "bearish"
    t = last_two(troughs)
    if t and t[1] >= w - 10 and win[t[1]] < win[t[0]] * 0.99:
        ra, rb = rsi_at(t[0]), rsi_at(t[1])
        if ra is not None and rb is not None and ra < 40 and rb > ra + 3:
            return "bullish"
    return None


def close_strength(high, low, close):
    """Where today's close landed in today's high-low range: 1.0 = closed at
    the high (buyers won the day), 0.0 = closed at the low (sellers won)."""
    if high <= low:
        return 0.5
    return clamp((close - low) / (high - low))


def detect_candle(opens, highs, lows, closes, near_low, near_high):
    """Classic 1-2 candle reversal pattern on the latest session, only
    meaningful (and only checked) right at a recent extreme: hammer/bullish-
    engulfing near a low, shooting-star/bearish-engulfing near a high."""
    i = len(closes) - 1
    if i < 1 or opens[i] <= 0 or not (near_low or near_high):
        return None
    o, h, l, c = opens[i], highs[i], lows[i], closes[i]
    rng = h - l
    if rng <= 0:
        return None
    body = abs(c - o)
    upper_wick = h - max(o, c)
    lower_wick = min(o, c) - l
    if near_low and body <= 0.35 * rng and lower_wick >= 2 * body and upper_wick <= 0.15 * rng:
        return "hammer"
    if near_high and body <= 0.35 * rng and upper_wick >= 2 * body and lower_wick <= 0.15 * rng:
        return "shooting-star"
    if opens[i - 1] > 0:
        po, pc = opens[i - 1], closes[i - 1]
        if near_low and pc < po and c > o and c >= po and o <= pc:
            return "bullish-engulfing"
        if near_high and pc > po and c < o and c <= po and o >= pc:
            return "bearish-engulfing"
    return None


def detect_gap(openp, ycp, price):
    """Gap % of today's open vs yesterday's close, and whether the move held
    (still on the gap side of yesterday's close) or faded (fully round-tripped
    back through it — a classic trap for chasers). None if too small to call
    a real gap, or the open isn't published yet (live intraday row)."""
    if openp <= 0 or ycp <= 0:
        return None, None
    gap_pct = (openp / ycp - 1) * 100
    if abs(gap_pct) < 1.5:
        return round(gap_pct, 2), None
    if gap_pct > 0:
        status = "follow-through" if price > ycp else "faded"
    else:
        status = "follow-through" if price < ycp else "faded"
    return round(gap_pct, 2), status


def detect_recent_spike(day_change, intraday_change, dates, closes, vols, highs, lows, vol30,
                        lookback=SPIKE_LOOKBACK, thresh=SPIKE_MIN_PCT,
                        vol_thresh=SPIKE_MIN_VOL_RATIO, close_confirm=SPIKE_CLOSE_CONFIRM):
    """Most recent session within the last `lookback` sessions (today and
    yesterday, by default) whose price move was >= thresh% in EITHER
    direction, CONFIRMED by two things — without them a raw % move is just
    noise, not a real signal, and is excluded outright rather than merely
    down-scored:
      - abnormal volume: that day's volume >= vol_thresh x the 30-day
        average — a proxy for genuine buying/selling demand overwhelming
        the other side, since DSE's public data has no order-book depth;
      - a close that backs the direction: for an up-move, closed in the
        upper half of that day's own high-low range (buyers were still in
        control at the bell, not just an intraday wick); for a down-move,
        the lower half.
    Today's check prefers day_change/intraday_change (the live overlay may
    make "now" a truer read than a plain close-to-close diff); older
    sessions use pure close-to-close returns since their day is final."""
    n = len(closes)
    if n < 2 or not vol30:
        return None

    def confirmed(i, chg):
        vr = (vols[i] / vol30) if vol30 else 0
        if vr < vol_thresh:
            return False
        h, l, c = highs[i], lows[i], closes[i]
        cs = (c - l) / (h - l) if h > l else 0.5
        return cs >= close_confirm if chg > 0 else cs <= (1 - close_confirm)

    today_chg = None
    if day_change is not None and abs(day_change) >= thresh:
        today_chg = day_change
    elif intraday_change is not None and abs(intraday_change) >= thresh:
        today_chg = intraday_change
    if today_chg is not None and confirmed(n - 1, today_chg):
        return {"days_ago": 0, "direction": "up" if today_chg > 0 else "down",
                "change_pct": round(today_chg, 2), "date": dates[-1],
                "price_that_day": round(closes[-1], 2)}
    for days_ago in range(1, lookback):
        i = n - 1 - days_ago
        if i < 1 or closes[i - 1] <= 0:
            continue
        chg = (closes[i] / closes[i - 1] - 1) * 100
        if abs(chg) >= thresh and confirmed(i, chg):
            return {"days_ago": days_ago, "direction": "up" if chg > 0 else "down",
                    "change_pct": round(chg, 2), "date": dates[i],
                    "price_that_day": round(closes[i], 2)}
    return None


def support_resistance_levels(highs, lows, lookback=250, tolerance=0.015, window=4):
    """Cluster swing highs/lows (local extrema, ±window sessions) into price
    levels touched 2+ times — real support/resistance from where the market
    has actually reversed before, not just a simple period high/low."""
    n = len(highs)
    if n < window * 2 + 10:
        return None
    lb = min(lookback, n)
    h, l = highs[-lb:], lows[-lb:]
    swings = []
    for i in range(window, lb - window):
        if h[i] == max(h[i - window:i + window + 1]):
            swings.append(h[i])
        if l[i] == min(l[i - window:i + window + 1]):
            swings.append(l[i])
    if not swings:
        return None
    swings.sort()
    clusters, cur = [], [swings[0]]
    for v in swings[1:]:
        if v <= cur[-1] * (1 + tolerance):
            cur.append(v)
        else:
            clusters.append(cur)
            cur = [v]
    clusters.append(cur)
    levels = [{"price": sum(c) / len(c), "touches": len(c)} for c in clusters if len(c) >= 2]
    return levels or None


REGIME_BREAK_LOOKBACKS = [252, 189, 126, 90, 63]   # 1y, 9mo, 6mo, ~4.5mo, 3mo — longest wins
REGIME_BREAK_HOLDOUT = 5                           # sessions held out to test for "the break"


def _linfit(ys):
    """OLS slope/intercept/R² of ys against 0..n-1 — used to fit log-price
    trends without needing numpy."""
    n = len(ys)
    xs = range(n)
    mx, my = (n - 1) / 2, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return 0.0, my, 0.0
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    slope = sxy / sxx
    intercept = my - slope * mx
    fitted = [intercept + slope * x for x in xs]
    ss_res = sum((y - f) ** 2 for y, f in zip(ys, fitted))
    ss_tot = sum((y - my) ** 2 for y in ys) or 1e-9
    r2 = 1 - ss_res / ss_tot
    return slope, intercept, r2


def detect_regime_break(dates, closes, holdout=REGIME_BREAK_HOLDOUT):
    """Has this share been in a long, clean downtrend/uptrend/range and just
    broken it in the last few sessions? Tries the LONGEST lookback (1y down
    to 3m) that still fits a clean regime, fits it on log(price) EXCLUDING
    the most recent `holdout` sessions, then checks whether those held-out
    sessions deviate sharply from what that established regime implied —
    the "something changed after a long time" alert for the Spike tab."""
    n = len(closes)
    for lb in REGIME_BREAK_LOOKBACKS:
        total = lb + holdout
        if n < total + 10 or any(c <= 0 for c in closes[-total:]):
            continue
        window = closes[-total:-holdout]
        recent = closes[-holdout:]
        logs = [math.log(c) for c in window]
        slope, intercept, r2 = _linfit(logs)
        resid_std = math.sqrt(sum((math.log(w) - (intercept + slope * i)) ** 2
                                  for i, w in enumerate(window)) / max(lb - 2, 1))
        band = (max(window) - min(window)) / (sum(window) / lb)
        daily_pct = (math.exp(slope) - 1) * 100
        regime = None
        if r2 >= 0.5 and daily_pct <= -0.08:
            regime = "downtrend"
        elif r2 >= 0.5 and daily_pct >= 0.08:
            regime = "uptrend"
        elif band <= 0.16 and abs(daily_pct) < 0.05:
            regime = "range"
        if not regime:
            continue

        z_scores, breaks = [], []
        for i, c in enumerate(recent):
            predicted = math.exp(intercept + slope * (lb - 1 + i + 1))
            z = (math.log(c) - math.log(predicted)) / resid_std if resid_std > 1e-6 else 0
            z_scores.append(z)
        z_last = z_scores[-1]
        if regime in ("downtrend", "range") and z_last >= 2.2:
            direction = "up"
        elif regime in ("uptrend", "range") and z_last <= -2.2:
            direction = "down"
        else:
            continue
        broke = [i for i, z in enumerate(z_scores)
                 if (z >= 2.2 if direction == "up" else z <= -2.2)]
        # recent[-1] (index holdout-1) IS today, so days-ago from today is
        # (holdout-1) - i, not holdout - i — that off-by-one previously made
        # "today" impossible to reach (min value was 1, not 0) and shifted
        # the whole 0..holdout-1 range up by one session.
        break_days_ago = (holdout - 1) - broke[0]
        lo_band, hi_band = min(window), max(window)
        return {
            "regime": regime, "direction": direction,
            "regime_sessions": lb, "break_days_ago": break_days_ago,
            "regime_start": dates[-total], "regime_end": dates[-holdout - 1],
            "z_score": round(z_last, 2), "range_lo": round(lo_band, 2), "range_hi": round(hi_band, 2),
        }
    return None


def find_range_episodes(dates, closes, lo, hi, lower_thresh=0.25, upper_thresh=0.75,
                        gap_tolerance=3, min_sessions=3):
    """Episodes of sustained bottom-quartile / top-quartile membership within
    a share's own [lo, hi] range — same 25%/75% thresholds the Margin tab
    uses for 'now', applied across the whole history. Up to `gap_tolerance`
    sessions of noise are tolerated before an episode is considered over, so
    a few wobbly days mid-bottom don't fragment one real episode into many.
    Answers 'how many times, and exactly when, has this cycled to its
    extremes' — evidence for how reliably this specific share reverts."""
    if hi <= lo:
        return []
    raw, cur = [], None
    for i, c in enumerate(closes):
        pos = (c - lo) / (hi - lo)
        zone = "bottom" if pos <= lower_thresh else "top" if pos >= upper_thresh else None
        if zone:
            if cur and cur["type"] == zone:
                cur["last_in_idx"] = i
                cur["gap"] = 0
            else:
                if cur:
                    raw.append(cur)
                cur = {"type": zone, "start_idx": i, "last_in_idx": i, "gap": 0}
        elif cur:
            cur["gap"] += 1
            if cur["gap"] > gap_tolerance:
                raw.append(cur)
                cur = None
    if cur:
        raw.append(cur)
    out = []
    for e in raw:
        sessions = e["last_in_idx"] - e["start_idx"] + 1
        if sessions < min_sessions:
            continue
        seg = closes[e["start_idx"]:e["last_in_idx"] + 1]
        extreme = min(seg) if e["type"] == "bottom" else max(seg)
        out.append({"type": e["type"], "start_date": dates[e["start_idx"]],
                    "end_date": dates[e["last_in_idx"]], "sessions": sessions,
                    "extreme_price": round(extreme, 2), "end_idx": e["last_in_idx"]})
    return out


def episode_reversion_stats(episodes, closes, kind, fwd=21, thresh=5.0):
    """Of THIS share's own past bottom/top episodes, how often did price move
    the expected way (up after a bottom, down after a top) within `fwd`
    sessions of the episode ending? Share-specific empirical track record —
    often more convincing than a generic technical rule alone."""
    rets = [(closes[e["end_idx"] + fwd] / closes[e["end_idx"]] - 1) * 100
            for e in episodes if e["type"] == kind and e["end_idx"] + fwd < len(closes)
            and closes[e["end_idx"]] > 0]
    if not rets:
        return None
    hits = sum(1 for r in rets if r > thresh) if kind == "bottom" else sum(1 for r in rets if r < -thresh)
    return {"n": len(rets), "hit_rate": round(100 * hits / len(rets)),
            "avg_return": round(sum(rets) / len(rets), 1)}


def holding_trend(hist, months_back=3):
    """Change in institute+foreign holding % over the last few stored
    snapshots — a simple 'smart money' accumulation/distribution signal.
    None until at least 2 monthly snapshots have accumulated (fetch_profiles
    only shows ~3 months per page; this builds up over repeated runs)."""
    if not hist or len(hist) < 2:
        return None
    latest = hist[-1]
    baseline = hist[max(0, len(hist) - 1 - months_back)]
    li = (latest.get("institute") or 0) + (latest.get("foreign") or 0)
    bi = (baseline.get("institute") or 0) + (baseline.get("foreign") or 0)
    return round(li - bi, 2)


def eps_momentum(eps_interim_hist):
    """(growth_pct, direction) from the latest vs. previous DISTINCT interim
    EPS reading. growth_pct is None when either figure isn't positive (a
    sign flip is reported as a direction label instead — dividing through a
    near-zero or negative base produces a meaningless percentage)."""
    if not eps_interim_hist or len(eps_interim_hist) < 2:
        return None, None
    latest, prev = eps_interim_hist[-1]["values"], eps_interim_hist[-2]["values"]
    if not latest or not prev:
        return None, None
    a, b = latest[0], prev[0]
    if b > 0 and a > 0:
        return round((a / b - 1) * 100, 1), ("up" if a > b else "down" if a < b else "flat")
    if b <= 0 < a:
        return None, "turned-profitable"
    if b > 0 >= a:
        return None, "turned-loss"
    return None, None


def annual_growth_metrics(annual_hist):
    """EPS/NAV/profit CAGR (earliest to latest year with data) + ROE, from
    the audited annual table persisted in fundamentals_history.json
    (fetch_profiles.py's merge_annual_history — up to ~8 years, scraped
    fresh in one page load each run, unlike holding/EPS-interim which only
    build up over repeated scrapes)."""
    out = {"eps_cagr": None, "nav_cagr": None, "profit_cagr": None, "roe": None}
    if not annual_hist:
        return out

    def cagr(key):
        pts = sorted((row["year"], row[key]) for row in annual_hist if row.get(key) is not None)
        if len(pts) < 2:
            return None
        (y0, v0), (y1, v1) = pts[0], pts[-1]
        years = y1 - y0
        if years <= 0 or v0 <= 0 or v1 <= 0:
            return None
        return round(((v1 / v0) ** (1 / years) - 1) * 100, 1)

    out["eps_cagr"] = cagr("eps_co_basic")
    out["nav_cagr"] = cagr("nav")
    out["profit_cagr"] = cagr("profit_mn")

    latest = annual_hist[-1]
    eps_latest, nav_latest = latest.get("eps_co_basic"), latest.get("nav")
    if eps_latest is not None and nav_latest and nav_latest > 0:
        out["roe"] = round(eps_latest / nav_latest * 100, 1)
    return out


def analyze_ticker(ticker, rows, profile, pe_map, today, fund_hist=None):
    dates, closes, vols, vals, highs, lows, opens = build_series(rows)
    if len(closes) < 15:
        return None

    price = closes[-1]
    m = {
        "price": round(price, 2),
        "last_date": dates[-1],
        "data_points": len(closes),
    }
    for label, nd in TRADING_DAYS.items():
        r = pct_return(closes, nd)
        m["r_" + label] = round(r, 2) if r is not None else None
    r_2y = (closes[-1] / closes[0] - 1) * 100 if closes[0] > 0 else None
    m["r_2y"] = round(r_2y, 2) if r_2y is not None else None

    sma20, sma50, sma200 = sma(closes, 20), sma(closes, 50), sma(closes, 200)
    m["sma20"] = round(sma20, 2) if sma20 else None
    m["sma50"] = round(sma50, 2) if sma50 else None
    m["sma200"] = round(sma200, 2) if sma200 else None

    rsi14 = rsi(closes[-80:])
    m["rsi14"] = round(rsi14, 1) if rsi14 is not None else None

    macd_hist = macd_hist_series(closes[-120:])
    hist_now = macd_hist[-1] if macd_hist else None
    hist_prev = macd_hist[-2] if len(macd_hist) > 1 else None
    m["macd_hist"] = round(hist_now, 4) if hist_now is not None else None
    m["macd_slope"] = (round(hist_now - hist_prev, 4)
                       if hist_now is not None and hist_prev is not None else None)

    bt = backtest_macd(closes)
    if bt:
        m["win_rate"] = bt["win_rate"]
        m["signal_trades"] = bt["n"]
        m["signal_avg"] = bt["avg_return"]
    else:
        m["win_rate"] = None
        m["signal_trades"] = 0
        m["signal_avg"] = None

    vol5 = sma(vols, 5)
    vol30 = sma(vols, 30)
    vol_ratio = (vol5 / vol30) if vol5 and vol30 and vol30 > 0 else None
    m["vol_ratio"] = round(vol_ratio, 2) if vol_ratio else None

    liq30 = sma(vals, min(30, len(vals)))
    m["avg_value_mn_30d"] = round(liq30, 2) if liq30 else 0.0

    # today's move vs yesterday's close (YCP) and vs today's open — spike
    # inputs. With the live overlay, "price" is the current intraday price, so
    # this compares NOW against the session open and the previous close.
    last_raw = next((r for r in reversed(rows) if r.get("Date") == dates[-1]), None)
    ycp = openp = 0.0
    if last_raw:
        try:
            ycp = float(last_raw.get("YCP") or 0)
            openp = float(last_raw.get("OpenP") or 0)
        except (ValueError, TypeError):
            pass
    if ycp <= 0 and len(closes) > 1:
        ycp = closes[-2]
    m["ltp"] = m["price"]  # alias: "price" IS the current/latest traded price
    m["ycp"] = round(ycp, 2) if ycp > 0 else None
    m["day_change"] = round((price / ycp - 1) * 100, 2) if ycp > 0 else None
    m["intraday_change"] = round((price / openp - 1) * 100, 2) if openp > 0 else None
    m["vol_today_ratio"] = round(vols[-1] / vol30, 2) if vols and vol30 else None
    m["recent_spike"] = detect_recent_spike(m["day_change"], m["intraday_change"], dates, closes,
                                            vols, highs, lows, vol30)

    yr = closes[-250:]
    hi52, lo52 = max(yr), min(yr)
    pos52 = (price - lo52) / (hi52 - lo52) if hi52 > lo52 else 0.5
    m["hi_52w"], m["lo_52w"], m["pos_52w"] = round(hi52, 2), round(lo52, 2), round(pos52, 2)

    # range position across multiple windows (trading sessions) — the Margin
    # tab's selectable basis; 0 = at the window low, 1 = at the window high
    ranges = {}
    for key, nd in (("1m", 21), ("2m", 42), ("3m", 63),
                    ("6m", 126), ("1y", 250), ("2y", None)):
        win = closes if nd is None else closes[-nd:]
        hi_w, lo_w = max(win), min(win)
        ranges[key] = {"lo": round(lo_w, 2), "hi": round(hi_w, 2),
                       "pos": round((price - lo_w) / (hi_w - lo_w), 3) if hi_w > lo_w else None}
    m["ranges"] = ranges
    m["hi_2y"], m["lo_2y"] = ranges["2y"]["hi"], ranges["2y"]["lo"]
    m["pos_2y"] = ranges["2y"]["pos"]

    # how many times, and when, has this share cycled to the bottom/top of
    # its OWN 2-year range, and how reliably has it reverted each time —
    # feeds margin_rise_score/margin_fall_score below and the Margin tab
    episodes = find_range_episodes(dates, closes, m["lo_2y"], m["hi_2y"])
    bottom_eps = [e for e in episodes if e["type"] == "bottom"]
    top_eps = [e for e in episodes if e["type"] == "top"]
    year_cutoff = dates[-250] if len(dates) >= 250 else dates[0]
    strip = lambda e: {k: v for k, v in e.items() if k != "end_idx"}
    m["margin_history"] = {
        "bottom_count_2y": len(bottom_eps), "top_count_2y": len(top_eps),
        "bottom_count_1y": sum(1 for e in bottom_eps if e["end_date"] >= year_cutoff),
        "top_count_1y": sum(1 for e in top_eps if e["end_date"] >= year_cutoff),
        "bottom_reversion": episode_reversion_stats(episodes, closes, "bottom"),
        "top_correction": episode_reversion_stats(episodes, closes, "top"),
        "recent_bottom_episodes": [strip(e) for e in bottom_eps[-3:]],
        "recent_top_episodes": [strip(e) for e in top_eps[-3:]],
    }

    # support / resistance over the last quarter (~63 trading days)
    qtr = closes[-63:]
    hi3m, lo3m = max(qtr), min(qtr)
    m["dist_support"] = round((price - lo3m) / price * 100, 1) if price else None
    m["dist_resistance"] = round((hi3m - price) / price * 100, 1) if price else None

    # gap analysis: today's open vs yesterday's close, and whether the move
    # held through the close or fully round-tripped (a classic chasers' trap)
    gap_pct, gap_status = detect_gap(openp, ycp, price)
    m["gap_pct"], m["gap_status"] = gap_pct, gap_status

    # intraday close-strength: where today's close sits in today's own
    # high-low range — near the top means buyers won the session
    m["close_strength"] = round(
        close_strength(highs[-1] if highs else price, lows[-1] if lows else price, price), 2)

    # candlestick reversal pattern — only meaningful (and only checked) right
    # at a recent extreme, using the 3-month range position as "recent"
    near_low = ranges["3m"]["pos"] is not None and ranges["3m"]["pos"] <= 0.12
    near_high = ranges["3m"]["pos"] is not None and ranges["3m"]["pos"] >= 0.88
    m["candle_pattern"] = detect_candle(opens, highs, lows, closes, near_low, near_high)

    # clustered support/resistance: real levels the price has reversed at
    # multiple times, not just a simple period high/low
    sr_levels = support_resistance_levels(highs, lows)
    m["key_support"] = m["key_resistance"] = None
    m["key_support_touches"] = m["key_resistance_touches"] = None
    m["dist_key_support"] = m["dist_key_resistance"] = None
    if sr_levels:
        below = [lv for lv in sr_levels if lv["price"] < price]
        above = [lv for lv in sr_levels if lv["price"] > price]
        if below:
            lv = sorted(below, key=lambda x: (-x["touches"], price - x["price"]))[0]
            m["key_support"] = round(lv["price"], 2)
            m["key_support_touches"] = lv["touches"]
            m["dist_key_support"] = round((price - lv["price"]) / price * 100, 1)
        if above:
            lv = sorted(above, key=lambda x: (-x["touches"], x["price"] - price))[0]
            m["key_resistance"] = round(lv["price"], 2)
            m["key_resistance_touches"] = lv["touches"]
            m["dist_key_resistance"] = round((lv["price"] - price) / price * 100, 1)

    bpos = bollinger_pos(closes)
    m["boll_pos"] = round(bpos, 2) if bpos is not None else None
    m["higher_lows"] = higher_lows(closes)
    m["up_streak"] = up_streak(closes[-15:])

    # OBV slope over 20 sessions, normalised by average volume: positive while
    # price is flat = quiet accumulation by bigger investors.
    accum = None
    if len(closes) > 21 and vol30:
        obv, obv_hist = 0.0, [0.0]
        for i in range(1, len(closes)):
            if closes[i] > closes[i - 1]:
                obv += vols[i]
            elif closes[i] < closes[i - 1]:
                obv -= vols[i]
            obv_hist.append(obv)
        accum = (obv_hist[-1] - obv_hist[-21]) / (20 * vol30)
    m["accum_20d"] = round(accum, 2) if accum is not None else None

    # Bollinger bandwidth percentile: how tight today's 20-day band is vs the
    # last ~6 months. A low value = volatility squeeze — coiled for a big move.
    squeeze = None
    if len(closes) >= 60:
        lookback = min(len(closes) - 20, 120)
        bws = []
        for j in range(len(closes) - lookback, len(closes) + 1):
            win = closes[j - 20:j]
            mid = sum(win) / 20
            sd = stdev(win)
            if mid > 0 and sd is not None:
                bws.append(4 * sd / mid)
        if len(bws) >= 30:
            cur = bws[-1]
            squeeze = 100 * sum(1 for b in bws if b <= cur) / len(bws)
    m["squeeze_pctile"] = round(squeeze) if squeeze is not None else None

    rets = [(closes[i] / closes[i - 1] - 1) * 100
            for i in range(max(1, len(closes) - 60), len(closes)) if closes[i - 1] > 0]
    vol_daily = stdev(rets)
    m["volatility"] = round(vol_daily, 2) if vol_daily is not None else None
    pos_days = sum(1 for r in rets if r > 0) / len(rets) if rets else 0.5

    # ATR(14): the true daily trading range including gaps — the risk unit
    # for trailing stops (from the last ~120 sessions)
    a14 = atr(highs[-120:], lows[-120:], closes[-120:])
    m["atr14"] = round(a14, 3) if a14 else None
    m["atr_pct"] = round(a14 / price * 100, 2) if a14 and price else None

    # RSI divergence — early warning that a trend is exhausting
    m["divergence"] = detect_divergence(closes)

    # ---- fundamentals ----
    prof = profile or {}
    eps = prof.get("eps_basic")          # latest REPORTED QUARTER's EPS (sign-only gate)
    eps_annual = prof.get("eps_annual")  # true annual EPS (continuing ops, basic) — for P/E
    pe = pe_map.get(ticker)
    if pe is None and eps_annual and eps_annual > 0:
        pe = price / eps_annual
    elif pe is None and eps and eps > 0:
        pe = price / eps      # last-resort: still better than no P/E at all
    m["eps"] = eps
    m["eps_annual"] = eps_annual
    m["pe"] = round(pe, 2) if pe else None
    m["sector"] = prof.get("sector")
    m["category"] = prof.get("category")
    m["dividend_pct"] = prof.get("last_cash_dividend_pct")
    # cash dividend % is on 10-taka face value → yield = pct/10 taka per share
    div_yield = (m["dividend_pct"] / 10 / price * 100) if m["dividend_pct"] and price else None
    m["dividend_yield"] = round(div_yield, 2) if div_yield else None
    is_equity = (prof.get("instrument_type") or "Equity") == "Equity"

    # NAV per share (from the audited annual filing) → P/NAV, a classic
    # value screen: trading below book value with profitable operations
    nav = prof.get("nav_per_share")
    m["nav_per_share"] = nav
    m["p_nav"] = round(price / nav, 2) if nav and nav > 0 and price else None

    # market capitalisation & size class (outstanding shares × price)
    shares_out = prof.get("outstanding_shares")
    cap_mn = (price * shares_out / 1e6) if shares_out and price else None
    m["market_cap_mn"] = round(cap_mn, 1) if cap_mn else None
    m["cap_class"] = ("Large" if cap_mn and cap_mn >= 20000 else
                      "Mid" if cap_mn and cap_mn >= 3000 else
                      "Small" if cap_mn else None)

    # institutional/foreign holding trend + interim-EPS momentum — both build
    # up from repeated fetch_profiles.py runs (data/fundamentals_history.json)
    fh = fund_hist or {}
    m["holding_trend_3m"] = holding_trend(fh.get("holding") or [])
    m["eps_qoq_growth"], m["eps_trend"] = eps_momentum(fh.get("eps_interim") or [])

    # multi-year EPS/NAV/profit CAGR + ROE — from the audited annual table,
    # not yet factored into any score (see PLAN.md); just made available
    ag = annual_growth_metrics(fh.get("annual") or [])
    m["eps_cagr"] = ag["eps_cagr"]
    m["nav_cagr"] = ag["nav_cagr"]
    m["profit_cagr"] = ag["profit_cagr"]
    m["roe"] = ag["roe"]

    # ================= SHORT-TERM SCORE =================
    sr, s_reasons = {}, []
    r5 = m.get("r_1w") or 0
    r10 = m.get("r_2w") or 0
    mom = 0.6 * r5 + 0.4 * r10
    sr["momentum"] = clamp((mom + 5) / 10)
    if mom > 1.5:
        s_reasons.append(f"Momentum: +{r5:.1f}% in 1w, +{r10:.1f}% in 2w")

    t = 0.0
    if sma20 and price > sma20:
        t += 0.5
    if sma20 and sma50 and sma20 > sma50:
        t += 0.5
    sr["trend"] = t
    if t == 1.0:
        s_reasons.append("Uptrend: price > SMA20 > SMA50")

    sr["volume"] = clamp(((vol_ratio or 1) - 0.8) / 1.2)
    if vol_ratio and vol_ratio > 1.4:
        s_reasons.append(f"Volume surge: {vol_ratio:.1f}x the 30-day average")

    sr["rsi"] = clamp(1 - abs((rsi14 or 50) - 55) / 25) if rsi14 is not None else 0.5
    if rsi14 and 45 <= rsi14 <= 65:
        s_reasons.append(f"RSI {rsi14:.0f} — room to run, not overbought")

    if hist_now is None:
        sr["macd"] = 0.5
    elif hist_now > 0 and hist_now > (hist_prev or 0):
        sr["macd"] = 1.0
        s_reasons.append("MACD bullish and strengthening")
    elif hist_now > 0:
        sr["macd"] = 0.7
    elif hist_now > (hist_prev or 0):
        sr["macd"] = 0.4
    else:
        sr["macd"] = 0.0

    if bpos is not None and bpos < 0.25 and r5 > 0:
        s_reasons.append("Rebounding off the lower Bollinger band")
    if (m.get("dist_resistance") or 0) > 8 and mom > 0:
        s_reasons.append(f"{m['dist_resistance']:.0f}% headroom below 3-month high")

    score_short = 100 * (0.30 * sr["momentum"] + 0.20 * sr["trend"] +
                         0.20 * sr["volume"] + 0.15 * sr["rsi"] + 0.15 * sr["macd"])

    # ================= LONG-TERM SCORE =================
    lr, l_reasons = {}, []
    t = 0.0
    if sma50 and price > sma50:
        t += 0.4
    sma50_prev = sma(closes[:-20], 50) if len(closes) >= 70 else None
    if sma50 and sma50_prev and sma50 > sma50_prev:
        t += 0.3
    if sma200 and price > sma200:
        t += 0.3
    lr["trend"] = t
    if t >= 0.7:
        l_reasons.append("Established uptrend (price above rising SMA50)")

    if prof:
        f = 0.0
        if eps and eps > 0:
            f += 0.3
        if pe and 0 < pe <= 25:
            f += 0.3
            l_reasons.append(f"Reasonable valuation: P/E {pe:.1f}")
        if prof.get("last_cash_dividend_pct"):
            f += 0.2
        if prof.get("category") == "A":
            f += 0.2
        p_nav = m.get("p_nav")
        if p_nav is not None and 0 < p_nav < 1 and eps and eps > 0:
            f += 0.2
            l_reasons.append(f"Trading below book value (P/NAV {p_nav:.2f}) while profitable")
        ht = m.get("holding_trend_3m")
        if ht is not None and ht >= 1.5:
            f += 0.15
            l_reasons.append(f"Institutional/foreign holding rising (+{ht:.1f}pp over recent snapshots)")
        elif ht is not None and ht <= -1.5:
            f -= 0.15
        if m.get("eps_trend") in ("up", "turned-profitable") and (
                m.get("eps_qoq_growth") is None or m["eps_qoq_growth"] > 5):
            f += 0.15
            l_reasons.append("Quarterly EPS improving — earnings momentum, not just price momentum")
        elif m.get("eps_trend") in ("down", "turned-loss"):
            f -= 0.1
        lr["fundamentals"] = clamp(f)
        if eps and eps > 0 and prof.get("last_cash_dividend_pct"):
            l_reasons.append(f"Profitable, pays dividend ({prof['last_cash_dividend_pct']:.0f}%)")
    else:
        lr["fundamentals"] = 0.5

    p = clamp(1 - abs(pos52 - 0.45) / 0.45)
    if (m.get("r_1m") or 0) <= 0:
        p *= 0.7
    lr["position"] = p
    if 0.2 <= pos52 <= 0.65 and (m.get("r_1m") or 0) > 0:
        l_reasons.append(f"Recovering from mid 52-week range ({pos52 * 100:.0f}% of range)")

    lr["consistency"] = (clamp((pos_days - 0.4) / 0.2) * 0.5 +
                         clamp((4 - (vol_daily or 4)) / 3) * 0.5)

    r21 = m.get("r_1m") or 0
    r63 = m.get("r_3m") or 0
    mq = clamp((0.5 * r21 + 0.5 * r63 + 5) / 15)
    if r21 > 25:
        mq *= 0.6  # parabolic — likely to mean-revert
    lr["momentum_q"] = mq
    if 3 < r21 <= 25:
        l_reasons.append(f"Steady gains: +{r21:.1f}% last month")
    if m["higher_lows"]:
        l_reasons.append("Higher-lows pattern — buyers stepping up on every dip")
    if div_yield and div_yield >= 3:
        l_reasons.append(f"Dividend yield {div_yield:.1f}% cushions downside")

    score_long = 100 * (0.25 * lr["trend"] + 0.25 * lr["fundamentals"] +
                        0.20 * lr["position"] + 0.15 * lr["consistency"] +
                        0.15 * lr["momentum_q"])

    # ================= FRESH SIGNALS (latest bar) =================
    signals = []
    sma20_prev1 = sma(closes[:-1], 20)
    sma50_prev1 = sma(closes[:-1], 50)
    if (sma20 and sma50 and sma20_prev1 and sma50_prev1
            and sma20 > sma50 and sma20_prev1 <= sma50_prev1):
        signals.append("golden-cross")
    if hist_now is not None and hist_prev is not None and hist_now > 0 >= hist_prev:
        signals.append("macd-cross")
    if len(closes) > 63 and price > max(closes[-63:-1]):
        signals.append("breakout-3m")
    vol30_full = sma(vols, 30)
    if vols and vol30_full and vols[-1] > 2.5 * vol30_full:
        signals.append("volume-spike")
    prev_rsi = rsi(closes[-81:-1])
    m["rsi_prev"] = round(prev_rsi, 1) if prev_rsi is not None else None
    if rsi14 is not None and prev_rsi is not None and prev_rsi < 30 <= rsi14:
        signals.append("oversold-rebound")
    if m["divergence"] == "bullish":
        signals.append("bullish-divergence")
    if m["candle_pattern"] in ("hammer", "bullish-engulfing"):
        signals.append(m["candle_pattern"])
    if m["gap_status"] == "follow-through" and (m["gap_pct"] or 0) > 0:
        signals.append("gap-up-held")
    m["signals"] = signals
    if signals:
        s_reasons.append("Fresh signal today: " + ", ".join(signals))

    # ================= RISK FLAGS =================
    flags = []
    if (liq30 or 0) < MIN_LIQUIDITY_MN:
        flags.append("illiquid")
    if prof.get("category") in ("Z", "B"):
        flags.append(f"category-{prof['category']}")
    if rsi14 and rsi14 > 70:
        flags.append("overbought")
    if pos52 > 0.92:
        flags.append("near-52w-high")
    if vol_daily and vol_daily > 4:
        flags.append("high-volatility")
    if m["up_streak"] >= 7:
        flags.append("extended-rally")
    if m["divergence"] == "bearish":
        flags.append("bearish-divergence")
    if m["candle_pattern"] in ("shooting-star", "bearish-engulfing"):
        flags.append(m["candle_pattern"])
    if m["gap_status"] == "faded" and (m["gap_pct"] or 0) > 0:
        flags.append("gap-fade")
    if (m["dist_key_resistance"] is not None and m["dist_key_resistance"] <= 2
            and (m["key_resistance_touches"] or 0) >= 3):
        flags.append("near-key-resistance")
    ht = m.get("holding_trend_3m")
    if ht is not None and ht >= 1.5:
        flags.append("institutional-accumulation")
    elif ht is not None and ht <= -1.5:
        flags.append("institutional-selling")
    if m.get("eps_trend") in ("down", "turned-loss"):
        flags.append("eps-declining")
    if not is_equity:
        flags.append("not-equity")
    last_dt = datetime.strptime(dates[-1], "%Y-%m-%d").date()
    if (today - last_dt).days > 7:
        flags.append("stale-data")

    # long-established trend/range suddenly broken in the last few sessions —
    # feeds the Spike tab as a distinct "trend-break" alert kind
    m["regime_break"] = detect_regime_break(dates, closes)

    m["score_short"] = round(score_short, 1)
    m["score_long"] = round(score_long, 1)
    m["reasons_short"] = s_reasons
    m["reasons_long"] = l_reasons
    m["flags"] = flags
    m["eligible"] = ("illiquid" not in flags and "not-equity" not in flags
                     and "stale-data" not in flags
                     and prof.get("category") != "Z")
    m["_series"] = (dates, closes)  # popped by run_analysis for the report card
    return m


def recommend(m, prof):
    """Analyst layer: quality score, composite, verdict, holding period,
    target & stop-loss. Runs after rel_1m (relative strength) is known."""
    vol = m.get("volatility") or 2.5
    liq = m.get("avg_value_mn_30d") or 0
    holding = (prof or {}).get("holding") or {}
    sponsor = holding.get("sponsor")

    q = clamp((liq - 5) / 25) * 0.30                       # market depth
    q += clamp((3.5 - vol) / 2.5) * 0.25                   # low daily risk
    q += {"A": 1.0, "B": 0.4}.get(m.get("category"), 0.0) * 0.20
    q += clamp(((m.get("rel_1m") or 0) + 5) / 10) * 0.15   # beats the market?
    q += (1.0 if (sponsor or 0) >= 30 else 0.5 if (sponsor or 0) >= 15 else 0.3) * 0.10
    quality = 100 * q
    composite = 0.35 * m["score_short"] + 0.40 * m["score_long"] + 0.25 * quality

    flags = set(m["flags"])
    if not m["eligible"]:
        verdict = "Avoid"
    elif composite >= 72 and "overbought" not in flags and "extended-rally" not in flags:
        verdict = "Strong Buy"
    elif composite >= 62:
        verdict = "Buy"
    elif composite >= 52:
        verdict = "Watch"
    else:
        verdict = "Neutral"

    ss, sl = m["score_short"], m["score_long"]
    if ss >= sl + 8:
        horizon, hz_key = "1–2 weeks", "short"
        tgt = clamp(2.5 * vol, 4, 12)
        stp = clamp(1.5 * vol, 2.5, 7)
    elif sl >= ss + 8:
        horizon, hz_key = "1–2 months", "long"
        tgt = clamp(5 * vol, 8, 25)
        stp = clamp(2.5 * vol, 4, 10)
    else:
        horizon, hz_key = "2 weeks – 2 months", "swing"
        tgt = clamp(4 * vol, 6, 18)
        stp = clamp(2 * vol, 3, 8)

    price = m["price"]
    m["quality"] = round(quality, 1)
    m["composite"] = round(composite, 1)
    m["verdict"] = verdict
    m["horizon"] = horizon
    m["horizon_key"] = hz_key
    m["target_pct"] = round(tgt, 1)
    m["stop_pct"] = round(stp, 1)
    m["target_price"] = round(price * (1 + tgt / 100), 1)
    m["stop_price"] = round(price * (1 - stp / 100), 1)
    m["rr"] = round(tgt / stp, 2) if stp else None

    bits = []
    if verdict in ("Strong Buy", "Buy"):
        bits.append(f"Enter near {price:.1f}")
        bits.append(f"book profit around {m['target_price']:.1f} (+{tgt:.0f}%)")
        bits.append(f"exit below {m['stop_price']:.1f} (−{stp:.0f}%) to cap losses")
    m["plan"] = "; ".join(bits) if bits else None


def apply_news_and_agm(m, ticker, announcements, agm_notices, today):
    """Layer company announcements + AGM/EGM record-date info onto a ticker's
    analysis: risk flags for halts/audit concerns/queries, a positive
    record-date-soon catalyst for dividend capture, and a short news feed for
    the detail view. Mutates m in place."""
    cutoff = (today - timedelta(days=NEWS_LOOKBACK_DAYS)).isoformat()
    items = [a for a in announcements.get(ticker, []) if a["date"] >= cutoff]
    items.sort(key=lambda a: a["date"], reverse=True)
    m["recent_news"] = items[:8]

    cats_present = {a["category"] for a in items}
    if "trading-halt" in cats_present:
        m["flags"].append("trading-halt")
        m["eligible"] = False
    if "audit-concern" in cats_present:
        m["flags"].append("audit-concern")
        m["eligible"] = False
    if "exchange-query" in cats_present:
        m["flags"].append("exchange-query")
    if "category-change" in cats_present:
        m["flags"].append("category-change-news")
    for a in items:
        if a["category"] == "dividend":
            m["reasons_long"].append(f"Recent dividend news: {a['title'].split(':', 1)[-1].strip()}")
            break
    for a in items:
        if a["category"] == "credit-rating":
            m["reasons_long"].append("Credit rating result recently published — check before buying")
            break

    entries = agm_notices.get(ticker, [])
    best = None
    for e in entries:
        rd = e.get("record_date")
        if not rd or rd < today.isoformat():
            continue
        if best is None or rd < best["record_date"]:
            best = e
    if best:
        days_away = (datetime.strptime(best["record_date"], "%Y-%m-%d").date() - today).days
        m["upcoming_record_date"] = best["record_date"]
        m["upcoming_dividend_pct"] = best.get("dividend_pct")
        m["days_to_record_date"] = days_away
        if best.get("dividend_pct"):
            m["reasons_long"].append(
                f"Record date {best['record_date']} ({days_away}d) for "
                f"{best['dividend_pct']:.0f}% {best.get('dividend_kind') or 'cash'} dividend — "
                f"buy before this date to qualify")
            if days_away <= 15:
                m["flags"].append("record-date-soon")
    else:
        m["upcoming_record_date"] = None
        m["upcoming_dividend_pct"] = None
        m["days_to_record_date"] = None


def next_trading_day(d, skip=1):
    """Date `skip` DSE trading sessions after d (market runs Sunday–Thursday;
    Friday=4 and Saturday=5 are the weekend)."""
    cur = d
    added = 0
    while added < skip:
        cur += timedelta(days=1)
        if cur.weekday() not in (4, 5):
            added += 1
    return cur


def prev_trading_day(d, skip=1):
    cur = d
    removed = 0
    while removed < skip:
        cur -= timedelta(days=1)
        if cur.weekday() not in (4, 5):
            removed += 1
    return cur


def buy_plan(m, today):
    """When to buy: next session for a fresh setup, 2–3 sessions later for an
    overheated one, and never later than 2 sessions before a record date worth
    capturing (DSE settles T+2 — buy late and you miss the dividend)."""
    if not m["eligible"] or m["verdict"] in ("Avoid",):
        m["buy_date"] = None
        m["buy_note"] = "Not recommended for purchase"
        return

    flags = set(m["flags"])
    if m["verdict"] == "Watch" or m["verdict"] == "Neutral":
        buy = next_trading_day(today, 3)
        note = "Wait for confirmation (rising close on good volume) first"
    elif "overbought" in flags or "extended-rally" in flags:
        buy = next_trading_day(today, 3)
        note = "Overheated — wait 2–3 sessions for a small dip before entering"
    else:
        buy = next_trading_day(today, 1)
        note = "Setup is fresh — enter at the next trading session"

    rd = m.get("upcoming_record_date")
    if rd and m.get("upcoming_dividend_pct"):
        rd_date = datetime.strptime(rd, "%Y-%m-%d").date()
        latest_buy = prev_trading_day(rd_date, 2)  # T+2 settlement cutoff
        if today <= latest_buy <= next_trading_day(today, 10):
            if buy > latest_buy:
                buy = max(next_trading_day(today, 1), latest_buy)
            note += (f"; buy by {latest_buy.isoformat()} to capture the "
                     f"{m['upcoming_dividend_pct']:.0f}% dividend (record date {rd})")

    m["buy_date"] = buy.isoformat()
    m["buy_note"] = note


def pick_top(results, n=20, sector_cap=3):
    """Diversified top-N: best composite first, capped per sector."""
    candidates = sorted(
        (m for m in results.values()
         if m["eligible"] and m["verdict"] in ("Strong Buy", "Buy")),
        key=lambda m: -m["composite"])
    picked, per_sector = [], {}
    for m in candidates:
        sec = m.get("sector") or "?"
        if per_sector.get(sec, 0) >= sector_cap:
            continue
        per_sector[sec] = per_sector.get(sec, 0) + 1
        picked.append(m["_code"])
        if len(picked) == n:
            break
    return picked


# ================= EXCEPTIONAL HIGH-PROFIT SETUPS =================
# Aggressive 1–2 month plays. Each strategy hunts one specific repeatable
# pattern that tends to precede outsized moves. The bar is higher than the
# regular pick lists (more liquidity, hard news screens, confirmation
# required) because these are bought for speed, not safety.
HP_MIN_LIQUIDITY_MN = 8.0
HP_MAX_PICKS = 15
HP_PER_STRATEGY = 4
HP_SECTOR_CAP = 3


def hp_candidates(m):
    """All exceptional setups this share currently matches."""
    out = []
    vol = m.get("volatility") or 2.5
    price = m["price"]
    rsi14 = m.get("rsi14")
    r1m = m.get("r_1m") or 0
    accum = m.get("accum_20d")
    signals = set(m.get("signals") or [])

    # 1. Volatility squeeze: tight bands + accumulation above SMA50 —
    #    energy stored for a breakout, entered before it happens.
    sq = m.get("squeeze_pctile")
    if (sq is not None and sq <= 20 and m.get("sma50") and price > m["sma50"]
            and (accum or 0) > 0 and r1m > -3):
        out.append(dict(
            strategy="squeeze",
            conf=1 + (sq <= 10) + ((accum or 0) >= 0.25),
            hold="3–8 weeks",
            target_pct=clamp(5.5 * vol, 10, 25), stop_pct=clamp(2 * vol, 3.5, 7),
            why=[f"20-day band width in the tightest {sq:.0f}% of the last 6 months — a volatility squeeze, coiled for an outsized move",
                 f"Quiet accumulation while coiled (OBV slope {accum:+.2f})",
                 "Trading above SMA50 — the pressure favours an upward break"]))

    # 2. Momentum leader: beating the market decisively but not yet parabolic.
    rel = m.get("rel_1m") or 0
    if (rel >= 8 and 5 <= r1m <= 25 and m.get("sma20") and m.get("sma50")
            and price > m["sma20"] > m["sma50"] and (rsi14 or 50) < 72):
        out.append(dict(
            strategy="momentum-leader",
            conf=1 + (rel >= 12) + ((m.get("r_1w") or 0) > 0),
            hold="2–6 weeks",
            target_pct=clamp(0.9 * r1m, 10, 28), stop_pct=clamp(2.2 * vol, 4, 8),
            why=[f"Beating the market by {rel:.0f}% over the last month — leaders tend to keep leading",
                 f"+{r1m:.1f}% in 1 month with a clean price > SMA20 > SMA50 uptrend",
                 f"RSI {(rsi14 or 50):.0f} — strong but not yet overbought"]))

    # 3. Quiet accumulation: volume flowing in while price hasn't moved yet.
    ht = m.get("holding_trend_3m")
    if (accum is not None and accum >= 0.30 and abs(r1m) <= 6 and m.get("sma50")
            and abs(price / m["sma50"] - 1) <= 0.06 and m.get("category") in ("A", "B")):
        why3 = [f"On-balance volume rising ({accum:+.2f}) while price moved only {r1m:+.1f}% — someone is buying quietly",
                "Price basing at SMA50 — the markup phase often follows this pattern",
                f"Category {m['category']} company, so the accumulation is credible"]
        if ht is not None and ht >= 1.5:
            why3.insert(0, f"Confirmed by the actual filing: institutional/foreign holding up "
                        f"+{ht:.1f}pp, not just an OBV proxy")
        out.append(dict(
            strategy="accumulation",
            conf=1 + (accum >= 0.5 or (ht or 0) >= 1.5) + ((m.get("vol_ratio") or 0) >= 1.2),
            hold="4–8 weeks",
            target_pct=clamp(5 * vol, 9, 22), stop_pct=clamp(2 * vol, 3.5, 7),
            why=why3[:3]))

    # 4. Oversold rebound in a quality uptrend: buy the dip at support.
    if (rsi14 is not None and rsi14 <= 40 and m.get("sma200") and price > m["sma200"]
            and (m.get("dist_support") or 99) <= 6 and (m.get("eps") or 0) > 0):
        sma20v = m.get("sma20")
        snap = (sma20v / price - 1) * 100 if sma20v and sma20v > price else 0
        cp_bonus = m.get("candle_pattern") in ("hammer", "bullish-engulfing")
        why4 = [f"RSI {rsi14:.0f} oversold inside a long-term uptrend (still above SMA200)",
                f"Only {m.get('dist_support'):.1f}% above 3-month support — a tight, defensible stop",
                "Profitable company (EPS > 0) — dips in quality get bought"]
        if cp_bonus:
            why4.insert(0, f"Fresh {m['candle_pattern'].replace('-', ' ')} candle confirms the bounce today")
        out.append(dict(
            strategy="rebound",
            conf=1 + (rsi14 <= 34) + (1 if m.get("higher_lows") or cp_bonus else 0),
            hold="2–5 weeks",
            target_pct=clamp(snap + 5, 8, 18), stop_pct=clamp(1.8 * vol, 3, 6),
            why=why4[:3]))

    # 5. Volume-backed breakout: past resistance with real demand behind it.
    near_hi = m.get("hi_52w") and price >= 0.98 * m["hi_52w"]
    if (("breakout-3m" in signals or near_hi) and (m.get("vol_ratio") or 0) >= 1.3
            and (rsi14 or 50) <= 78):
        held_gap = m.get("gap_status") == "follow-through" and (m.get("gap_pct") or 0) > 0
        why5 = [("Fresh close above the 3-month high" if "breakout-3m" in signals
                else "Pressing against its 52-week high") + " — overhead sellers are cleared out",
                f"Volume {m['vol_ratio']:.1f}× the 30-day average confirms real demand",
                "Volume-backed breakouts from a base tend to run for weeks"]
        if m.get("dist_key_resistance") is not None and m["dist_key_resistance"] > 5:
            why5.append(f"{m['dist_key_resistance']:.0f}% clear of the next real resistance level")
        out.append(dict(
            strategy="breakout",
            conf=1 + ("volume-spike" in signals or held_gap) + ((m.get("vol_ratio") or 0) >= 1.8),
            hold="2–6 weeks",
            target_pct=clamp(4.5 * vol, 9, 22), stop_pct=clamp(2 * vol, 3.5, 7),
            why=why5[:3]))

    # 6. Dividend runner: ride the pre-record-date run-up AND keep the dividend.
    dtr = m.get("days_to_record_date")
    dy = m.get("dividend_yield")
    if (dtr is not None and 4 <= dtr <= 25 and (dy or 0) >= 3.5
            and m.get("sma50") and price > m["sma50"]):
        out.append(dict(
            strategy="dividend-runner",
            conf=1 + (dy >= 5) + (m["verdict"] in ("Buy", "Strong Buy")),
            hold=f"through record date {m.get('upcoming_record_date')}",
            target_pct=clamp(dy + 5, 8, 15), stop_pct=clamp(2 * vol, 3, 6),
            why=[f"Record date {m['upcoming_record_date']} in {dtr} days with a {dy:.1f}% cash yield",
                 "Shares typically run up into the record date — and you keep the dividend either way",
                 "Already in an uptrend (above SMA50), so the run-up has support"]))

    # 7. Proven signal: a fresh cross on a share whose past signals actually paid.
    if ((signals & {"macd-cross", "golden-cross"}) and (m.get("win_rate") or 0) >= 60
            and (m.get("signal_trades") or 0) >= 5 and (m.get("signal_avg") or 0) >= 3):
        out.append(dict(
            strategy="proven-signal",
            conf=1 + (m["win_rate"] >= 70) + (m["signal_avg"] >= 5),
            hold="3–5 weeks",
            target_pct=clamp(1.6 * m["signal_avg"], 8, 20), stop_pct=clamp(2 * vol, 3.5, 7),
            why=[f"Fresh {'MACD' if 'macd-cross' in signals else 'golden'} cross on the latest session — day-one entry, not a chase",
                 f"This share's past buy signals won {m['win_rate']}% of the time "
                 f"({m['signal_trades']} trades, avg {m['signal_avg']:+.1f}% in a month)"]))

    # 8. Reversal candle at a proven level: a hammer/bullish-engulfing candle
    #    right on support the market has actually defended before — day-one
    #    entry on the clearest visual reversal signal there is.
    if (m.get("candle_pattern") in ("hammer", "bullish-engulfing")
            and m.get("dist_key_support") is not None and m["dist_key_support"] <= 3
            and (m.get("key_support_touches") or 0) >= 2 and (m.get("eps") or 0) > 0):
        out.append(dict(
            strategy="reversal-candle",
            conf=1 + ((m.get("key_support_touches") or 0) >= 3) + ((m.get("vol_ratio") or 0) >= 1.3),
            hold="2–5 weeks",
            target_pct=clamp(3.5 * vol, 8, 18), stop_pct=clamp(1.6 * vol, 2.5, 5),
            why=[f"Fresh {m['candle_pattern'].replace('-', ' ')} candle right on a level touched "
                 f"{m['key_support_touches']}× before (at {m['key_support']:.1f}) — a clean, early reversal signal",
                 "Stop sits just below a level the market has already defended multiple times",
                 "Profitable company (EPS > 0) — the market has a reason to keep defending this level"]))

    return out


def build_high_profit(results, regime):
    """Scan every liquid, eligible share for exceptional setups; rank by edge
    with per-strategy and per-sector caps so the list stays diversified."""
    scanned, matched = 0, []
    for code, m in results.items():
        if not m["eligible"] or m["verdict"] == "Avoid":
            continue
        if (m.get("avg_value_mn_30d") or 0) < HP_MIN_LIQUIDITY_MN:
            continue
        scanned += 1
        cands = hp_candidates(m)
        if not cands:
            continue
        for c in cands:
            c["rr"] = round(c["target_pct"] / c["stop_pct"], 2)
            c["edge"] = (c["conf"] * 8 + min(c["target_pct"], 25) * 0.8
                         + max(c["rr"] - 1, 0) * 6 + (m["composite"] - 50) * 0.3)
        best = max(cands, key=lambda c: c["edge"])
        if len(cands) > 1:  # confluence: independent strategies agreeing
            best["edge"] += 5 * (len(cands) - 1)
            best["conf"] = min(3, best["conf"] + 1)
        best["conf"] = min(3, best["conf"])
        pick = {
            "code": code, "price": m["price"], "ycp": m.get("ycp"), "sector": m.get("sector"),
            "verdict": m["verdict"], "composite": m["composite"],
            "buy_date": m.get("buy_date"), "win_rate": m.get("win_rate"),
            "matched": sorted(c["strategy"] for c in cands),
            "strategy": best["strategy"], "conf": best["conf"], "hold": best["hold"],
            "target_pct": round(best["target_pct"], 1), "stop_pct": round(best["stop_pct"], 1),
            "rr": best["rr"], "edge": round(best["edge"], 1), "why": best["why"],
        }
        pick["target_price"] = round(m["price"] * (1 + pick["target_pct"] / 100), 1)
        pick["stop_price"] = round(m["price"] * (1 - pick["stop_pct"] / 100), 1)
        matched.append(pick)

    matched.sort(key=lambda p: -p["edge"])
    picks, per_strat, per_sector = [], {}, {}
    for p in matched:
        sec = p.get("sector") or "?"
        if per_strat.get(p["strategy"], 0) >= HP_PER_STRATEGY:
            continue
        if per_sector.get(sec, 0) >= HP_SECTOR_CAP:
            continue
        per_strat[p["strategy"]] = per_strat.get(p["strategy"], 0) + 1
        per_sector[sec] = per_sector.get(sec, 0) + 1
        picks.append(p)
        if len(picks) == HP_MAX_PICKS:
            break
    return {"picks": picks, "scanned": scanned, "matched": len(matched),
            "regime": regime}


# ================= MARGIN VIEW (range extremes) =================
# "Lower margin" = trading in the bottom quarter of its 2-year range;
# "higher margin" = top quarter. For each, score the chance the price turns
# (up from the bottom, down from the top) using the same evidence the rest of
# the app trusts — 2y technicals, OBV flow, announcements, record dates — and
# estimate WHEN the turn could start (DSE trading-calendar aware).
MARGIN_LOWER = 0.25
MARGIN_UPPER = 0.75


def margin_rise_score(m):
    """0–100 chance a bottom-of-range share starts rising."""
    rsi14, rsi_prev = m.get("rsi14"), m.get("rsi_prev")
    hist, slope = m.get("macd_hist"), m.get("macd_slope") or 0

    reversal = 0.0                                   # is the turn already showing?
    if hist is not None and hist > 0:
        reversal += 0.35
    if slope > 0:
        reversal += 0.25
    if rsi14 is not None and rsi_prev is not None and rsi_prev < rsi14 < 60:
        reversal += 0.2
    if (m.get("r_1w") or 0) > 0:
        reversal += 0.2
    if m.get("divergence") == "bullish":
        reversal += 0.25
    if m.get("candle_pattern") in ("hammer", "bullish-engulfing"):
        reversal += 0.3
    if m.get("gap_status") == "follow-through" and (m.get("gap_pct") or 0) > 0:
        reversal += 0.15

    accumulation = clamp(((m.get("accum_20d") or 0) + 0.2) / 0.7)
    ht = m.get("holding_trend_3m")
    if ht is not None:                                # real filing data, not just an OBV proxy
        accumulation = clamp(0.6 * accumulation + 0.4 * clamp((ht + 1) / 4))

    support = clamp(1 - (m.get("dist_support") or 20) / 15)
    if (m.get("r_1w") or 0) < -2:                    # still knifing down
        support *= 0.5
    if m.get("higher_lows"):
        support = clamp(support + 0.3)
    if (m.get("dist_key_support") is not None and m["dist_key_support"] <= 3
            and (m.get("key_support_touches") or 0) >= 2):
        support = clamp(support + 0.25)              # defended by a real multi-touch level
    bh = (m.get("margin_history") or {}).get("bottom_reversion")
    if bh and bh["n"] >= 2 and bh["hit_rate"] >= 60:
        support = clamp(support + 0.25)              # this share's own history: it reliably bounces from bottoms
    elif bh and bh["n"] >= 3 and bh["hit_rate"] <= 25:
        support *= 0.7                                # ...or historically it doesn't — a falling-knife pattern

    f = 0.0                                          # is it worth catching?
    if (m.get("eps") or 0) > 0:
        f += 0.35
    f += {"A": 0.3, "B": 0.15}.get(m.get("category"), 0.0)
    if m.get("dividend_yield"):
        f += 0.2
    if (m.get("avg_value_mn_30d") or 0) >= MIN_LIQUIDITY_MN:
        f += 0.15
    if m.get("eps_trend") in ("up", "turned-profitable"):
        f += 0.15
    elif m.get("eps_trend") in ("down", "turned-loss"):
        f -= 0.15
    p_nav = m.get("p_nav")
    if p_nav is not None and 0 < p_nav < 1:
        f += 0.15                                     # cheap relative to book value too

    cat = 0.0                                        # a reason to turn NOW
    dtr = m.get("days_to_record_date")
    if dtr is not None and 0 < dtr <= 30:
        cat += 0.6
    news_cats = {a["category"] for a in (m.get("recent_news") or [])}
    if "dividend" in news_cats:
        cat += 0.3
    if "board-meeting" in news_cats:
        cat += 0.2
    if "financials" in news_cats:
        cat += 0.1

    score = 100 * (0.35 * clamp(reversal) + 0.20 * accumulation + 0.15 * clamp(support)
                   + 0.15 * clamp(f) + 0.15 * clamp(cat))
    flags = set(m.get("flags") or [])
    if flags & {"trading-halt", "audit-concern"}:    # cheap for a reason
        score = min(score, 5)
    if "stale-data" in flags:
        score *= 0.3
    if m.get("category") == "Z":
        score *= 0.5
    return round(score, 1)


def margin_fall_score(m):
    """0–100 chance a top-of-range share starts falling."""
    rsi14 = m.get("rsi14") or 50
    slope = m.get("macd_slope") or 0

    over = 0.0                                       # how stretched is it?
    if rsi14 > 70:
        over += 0.35
    elif rsi14 > 65:
        over += 0.2
    if (m.get("boll_pos") or 0.5) > 0.9:
        over += 0.2
    if (m.get("up_streak") or 0) >= 5:
        over += 0.2
    if (m.get("r_1m") or 0) > 25:
        over += 0.25
    if (m.get("dist_key_resistance") is not None and m["dist_key_resistance"] <= 2
            and (m.get("key_resistance_touches") or 0) >= 2):
        over = clamp(over + 0.25)                    # sitting right at a proven rejection level
    th = (m.get("margin_history") or {}).get("top_correction")
    if th and th["n"] >= 2 and th["hit_rate"] >= 60:
        over = clamp(over + 0.2)                      # this share's own history: it reliably corrects from tops
    elif th and th["n"] >= 3 and th["hit_rate"] <= 25:
        over *= 0.75                                   # ...or historically it just keeps running — a real momentum name

    fade = 0.0                                       # is momentum already rolling over?
    if slope < 0:
        fade += 0.5
    if (m.get("r_1w") or 0) < 0:
        fade += 0.3
    if (m.get("vol_ratio") or 1) < 0.8:
        fade += 0.2
    if m.get("divergence") == "bearish":
        fade += 0.4
    if m.get("candle_pattern") in ("shooting-star", "bearish-engulfing"):
        fade += 0.3
    if m.get("gap_status") == "faded" and (m.get("gap_pct") or 0) > 0:
        fade += 0.2

    distribution = clamp((0.1 - (m.get("accum_20d") or 0)) / 0.6)
    ht = m.get("holding_trend_3m")
    if ht is not None:                                # real filing data, not just an OBV proxy
        distribution = clamp(0.6 * distribution + 0.4 * clamp((1 - ht) / 4))

    v = 0.0                                          # what is the height built on?
    pe = m.get("pe")
    if pe and pe > 30:
        v += 0.5
    if (m.get("eps") or 0) <= 0:
        v += 0.3
    v += {"B": 0.2, "N": 0.2, "Z": 0.5}.get(m.get("category"), 0.0)
    if m.get("eps_trend") in ("down", "turned-loss"):
        v = clamp(v + 0.25)                           # rally isn't backed by improving earnings

    ev = 0.0                                         # a scheduled reason to drop
    dtr = m.get("days_to_record_date")
    if dtr is not None and 0 <= dtr <= 7:            # ex-dividend adjustment imminent
        ev += 0.6
    news_cats = {a["category"] for a in (m.get("recent_news") or [])}
    flags = set(m.get("flags") or [])
    if "exchange-query" in news_cats or "exchange-query" in flags:
        ev += 0.4
    if "audit-concern" in flags:
        ev += 0.5
    if "category-change-news" in flags:
        ev += 0.2

    score = 100 * (0.35 * clamp(over) + 0.20 * clamp(fade) + 0.15 * distribution
                   + 0.15 * clamp(v) + 0.15 * clamp(ev))
    return round(score, 1)


def margin_rise_when(m, today):
    """Estimated date the rise could start, from how far along the reversal is."""
    hist, slope = m.get("macd_hist"), m.get("macd_slope") or 0
    rsi14, rsi_prev = m.get("rsi14"), m.get("rsi_prev")
    if m.get("candle_pattern") in ("hammer", "bullish-engulfing"):
        d = next_trading_day(today, 1)
        note = f"{m['candle_pattern'].replace('-', ' ').title()} candle right at support — from the next session"
    elif hist is not None and hist > 0 and ((m.get("r_1w") or 0) > 0 or slope > 0):
        d = next_trading_day(today, 1)
        note = "Reversal already confirmed (MACD positive, price turning) — from the next session"
    elif hist is not None and hist < 0 and slope > 0:
        sessions = int(clamp(math.ceil(-hist / slope), 2, 20))
        d = next_trading_day(today, sessions)
        note = f"MACD histogram closing on zero at its current pace (~{sessions} sessions)"
    elif ((rsi14 is not None and rsi_prev is not None and rsi_prev < rsi14 < 45)
          or (m.get("accum_20d") or 0) > 0.2):
        d = next_trading_day(today, 8)
        note = "Early bottoming signs — typically needs another 1–2 weeks of basing"
    else:
        d = next_trading_day(today, 15)
        note = "No reversal evidence yet — recheck in ~3 weeks"
    rd = m.get("upcoming_record_date")
    if rd:
        rd_date = datetime.strptime(rd, "%Y-%m-%d").date()
        runup = prev_trading_day(rd_date, 10)        # run-ups start ~2 weeks ahead
        if runup <= today < rd_date:
            d2 = next_trading_day(today, 1)
            if d2 < d:
                d, note = d2, f"Pre-record-date run-up window is open (record date {rd})"
        elif today < runup < d:
            d, note = runup, f"Run-ups ahead of a record date typically start around here (record date {rd})"
    return d.isoformat(), note


def margin_fall_when(m, today):
    """Estimated date the fall could start."""
    rd = m.get("upcoming_record_date")
    if rd:
        rd_date = datetime.strptime(rd, "%Y-%m-%d").date()
        if 0 <= (rd_date - today).days <= 10:
            return (next_trading_day(rd_date, 1).isoformat(),
                    f"Ex-dividend adjustment — price typically drops right after record date {rd}")
    if m.get("candle_pattern") in ("shooting-star", "bearish-engulfing"):
        return (next_trading_day(today, 1).isoformat(),
                f"{m['candle_pattern'].replace('-', ' ').title()} candle right at resistance — from the next session")
    slope = m.get("macd_slope") or 0
    rsi14 = m.get("rsi14") or 50
    streak = m.get("up_streak") or 0
    if slope < 0 and (m.get("r_1w") or 0) < 0:
        return (next_trading_day(today, 1).isoformat(),
                "Rollover already underway (momentum and price both falling)")
    if slope < 0 or rsi14 >= 75:
        return (next_trading_day(today, 3).isoformat(),
                "Momentum fading at the top — turn likely within a week")
    if streak >= 5:
        return (next_trading_day(today, max(1, 8 - streak)).isoformat(),
                f"{streak} straight up days — statistically overdue for a red session")
    return (next_trading_day(today, 10).isoformat(),
            "Still strong — no fall trigger yet; reassess in ~2 weeks")


def margin_rise_reasons(m):
    """(english, বাংলা) reason pairs."""
    r = []
    hist, slope = m.get("macd_hist"), m.get("macd_slope") or 0
    rsi14, rsi_prev = m.get("rsi14"), m.get("rsi_prev")
    cp = m.get("candle_pattern")
    if cp == "hammer":
        r.append(("Hammer candle today — a long lower wick shows buyers rejected further downside",
                  "আজ হ্যামার ক্যান্ডেল — লম্বা নিচের বাতি দেখাচ্ছে ক্রেতারা আরও পতন প্রতিহত করেছে"))
    elif cp == "bullish-engulfing":
        r.append(("Bullish engulfing candle today — today's buying erased all of yesterday's selling",
                  "আজ বুলিশ এনগাল্ফিং ক্যান্ডেল — আজকের কেনাকাটা গতকালের সব বিক্রি মুছে দিয়েছে"))
    bh = (m.get("margin_history") or {}).get("bottom_reversion")
    if bh and bh["n"] >= 2 and bh["hit_rate"] >= 60:
        r.append((f"This share's own track record: bounced back {bh['hit_rate']}% of the past {bh['n']} times "
                  f"it hit bottom (avg {bh['avg_return']:+.1f}% within a month)",
                  f"এই শেয়ারের নিজস্ব রেকর্ড: গত {bh['n']} বার তলানিতে যাওয়ার {bh['hit_rate']}% বারই ঘুরে দাঁড়িয়েছে "
                  f"(এক মাসে গড়ে {bh['avg_return']:+.1f}%)"))
    elif bh and bh["n"] >= 3 and bh["hit_rate"] <= 25:
        r.append((f"⚠ This share rarely bounces from bottom — only {bh['hit_rate']}% of its past {bh['n']} bottom "
                  f"episodes recovered — could be a structural decline, not a dip",
                  f"⚠ এই শেয়ার তলানি থেকে খুব কমই ঘুরে দাঁড়ায় — গত {bh['n']} বারের মধ্যে মাত্র {bh['hit_rate']}% "
                  f"বার সফল হয়েছে — এটি সাময়িক পতন নাও হতে পারে"))
    ht = m.get("holding_trend_3m")
    if ht is not None and ht >= 1.5:
        r.append((f"Institutional/foreign holding actually rising (+{ht:.1f}pp) — confirmed in the filings, not just OBV",
                  f"প্রাতিষ্ঠানিক/বিদেশি মালিকানা সত্যিই বাড়ছে (+{ht:.1f}pp) — ফাইলিংয়ে নিশ্চিত, শুধু OBV নয়"))
    if m.get("eps_trend") == "turned-profitable":
        r.append(("Turned profitable in the latest reported quarter",
                  "সর্বশেষ প্রান্তিকে লাভজনক হয়েছে"))
    elif m.get("eps_trend") == "up" and (m.get("eps_qoq_growth") or 0) > 5:
        r.append((f"Quarterly EPS growing (+{m['eps_qoq_growth']:.0f}% vs prior quarter)",
                  f"প্রান্তিক EPS বাড়ছে (আগের প্রান্তিকের তুলনায় +{m['eps_qoq_growth']:.0f}%)"))
    p_nav = m.get("p_nav")
    if p_nav is not None and 0 < p_nav < 1:
        r.append((f"Trading below book value (P/NAV {p_nav:.2f})",
                  f"বুক ভ্যালুর নিচে লেনদেন (P/NAV {p_nav:.2f})"))
    if (m.get("dist_key_support") is not None and m["dist_key_support"] <= 3
            and (m.get("key_support_touches") or 0) >= 2):
        r.append((f"Sitting on a real support level touched {m['key_support_touches']}× before "
                  f"(at {m['key_support']:.1f})",
                  f"একটি প্রকৃত সাপোর্ট স্তরে আছে যা আগে {m['key_support_touches']}বার স্পর্শ করেছে "
                  f"({m['key_support']:.1f}-এ)"))
    if m.get("gap_status") == "follow-through" and (m.get("gap_pct") or 0) > 0:
        r.append((f"Gapped up {m['gap_pct']:.1f}% and held through the close — buyers defended the gap",
                  f"{m['gap_pct']:.1f}% গ্যাপ-আপ হয়ে ক্লোজ পর্যন্ত টিকে আছে — ক্রেতারা গ্যাপ রক্ষা করেছে"))
    if m.get("divergence") == "bullish":
        r.append(("Bullish RSI divergence — price made a lower low but RSI didn't, selling pressure exhausting",
                  "বুলিশ RSI ডাইভারজেন্স — দাম নতুন নিচে নামলেও RSI নামেনি, বিক্রির চাপ ফুরিয়ে আসছে"))
    if hist is not None and hist > 0:
        r.append(("MACD already bullish", "MACD ইতিমধ্যে ঊর্ধ্বমুখী"))
    elif slope > 0:
        r.append(("MACD histogram rising toward a cross",
                  "MACD হিস্টোগ্রাম ক্রসের দিকে বাড়ছে"))
    if rsi14 is not None and rsi_prev is not None and rsi_prev + 1 <= rsi14 < 55:
        r.append((f"RSI turning up ({rsi_prev:.0f}→{rsi14:.0f})",
                  f"RSI ঘুরে দাঁড়াচ্ছে ({rsi_prev:.0f}→{rsi14:.0f})"))
    if (m.get("accum_20d") or 0) >= 0.2:
        r.append((f"OBV accumulation ({m['accum_20d']:+.2f}) near the lows",
                  f"তলানিতে OBV সঞ্চয় ({m['accum_20d']:+.2f}) — কেউ চুপচাপ কিনছে"))
    if m.get("higher_lows"):
        r.append(("Higher-lows base forming", "ক্রমশ উঁচু লো — ভিত তৈরি হচ্ছে"))
    if (m.get("dist_support") or 99) <= 5:
        r.append((f"Holding {m['dist_support']:.1f}% above defended support",
                  f"সাপোর্টের {m['dist_support']:.1f}% উপরে টিকে আছে"))
    dtr = m.get("days_to_record_date")
    if dtr is not None and 0 < dtr <= 30:
        div = (f" ({m['upcoming_dividend_pct']:.0f}% dividend)"
               if m.get("upcoming_dividend_pct") else "")
        div_bn = (f" ({m['upcoming_dividend_pct']:.0f}% লভ্যাংশ)"
                  if m.get("upcoming_dividend_pct") else "")
        r.append((f"Record date {m['upcoming_record_date']} in {dtr}d{div}",
                  f"রেকর্ড ডেট {m['upcoming_record_date']}, {dtr} দিন বাকি{div_bn}"))
    news_cats = {a["category"] for a in (m.get("recent_news") or [])}
    if "dividend" in news_cats:
        r.append(("Recent dividend announcement", "সাম্প্রতিক লভ্যাংশ ঘোষণা"))
    if "board-meeting" in news_cats:
        r.append(("Board meeting scheduled — possible catalyst",
                  "বোর্ড মিটিং নির্ধারিত — সম্ভাব্য উপলক্ষ"))
    if (m.get("eps") or 0) > 0 and m.get("category") == "A":
        r.append(("Profitable category-A share at the bottom of its range",
                  "লাভজনক A-ক্যাটাগরি শেয়ার, নিজের সীমার তলানিতে"))
    hard = set(m.get("flags") or []) & {"trading-halt", "audit-concern", "stale-data"}
    if hard:
        hard_s = ", ".join(sorted(hard))
        r.append((f"⚠ {hard_s} — cheap for a reason",
                  f"⚠ {hard_s} — কারণ ছাড়া সস্তা নয়"))
    return r[:4] or [("No turn evidence yet — deep value only if fundamentals convince you",
                      "ঘুরে দাঁড়ানোর প্রমাণ এখনো নেই — মৌলভিত্তিতে আস্থা থাকলে তবেই ভাবুন")]


def margin_fall_reasons(m):
    """(english, বাংলা) reason pairs."""
    r = []
    rsi14 = m.get("rsi14")
    cp = m.get("candle_pattern")
    if cp == "shooting-star":
        r.append(("Shooting star candle today — a long upper wick shows sellers rejected further upside",
                  "আজ শুটিং স্টার ক্যান্ডেল — লম্বা উপরের বাতি দেখাচ্ছে বিক্রেতারা আরও বৃদ্ধি প্রতিহত করেছে"))
    elif cp == "bearish-engulfing":
        r.append(("Bearish engulfing candle today — today's selling erased all of yesterday's buying",
                  "আজ বিয়ারিশ এনগাল্ফিং ক্যান্ডেল — আজকের বিক্রি গতকালের সব কেনাকাটা মুছে দিয়েছে"))
    th = (m.get("margin_history") or {}).get("top_correction")
    if th and th["n"] >= 2 and th["hit_rate"] >= 60:
        r.append((f"This share's own track record: corrected {th['hit_rate']}% of the past {th['n']} times "
                  f"it hit the top (avg {th['avg_return']:+.1f}% within a month)",
                  f"এই শেয়ারের নিজস্ব রেকর্ড: গত {th['n']} বার চূড়ায় যাওয়ার {th['hit_rate']}% বারই সংশোধন হয়েছে "
                  f"(এক মাসে গড়ে {th['avg_return']:+.1f}%)"))
    elif th and th["n"] >= 3 and th["hit_rate"] <= 25:
        r.append((f"This share rarely corrects from the top — only {th['hit_rate']}% of its past {th['n']} top "
                  f"episodes pulled back — could be genuine sustained momentum",
                  f"এই শেয়ার চূড়া থেকে খুব কমই সংশোধিত হয় — গত {th['n']} বারের মধ্যে মাত্র {th['hit_rate']}% "
                  f"বার হয়েছে — এটি সত্যিকারের টেকসই গতিও হতে পারে"))
    ht = m.get("holding_trend_3m")
    if ht is not None and ht <= -1.5:
        r.append((f"Institutional/foreign holding actually falling ({ht:.1f}pp) — confirmed in the filings, not just OBV",
                  f"প্রাতিষ্ঠানিক/বিদেশি মালিকানা সত্যিই কমছে ({ht:.1f}pp) — ফাইলিংয়ে নিশ্চিত, শুধু OBV নয়"))
    if m.get("eps_trend") == "turned-loss":
        r.append(("Turned loss-making in the latest reported quarter — the rally isn't backed by earnings",
                  "সর্বশেষ প্রান্তিকে লোকসানে পড়েছে — ঊর্ধ্বগতি আয় দ্বারা সমর্থিত নয়"))
    elif m.get("eps_trend") == "down":
        r.append(("Quarterly EPS declining vs the prior reported quarter",
                  "প্রান্তিক EPS আগের প্রান্তিকের তুলনায় কমছে"))
    if (m.get("dist_key_resistance") is not None and m["dist_key_resistance"] <= 2
            and (m.get("key_resistance_touches") or 0) >= 2):
        r.append((f"Right at a real resistance level rejected {m['key_resistance_touches']}× before "
                  f"(at {m['key_resistance']:.1f})",
                  f"একটি প্রকৃত রেজিস্ট্যান্স স্তরে আছে যা আগে {m['key_resistance_touches']}বার প্রত্যাখ্যাত হয়েছে "
                  f"({m['key_resistance']:.1f}-এ)"))
    if m.get("gap_status") == "faded" and (m.get("gap_pct") or 0) > 0:
        r.append((f"Gapped up {m['gap_pct']:.1f}% but fully faded back below yesterday's close — a trap for chasers",
                  f"{m['gap_pct']:.1f}% গ্যাপ-আপ হয়েও গতকালের ক্লোজের নিচে ফিরে গেছে — তাড়াহুড়ো করে কেনাদের জন্য ফাঁদ"))
    if rsi14 is not None and rsi14 > 70:
        r.append((f"RSI {rsi14:.0f} overbought", f"RSI {rsi14:.0f} — অতিরিক্ত কেনা"))
    if (m.get("boll_pos") or 0.5) > 0.9:
        r.append(("Pressing the upper Bollinger band", "উপরের বলিঞ্জার ব্যান্ডে চাপ দিচ্ছে"))
    if (m.get("r_1m") or 0) > 25:
        r.append((f"+{m['r_1m']:.0f}% in a month — parabolic, mean-reversion risk",
                  f"এক মাসে +{m['r_1m']:.0f}% — অস্বাভাবিক গতি, দাম ফিরে আসার ঝুঁকি"))
    if (m.get("up_streak") or 0) >= 5:
        r.append((f"{m['up_streak']} straight up days",
                  f"টানা {m['up_streak']} দিন ঊর্ধ্বমুখী"))
    if (m.get("accum_20d") or 0) <= -0.2:
        r.append((f"OBV distribution ({m['accum_20d']:+.2f}) — volume leaving at the highs",
                  f"OBV বিতরণ ({m['accum_20d']:+.2f}) — চূড়ায় ভলিউম বেরিয়ে যাচ্ছে"))
    if m.get("divergence") == "bearish":
        r.append(("Bearish RSI divergence — price made a higher high but RSI didn't, buying power exhausting",
                  "বিয়ারিশ RSI ডাইভারজেন্স — দাম নতুন চূড়ায় উঠলেও RSI ওঠেনি, কেনার শক্তি ফুরিয়ে আসছে"))
    if (m.get("macd_slope") or 0) < 0:
        r.append(("MACD momentum already fading", "MACD-র গতি ইতিমধ্যে কমছে"))
    dtr = m.get("days_to_record_date")
    if dtr is not None and 0 <= dtr <= 7:
        r.append((f"Ex-dividend drop expected after record date {m['upcoming_record_date']}",
                  f"রেকর্ড ডেট {m['upcoming_record_date']}-এর পর এক্স-ডিভিডেন্ড পতনের সম্ভাবনা"))
    news_cats = {a["category"] for a in (m.get("recent_news") or [])}
    if "exchange-query" in news_cats:
        r.append(("DSE exchange query on the price move",
                  "দামের ওঠানামা নিয়ে DSE-র আনুষ্ঠানিক প্রশ্ন (এক্সচেঞ্জ কোয়েরি)"))
    pe = m.get("pe")
    if pe and pe > 30:
        r.append((f"Expensive at P/E {pe:.0f}", f"P/E {pe:.0f} — আয়ের তুলনায় দামি"))
    if (m.get("eps") or 0) <= 0:
        r.append(("Loss-making yet at 2-year highs", "লোকসানি কোম্পানি, তবু ২ বছরের চূড়ায়"))
    return r[:4] or [("Strong uptrend with no fall trigger yet — just extended",
                      "শক্তিশালী ঊর্ধ্বগতি, পতনের সংকেত এখনো নেই — শুধু অনেকটা বেড়ে আছে")]


MARGIN_WINDOWS = ["1m", "2m", "3m", "6m", "1y", "2y"]
MARGIN_DEFAULT_WINDOW = "3m"


def build_margin(results, today):
    """Per-window (1m…2y) lower/higher membership + one shared rise/fall
    assessment per ticker. A share can be at the bottom of its 1-month range
    yet the top of its 2-year range — membership is per window, but the turn
    evidence (MACD/RSI/OBV/news) is the same maths whichever window shows it."""
    windows = {k: {"lower": [], "higher": []} for k in MARGIN_WINDOWS}
    tickers = {}
    for code, m in results.items():
        ranges = m.get("ranges") or {}
        in_lower = in_higher = False
        for k in MARGIN_WINDOWS:
            r = ranges.get(k)
            if not r or r["pos"] is None:
                continue
            if r["pos"] <= MARGIN_LOWER:
                windows[k]["lower"].append({
                    "code": code, "pos": r["pos"],
                    "from_low": round((m["price"] / r["lo"] - 1) * 100, 1) if r["lo"] else None})
                in_lower = True
            elif r["pos"] >= MARGIN_UPPER:
                windows[k]["higher"].append({
                    "code": code, "pos": r["pos"],
                    "from_high": round((1 - m["price"] / r["hi"]) * 100, 1) if r["hi"] else None})
                in_higher = True
        if not (in_lower or in_higher):
            continue
        t = {}
        if in_lower:
            t["rise_score"] = margin_rise_score(m)
            t["rise_date"], t["rise_note"] = margin_rise_when(m, today)
            pairs = margin_rise_reasons(m)
            t["rise_why"] = [p[0] for p in pairs]
            t["rise_why_bn"] = [p[1] for p in pairs]
        if in_higher:
            t["fall_score"] = margin_fall_score(m)
            t["fall_date"], t["fall_note"] = margin_fall_when(m, today)
            pairs = margin_fall_reasons(m)
            t["fall_why"] = [p[0] for p in pairs]
            t["fall_why_bn"] = [p[1] for p in pairs]
        tickers[code] = t
    for k in MARGIN_WINDOWS:
        windows[k]["lower"].sort(key=lambda e: -tickers[e["code"]]["rise_score"])
        windows[k]["higher"].sort(key=lambda e: -tickers[e["code"]]["fall_score"])
    return {"windows": windows, "tickers": tickers,
            "default": MARGIN_DEFAULT_WINDOW,
            "lower_threshold": MARGIN_LOWER, "higher_threshold": MARGIN_UPPER}


# ================= SPIKE DETECTOR =================
# Shares that suddenly moved a big amount — today or within the last few
# sessions (see detect_recent_spike / SPIKE_LOOKBACK) — vs yesterday's close
# and/or vs today's open (the live overlay makes "now vs session start" real
# during trading hours). Each spike is scored for the chance it CONTINUES in
# its own direction: volume backing, room to run, trend backdrop, a real
# catalyst, and this share's own history of following through.
SPIKE_NEWS_DAYS = 5


def spike_score(m, today, rs):
    """0–100 chance the spike/drop in `rs` (either direction) continues in
    its own direction, with (english, বাংলা) reasons. Mirrors the same five
    weighted components (volume/room/trend/catalyst/history) for both an
    upward jump and a downward drop, since a sudden fall is just as
    alert-worthy as a sudden rise — just scored by opposite logic."""
    why = []
    up = rs["direction"] == "up"
    chg = abs(rs["change_pct"])

    vt = m.get("vol_today_ratio") or 0
    volume = clamp((vt - 0.8) / 2.2)
    if vt >= 2:
        why.append((f"Volume {vt:.1f}× the 30-day average — real money behind the move",
                    f"ভলিউম ৩০ দিনের গড়ের {vt:.1f} গুণ — মুভের পেছনে সত্যিকারের টাকা"))
    elif vt < 1:
        why.append((f"⚠ Only {vt:.1f}× average volume — a move without backing usually fades",
                    f"⚠ ভলিউম গড়ের মাত্র {vt:.1f} গুণ — সমর্থনহীন মুভ সাধারণত মিলিয়ে যায়"))

    rsi14 = m.get("rsi14") or 50
    if up:
        room = (clamp((10 - chg) / 7) * 0.4          # distance to the 10% circuit
                + clamp((80 - rsi14) / 30) * 0.3
                + clamp((m.get("dist_resistance") or 0) / 10) * 0.3)
        if chg >= 9:
            why.append(("At/near the 10% daily circuit — no room left today; continuation would need tomorrow",
                        "১০% দৈনিক সার্কিটের কাছে — আজ আর বাড়ার জায়গা নেই; চলতে হলে আগামীকাল"))
        elif (m.get("dist_resistance") or 0) > 8:
            why.append((f"{m['dist_resistance']:.0f}% headroom below 3-month resistance",
                        f"৩ মাসের রেজিস্ট্যান্সের নিচে {m['dist_resistance']:.0f}% ফাঁকা জায়গা"))
        if rsi14 > 80:
            why.append((f"⚠ RSI {rsi14:.0f} — already very overbought",
                        f"⚠ RSI {rsi14:.0f} — ইতিমধ্যে মাত্রাতিরিক্ত কেনা"))
    else:
        room = (clamp((10 - chg) / 7) * 0.4          # distance to the -10% circuit
                + clamp((rsi14 - 20) / 30) * 0.3
                + clamp((m.get("dist_support") or 0) / 10) * 0.3)
        if chg >= 9:
            why.append(("At/near the −10% daily circuit — no room left today; continuation would need tomorrow",
                        "−১০% দৈনিক সার্কিটের কাছে — আজ আর কমার জায়গা নেই; চলতে হলে আগামীকাল"))
        elif (m.get("dist_support") or 0) > 8:
            why.append((f"{m['dist_support']:.0f}% room above 3-month support before it's tested",
                        f"৩ মাসের সাপোর্ট পরীক্ষা হওয়ার আগে {m['dist_support']:.0f}% জায়গা বাকি"))
        if rsi14 < 20:
            why.append((f"⚠ RSI {rsi14:.0f} — already very oversold, a bounce is due",
                        f"⚠ RSI {rsi14:.0f} — ইতিমধ্যে মাত্রাতিরিক্ত বিক্রি, উল্টো ঘোরার সম্ভাবনা"))

    trend = 0.0
    if up:
        if m.get("sma50") and m["price"] > m["sma50"]:
            trend += 0.4
        if m.get("sma20") and m["price"] > m["sma20"]:
            trend += 0.2
        if (m.get("macd_hist") or 0) > 0:
            trend += 0.2
        if m.get("higher_lows"):
            trend += 0.2
        if m.get("divergence") == "bearish":
            trend = max(0.0, trend - 0.4)
            why.append(("⚠ Bearish RSI divergence under this spike — buying power was already exhausting",
                        "⚠ স্পাইকের নিচে বিয়ারিশ RSI ডাইভারজেন্স — কেনার শক্তি আগেই ফুরিয়ে আসছিল"))
    else:
        if m.get("sma50") and m["price"] < m["sma50"]:
            trend += 0.4
        if m.get("sma20") and m["price"] < m["sma20"]:
            trend += 0.2
        if (m.get("macd_hist") or 0) < 0:
            trend += 0.2
        if "extended-rally" in (m.get("flags") or []):
            trend = max(0.0, trend - 0.2)
        if m.get("divergence") == "bullish":
            trend = max(0.0, trend - 0.4)
            why.append(("⚠ Bullish RSI divergence under this drop — selling pressure was already exhausting",
                        "⚠ পতনের নিচে বুলিশ RSI ডাইভারজেন্স — বিক্রির চাপ আগেই ফুরিয়ে আসছিল"))

    cs = m.get("close_strength")
    if up:
        if cs is not None and cs >= 0.7:
            trend = clamp(trend + 0.2)
            why.append((f"Closed strong — {cs * 100:.0f}% up in today's own range, buyers won the session",
                        f"শক্তিশালী ক্লোজ — আজকের নিজস্ব পরিসরের {cs * 100:.0f}% উপরে, ক্রেতারা দিনটি জিতেছে"))
        elif cs is not None and cs <= 0.3:
            trend = max(0.0, trend - 0.25)
            why.append((f"⚠ Closed weak — only {cs * 100:.0f}% up in today's range, sellers took it back",
                        f"⚠ দুর্বল ক্লোজ — আজকের পরিসরের মাত্র {cs * 100:.0f}% উপরে, বিক্রেতারা ফিরিয়ে নিয়েছে"))
    else:
        if cs is not None and cs <= 0.3:
            trend = clamp(trend + 0.2)
            why.append((f"Closed weak — only {cs * 100:.0f}% up in today's own range, sellers stayed in control",
                        f"দুর্বল ক্লোজ — আজকের পরিসরের মাত্র {cs * 100:.0f}% উপরে, বিক্রেতারা নিয়ন্ত্রণে ছিল"))
        elif cs is not None and cs >= 0.7:
            trend = max(0.0, trend - 0.25)
            why.append((f"⚠ Closed strong — {cs * 100:.0f}% up in today's range, buyers defended into the close",
                        f"⚠ শক্তিশালী ক্লোজ — আজকের পরিসরের {cs * 100:.0f}% উপরে, ক্রেতারা ক্লোজ পর্যন্ত রক্ষা করেছে"))

    if up:
        if m.get("gap_status") == "faded" and (m.get("gap_pct") or 0) > 0:
            trend = max(0.0, trend - 0.35)
            why.append((f"⚠ Gapped up {m['gap_pct']:.1f}% but fully faded back below yesterday's close — a classic trap",
                        f"⚠ {m['gap_pct']:.1f}% গ্যাপ-আপ হয়েও গতকালের ক্লোজের নিচে ফিরে গেছে — চিরায়ত ফাঁদ"))
        elif m.get("gap_status") == "follow-through" and (m.get("gap_pct") or 0) > 0:
            trend = clamp(trend + 0.15)
            why.append((f"Gapped up {m['gap_pct']:.1f}% and held through the close",
                        f"{m['gap_pct']:.1f}% গ্যাপ-আপ হয়ে ক্লোজ পর্যন্ত টিকে আছে"))
    else:
        if m.get("gap_status") == "faded" and (m.get("gap_pct") or 0) < 0:
            trend = max(0.0, trend - 0.35)
            why.append((f"⚠ Gapped down {abs(m['gap_pct']):.1f}% but fully recovered back above yesterday's close — buyers stepped in",
                        f"⚠ {abs(m['gap_pct']):.1f}% গ্যাপ-ডাউন হয়েও গতকালের ক্লোজের উপরে ফিরে এসেছে — ক্রেতারা এগিয়ে এসেছে"))
        elif m.get("gap_status") == "follow-through" and (m.get("gap_pct") or 0) < 0:
            trend = clamp(trend + 0.15)
            why.append((f"Gapped down {abs(m['gap_pct']):.1f}% and stayed down through the close",
                        f"{abs(m['gap_pct']):.1f}% গ্যাপ-ডাউন হয়ে ক্লোজ পর্যন্ত নিচেই থেকেছে"))

    if trend >= 0.6:
        if up:
            why.append(("Spike inside an established uptrend — these follow through more often",
                        "প্রতিষ্ঠিত ঊর্ধ্বগতির মধ্যে স্পাইক — এগুলো প্রায়ই চলতে থাকে"))
        else:
            why.append(("Drop inside an established downtrend — these follow through more often",
                        "প্রতিষ্ঠিত নিম্নগতির মধ্যে পতন — এগুলো প্রায়ই চলতে থাকে"))
    elif trend <= 0.2:
        if up:
            why.append(("⚠ Spike against a downtrend — usually a one-day event",
                        "⚠ নিম্নগতির বিপরীতে স্পাইক — সাধারণত একদিনের ঘটনা"))
        else:
            why.append(("⚠ Drop against an uptrend — often just a one-day dip, not a reversal",
                        "⚠ ঊর্ধ্বগতির বিপরীতে পতন — প্রায়ই একদিনের ডিপ, পতনের শুরু নয়"))

    cat = 0.0
    cutoff = (today - timedelta(days=SPIKE_NEWS_DAYS)).isoformat()
    fresh = {a["category"] for a in (m.get("recent_news") or []) if a["date"] >= cutoff}
    if up:
        if "dividend" in fresh:
            cat += 0.5
            why.append(("Dividend announcement in the last few days — a real catalyst",
                        "গত কয়েক দিনে লভ্যাংশ ঘোষণা — প্রকৃত উপলক্ষ"))
        if "financials" in fresh:
            cat += 0.35
            why.append(("Fresh financial results behind the move",
                        "মুভের পেছনে নতুন আর্থিক ফলাফল"))
        if "credit-rating" in fresh:
            cat += 0.25
        if "board-meeting" in fresh:
            cat += 0.3
            why.append(("Board meeting announced — market may be front-running a dividend decision",
                        "বোর্ড মিটিং ঘোষণা — লভ্যাংশের প্রত্যাশায় বাজার আগাম কিনছে হতে পারে"))
        dtr = m.get("days_to_record_date")
        if dtr is not None and 0 < dtr <= 15:
            cat += 0.5
            why.append((f"Record date {m['upcoming_record_date']} in {dtr}d — dividend-capture buying",
                        f"রেকর্ড ডেট {m['upcoming_record_date']}, {dtr} দিন বাকি — লভ্যাংশ পেতে কেনাকাটা"))
        if "exchange-query" in fresh:
            cat -= 0.4
            why.append(("⚠ DSE exchange query on this price move — regulator sees it as abnormal",
                        "⚠ এই মুভ নিয়ে DSE-র এক্সচেঞ্জ কোয়েরি — নিয়ন্ত্রক একে অস্বাভাবিক মনে করছে"))
        if cat <= 0 and not fresh:
            why.append(("⚠ No announcement behind the spike — could be pure speculation",
                        "⚠ স্পাইকের পেছনে কোনো ঘোষণা নেই — নিছক জল্পনাও হতে পারে"))
    else:
        if "audit-concern" in fresh or "audit-concern" in (m.get("flags") or []):
            cat += 0.5
            why.append(("Auditor concern behind the drop — a real reason to stay away",
                        "পতনের পেছনে অডিটরের উদ্বেগ — দূরে থাকার প্রকৃত কারণ"))
        if "financials" in fresh:
            cat += 0.35
            why.append(("Weak financial results behind the drop",
                        "পতনের পেছনে দুর্বল আর্থিক ফলাফল"))
        if "exchange-query" in fresh:
            cat += 0.4
            why.append(("DSE exchange query on this price move — regulator flagged it as abnormal",
                        "এই মুভ নিয়ে DSE-র এক্সচেঞ্জ কোয়েরি — নিয়ন্ত্রক একে অস্বাভাবিক চিহ্নিত করেছে"))
        if "category-change" in fresh:
            cat += 0.3
        dtr = m.get("days_to_record_date")
        if dtr is not None and 0 <= dtr <= 3:
            cat -= 0.3  # likely the ex-dividend adjustment, not a real breakdown
            why.append((f"Likely the ex-dividend adjustment (record date {m.get('upcoming_record_date')}) — not necessarily bad news",
                        f"সম্ভবত এক্স-ডিভিডেন্ড সমন্বয় (রেকর্ড ডেট {m.get('upcoming_record_date')}) — খারাপ খবর নাও হতে পারে"))
        if cat <= 0 and not fresh:
            why.append(("⚠ No bad news behind the drop — often a panic overreaction that bounces back",
                        "⚠ পতনের পেছনে কোনো খারাপ খবর নেই — প্রায়ই আতঙ্কের অতিরিক্ত প্রতিক্রিয়া, যা ফিরে আসে"))

    hist = clamp(((m.get("win_rate") or 45) - 40) / 40)

    score = 100 * (0.25 * volume + 0.20 * room + 0.20 * clamp(trend)
                   + 0.20 * clamp(cat) + 0.15 * hist)
    flags = set(m.get("flags") or [])
    if flags & {"trading-halt", "audit-concern"}:
        score = min(score, 5)
        why.append(("⚠ Hard risk flag — do not chase this move",
                    "⚠ গুরুতর ঝুঁকি-চিহ্ন — এই মুভের পেছনে ছুটবেন না"))
    if m.get("category") == "Z":
        score *= 0.5
    if "illiquid" in flags:
        score *= 0.7
    score = round(score, 1)
    if up:
        label = ("Likely to continue" if score >= 60
                 else "Mixed — wait for confirmation" if score >= 40
                 else "Likely to fade")
    else:
        label = ("Likely to continue falling" if score >= 60
                 else "Mixed — wait for confirmation" if score >= 40
                 else "Likely to bounce")
    pairs = why[:5]
    return score, label, [p[0] for p in pairs], [p[1] for p in pairs]


REGIME_LABEL_EN = {"downtrend": "downtrend", "uptrend": "uptrend", "range": "sideways range"}
REGIME_LABEL_BN = {"downtrend": "নিম্নমুখী প্রবণতা", "uptrend": "ঊর্ধ্বমুখী প্রবণতা", "range": "পার্শ্ববর্তী সীমা"}


def regime_break_score(m, rb):
    """0–100 conviction that a long-held trend/range break is real, plus
    (english, বাংলা) reasons — confirmed by volume, momentum, candles and
    divergence the same way every other score in this file is."""
    why = []
    up = rb["direction"] == "up"
    regime_en, regime_bn = REGIME_LABEL_EN[rb["regime"]], REGIME_LABEL_BN[rb["regime"]]
    span = f"{rb['regime_start']} to {rb['regime_end']}"
    why.append((
        f"Was in a {'clean' if rb['regime'] != 'range' else 'tight'} {regime_en} for "
        f"{rb['regime_sessions']} sessions ({span}) — this is the first break of it in the last "
        f"{max(rb['break_days_ago'], 1)} session(s)",
        f"{rb['regime_sessions']} সেশন ধরে {regime_bn}-এ ছিল ({span}) — গত "
        f"{max(rb['break_days_ago'], 1)} সেশনে প্রথমবার তা ভেঙেছে"))

    conf = 1 + (rb["break_days_ago"] <= 2) + (abs(rb["z_score"]) >= 3.0)

    vt = m.get("vol_ratio") or 1
    volume = clamp((vt - 0.8) / 2.2)
    if vt >= 1.5:
        why.append((f"Volume {vt:.1f}× the 30-day average confirms real participation, not noise",
                    f"ভলিউম ৩০ দিনের গড়ের {vt:.1f} গুণ — নিছক শব্দ নয়, প্রকৃত অংশগ্রহণ"))
        conf = min(3, conf + 1)
    else:
        why.append((f"⚠ Volume only {vt:.1f}× average — the break lacks a volume signature so far",
                    f"⚠ ভলিউম গড়ের মাত্র {vt:.1f} গুণ — ব্রেকের সাথে এখনো ভলিউমের সমর্থন নেই"))

    momentum = 0.0
    if up and (m.get("macd_hist") or 0) > 0:
        momentum += 0.5
        why.append(("MACD already confirms — turned bullish", "MACD ইতিমধ্যে নিশ্চিত করছে — বুলিশ হয়েছে"))
    elif not up and (m.get("macd_hist") or 0) < 0:
        momentum += 0.5
        why.append(("MACD already confirms — turned bearish", "MACD ইতিমধ্যে নিশ্চিত করছে — বিয়ারিশ হয়েছে"))
    if up and m.get("divergence") == "bullish":
        momentum += 0.3
    if not up and m.get("divergence") == "bearish":
        momentum += 0.3
    if up and m.get("candle_pattern") in ("hammer", "bullish-engulfing"):
        momentum += 0.2
        why.append((f"Fresh {m['candle_pattern'].replace('-', ' ')} candle right at the break",
                    f"ব্রেকের ঠিক মুহূর্তে নতুন {m['candle_pattern'].replace('-', ' ')} ক্যান্ডেল"))
    if not up and m.get("candle_pattern") in ("shooting-star", "bearish-engulfing"):
        momentum += 0.2
        why.append((f"Fresh {m['candle_pattern'].replace('-', ' ')} candle right at the break",
                    f"ব্রেকের ঠিক মুহূর্তে নতুন {m['candle_pattern'].replace('-', ' ')} ক্যান্ডেল"))

    score = 100 * (0.40 * clamp(abs(rb["z_score"]) / 4) + 0.30 * volume + 0.30 * clamp(momentum))
    flags = set(m.get("flags") or [])
    if flags & {"trading-halt", "audit-concern"}:
        score = min(score, 5)
        why.append(("⚠ Hard risk flag — do not chase this break", "⚠ গুরুতর ঝুঁকি-চিহ্ন — এই ব্রেকের পেছনে ছুটবেন না"))
    score = round(score, 1)

    if rb["regime"] == "range":
        label = ("Breakout" if up else "Breakdown")
    else:
        label = ("Reversal likely" if score >= 55 else "Early reversal — watch for confirmation")
    conf = min(3, conf)
    pairs = why[:5]
    return score, label, conf, [p[0] for p in pairs], [p[1] for p in pairs]


def build_spike(results, today):
    # market date = latest date a meaningful share of tickers traded on — a
    # single stray row (odd-lot listing, partial fetch) must not define it
    counts = {}
    for m in results.values():
        counts[m["last_date"]] = counts.get(m["last_date"], 0) + 1
    floor = max(5, len(results) // 20)
    real = [d for d, n in counts.items() if n >= floor]
    market_date = max(real) if real else (max(counts) if counts else None)

    spikes = []
    for code, m in results.items():
        if m["last_date"] != market_date:
            continue
        rs = m.get("recent_spike")
        if not rs:
            continue
        score, label, why, why_bn = spike_score(m, today, rs)
        spikes.append({
            "code": code, "price": m["price"], "ycp": m.get("ycp"), "sector": m.get("sector"),
            "category": m.get("category"),
            "direction": rs["direction"], "days_ago": rs["days_ago"],
            "change_pct": rs["change_pct"], "spike_date": rs["date"],
            "price_on_spike_day": rs["price_that_day"],
            "day_change": m.get("day_change"), "intraday_change": m.get("intraday_change"),
            "vol_today_ratio": m.get("vol_today_ratio"), "rsi14": m.get("rsi14"),
            "dist_resistance": m.get("dist_resistance"), "dist_support": m.get("dist_support"),
            "score": score, "label": label, "why": why, "why_bn": why_bn,
            "flags": m.get("flags") or [], "eligible": m["eligible"],
            "record_date": m.get("upcoming_record_date"),
        })
    # today's freshest first; ties (same day) broken by price, highest first
    spikes.sort(key=lambda s: (s["days_ago"], -s["price"]))

    # trend/range breaks: a share that held a clean pattern for a long time
    # and just broke it in the last few sessions — a different kind of "alert
    # something changed" than a same-day price jump, so it doesn't need
    # today's single-day % move to qualify, and can coexist with an entry in
    # `spikes` above (both are independently informative).
    trend_breaks = []
    for code, m in results.items():
        if m["last_date"] != market_date:
            continue
        if not m["eligible"]:      # a "breakout" on an illiquid bond/fund is just noise
            continue
        rb = m.get("regime_break")
        if not rb:
            continue
        score, label, conf, why, why_bn = regime_break_score(m, rb)
        trend_breaks.append({
            "regime": rb["regime"], "direction": rb["direction"],
            "regime_sessions": rb["regime_sessions"], "days_ago": rb["break_days_ago"],
            "regime_start": rb["regime_start"], "regime_end": rb["regime_end"],
            "code": code, "price": m["price"], "ycp": m.get("ycp"), "sector": m.get("sector"),
            "category": m.get("category"), "day_change": m.get("day_change"),
            "intraday_change": m.get("intraday_change"),
            "vol_today_ratio": m.get("vol_today_ratio"), "rsi14": m.get("rsi14"),
            "dist_resistance": m.get("dist_resistance"),
            "score": score, "label": label, "conf": conf, "why": why, "why_bn": why_bn,
            "flags": m.get("flags") or [], "eligible": m["eligible"],
            "record_date": m.get("upcoming_record_date"),
        })
    trend_breaks.sort(key=lambda s: (s["days_ago"], -s["price"]))

    return {"date": market_date, "min_pct": SPIKE_MIN_PCT, "lookback": SPIKE_LOOKBACK,
            "spikes": spikes, "trend_breaks": trend_breaks}


# ================= MARKET WISDOM (cross-signal pass) =================
# Classic market rules layered on the composite before final verdicts:
# buy low (lower-margin share with reversal evidence), don't chase tops
# (higher-margin share with fall risk), respect a backed spike, and never
# chase an unbacked one. Adjusts composite ± and re-derives the verdict.
def apply_market_wisdom(results, spike, margin):
    sp = {s["code"]: s for s in spike["spikes"]}
    # wisdom is anchored to the long view: the 2-year window's extremes
    mt = margin["tickers"]
    lo = {e["code"]: mt[e["code"]] for e in margin["windows"]["2y"]["lower"]}
    hi = {e["code"]: mt[e["code"]] for e in margin["windows"]["2y"]["higher"]}
    for code, m in results.items():
        adj = 0.0
        notes = []
        s = sp.get(code)
        if s:
            when = "today" if s["days_ago"] == 0 else f"{s['days_ago']}d ago"
            when_bn = "আজ" if s["days_ago"] == 0 else f"{s['days_ago']} দিন আগে"
            if s["direction"] == "up":
                if s["score"] >= 60:
                    adj += 3
                    notes.append((
                        f"Spiked {s['change_pct']:+.1f}% {when} with volume/catalyst backing — "
                        f"continuation score {s['score']:.0f}/100",
                        f"{when_bn} {s['change_pct']:+.1f}% স্পাইক করেছে ভলিউম/উপলক্ষের সমর্থনসহ — "
                        f"ধারাবাহিকতা স্কোর {s['score']:.0f}/100"))
                elif s["score"] < 40:
                    adj -= 4
                    m["flags"].append("spike-fade-risk")
                    notes.append((
                        f"The {s['change_pct']:+.1f}% spike {when} looks unbacked "
                        f"(continuation score only {s['score']:.0f}/100) — don't chase it",
                        f"{when_bn} {s['change_pct']:+.1f}% স্পাইকটি সমর্থনহীন মনে হচ্ছে "
                        f"(স্কোর মাত্র {s['score']:.0f}/100) — পেছনে ছুটবেন না"))
            else:
                if s["score"] >= 60:
                    adj -= 4
                    m["flags"].append("spike-down-risk")
                    notes.append((
                        f"Dropped {s['change_pct']:.1f}% {when} with signs the decline continues — "
                        f"continuation score {s['score']:.0f}/100",
                        f"{when_bn} {s['change_pct']:.1f}% পড়েছে, পতন চলতে থাকার লক্ষণসহ — "
                        f"ধারাবাহিকতা স্কোর {s['score']:.0f}/100"))
                elif s["score"] < 40:
                    adj += 2
                    notes.append((
                        f"The {s['change_pct']:.1f}% drop {when} looks like a panic overreaction "
                        f"(continuation score only {s['score']:.0f}/100) — often bounces back",
                        f"{when_bn} {s['change_pct']:.1f}% পতন আতঙ্কের অতিরিক্ত প্রতিক্রিয়া মনে হচ্ছে "
                        f"(স্কোর মাত্র {s['score']:.0f}/100) — প্রায়ই ফিরে আসে"))
        e = lo.get(code)
        if e and e["rise_score"] >= 55:
            adj += 4
            notes.append((
                f"Bottom of its 2-year range WITH reversal evidence (rise score "
                f"{e['rise_score']:.0f}/100) — buying low instead of chasing high",
                f"২ বছরের সীমার তলানিতে, ঘুরে দাঁড়ানোর প্রমাণসহ (রাইজ স্কোর "
                f"{e['rise_score']:.0f}/100) — চড়া দামের পেছনে না ছুটে সস্তায় কেনা"))
        h = hi.get(code)
        if h and h["fall_score"] >= 50:
            adj -= 6
            m["flags"].append("top-of-range")
            notes.append((
                f"Top of its 2-year range with fall risk {h['fall_score']:.0f}/100 — "
                f"a profit-taking zone, not an entry zone",
                f"২ বছরের সীমার চূড়ায়, পতনের ঝুঁকি {h['fall_score']:.0f}/100 — "
                f"এটি মুনাফা তোলার জায়গা, ঢোকার নয়"))
        m["wisdom"] = notes
        if adj:
            m["composite"] = round(clamp(m["composite"] + adj, 0, 100), 1)
        # re-derive verdict & plan with the adjusted composite (same thresholds
        # as recommend, plus top-of-range blocks Strong Buy like overbought)
        flags = set(m["flags"])
        blocked = flags & {"overbought", "extended-rally", "top-of-range"}
        if not m["eligible"]:
            v = "Avoid"
        elif m["composite"] >= 72 and not blocked:
            v = "Strong Buy"
        elif m["composite"] >= 62:
            v = "Buy"
        elif m["composite"] >= 52:
            v = "Watch"
        else:
            v = "Neutral"
        m["verdict"] = v
        if v in ("Strong Buy", "Buy"):
            m["plan"] = (f"Enter near {m['price']:.1f}; "
                         f"book profit around {m['target_price']:.1f} (+{m['target_pct']:.0f}%); "
                         f"exit below {m['stop_price']:.1f} (−{m['stop_pct']:.0f}%) to cap losses")
        else:
            m["plan"] = None


def build_pick_why(m):
    """Detailed, data-backed reasons for the suggestion tables — parallel
    (english, বাংলা) lists built from structured fields so both stay in sync."""
    en, bn = [], []

    def add(e, b):
        en.append(e)
        bn.append(b)

    price = m["price"]
    r1w, r1m = m.get("r_1w") or 0, m.get("r_1m") or 0
    if m.get("sma20") and m.get("sma50") and price > m["sma20"] > m["sma50"]:
        add(f"Clean uptrend — price above SMA20 above SMA50, {r1m:+.1f}% in 1 month, {r1w:+.1f}% this week",
            f"পরিষ্কার ঊর্ধ্বগতি — দাম > SMA20 > SMA50, ১ মাসে {r1m:+.1f}%, এই সপ্তাহে {r1w:+.1f}%")
    elif m.get("sma50") and price > m["sma50"]:
        add(f"Medium-term trend intact (above SMA50), {r1m:+.1f}% in 1 month",
            f"মধ্যমেয়াদি প্রবণতা অটুট (SMA50-এর উপরে), ১ মাসে {r1m:+.1f}%")
    rel = m.get("rel_1m") or 0
    if rel > 2:
        add(f"Beating the market average by {rel:.1f}% over the last month",
            f"গত এক মাসে বাজারের গড়কে {rel:.1f}% ব্যবধানে হারাচ্ছে")
    if m.get("candle_pattern") in ("hammer", "bullish-engulfing"):
        cp = m["candle_pattern"].replace("-", " ")
        add(f"Fresh {cp} candle today — a classic bullish reversal signal",
            f"আজ {cp} ক্যান্ডেল — ক্লাসিক বুলিশ রিভার্সাল সংকেত")
    if (m.get("dist_key_support") is not None and m["dist_key_support"] <= 3
            and (m.get("key_support_touches") or 0) >= 2):
        add(f"Sitting on a real support level touched {m['key_support_touches']}× before",
            f"একটি প্রকৃত সাপোর্ট স্তরে আছে যা আগে {m['key_support_touches']}বার স্পর্শ করেছে")
    rsi14 = m.get("rsi14")
    if rsi14 is not None and 45 <= rsi14 <= 65:
        add(f"RSI {rsi14:.0f} — rising with room to run, not yet overbought",
            f"RSI {rsi14:.0f} — বাড়ছে কিন্তু এখনো অতিরিক্ত কেনা নয়, জায়গা আছে")
    vr = m.get("vol_ratio")
    if vr and vr >= 1.3:
        add(f"Volume {vr:.1f}× its 30-day average — fresh buyers stepping in",
            f"ভলিউম ৩০ দিনের গড়ের {vr:.1f} গুণ — নতুন ক্রেতা ঢুকছে")
    elif (m.get("accum_20d") or 0) >= 0.25:
        add(f"Quiet OBV accumulation ({m['accum_20d']:+.2f}) before the price moves",
            f"দাম বড় ওঠার আগে নীরব OBV সঞ্চয় ({m['accum_20d']:+.2f})")
    fund = []
    fund_bn = []
    eps_disp = m.get("eps_annual") or m.get("eps")
    if (eps_disp or 0) > 0:
        fund.append(f"EPS {eps_disp:.1f}")
        fund_bn.append(f"EPS {eps_disp:.1f}")
    if m.get("pe") and 0 < m["pe"] <= 25:
        fund.append(f"fair P/E {m['pe']:.1f}")
        fund_bn.append(f"যুক্তিসঙ্গত P/E {m['pe']:.1f}")
    if m.get("dividend_yield"):
        fund.append(f"{m['dividend_yield']:.1f}% dividend yield")
        fund_bn.append(f"{m['dividend_yield']:.1f}% লভ্যাংশ ফলন")
    if m.get("category") == "A":
        fund.append("category A")
        fund_bn.append("A ক্যাটাগরি")
    if len(fund) >= 2:
        add("Solid fundamentals: " + ", ".join(fund),
            "মজবুত মৌলভিত্তি: " + ", ".join(fund_bn))
    p_nav = m.get("p_nav")
    if p_nav is not None and 0 < p_nav < 1 and (eps_disp or 0) > 0:
        add(f"Trading below book value — P/NAV {p_nav:.2f} (NAV {m['nav_per_share']:.1f} vs price {price:.1f})",
            f"বুক ভ্যালুর নিচে লেনদেন হচ্ছে — P/NAV {p_nav:.2f} (NAV {m['nav_per_share']:.1f}, দাম {price:.1f})")
    ht = m.get("holding_trend_3m")
    if ht is not None and ht >= 1.5:
        add(f"Institutional/foreign holding rising (+{ht:.1f}pp over recent snapshots) — smart money accumulating",
            f"প্রাতিষ্ঠানিক/বিদেশি মালিকানা বাড়ছে (+{ht:.1f}pp) — বড় বিনিয়োগকারীরা কিনছে")
    if m.get("eps_trend") == "turned-profitable":
        add("Turned profitable in the latest reported quarter — an inflection point",
            "সর্বশেষ প্রান্তিকে লাভজনক হয়েছে — একটি গুরুত্বপূর্ণ মোড়")
    elif m.get("eps_trend") == "up" and (m.get("eps_qoq_growth") or 0) > 5:
        add(f"Quarterly EPS growing ({m['eps_qoq_growth']:+.0f}% vs the prior reported quarter)",
            f"প্রান্তিক EPS বাড়ছে (আগের প্রান্তিকের তুলনায় {m['eps_qoq_growth']:+.0f}%)")
    if (m.get("win_rate") or 0) >= 60 and (m.get("signal_trades") or 0) >= 5:
        add(f"Reliable history — past buy signals won {m['win_rate']}% of the time "
            f"({m['signal_trades']} trades in 2 years)",
            f"নির্ভরযোগ্য ইতিহাস — অতীতের কেনার সংকেত {m['win_rate']}% সময় সফল "
            f"(২ বছরে {m['signal_trades']}টি)")
    dtr = m.get("days_to_record_date")
    if dtr is not None and 0 < dtr <= 20 and m.get("upcoming_dividend_pct"):
        add(f"Record date {m['upcoming_record_date']} in {dtr}d — buy before it to capture "
            f"the {m['upcoming_dividend_pct']:.0f}% dividend",
            f"রেকর্ড ডেট {m['upcoming_record_date']}, {dtr} দিন বাকি — আগে কিনলে "
            f"{m['upcoming_dividend_pct']:.0f}% লভ্যাংশ পাবেন")
    if m.get("higher_lows"):
        add("Higher-lows pattern — buyers defending every dip at a higher price",
            "ক্রমশ উঁচু লো — প্রতিটি পতনে ক্রেতারা আরও উঁচু দামে কিনে নিচ্ছে")
    for e_, b_ in m.get("wisdom") or []:
        add(e_, b_)
    if not en:
        add("No strong edge right now — scores are middling across the board",
            "এই মুহূর্তে বিশেষ সুবিধা নেই — সব সূচকই মাঝারি মানের")
    return en[:5], bn[:5]


# ================= REPORT CARD (self-grading) =================
# Every analysis run snapshots what it recommended (by market date). Later
# runs grade those snapshots against what prices actually did over the next
# 1w/2w/1m — win rates and average returns per category, next to the market
# baseline. The app grades itself so you know which calls to trust.
RC_HORIZONS = {"1w": 5, "2w": 10, "1m": 21}
RC_KEEP_SNAPSHOTS = 150
RC_WIN_THRESHOLD = 2.0     # a "win" = more than +2% over the horizon


def snapshot_and_grade(results, top20, high_profit, market_date, series_cache):
    hist = load_json(REC_HISTORY_JSON, {}) or {}
    hist[market_date] = {
        "strong_buy": [c for c, m in results.items() if m["verdict"] == "Strong Buy"],
        "buy": [c for c, m in results.items() if m["verdict"] == "Buy"],
        "top20": list(top20),
        "high_profit": [p["code"] for p in high_profit["picks"]],
        # point-price predictions snapshotted alongside the categorical picks
        # so pred_accuracy below can grade them against what actually happened —
        # same self-grading principle as the rest of the report card, just for
        # a price forecast instead of a buy/sell call.
        "pred": {c: {"price": results[c]["price"],
                     "pred_1w": results[c].get("pred_1w_price"),
                     "pred_1m": results[c].get("pred_1m_price")}
                 for c in top20 if results[c].get("pred_1w_price") is not None},
    }
    for d in sorted(hist)[:-RC_KEEP_SNAPSHOTS]:
        del hist[d]
    save_json(REC_HISTORY_JSON, hist)

    date_idx = {t: {d: i for i, d in enumerate(ds)}
                for t, (ds, cs) in series_cache.items()}

    def fwd_return(code, d, nd):
        s = series_cache.get(code)
        if not s:
            return None
        ds, cs = s
        i = date_idx[code].get(d)
        if i is None or i + nd >= len(cs) or cs[i] <= 0:
            return None
        return (cs[i + nd] / cs[i] - 1) * 100

    cats = {k: {h: [] for h in RC_HORIZONS}
            for k in ("strong_buy", "buy", "top20", "high_profit")}
    base = {h: [] for h in RC_HORIZONS}
    graded = set()
    for d, snap in hist.items():
        if d >= market_date:
            continue
        for h, nd in RC_HORIZONS.items():
            rets = [r for r in (fwd_return(c, d, nd) for c in series_cache)
                    if r is not None]
            if rets:
                base[h].append(sum(rets) / len(rets))
                graded.add(d)
        for cat in cats:
            for c in snap.get(cat, []):
                for h, nd in RC_HORIZONS.items():
                    r = fwd_return(c, d, nd)
                    if r is not None:
                        cats[cat][h].append(r)

    def agg(vals):
        if not vals:
            return None
        wins = sum(1 for v in vals if v > RC_WIN_THRESHOLD)
        return {"n": len(vals), "avg": round(sum(vals) / len(vals), 2),
                "win_rate": round(100 * wins / len(vals))}

    # Pred. 1w/1m accuracy: honest, backtested grading of the point-price
    # forecast (forecast.py's deterministic drift+seasonal curve) against what
    # the share's price actually did — same self-grading principle as the
    # categories above, but tracking predicted vs actual % change and price
    # direction instead of a buy/sell call.
    pred_pairs = {"1w": [], "1m": []}
    for d, snap in hist.items():
        if d >= market_date:
            continue
        for c, p in snap.get("pred", {}).items():
            snap_price = p.get("price")
            if not snap_price:
                continue
            for h, nd, pred_key in (("1w", RC_HORIZONS["1w"], "pred_1w"),
                                    ("1m", RC_HORIZONS["1m"], "pred_1m")):
                pred_price = p.get(pred_key)
                actual_pct = fwd_return(c, d, nd)
                if pred_price is None or actual_pct is None:
                    continue
                predicted_pct = (pred_price / snap_price - 1) * 100
                pred_pairs[h].append((predicted_pct, actual_pct))

    def agg_pred(pairs):
        if not pairs:
            return None
        n = len(pairs)
        mae = sum(abs(a - p) for p, a in pairs) / n
        same_dir = sum(1 for p, a in pairs if (p > 0) == (a > 0))
        pct_actual_up = sum(1 for _, a in pairs if a > 0) / n * 100
        return {
            "n": n,
            "mae_pct": round(mae, 2),
            "direction_accuracy": round(100 * same_dir / n),
            "always_up_baseline": round(pct_actual_up),  # accuracy a naive "always predict up" guess would get
            "avg_predicted_pct": round(sum(p for p, _ in pairs) / n, 2),
            "avg_actual_pct": round(sum(a for _, a in pairs) / n, 2),
        }

    return {
        "snapshots": len(hist),
        "graded_snapshots": len(graded),
        "first_date": min(hist) if hist else None,
        "win_threshold": RC_WIN_THRESHOLD,
        "categories": {cat: {h: agg(v) for h, v in hs.items()}
                       for cat, hs in cats.items()},
        "baseline": {h: (round(sum(v) / len(v), 2) if v else None)
                     for h, v in base.items()},
        "pred_accuracy": {h: agg_pred(v) for h, v in pred_pairs.items()},
    }


# ================= BETA (risk vs the market) =================
def build_market_returns(series_cache):
    """Equal-weighted average daily % return across every tracked share, by
    date — a synthetic market index for beta. The real DSEX history only
    accumulates on days someone clicks Update Data, far too sparse for a
    180-session regression; this uses the full 2-year price history instead."""
    by_date = {}
    for dates, closes in series_cache.values():
        for i in range(1, len(closes)):
            if closes[i - 1] > 0:
                by_date.setdefault(dates[i], []).append((closes[i] / closes[i - 1] - 1) * 100)
    return {d: sum(v) / len(v) for d, v in by_date.items() if len(v) >= 20}


def compute_beta(dates, closes, market_returns, window=180):
    """Beta vs the equal-weighted market return series, from the last
    `window` sessions with a matching market observation. Capped to [-2, 4]
    — an illiquid share's raw regression can swing wildly from a couple of
    abnormal days; beyond that range it's noise, not systematic risk."""
    n = len(closes)
    if n < 40:
        return None
    start = max(1, n - window)
    xs, ys = [], []
    for i in range(start, n):
        if closes[i - 1] <= 0:
            continue
        mr = market_returns.get(dates[i])
        if mr is None:
            continue
        xs.append(mr)
        ys.append((closes[i] / closes[i - 1] - 1) * 100)
    if len(xs) < 40:
        return None
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    var = sum((x - mx) ** 2 for x in xs) / (len(xs) - 1)
    if var <= 0:
        return None
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (len(xs) - 1)
    return round(max(-2.0, min(4.0, cov / var)), 2)


# ================= SEASONALITY (context, not a signal) =================
def build_seasonality(series_cache):
    """Market-wide seasonality: average daily % return grouped by calendar
    month across every tracked share's full history — informational context
    only, never fed into a score. Scaled by ~21 trading sessions to read as
    an approximate 'monthly' figure."""
    sums, counts = {}, {}
    for dates, closes in series_cache.values():
        for i in range(1, len(closes)):
            if closes[i - 1] <= 0:
                continue
            mon = int(dates[i][5:7])
            sums[mon] = sums.get(mon, 0.0) + (closes[i] / closes[i - 1] - 1) * 100
            counts[mon] = counts.get(mon, 0) + 1
    return {mon: {"avg_daily": round(sums[mon] / counts[mon], 3),
                  "approx_monthly": round(sums[mon] / counts[mon] * 21, 1),
                  "n": counts[mon]}
            for mon in sums if counts[mon] >= 50}


def ticker_month_seasonality(dates, closes, month):
    """Same idea, restricted to one share and one calendar month — shown in
    the detail view as context, explicitly with its sample size."""
    total, n = 0.0, 0
    for i in range(1, len(closes)):
        if closes[i - 1] <= 0:
            continue
        if int(dates[i][5:7]) == month:
            total += (closes[i] / closes[i - 1] - 1) * 100
            n += 1
    if n < 10:
        return None
    return {"avg_daily": round(total / n, 3), "approx_monthly": round(total / n * 21, 1), "n": n}


def run_analysis():
    tick_cache = load_tickers()
    tickers = tick_cache["tickers"]
    profiles = load_json(PROFILES_JSON, {}) or {}
    companies = profiles.get("companies", {})
    pe_map = profiles.get("pe", {})
    fund_hist = load_json(FUNDAMENTALS_HISTORY_JSON, {}) or {}
    history = load_history()
    today = date.today()
    announcements = (load_json(ANNOUNCEMENTS_JSON, {}) or {}).get("by_ticker", {})
    agm_notices = (load_json(AGM_JSON, {}) or {}).get("by_ticker", {})

    results = {}
    series_cache = {}
    for t in tickers:
        rows = history.get(t)
        if not rows:
            continue
        m = analyze_ticker(t, rows, companies.get(t), pe_map, today, fund_hist.get(t))
        if m:
            m["_code"] = t
            series_cache[t] = m.pop("_series")
            results[t] = m

    # beta (vs an equal-weighted synthetic market index) + seasonality
    # context — both need the full series_cache, so run right after it fills
    market_returns = build_market_returns(series_cache)
    seasonality = build_seasonality(series_cache)
    for t, m in results.items():
        dates, closes = series_cache[t]
        m["beta"] = compute_beta(dates, closes, market_returns)
        m["season_this_month"] = ticker_month_seasonality(dates, closes, today.month)

    # sector-average valuation — "cheap/expensive relative to its own peers,"
    # the achievable version of historical-band comparison (only 2 years of
    # price history is stored, too short for a meaningful 5-10yr P/E band).
    # sector/pe/p_nav/dividend_yield are already set per-ticker above, so this
    # only needs the completed results dict — no dependency on flags/eligible,
    # which recommend() hasn't set yet at this point in the pipeline.
    sector_pe, sector_pnav, sector_dy = {}, {}, {}
    for m in results.values():
        sec = m.get("sector")
        if not sec:
            continue
        if m.get("pe") and m["pe"] > 0:
            sector_pe.setdefault(sec, []).append(m["pe"])
        if m.get("p_nav") and m["p_nav"] > 0:
            sector_pnav.setdefault(sec, []).append(m["p_nav"])
        if m.get("dividend_yield"):
            sector_dy.setdefault(sec, []).append(m["dividend_yield"])
    avg = lambda vals: round(sum(vals) / len(vals), 2) if vals else None
    for m in results.values():
        sec = m.get("sector")
        m["sector_avg_pe"] = avg(sector_pe.get(sec, []))
        m["sector_avg_pnav"] = avg(sector_pnav.get(sec, []))
        m["sector_avg_dividend_yield"] = avg(sector_dy.get(sec, []))

    # second pass: relative strength vs market, then the recommendation layer
    r1m_all = [m["r_1m"] for m in results.values() if m.get("r_1m") is not None]
    market_r1m = sum(r1m_all) / len(r1m_all) if r1m_all else 0
    for t, m in results.items():
        m["rel_1m"] = round((m.get("r_1m") or 0) - market_r1m, 2)
        apply_news_and_agm(m, t, announcements, agm_notices, today)
        recommend(m, companies.get(t))

    # cross-signal pass: every share checked against today's spikes and its
    # 2-year range extremes before the final verdicts and pick lists
    spike = build_spike(results, today)
    margin = build_margin(results, today)
    apply_market_wisdom(results, spike, margin)
    for t, m in results.items():
        buy_plan(m, today)
        m["why"], m["why_bn"] = build_pick_why(m)

    top20 = pick_top(results, n=20, sector_cap=3)

    # 1w/1m predicted price for every share (not just Top 20 — the AI
    # Prediction Chart tab lists the full universe), read from forecast.py's
    # deterministic projection (see forecast.py's docstring — drift + damped
    # seasonal shape, not machine learning; "AI Pred." is a UI label, not a
    # claim about the underlying method). Sync always regenerates that
    # projection before analysis runs, so it reflects the same fresh history
    # used here.
    potential = load_potential()
    for code, m in results.items():
        fut = potential.get(code)
        if fut and len(fut) >= TRADING_DAYS["1m"]:
            pred_1w = fut[TRADING_DAYS["1w"] - 1][1]
            pred_1m = fut[TRADING_DAYS["1m"] - 1][1]
            m["pred_1w_price"] = pred_1w
            m["pred_1m_price"] = pred_1m
            m["pred_1w_pct"] = round((pred_1w / m["price"] - 1) * 100, 2) if m["price"] else None
            m["pred_1m_pct"] = round((pred_1m / m["price"] - 1) * 100, 2) if m["price"] else None
        else:
            m["pred_1w_price"] = m["pred_1m_price"] = None
            m["pred_1w_pct"] = m["pred_1m_pct"] = None

    # market breadth (structural, our own dataset — secondary confirmation)
    equities = [m for m in results.values() if "not-equity" not in m["flags"]]
    above50 = [m for m in equities if m.get("sma50") and m["price"] > m["sma50"]]
    above200 = [m for m in equities if m.get("sma200") and m["price"] > m["sma200"]]
    pct50 = round(100 * len(above50) / len(equities)) if equities else 0
    pct200 = round(100 * len(above200) / len(equities)) if equities else 0

    # official market snapshot (DSEX/DS30/DSES index, turnover, breadth, cap) —
    # scraped from the DSE homepage + market-statistics.php each sync. This is
    # the primary regime signal: the real exchange-wide index and today's
    # official advance/decline count, not a proxy from our own tracked shares.
    mkt_hist = load_json(MARKET_HISTORY_JSON, {}) or {}
    market = None
    if mkt_hist:
        latest_date = max(mkt_hist)
        snap = mkt_hist[latest_date]
        dsex = snap.get("indices", {}).get("DSEX")
        adv_all = snap.get("categories", {}).get("All")
        market = {
            "date": latest_date, "as_of": snap.get("as_of_text"),
            "indices": snap.get("indices"),
            "total_trades": snap.get("total_trades"), "total_volume": snap.get("total_volume"),
            "total_value_mn": snap.get("total_value_mn"),
            "advanced": adv_all["advanced"] if adv_all else snap.get("advanced"),
            "declined": adv_all["declined"] if adv_all else snap.get("declined"),
            "unchanged": adv_all["unchanged"] if adv_all else snap.get("unchanged"),
            "categories": snap.get("categories"),
            "market_cap": snap.get("market_cap"),
        }
        # 5-session DSEX trend, if history has accumulated
        dates = sorted(mkt_hist)
        levels = [mkt_hist[d].get("indices", {}).get("DSEX", {}).get("level")
                 for d in dates if mkt_hist[d].get("indices", {}).get("DSEX")]
        levels = [l for l in levels if l is not None]
        market["dsex_history"] = list(zip([d for d in dates if mkt_hist[d].get("indices", {}).get("DSEX")], levels))[-60:]

        if dsex and adv_all and adv_all["advanced"] + adv_all["declined"] > 0:
            breadth_ratio = adv_all["advanced"] / (adv_all["advanced"] + adv_all["declined"])
            if dsex["change_pct"] > 0.3 and breadth_ratio > 0.55:
                regime = "Bullish"
            elif dsex["change_pct"] < -0.3 and breadth_ratio < 0.45:
                regime = "Bearish"
            else:
                regime = "Neutral"
        else:
            regime = "Bullish" if pct50 >= 60 and market_r1m > 0 else ("Bearish" if pct50 <= 40 else "Neutral")
    else:
        # fallback to the structural proxy if the market snapshot isn't available yet
        regime = "Bullish" if pct50 >= 60 and market_r1m > 0 else ("Bearish" if pct50 <= 40 else "Neutral")

    # sector aggregates
    sec_agg = {}
    for m in equities:
        sec = m.get("sector")
        if not sec:
            continue
        a = sec_agg.setdefault(sec, {"count": 0, "r_1w": [], "r_1m": [], "r_3m": [],
                                     "above50": 0, "best": None, "best_score": -1})
        a["count"] += 1
        for k in ("r_1w", "r_1m", "r_3m"):
            if m.get(k) is not None:
                a[k].append(m[k])
        if m.get("sma50") and m["price"] > m["sma50"]:
            a["above50"] += 1
        if m.get("composite", 0) > a["best_score"] and m["eligible"]:
            a["best_score"] = m["composite"]
            a["best"] = m["_code"]
    sectors = []
    for name, a in sec_agg.items():
        avg = lambda xs: round(sum(xs) / len(xs), 2) if xs else None
        sectors.append({
            "name": name, "count": a["count"],
            "avg_1w": avg(a["r_1w"]), "avg_1m": avg(a["r_1m"]), "avg_3m": avg(a["r_3m"]),
            "pct_above_sma50": round(100 * a["above50"] / a["count"]) if a["count"] else 0,
            "best": a["best"], "best_score": a["best_score"] if a["best"] else None,
        })
    sectors.sort(key=lambda s: -(s["avg_1m"] if s["avg_1m"] is not None else -999))

    # company alerts: hard risks (halts, audit concerns) and the positive
    # record-date-soon catalyst (buy before this date to capture the dividend)
    alerts = {"trading_halt": [], "audit_concern": [], "record_dates_soon": []}
    for m in results.values():
        if "trading-halt" in m["flags"]:
            alerts["trading_halt"].append(m["_code"])
        if "audit-concern" in m["flags"]:
            alerts["audit_concern"].append(m["_code"])
        if m.get("days_to_record_date") is not None and m["days_to_record_date"] <= 20 and m["eligible"]:
            alerts["record_dates_soon"].append({
                "ticker": m["_code"], "days": m["days_to_record_date"],
                "record_date": m["upcoming_record_date"], "dividend_pct": m["upcoming_dividend_pct"],
            })
    alerts["record_dates_soon"].sort(key=lambda r: r["days"])

    # today's fresh signals index (eligible equities only)
    signal_index = {}
    for m in equities:
        if not m["eligible"]:
            continue
        for s in m.get("signals", []):
            signal_index.setdefault(s, []).append(m["_code"])
    for s in signal_index:
        signal_index[s].sort(key=lambda c: -results[c]["composite"])

    high_profit = build_high_profit(results, regime)
    report_card = snapshot_and_grade(results, top20, high_profit,
                                     spike["date"], series_cache)

    for m in results.values():
        del m["_code"]

    # market overview — same robust market date the spike detector derived
    # (a single stray row must not claim a newer session than the market had)
    market_date = spike["date"]
    day_rets = [m["r_1w"] for m in results.values() if m.get("r_1w") is not None]
    overview = {
        "tickers_analyzed": len(results),
        "market_date": market_date,
        "advancers_1w": sum(1 for r in day_rets if r > 0),
        "decliners_1w": sum(1 for r in day_rets if r < 0),
        "avg_return_1w": round(sum(day_rets) / len(day_rets), 2) if day_rets else None,
        "avg_return_1m": round(market_r1m, 2),
        "regime": regime,
        "pct_above_sma50": pct50,
        "pct_above_sma200": pct200,
    }

    out = {
        "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "overview": overview,
        "market": market,
        "top20": top20,
        "high_profit": high_profit,
        "margin": margin,
        "spike": spike,
        "report_card": report_card,
        "seasonality": seasonality,
        "sectors": sectors,
        "signals": signal_index,
        "alerts": alerts,
        "tickers": results,
    }
    save_json(ANALYSIS_JSON, out)
    return out


if __name__ == "__main__":
    out = run_analysis()
    ov = out["overview"]
    print(f"Analyzed {ov['tickers_analyzed']} tickers (market date {ov['market_date']}).")
    top_s = sorted(((m["score_short"], t) for t, m in out["tickers"].items()
                    if m["eligible"]), reverse=True)[:10]
    top_l = sorted(((m["score_long"], t) for t, m in out["tickers"].items()
                    if m["eligible"]), reverse=True)[:10]
    print("\nTop short-term:", ", ".join(f"{t}({s:.0f})" for s, t in top_s))
    print("Top long-term: ", ", ".join(f"{t}({s:.0f})" for s, t in top_l))
