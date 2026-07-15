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

    yr = closes[-250:]
    hi52, lo52 = max(yr), min(yr)
    pos52 = (price - lo52) / (hi52 - lo52) if hi52 > lo52 else 0.5
    m["hi_52w"], m["lo_52w"], m["pos_52w"] = round(hi52, 2), round(lo52, 2), round(pos52, 2)

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
        buy_plan(m, today)

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

    # market overview
    latest_dates = sorted({m["last_date"] for m in results.values()})
    market_date = latest_dates[-1] if latest_dates else None
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
