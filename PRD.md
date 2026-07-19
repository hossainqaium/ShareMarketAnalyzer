# PRD — DSE Market Analyzer

## Problem

Picking shares on the Dhaka Stock Exchange requires reviewing hundreds of
companies across price history, momentum, volume behaviour, and fundamentals.
Doing this by hand is slow; doing it with an AI assistant costs tokens on every
question. The owner needs a **local, free-to-run tool** that keeps two years of
market data on disk, updates it incrementally, and surfaces buy candidates via
transparent, repeatable rules.

## Goals

1. Analyze every listed DSE share using price history and company profile data.
2. Suggest shares with a high probability of profit over a **short horizon
   (1–2 weeks)** and a **long horizon (1–2 months)**, with visible reasoning.
3. Visualize every share as a line chart (2-year and 1-year views), browsable
   100 charts at a time with pagination.
4. Update data **incrementally** — never re-download the 2 years already stored.
5. Perform all analysis **locally with zero AI/API tokens**.
6. Cache ticker symbols and company URLs so routine syncs don't re-scrape
   listing pages.
7. Track the real, exchange-wide market picture (benchmark indices, official
   advance/decline, turnover) as context for the regime, not just a proxy
   derived from our own tracked shares.
8. Track material company announcements (dividends, trading halts, auditor
   concerns, exchange queries) and upcoming dividend record dates, and factor
   them into eligibility, flags, and reasons — a technically strong share with
   a fresh auditor concern or an active trading halt should never be
   recommended as a buy.

## Non-goals

- Automated trading or order placement.
- Intraday quotes as a continuously live feed — the "live" price layer is a
  best-effort snapshot refreshed only when the user clicks Update Data, not a
  streaming ticker.
- Guaranteed predictions. The tool ranks candidates by rules; the user decides.

## Users

Single user (the owner), running the app on their own machine against public
DSE day-end data.

## Functional requirements

