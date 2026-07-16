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
                        MARKET_HISTORY_JSON, PROFILES_JSON, load_history,
                        load_json, load_tickers, save_json)

NEWS_LOOKBACK_DAYS = 30
CRITICAL_NEWS_CATEGORIES = {"trading-halt", "audit-concern"}

MIN_LIQUIDITY_MN = 5.0     # avg daily traded value (mn BDT) to qualify for picks
TRADING_DAYS = {"1w": 5, "2w": 10, "1m": 21, "2m": 42, "3m": 63, "6m": 126, "1y": 250}


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
    """Extract clean (dates, closes, volumes, values_mn) skipping non-traded days."""
    dates, closes, vols, vals = [], [], [], []
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
        except (ValueError, KeyError):
            continue
    return dates, closes, vols, vals


def analyze_ticker(ticker, rows, profile, pe_map, today):
    dates, closes, vols, vals = build_series(rows)
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
    m["day_change"] = round((price / ycp - 1) * 100, 2) if ycp > 0 else None
    m["intraday_change"] = round((price / openp - 1) * 100, 2) if openp > 0 else None
    m["vol_today_ratio"] = round(vols[-1] / vol30, 2) if vols and vol30 else None

    yr = closes[-250:]
    hi52, lo52 = max(yr), min(yr)
    pos52 = (price - lo52) / (hi52 - lo52) if hi52 > lo52 else 0.5
    m["hi_52w"], m["lo_52w"], m["pos_52w"] = round(hi52, 2), round(lo52, 2), round(pos52, 2)

    # full-history (up to 2y) range position — the "margin" the share trades at
    hi2, lo2 = max(closes), min(closes)
    m["hi_2y"], m["lo_2y"] = round(hi2, 2), round(lo2, 2)
    m["pos_2y"] = round((price - lo2) / (hi2 - lo2), 3) if hi2 > lo2 else None

    # support / resistance over the last quarter (~63 trading days)
    qtr = closes[-63:]
    hi3m, lo3m = max(qtr), min(qtr)
    m["dist_support"] = round((price - lo3m) / price * 100, 1) if price else None
    m["dist_resistance"] = round((hi3m - price) / price * 100, 1) if price else None

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

    # ---- fundamentals ----
    prof = profile or {}
    eps = prof.get("eps_basic")
    pe = pe_map.get(ticker)
    if pe is None and eps and eps > 0:
        pe = price / eps
    m["eps"] = eps
    m["pe"] = round(pe, 2) if pe else None
    m["sector"] = prof.get("sector")
    m["category"] = prof.get("category")
    m["dividend_pct"] = prof.get("last_cash_dividend_pct")
    # cash dividend % is on 10-taka face value → yield = pct/10 taka per share
    div_yield = (m["dividend_pct"] / 10 / price * 100) if m["dividend_pct"] and price else None
    m["dividend_yield"] = round(div_yield, 2) if div_yield else None
    is_equity = (prof.get("instrument_type") or "Equity") == "Equity"

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
        lr["fundamentals"] = f
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
    if not is_equity:
        flags.append("not-equity")
    last_dt = datetime.strptime(dates[-1], "%Y-%m-%d").date()
    if (today - last_dt).days > 7:
        flags.append("stale-data")

    m["score_short"] = round(score_short, 1)
    m["score_long"] = round(score_long, 1)
    m["reasons_short"] = s_reasons
    m["reasons_long"] = l_reasons
    m["flags"] = flags
    m["eligible"] = ("illiquid" not in flags and "not-equity" not in flags
                     and "stale-data" not in flags
                     and prof.get("category") != "Z")
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
    if (accum is not None and accum >= 0.30 and abs(r1m) <= 6 and m.get("sma50")
            and abs(price / m["sma50"] - 1) <= 0.06 and m.get("category") in ("A", "B")):
        out.append(dict(
            strategy="accumulation",
            conf=1 + (accum >= 0.5) + ((m.get("vol_ratio") or 0) >= 1.2),
            hold="4–8 weeks",
            target_pct=clamp(5 * vol, 9, 22), stop_pct=clamp(2 * vol, 3.5, 7),
            why=[f"On-balance volume rising ({accum:+.2f}) while price moved only {r1m:+.1f}% — someone is buying quietly",
                 "Price basing at SMA50 — the markup phase often follows this pattern",
                 f"Category {m['category']} company, so the accumulation is credible"]))

    # 4. Oversold rebound in a quality uptrend: buy the dip at support.
    if (rsi14 is not None and rsi14 <= 40 and m.get("sma200") and price > m["sma200"]
            and (m.get("dist_support") or 99) <= 6 and (m.get("eps") or 0) > 0):
        sma20v = m.get("sma20")
        snap = (sma20v / price - 1) * 100 if sma20v and sma20v > price else 0
        out.append(dict(
            strategy="rebound",
            conf=1 + (rsi14 <= 34) + (1 if m.get("higher_lows") else 0),
            hold="2–5 weeks",
            target_pct=clamp(snap + 5, 8, 18), stop_pct=clamp(1.8 * vol, 3, 6),
            why=[f"RSI {rsi14:.0f} oversold inside a long-term uptrend (still above SMA200)",
                 f"Only {m.get('dist_support'):.1f}% above 3-month support — a tight, defensible stop",
                 "Profitable company (EPS > 0) — dips in quality get bought"]))

    # 5. Volume-backed breakout: past resistance with real demand behind it.
    near_hi = m.get("hi_52w") and price >= 0.98 * m["hi_52w"]
    if (("breakout-3m" in signals or near_hi) and (m.get("vol_ratio") or 0) >= 1.3
            and (rsi14 or 50) <= 78):
        out.append(dict(
            strategy="breakout",
            conf=1 + ("volume-spike" in signals) + ((m.get("vol_ratio") or 0) >= 1.8),
            hold="2–6 weeks",
            target_pct=clamp(4.5 * vol, 9, 22), stop_pct=clamp(2 * vol, 3.5, 7),
            why=[("Fresh close above the 3-month high" if "breakout-3m" in signals
                  else "Pressing against its 52-week high") + " — overhead sellers are cleared out",
                 f"Volume {m['vol_ratio']:.1f}× the 30-day average confirms real demand",
                 "Volume-backed breakouts from a base tend to run for weeks"]))

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
            "code": code, "price": m["price"], "sector": m.get("sector"),
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

    accumulation = clamp(((m.get("accum_20d") or 0) + 0.2) / 0.7)

    support = clamp(1 - (m.get("dist_support") or 20) / 15)
    if (m.get("r_1w") or 0) < -2:                    # still knifing down
        support *= 0.5
    if m.get("higher_lows"):
        support = clamp(support + 0.3)

    f = 0.0                                          # is it worth catching?
    if (m.get("eps") or 0) > 0:
        f += 0.35
    f += {"A": 0.3, "B": 0.15}.get(m.get("category"), 0.0)
    if m.get("dividend_yield"):
        f += 0.2
    if (m.get("avg_value_mn_30d") or 0) >= MIN_LIQUIDITY_MN:
        f += 0.15

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

    fade = 0.0                                       # is momentum already rolling over?
    if slope < 0:
        fade += 0.5
    if (m.get("r_1w") or 0) < 0:
        fade += 0.3
    if (m.get("vol_ratio") or 1) < 0.8:
        fade += 0.2

    distribution = clamp((0.1 - (m.get("accum_20d") or 0)) / 0.6)

    v = 0.0                                          # what is the height built on?
    pe = m.get("pe")
    if pe and pe > 30:
        v += 0.5
    if (m.get("eps") or 0) <= 0:
        v += 0.3
    v += {"B": 0.2, "N": 0.2, "Z": 0.5}.get(m.get("category"), 0.0)

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
    if hist is not None and hist > 0 and ((m.get("r_1w") or 0) > 0 or slope > 0):
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


