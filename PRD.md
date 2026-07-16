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
| F16 | Margin tab with Lower/Higher sub-tabs: all shares in the bottom 25% of their 2-year range scored 0–100 for rise probability, all shares in the top 25% scored for fall probability, each with an estimated DSE-calendar-aware turn date and reasons drawn from technicals, announcements, record dates and AGM/EGM data. |
| F17 | Spike tab: shares up 3%+ this session vs yesterday's close or the session open (live prices on Update Data make it now-vs-open), each scored 0–100 for continuation (volume 25%, room 20%, trend 20%, catalyst 20%, follow-through history 15%) with a Likely-to-continue / Mixed / Likely-to-fade outlook. |
| F18 | Market-wisdom cross-signal pass before final verdicts: backed spike (continuation ≥ 60) composite +3; unbacked spike (< 40) −4 and `spike-fade-risk` flag; lower-margin reversal (rise score ≥ 55) +4; higher-margin fall risk (≥ 50) −6 and `top-of-range` flag which blocks Strong Buy. Verdicts and plans re-derived after adjustment. |
| F19 | Detailed Why reasons: every ticker gets structured, data-backed (English, বাংলা) reason pairs — trend, relative strength, RSI, volume/OBV, fundamentals, backtest reliability, record dates, wisdom cross-checks — shown as bullets in the Top 20 and available in Bengali via hover in the Suggestions, Spike and Margin Why columns. |

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

## Success criteria

- Full pipeline (sync → analysis → UI refresh) completes in under a minute for
  a routine daily update.
- Analysis of ~390 shares completes in under 5 seconds.
- App runs with Python 3 stdlib only — no pip installs, no external services.
- Suggestions always display the *why* (reasons + flags), never a bare score.

## Disclaimer

Output is rule-based screening, not financial advice. Historical patterns do
not guarantee future returns.