| # | Requirement |
|---|---|
| F1 | Web UI served locally showing suggestions, charts, and a screener. |
| F2 | Short-term and long-term ranked pick lists, each entry showing score (0–100), price, recent returns, reasons, and risk flags. |
| F3 | Chart grid: 100 line charts per page, Prev/Next pagination, 2y/1y toggle, sort by name or score. |
| F4 | Click-through detail view per share: price + SMA20/SMA50 overlays, volume, RSI(14), fundamentals, and both scoring cases. |
| F5 | "Update Data" button performs an incremental sync from the last stored date to today, then re-runs analysis automatically. |
| F6 | New listings detected during sync are backfilled with 2 years of history automatically. |
| F7 | Screener: sortable, searchable table of all shares × all computed indicators. |
| F8 | Company profiles (name, sector, category, EPS, P/E, dividends, sponsor holding) scraped and cached locally; refreshable on demand. |
| F9 | Ticker list + company URLs cached on disk; refreshed only during sync. |
| F10 | Official Market Update snapshot (DSEX/DS30/DSES/DSMEX indices, turnover, official advance/decline by category, market cap) scraped each sync; a DSEX trend accumulates day over day. |
| F11 | Company announcements scraped each sync and categorized (trading halt, audit concern, exchange query, category change, dividend, financials, credit rating, board meeting, rights issue); hard flags (halt/audit concern) force ineligibility. |
| F12 | AGM/EGM & record-date PDF parsed each sync, matched from full company names to tickers, surfacing the next dividend record date and a "buy before this date" catalyst within ~20 days. |
| F13 | Top 10 composite recommendation: diversified (max 2/sector) picks with verdict, holding period, target price, stop-loss, risk/reward ratio, and historical signal win rate. |
| F14 | Every term, column, flag, and score has an English + Bengali hover explanation, plus a full glossary in a Help modal. |
| F15 | ⚡ High Profit tab: exceptional 1–2 month setups found by seven aggressive strategies (volatility squeeze, momentum leader, quiet accumulation, oversold rebound, volume breakout, dividend runner, proven signal), each pick with conviction stars, aggressive target, tight stop, R/R, buy date and hold period; ranked by edge, capped 4/strategy and 3/sector, max 15; Bearish-regime warning banner. |
| F16 | Margin tab with Lower/Higher sub-tabs and a range filter (1M/2M/3M/6M/1Y/2Y, default 3M; all windows precomputed per analysis run): shares in the bottom 25% of the selected range scored 0–100 for rise probability, shares in the top 25% scored for fall probability, each with an estimated DSE-calendar-aware turn date and reasons drawn from technicals, announcements, record dates and AGM/EGM data. The market-wisdom pass stays anchored to the 2-year window. |
| F17 | Spike tab (Spikes sub-view): shares that moved 3%+ EITHER direction, today or yesterday (`detect_recent_spike()`, `SPIKE_LOOKBACK=2`; today prefers day_change/intraday_change, yesterday uses pure close-to-close), REQUIRED to be confirmed by abnormal volume (that day's volume ≥ `SPIKE_MIN_VOL_RATIO=2.0`× the 30-day average) and a direction-backing close (≥50% up the day's own H-L range for an up-move, ≤50% for a down-move) — a move missing either confirmation is excluded outright, not merely down-scored, keeping the list to roughly a couple dozen shares instead of hundreds. Each qualifying spike is scored 0–100 for continuation with direction-mirrored logic (volume 25%, room-to-run 20%, trend 20%, direction-appropriate catalyst 20%, follow-through history 15%) and an up/down-specific outlook label (Likely to continue/fade, or continue falling/bounce). Sorted by days-ago ascending (today first), same-day ties broken by price descending. |
| F18 | Market-wisdom cross-signal pass before final verdicts: backed spike (continuation ≥ 60) composite +3; unbacked spike (< 40) −4 and `spike-fade-risk` flag; lower-margin reversal (rise score ≥ 55) +4; higher-margin fall risk (≥ 50) −6 and `top-of-range` flag which blocks Strong Buy. Verdicts and plans re-derived after adjustment. |
| F19 | Detailed Why reasons: every ticker gets structured, data-backed (English, বাংলা) reason pairs — trend, relative strength, RSI, volume/OBV, fundamentals, backtest reliability, record dates, wisdom cross-checks — shown as bullets in the Top 20 and available in Bengali via hover in the Suggestions, Spike and Margin Why columns. |
| F20 | Portfolio tab (trade journal + exit engine): add/sell/delete holdings via `data/portfolio.json`; per holding live P&L, ATR trailing stop (hi-since-buy − 2.5×ATR, ratchets up only), break-even rule (+5% ⇒ stop ≥ entry), time stop (past horizon and < +2%), and sell alerts (target-hit, stop-hit, fall-risk, bearish divergence, momentum turn, unbacked spike, halt/audit, record-date info); closed-trades ledger with realized P&L and win rate. |
| F21 | Report card: each analysis run snapshots Strong Buy / Buy / Top 20 / High Profit lists into `data/rec_history.json` (by market date, last 150 kept); later runs grade snapshots by forward 1w/2w/1m returns (win = >+2%) vs whole-market baseline, shown on the Suggestions tab. |
| F22 | ATR(14) computed from High/Low (Wilder); fresh RSI divergence detection (bearish → risk flag, fall-score and spike penalties; bullish → fresh signal and rise-score boost). |
| F23 | Candlestick reversal patterns (hammer, bullish-engulfing, shooting-star, bearish-engulfing), detected only at a recent price extreme (3-month range position ≤12% or ≥88%); bullish patterns feed the Margin rise score and a new High Profit `reversal-candle` strategy, bearish patterns feed a risk flag, the Margin fall score, and a Portfolio sell alert. |
| F24 | Gap analysis: today's open vs yesterday's close classified as follow-through or faded (full round-trip through yesterday's close) when ≥1.5%; feeds Spike continuation, Margin rise/fall scores, and a `gap-fade` Portfolio sell alert. |
| F25 | Intraday close-strength: today's close position (0–100%) within today's own high-low range; feeds the Spike continuation score. |
| F26 | Clustered support/resistance: swing highs/lows over the last year grouped into levels with 2+ touches (1.5% tolerance); nearest level above/below price with touch count shown in the detail view, strengthens Margin rise support and High Profit breakout headroom, and a `near-key-resistance` flag (≤2% of a 3+-touch level) weakens Margin scores and triggers a Portfolio sell alert. |
| F27 | NAV per share + true annual EPS parsed from each company's audited annual filing (fixing the P/E fallback, previously computed from a quarterly EPS mistaken for annual on 150/393 tickers); P/NAV shown in the Screener and detail view, feeds the long-term score, Margin rise/fall scores, and Suggestions/Margin reasons when < 1.0 (trading below book value) in a profitable company. |
| F28 | Institutional/foreign shareholding-split history, accumulated across repeated `fetch_profiles.py` runs into `data/fundamentals_history.json` (each company page shows ~3 months per scrape); a 3-snapshot institute+foreign trend feeds the Margin accumulation/distribution signal, the High Profit accumulation strategy, and `institutional-accumulation`/`institutional-selling` flags. |
| F29 | Quarterly-EPS momentum: distinct interim-EPS readings accumulated the same way; latest-vs-previous reported quarter drives an up/down/turned-profitable/turned-loss direction (+ growth % when both are positive) feeding the long-term score, Margin scores, Suggestions reasons, and an `eps-declining` flag. Needs 2+ `--refresh` runs spanning a reporting change to populate. |
| F30 | Beta vs a synthetic equal-weighted market index (all tracked shares' own 2-year history), 180-session regression capped to [-2,4]; classified Aggressive/Market-like/Defensive. Screener column, detail-view stat, and a value-weighted portfolio beta on the Portfolio tab. |
| F31 | Market capitalisation (price × outstanding shares) with Large/Mid/Small size classing (≥20,000mn / 3,000–20,000mn / <3,000mn); Screener column + filter, detail-view stat. |
| F32 | Seasonality context (never scored): market-wide average return by calendar month (all shares, shown on Suggestions) and each share's own current-month figure with sample size (detail view) — both approximated as a ~21-session "monthly" figure from the daily average. |
| F33 | Portfolio diversification check: pairwise Pearson correlation of daily returns among current holdings (not sector labels); pairs ≥0.7 flagged as concentration risk in a dedicated Portfolio-tab panel. |
| F34 | Screener upgrades: filters for cap size, max P/NAV, max ATR%, institutional-accumulation-only; a CSV export of the current filtered/sorted view; named saved filter presets (save/load/delete, localStorage). |
| F35 | Two-level navigation: Decide (Suggestions, High Profit, Spike, Margin) / Manage (Portfolio) / Explore (Charts, Potential Charts, Screener, Sectors) groups, each remembering its last-active sub-tab. Deep-link hashes (`#screener`, `#t:CODE`) resolve through the group structure. |
| F36 | Suggestions layout split: Top 20, Company Alerts, and Today's Fresh Signals stay visible by default; Market Update and the Report Card are collapsed behind a "Market overview & report card" `<details>` toggle so they don't push actionable content below the fold. |
| F37 | Screener column visibility picker: any of the 25+ columns can be shown/hidden (Code always shown); ~12 visible by default; choice persisted per-browser (localStorage). Sort-by-header and the shortlist mirror table both respect the same visible set. |
| F38 | Screener filters regrouped into a themed, collapsible "More filters" panel (Technical / Fundamental / Risk & ownership / cross-tab "also appears in"), plus two new filters (min dividend yield, EPS trend) and four cross-tab toggles (also in Spike / High Profit / Margin lower / Margin higher, computed from the other tabs' current output). |
| F39 | Active-filter chips row above the Screener table — one removable chip per active filter — plus a "Clear all filters" button. Five curated built-in Quick Screens (Value picks, Momentum breakouts, Income, Turnarounds, Institutional accumulation) ship alongside user-saved presets in the same dropdown; built-ins can't be overwritten or deleted, and loading any preset replaces the current filter state rather than layering onto it. |
| F40 | Real Open/High/Low/Close exposed by the API (`/api/history` full series, `/api/charts` a 60-session compact tail per card) alongside the existing close-only series, powering candlestick/OHLC-bar rendering without changing any existing close-only consumer. |
| F41 | Detail-view chart-type menu: Line (existing) / Candlestick / OHLC Bars for the main price panel, sharing one axis/grid scaffold so switching types doesn't shift the canvas; SMA20/50 overlay and the hover tooltip (now also showing Open/High/Low) work identically in all three modes. |
| F42 | Charts-tab grid Line/Candlestick toggle: candlestick mode renders each card's last 60 sessions as compact candlesticks (2y/1y range toggle disabled in this mode, since it doesn't apply to the fixed 60-session window); applies to the main grid and the shortlist mirror grid alike. |
| F43 | Sectors tab: new sector-performance bar chart (avg 1-month return per sector, horizontal bars from a zero baseline, colour-coded, hover for 1w/3m/breadth) above the existing sector table, using the same sort order. |
| F44 | Detail-view chart zoom: preset window buttons (1M/3M/6M/1Y/All sessions, default 6M) plus mouse-wheel zoom (centred on cursor position) and click-drag pan, implemented as index-window slicing of the full OHLC/SMA/volume/RSI series shared across all three chart types and the Volume/RSI panels so they scroll in sync. Manual wheel/drag interaction deselects the preset buttons; opening a different ticker resets to the 6M default. |
| F45 | Compare tab (new Decide sub-tab): a ⚖ Compare button mirrors the ☆ shortlist button on every share surface (Suggestions Top 20, short/long picks, Spike, Margin, High Profit, Charts, Potential Charts, Screener, detail modal), toggling localStorage-persisted membership in a set capped at 6. The Compare tab renders selected shares as side-by-side columns against a full metric set plus a sparkline, and a Head-to-head insights panel ranks the selected shares only against each other (composite, R/R, buy date, record date, risk flags, precise 2-year-window Margin rise/fall signal at the engine's own thresholds — not the broader multi-window union used by Screener's cross-tab filters, which fires too often on short-term noise to support a specific buy/avoid claim), ending in an explicit relative verdict. |
| F46 | Trend-Break detection (Spike tab, own sub-view): `detect_regime_break()` fits log-price OLS over the longest of {252,189,126,90,63} sessions (excluding the last 5 as a holdout) that qualifies as a clean downtrend/uptrend (R² ≥ 0.5, ≥0.08%/day drift) or tight range (≤16% band width); the holdout sessions are z-scored against the fitted trend/range and a break is flagged at \|z\| ≥ 2.2, tagged with `break_days_ago` (0–4). Scored 0–100 (40% break magnitude, 30% volume confirmation, 30% MACD/candle/divergence agreement) and returned as `build_spike()`'s separate `trend_breaks[]` array (not merged with `spikes[]`), sorted by days-ago ascending then price descending; excluded for non-equity/illiquid instruments. |
| F47 | Spike/Trend-Break UI split: two dedicated sub-panels under the Spike tab (`#spSpikesPanel`/`#spTrendBreaksPanel`, toggled via `#spViewSeg`) each with a "Days" column (Today/1d ago/2d ago…) and a ▲/▼ direction column. The Suggestions tab shows a same-day-only (`days_ago === 0`) top-6-by-score summary of both lists right after the Top 20 table, each item linking into the detail modal and a "View all" link that jumps to the corresponding Spike sub-view. |
| F47 | Margin cycle history: `find_range_episodes()` scans a share's full 2-year closes against its own [lo_2y, hi_2y] bounds for sustained bottom-quartile/top-quartile episodes (≥3 sessions, ≤3-session gap tolerance), and `episode_reversion_stats()` measures, over past *completed* episodes only, the hit rate and average return of the expected reversion (bounce from bottom / correction from top) within 21 sessions. Feeds a real-history bonus/penalty into `margin_rise_score`/`margin_fall_score` and leads the Margin tab's Why reasons when the share has ≥2 own-history data points. |
| F48 | Multi-year fundamentals: `fetch_profiles.py` persists the full audited annual EPS/NAV/profit table (up to ~8 years, one page load) into `data/fundamentals_history.json` instead of keeping only the latest year. `analysis.py` computes EPS/NAV(book-value)/profit CAGR and ROE (EPS÷NAV) from it, plus a same-run sector-average P/E, P/NAV, and dividend yield across all tracked tickers. Computed and stored on every ticker; not yet wired into any score or surfaced in the UI (see the data-coverage audit below). |
| F49 | LTP integrity for the live/provisional row: `sync.py`'s intraday append no longer writes the live page's own "close" field into the row's CloseP column (that field is itself a stale intraday snapshot that can lag the true last-traded price by a meaningful margin mid-session — confirmed empirically, e.g. one share showed live LTP 202 vs that field reading 198.4 at the same fetch). It writes `"0"` instead, same treatment as OpenP, so every reader's existing CloseP-else-LTP fallback (`build_series()` in analysis.py, `series_for()` in server.py — both pre-existing, unchanged) correctly resolves "today's price" to the true LTP for every module under Decide (Suggestions, High Profit, Spike, Margin, Compare, detail view) and Portfolio, until the official close replaces the row. Completed archive days are untouched — their CloseP is the exchange's own authoritative close, not a last tick, and stays primary. |

## Scoring rules (the analysis contract)

**Short-term score** = 100 × (momentum·0.30 + trend·0.20 + volume-surge·0.20 +
RSI-zone·0.15 + MACD·0.15)

- *momentum*: blend of 1-week and 2-week returns
- *trend*: price > SMA20 and SMA20 > SMA50
- *volume surge*: 5-day avg volume vs 30-day avg
- *RSI zone*: peak credit near RSI 55; overbought (>70) scores zero
- *MACD*: bullish and strengthening histogram scores highest

**Long-term score** = 100 × (trend·0.25 + fundamentals·0.25 + 52w-position·0.20 +
consistency·0.15 + momentum-quality·0.15)

- *trend*: price above rising SMA50, above SMA200
- *fundamentals*: EPS > 0, P/E ≤ 25, pays cash dividend, category A
- *52w position*: prefers mid-range recovery, not tops or falling knives
- *consistency*: share of positive days + low daily volatility
- *momentum quality*: steady 1m/3m gains; parabolic moves (>25%/month) penalized

**Eligibility for pick lists**: equity instruments only, avg daily traded value
≥ 5 mn BDT, not category Z, data fresh within 7 days, **no active trading halt,
no unresolved auditor concern (Qualified Opinion / Emphasis of Matter / going
concern)**. All other risks surface as flags: `overbought`, `category-B`,
`near-52w-high`, `high-volatility`, `illiquid`, `stale-data`, `exchange-query`,
`category-change-news`.

**Composite recommendation** (Top 10) = 0.35·score_short + 0.40·score_long +
0.25·quality, where quality blends liquidity depth, low volatility, DSE
category, market-beating relative strength, and sponsor holding. Verdict
(Strong Buy/Buy/Watch/Neutral/Avoid) and holding horizon derive from which
score dominates; target/stop-loss scale with the share's own volatility.

**Exceptional setups (High Profit tab)**: a stricter, aggressive layer on top.
Gate: eligible, verdict ≠ Avoid, liquidity ≥ 8 mn BDT. Extra indicators:
20-session OBV slope normalised by average volume (`accum_20d`) and the
Bollinger bandwidth percentile vs the last ~6 months (`squeeze_pctile`).
Seven strategies each define their own entry conditions, volatility-scaled
target/stop and holding window; a share matching several strategies gets a
confluence bonus (+1 conviction, higher edge). Edge = conviction·8 +
min(target, 25)·0.8 + max(R/R − 1, 0)·6 + (composite − 50)·0.3. Final list:
sorted by edge, ≤ 4 per strategy, ≤ 3 per sector, ≤ 15 total.

**Margin scores**: shares with 2-year range position ≤ 0.25 get a **rise
score** = reversal evidence·0.35 + OBV accumulation·0.20 + support·0.15 +
fundamentals·0.15 + catalyst·0.15 (halt/audit ⇒ ≤ 5, stale ×0.3, cat-Z ×0.5);
position ≥ 0.75 gets a **fall score** = over-extension·0.35 + momentum
fade·0.20 + OBV distribution·0.15 + valuation risk·0.15 + event risk·0.15.
Turn-date estimate: confirmed reversal/rollover → next session; MACD
histogram approaching zero → extrapolated sessions at current slope (2–20);
record dates override (run-up window opens ~10 sessions before the record
date; the ex-dividend drop is dated the session after it).

## Data requirements

- Source: dsebd.org public pages (day-end archive, company pages, P/E page,
  homepage market snapshot, market-statistics.php, old_news.php announcement
  feed) and the `Company_AGM_EGM.pdf` record-date document.
- History: rolling ~2 years of daily OHLC+volume per share (DSE's own archive
  limit), stored as one combined CSV.
- Sync efficiency: a routine daily update must cost O(1) HTTP requests for
  price history, not O(number of shares) — achieved via the archive's "All
  Instrument" mode. Announcements and the AGM PDF are small, cheap fetches
  done once per sync regardless of share count.
- Announcements: rolling 60-day window per ticker, deduplicated by
  (date, title, text), categorized by regex rules against the title.
- AGM/EGM matching: PDF company names (full legal names) matched to tickers
  via normalized-name comparison against full names captured from each
  company's own profile page — exact match, then containment, then token
  Jaccard similarity ≥ 0.6; unmatched entries are kept but not attributed.
- Politeness: throttled requests with retries; scraping only public quote data.

## Data coverage vs. a professional investment framework

Audited against a 14-category, ~150-line-item "Ultimate Stock Analysis Framework" checklist
(business quality, financial statements, profitability, growth, valuation, technical analysis,
smart money, earnings quality, management quality, economic factors, risks, catalysts, market
psychology, portfolio fit). For every metric: whether it's used today, what analysis/feature
consumes it, and — for anything missing — whether DSE's public pages actually contain the raw
data needed (**Feasible**, just unimplemented) or don't (**Not feasible**, would need an entirely
new data source such as full annual-report PDFs, analyst coverage, or a macroeconomic data feed).

**What's actually scraped, today:** `dse_2y_history.csv` — 2 years of daily OHLC+volume, all
tickers (`scrape_dse.py`/`sync.py`). `data/profiles.json` — name, sector, category, listing year,
paid-up capital, outstanding shares, reserve, instrument type, cash/stock dividend %, latest
EPS/NAV, market-wide trailing P/E (`fetch_profiles.py`). `data/fundamentals_history.json` — up to
~8 years of audited annual EPS/NAV/profit-for-year (F48), a shareholding-composition time series
(Sponsor/Govt/Institute/Foreign/Public %, ~24 snapshots), and distinct interim-EPS readings.
`data/market_history.json` — daily DSEX/DS30/DSES/DSMEX + official breadth/turnover snapshots.
`data/announcements.json` — categorized company news (60-day window). `data/agm_notices.json` /
`data/rights_entitlement.json` — record dates, dividend %, rights-issue terms. **Not scraped, and
not published anywhere on DSE's public pages: income statements, balance sheets, cash-flow
statements, analyst estimates/guidance, insider transactions, buyback/M&A disclosures, board/
governance data, and options/short-interest (DSE has no listed options market).**

### 1. Business Quality

| Metric | Status | Used for | Notes |
|---|---|---|---|
| Business model / revenue streams | ❌ Not feasible | — | Qualitative; not on any DSE data page |
| Recurring vs. one-time revenue | ❌ Not feasible | — | No revenue data scraped at all |
| Customer / geographic concentration | ❌ Not feasible | — | Not published |
| Moat (brand, network effects, IP, switching costs, distribution) | ❌ Not feasible | — | Qualitative, would need annual-report text mining |
| Market share / industry rank / growth / disruption threat | ❌ Not feasible | — | Not published; `sector` exists but not a ranking |

### 2. Financial Statement Analysis

| Metric | Status | Used for | Notes |
|---|---|---|---|
| Annual EPS | ✅ Used | P/E (F27), long-term score fundamentals | `analysis.py` `m["eps_annual"]` |
| NAV per share (book value) | ✅ Used | P/NAV (F27), Margin scores, value reasons | `m["nav_per_share"]` |
| EPS growth (multi-year) | ✅ Used | — | `m["eps_cagr"]` (F48); computed, not yet scored |
| Book-value growth | ✅ Used | — | `m["nav_cagr"]` (F48); computed, not yet scored |
| Profit-for-year growth | ✅ Used | — | `m["profit_cagr"]` (F48); computed, not yet scored |
| Revenue growth (5yr), gross/operating/net profit growth | ❌ Not feasible | — | No income statement scraped |
| Margin stability (gross/operating/net) | ❌ Not feasible | — | No revenue or COGS/opex data |
| Cash, debt, debt/equity, current ratio, quick ratio | ❌ Not feasible | — | No balance sheet scraped |
| Operating cash flow, FCF, capex, cash conversion, FCF margin | ❌ Not feasible | — | No cash-flow statement on DSE's pages |

### 3. Profitability

| Metric | Status | Used for | Notes |
|---|---|---|---|
| ROE (EPS ÷ NAV) | ✅ Used | — | `m["roe"]` (F48); computed, not yet scored |
| ROA, ROIC | ❌ Not feasible | — | Need total assets/debt, not scraped |
| Gross / operating / net margin | ❌ Not feasible | — | No revenue or COGS data |

### 4. Growth Quality

| Metric | Status | Used for | Notes |
|---|---|---|---|
| EPS CAGR (5yr) | ✅ Used | — | `m["eps_cagr"]` (F48); computed, not yet scored |
| Revenue CAGR, FCF CAGR | ❌ Not feasible | — | No revenue/cash-flow data |
| Customer growth, market/product/international expansion | ❌ Not feasible | — | Not published |

### 5. Valuation

| Metric | Status | Used for | Notes |
|---|---|---|---|
| P/E | ✅ Used | Long-term score, Screener, Suggestions | `m["pe"]` |
| P/NAV (≈ Price/Book) | ✅ Used | Margin scores, value reasons (F27) | `m["p_nav"]` |
| Dividend yield | ✅ Used | Long-term score, Screener filter (F34) | `m["dividend_yield"]` |
| Sector-average P/E, P/NAV, dividend yield | ✅ Used | — | `m["sector_avg_*"]` (F48); computed, not yet scored |
| Forward P/E, PEG, EV/EBITDA, EV/Sales, Price/Sales | ❌ Not feasible | — | Need revenue/EBITDA/enterprise value (debt+cash), none scraped |
| 5–10yr historical P/E/P-NAV band (own history) | ❌ Not feasible | — | Only 2 years of price history stored — too short to match against fiscal-year-end prices for a meaningful band |

### 6. Technical Analysis

| Metric | Status | Used for | Notes |
|---|---|---|---|
| SMA20 / SMA50 / SMA200 | ✅ Used | Short/long-term score, trend, gates | `m["sma20"/"sma50"/"sma200"]` |
| RSI(14) + divergence | ✅ Used | Short-term score, flags, Margin, Spike | `m["rsi14"]`, `detect_divergence()` (F22) |
| MACD histogram + slope + backtest win-rate | ✅ Used | Short-term score, signal reliability | `m["macd_hist"/"macd_slope"]` |
| Relative volume, volume spike/breakout confirmation | ✅ Used | Short-term score, Spike, High Profit | `m["vol_ratio"]` |
| Higher-lows / market structure, regime-break detection | ✅ Used | Trend-Break detection (F46) | `higher_lows()`, `detect_regime_break()` |
| Candlestick reversal patterns (hammer, engulfing, shooting-star) | ✅ Used | Margin, High Profit, Portfolio alerts (F23) | `detect_candle()` |
| Volatility squeeze (Bollinger-bandwidth percentile) | ✅ Used | High Profit squeeze strategy | `m["squeeze_pctile"]` |
| Clustered support/resistance | ✅ Used | Detail view, Margin, High Profit, flags (F26) | `support_resistance_levels()` |
| SMA100, 20 EMA (exposed as its own metric) | ❌ Feasible | — | OHLC/close series already available; SMA100 trivial, EMA already computed internally for MACD |
| ADX, Stochastic oscillator | ❌ Feasible | — | Zero hits in codebase; OHLC series already available |
| Named chart patterns (flag, cup & handle, ascending triangle, double top/bottom) | ❌ Feasible, moderate effort | — | Squeeze/regime-break signals cover similar ground; would need dedicated shape-matching logic |
| Classic pivot-point levels (P/R1–3/S1–3) | ❌ Not applicable | — | App deliberately uses reversal-cluster levels instead — arguably better for a noisy frontier market |

### 7. Smart Money Analysis

| Metric | Status | Used for | Notes |
|---|---|---|---|
| Institutional/foreign holding-% trend | ✅ Used | Margin, High Profit accumulation, flags (F28) | `holding_trend()`, `m["holding_trend_3m"]` |
| Sponsor/Director % | ✅ Used | Quality score | `quality_score()` |
| Share dilution from rights issues | ❌ Feasible, moderate effort | — | `fetch_rights.py` tracks rights issues (F12) but not turned into a dilution % for scoring |
| Mutual-fund-specific ownership | ❌ Not feasible | — | DSE's split has no fund-level detail |
| Hedge-fund ownership | ❌ Not applicable | — | Not part of DSE's market structure |
| Insider buying/selling (individual transactions) | ❌ Not feasible | — | Not published |
| Share buybacks | ❌ Not feasible | — | Not published/tracked |

### 8. Earnings Quality

| Metric | Status | Used for | Notes |
|---|---|---|---|
| QoQ EPS momentum/direction | ⚠️ Proxy, used | Long-term score, Margin, `eps-declining` flag (F29) | `eps_momentum()`, closest available proxy |
| Earnings surprises vs. estimate, guidance, analyst revisions | ❌ Not feasible | — | No analyst-coverage data exists for DSE |
| Revenue quality, margin improvement | ❌ Not feasible | — | No revenue data |

### 9. Management Quality

| Metric | Status | Used for | Notes |
|---|---|---|---|
| Insider/institutional alignment (via holding trend) | ⚠️ Proxy, used | Quality score (as §7) | — |
| Dividend payout as capital-allocation signal | ⚠️ Proxy, used | Long-term score, reasons | Already used throughout |
| CEO track record, board independence/governance | ❌ Not feasible | — | Not published on DSE's scraped pages |
| Buybacks, M&A activity, explicit debt management | ❌ Not feasible | — | Would need annual-report/AGM-minutes text mining beyond current PDF date-parsing (F12) |

### 10. Economic Factors

| Metric | Status | Used for | Notes |
|---|---|---|---|
| DSEX/DS30/DSES index, market cap, turnover, breadth | ⚠️ Proxy, used | Market regime (Bullish/Bearish/Neutral), composite score | F10; legitimate market-wide proxy, not true macro |
| Interest rates, inflation, GDP, currency, commodity prices | ❌ Not feasible (out of scope) | — | Not scraped from anywhere; would need an entirely separate source (e.g. Bangladesh Bank), a different project scope than DSE scraping |

### 11. Risks

| Metric | Status | Used for | Notes |
|---|---|---|---|
| Trading halt, audit concern, exchange query | ✅ Used | Hard eligibility gate (F11) | `fetch_news.py` CATEGORY_RULES |
| Category-Z / delisting-adjacent risk | ✅ Used | Flags, eligibility | `flags["category-Z"]` |
| Illiquidity risk | ✅ Used | Eligibility, flags | `flags["illiquid"]` |
| Customer/supplier concentration, currency risk, political risk, technology disruption | ❌ Not feasible | — | Qualitative disclosures DSE doesn't publish |

### 12. Future Catalysts

| Metric | Status | Used for | Notes |
|---|---|---|---|
| Dividend / record-date catalyst | ✅ Used | Scoring, buy-by date, alerts (F12) | `upcoming_record_date`/`upcoming_dividend_pct` |
| Board-meeting mention | ⚠️ Unweighted | Raw reason string only | Not factored into any score |
| New product / acquisition / expansion catalysts | ❌ Feasible, lower confidence | — | Would mean expanding `fetch_news.py` regex rules; DSE announcement text is often terse/administrative |
| AI integration, new regulations benefiting the company | ❌ Not feasible | — | No structured source |

### 13. Market Psychology

| Metric | Status | Used for | Notes |
|---|---|---|---|
| News topic categorization | ⚠️ Used, not sentiment-scored | Alerts, flags (F11) | Classification only, no positive/negative score |
| Fear/greed index, short interest, options activity, retail participation | ❌ Not feasible / not applicable | — | Not published; DSE has no listed options market |

### 14. Portfolio Fit

| Metric | Status | Used for | Notes |
|---|---|---|---|
| Correlation / diversification across holdings | ✅ Used | Portfolio concentration-risk panel (F33) | `pearson_correlation()` |
| Exit strategy (stop, ATR trail, break-even, time-stop) | ✅ Used | Portfolio sell alerts (F20) | `portfolio_view()` |
| Position sizing (2% rule) | ⚠️ Manual tool, not automated | Detail-view calculator | Not wired into actual holding sizes |
| Sector-allocation rollup, automated position-size check | ❌ Feasible | — | Sector already attached to every holding; needs aggregation logic |

### Final Buy Checklist thresholds (from the audited framework)

| Metric | Status | Used for | Notes |
|---|---|---|---|
| Above 200-day moving average | ✅ Used | Buy-signal gate | `price > m["sma200"]` |
| Reward:risk ratio | ✅ Used, not gated | Scoring input (High Profit edge) | `m["rr"]`; no hard minimum-rr rejection rule yet |
| Volume confirmation on advances | ⚠️ Implicit | Baked into other signals | Not an explicit standalone gate |
| EPS growth threshold (>15%) | ⚠️ Only QoQ exists | — | Annual CAGR now computed (F48) but not thresholded |
| Revenue growth >10%, FCF positive, ROE >15%, ROIC >12%, debt/leverage, PEG ≤1.5 | ❌ Not feasible | — | Same data wall as §2/§3; ROE itself is now available (F48), the rest aren't |

**Bottom line:** strong on technicals and portfolio risk management; a solid but shallow
valuation layer (P/E, P/NAV, dividend yield, now with sector-average comparison); structurally
unable to cover most of Business Quality, full Financial Statements, Earnings Quality, Management
Quality, true Economic Factors, or Market Psychology, because that data simply isn't on DSE's
public pages — not a gap this app's scraping approach can close without a fundamentally different
data source.

## Success criteria

- Full pipeline (sync → analysis → UI refresh) completes in under a minute for
  a routine daily update.
- Analysis of ~390 shares completes in under 5 seconds.
- App runs with Python 3 stdlib only — no pip installs, no external services.
- Suggestions always display the *why* (reasons + flags), never a bare score.

## Disclaimer

Output is rule-based screening, not financial advice. Historical patterns do
not guarantee future returns.