def build_margin(results, today):
    lower, higher = [], []
    for code, m in results.items():
        pos = m.get("pos_2y")
        if pos is None:
            continue
        base = {
            "code": code, "price": m["price"], "sector": m.get("sector"),
            "category": m.get("category"), "pos_2y": pos,
            "rsi14": m.get("rsi14"), "r_1w": m.get("r_1w"), "r_1m": m.get("r_1m"),
            "flags": m.get("flags") or [], "eligible": m["eligible"],
            "record_date": m.get("upcoming_record_date"),
        }
        if pos <= MARGIN_LOWER:
            when, note = margin_rise_when(m, today)
            pairs = margin_rise_reasons(m)
            lower.append(dict(
                base, score=margin_rise_score(m), turn_date=when, turn_note=note,
                from_low=round((m["price"] / m["lo_2y"] - 1) * 100, 1) if m.get("lo_2y") else None,
                why=[p[0] for p in pairs], why_bn=[p[1] for p in pairs]))
        elif pos >= MARGIN_UPPER:
            when, note = margin_fall_when(m, today)
            pairs = margin_fall_reasons(m)
            higher.append(dict(
                base, score=margin_fall_score(m), turn_date=when, turn_note=note,
                from_high=round((1 - m["price"] / m["hi_2y"]) * 100, 1) if m.get("hi_2y") else None,
                why=[p[0] for p in pairs], why_bn=[p[1] for p in pairs]))
    lower.sort(key=lambda e: -e["score"])
    higher.sort(key=lambda e: -e["score"])
    return {"lower": lower, "higher": higher,
            "lower_threshold": MARGIN_LOWER, "higher_threshold": MARGIN_UPPER}


# ================= SPIKE DETECTOR =================
# Shares that suddenly rose a big amount TODAY — vs yesterday's close and/or
# vs today's open (the live overlay makes "now vs session start" real during
# trading hours). Each spike is scored for the chance it CONTINUES rising:
# volume backing, room to run, trend backdrop, a real catalyst, and this
# share's own history of following through.
SPIKE_MIN_PCT = 3.0          # DSE circuit is ±10%, so 3%+ in a day is a jolt
SPIKE_NEWS_DAYS = 5


def spike_score(m, today):
    """0–100 chance today's spike keeps going, with (english, বাংলা) reasons."""
    why = []
    dc = max(m.get("day_change") or 0, m.get("intraday_change") or 0)

    vt = m.get("vol_today_ratio") or 0
    volume = clamp((vt - 0.8) / 2.2)
    if vt >= 2:
        why.append((f"Volume {vt:.1f}× the 30-day average — real money behind the move",
                    f"ভলিউম ৩০ দিনের গড়ের {vt:.1f} গুণ — মুভের পেছনে সত্যিকারের টাকা"))
    elif vt < 1:
        why.append((f"⚠ Only {vt:.1f}× average volume — a spike without backing usually fades",
                    f"⚠ ভলিউম গড়ের মাত্র {vt:.1f} গুণ — সমর্থনহীন স্পাইক সাধারণত মিলিয়ে যায়"))

    rsi14 = m.get("rsi14") or 50
    room = (clamp((10 - dc) / 7) * 0.4          # distance to the 10% circuit
            + clamp((80 - rsi14) / 30) * 0.3
            + clamp((m.get("dist_resistance") or 0) / 10) * 0.3)
    if dc >= 9:
        why.append(("At/near the 10% daily circuit — no room left today; continuation would need tomorrow",
                    "১০% দৈনিক সার্কিটের কাছে — আজ আর বাড়ার জায়গা নেই; চলতে হলে আগামীকাল"))
    elif (m.get("dist_resistance") or 0) > 8:
        why.append((f"{m['dist_resistance']:.0f}% headroom below 3-month resistance",
                    f"৩ মাসের রেজিস্ট্যান্সের নিচে {m['dist_resistance']:.0f}% ফাঁকা জায়গা"))
    if rsi14 > 80:
        why.append((f"⚠ RSI {rsi14:.0f} — already very overbought",
                    f"⚠ RSI {rsi14:.0f} — ইতিমধ্যে মাত্রাতিরিক্ত কেনা"))

    trend = 0.0
    if m.get("sma50") and m["price"] > m["sma50"]:
        trend += 0.4
    if m.get("sma20") and m["price"] > m["sma20"]:
        trend += 0.2
    if (m.get("macd_hist") or 0) > 0:
        trend += 0.2
    if m.get("higher_lows"):
        trend += 0.2
    if trend >= 0.6:
        why.append(("Spike inside an established uptrend — these follow through more often",
                    "প্রতিষ্ঠিত ঊর্ধ্বগতির মধ্যে স্পাইক — এগুলো প্রায়ই চলতে থাকে"))
    elif trend <= 0.2:
        why.append(("⚠ Spike against a downtrend — usually a one-day event",
                    "⚠ নিম্নগতির বিপরীতে স্পাইক — সাধারণত একদিনের ঘটনা"))

    cat = 0.0
    cutoff = (today - timedelta(days=SPIKE_NEWS_DAYS)).isoformat()
    fresh = {a["category"] for a in (m.get("recent_news") or []) if a["date"] >= cutoff}
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

    hist = clamp(((m.get("win_rate") or 45) - 40) / 40)

    score = 100 * (0.25 * volume + 0.20 * room + 0.20 * trend
                   + 0.20 * clamp(cat) + 0.15 * hist)
    flags = set(m.get("flags") or [])
    if flags & {"trading-halt", "audit-concern"}:
        score = min(score, 5)
        why.append(("⚠ Hard risk flag — do not chase this spike",
                    "⚠ গুরুতর ঝুঁকি-চিহ্ন — এই স্পাইকের পেছনে ছুটবেন না"))
    if m.get("category") == "Z":
        score *= 0.5
    if "illiquid" in flags:
        score *= 0.7
    score = round(score, 1)
    label = ("Likely to continue" if score >= 60
             else "Mixed — wait for confirmation" if score >= 40
             else "Likely to fade")
    pairs = why[:5]
    return score, label, [p[0] for p in pairs], [p[1] for p in pairs]


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
        if m["last_date"] != market_date:       # spike must be from the live session
            continue
        dc, ic = m.get("day_change"), m.get("intraday_change")
        if (dc or 0) < SPIKE_MIN_PCT and (ic or 0) < SPIKE_MIN_PCT:
            continue
        score, label, why, why_bn = spike_score(m, today)
        spikes.append({
            "code": code, "price": m["price"], "sector": m.get("sector"),
            "category": m.get("category"), "day_change": dc, "intraday_change": ic,
            "vol_today_ratio": m.get("vol_today_ratio"), "rsi14": m.get("rsi14"),
            "dist_resistance": m.get("dist_resistance"),
            "score": score, "label": label, "why": why, "why_bn": why_bn,
            "flags": m.get("flags") or [], "eligible": m["eligible"],
            "record_date": m.get("upcoming_record_date"),
        })
    spikes.sort(key=lambda s: -s["score"])
    return {"date": market_date, "min_pct": SPIKE_MIN_PCT, "spikes": spikes}


# ================= MARKET WISDOM (cross-signal pass) =================
# Classic market rules layered on the composite before final verdicts:
# buy low (lower-margin share with reversal evidence), don't chase tops
# (higher-margin share with fall risk), respect a backed spike, and never
# chase an unbacked one. Adjusts composite ± and re-derives the verdict.
def apply_market_wisdom(results, spike, margin):
    sp = {s["code"]: s for s in spike["spikes"]}
    lo = {e["code"]: e for e in margin["lower"]}
    hi = {e["code"]: e for e in margin["higher"]}
    for code, m in results.items():
        adj = 0.0
        notes = []
        s = sp.get(code)
        if s:
            if s["score"] >= 60:
                adj += 3
                notes.append((
                    f"Spiking today (+{s['day_change']:.1f}%) with volume/catalyst backing — "
                    f"continuation score {s['score']:.0f}/100",
                    f"আজ স্পাইক করছে (+{s['day_change']:.1f}%) ভলিউম/উপলক্ষের সমর্থনসহ — "
                    f"ধারাবাহিকতা স্কোর {s['score']:.0f}/100"))
            elif s["score"] < 40:
                adj -= 4
                m["flags"].append("spike-fade-risk")
                notes.append((
                    f"Today's +{s['day_change']:.1f}% spike looks unbacked "
                    f"(continuation score only {s['score']:.0f}/100) — don't chase it",
                    f"আজকের +{s['day_change']:.1f}% স্পাইক সমর্থনহীন মনে হচ্ছে "
                    f"(স্কোর মাত্র {s['score']:.0f}/100) — পেছনে ছুটবেন না"))
        e = lo.get(code)
        if e and e["score"] >= 55:
            adj += 4
            notes.append((
                f"Bottom of its 2-year range WITH reversal evidence (rise score "
                f"{e['score']:.0f}/100) — buying low instead of chasing high",
                f"২ বছরের সীমার তলানিতে, ঘুরে দাঁড়ানোর প্রমাণসহ (রাইজ স্কোর "
                f"{e['score']:.0f}/100) — চড়া দামের পেছনে না ছুটে সস্তায় কেনা"))
        h = hi.get(code)
        if h and h["score"] >= 50:
            adj -= 6
            m["flags"].append("top-of-range")
            notes.append((
                f"Top of its 2-year range with fall risk {h['score']:.0f}/100 — "
                f"a profit-taking zone, not an entry zone",
                f"২ বছরের সীমার চূড়ায়, পতনের ঝুঁকি {h['score']:.0f}/100 — "
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
    if (m.get("eps") or 0) > 0:
        fund.append(f"EPS {m['eps']:.1f}")
        fund_bn.append(f"EPS {m['eps']:.1f}")
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


def run_analysis():
    tick_cache = load_tickers()
    tickers = tick_cache["tickers"]
    profiles = load_json(PROFILES_JSON, {}) or {}
    companies = profiles.get("companies", {})
    pe_map = profiles.get("pe", {})
    history = load_history()
    today = date.today()
    announcements = (load_json(ANNOUNCEMENTS_JSON, {}) or {}).get("by_ticker", {})
    agm_notices = (load_json(AGM_JSON, {}) or {}).get("by_ticker", {})

    results = {}
    for t in tickers:
        rows = history.get(t)
        if not rows:
            continue
        m = analyze_ticker(t, rows, companies.get(t), pe_map, today)
        if m:
            m["_code"] = t
            results[t] = m

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
