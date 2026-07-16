# DSE Market Analyzer

Local web app for analyzing Dhaka Stock Exchange shares: 2 years of daily price
history, company fundamentals, official market data, company announcements, and
rule-based buy suggestions — all computed on your machine with **zero AI
tokens** (Python 3 stdlib only, plus one PDF-parsing dependency — see
Requirements below).

See [PRD.md](PRD.md) for the product requirements and [PLAN.md](PLAN.md) for the
architecture.

## Quick start

```bash
cd /Users/qaium/p/w/StockMarket
python3 server.py                 # starts backend + serves the app
```

Open **http://localhost:8765** in your browser. That's it — the server *is* the
backend; the web page is served by it.

To use a different port:

```bash
python3 server.py 9000            # http://localhost:9000
```

Stop it with `Ctrl+C`. To keep it running after closing the terminal:

```bash
nohup python3 server.py > server.log 2>&1 &
```

## Using the app

**Navigation** is grouped by decision, not by build order: three top-level
groups — **Decide** (Suggestions, ⚡High Profit, Spike, Margin — "what should
I buy/watch right now"), **Manage** (Portfolio — "what do I already own"),
and **Explore** (Charts, Potential Charts, Screener, Sectors — "let me dig
through the data myself") — each with its own row of sub-tabs. Switching
groups remembers the last sub-tab you were on within that group. The
Suggestions tab keeps the Top 20 and picks front and centre; Market Update
and the Report Card are supporting context, tucked behind a **"Market
overview & report card"** collapsible toggle so they don't push the actual
picks below the fold.

- **Top 20 preferred shares** — the analyst view: best overall picks across
  price history, announcements and AGM/EGM record dates (diversified, max 3
  per sector), each with a verdict (Strong Buy/Buy), a suggested **purchase
  date** (DSE Sunday–Thursday calendar aware: fresh setups buy next session,
  overheated ones wait 2–3 sessions, record-date captures buy ≥2 sessions
  before the date), a **holding period**, a **profit target price** and a
  **stop-loss price** scaled to that share's volatility. A **market-wisdom
  pass** cross-checks every share against the Spike and Margin analyses
  before final verdicts: a volume/catalyst-backed spike or a bottom-of-range
  reversal earns a composite bonus, while an unbacked spike
  (`spike-fade-risk`) or a top-of-range share with fall risk
  (`top-of-range`, blocks Strong Buy) is penalised. The **Why column** gives
  detailed, data-backed bullet reasons (trend, relative strength, volume,
  fundamentals, signal history, record dates, wisdom cross-checks) — hover
  the text to read it in Bengali; the Spike and Margin Why columns work the
  same way.
- **Suggestions** — top short-term (1–2 week) and long-term (1–2 month) picks,
  each with a 0–100 score, the reasons behind it, and risk flags.
- **Portfolio** — your trade journal and exit engine. Record actual purchases
  (code, qty, price, date; saved in `data/portfolio.json`) and every holding
  is watched with the full analysis: live P&L, an **ATR trailing stop**
  (highest close since buy − 2.5× Average True Range, ratchets up and never
  down), a **break-even rule** (after +5% the stop never sits below entry),
  a **time stop** (past the planned holding period and still flat = thesis
  failed), and **sell alerts** from every engine — target hit, stop broken,
  Higher-Margin fall risk, bearish RSI divergence, momentum turned negative,
  unbacked spike (sell into strength), trading halt / audit concern. Selling
  a holding moves it to a closed-trades ledger with realized P&L and win
  rate. All alerts have Bengali hover meanings.
- **Report card** (Suggestions tab) — the app grades itself: every analysis
  run snapshots its Strong Buy / Buy / Top 20 / High Profit lists
  (`data/rec_history.json`), and later runs measure what those shares
  actually returned over the following 1w/2w/1m against the whole-market
  baseline. Builds up as Update Data is clicked across trading days — trust
  the categories that beat the baseline.
- **ATR & divergence** — the engine computes true Average True Range from
  High/Low data (the risk unit for trailing stops) and detects fresh **RSI
  divergences**: bearish (price higher high, RSI lower high — feeds the fall
  score, a risk flag and spike penalties) and bullish (price lower low, RSI
  higher low — feeds the rise score and today's fresh signals).
- **Candlestick reversal patterns** — hammer / bullish-engulfing (bottom
  reversal) and shooting-star / bearish-engulfing (top reversal), detected
  only right at a recent price extreme so they mean something. Bullish
  patterns strengthen the Margin rise score, unlock a new High Profit
  **reversal-candle** strategy (a hammer/bullish-engulfing right on a support
  level touched 2+ times before, in a profitable company), and surface as
  fresh signals; bearish patterns add a risk flag, weaken the Margin fall
  score, and trigger a Portfolio sell alert.
- **Gap analysis** — today's open vs yesterday's close, classified as
  **follow-through** (the move held through the close — a real catalyst) or
  **faded** (fully round-tripped back through yesterday's close — a classic
  trap for chasers). Feeds the Spike continuation score, the Margin rise/fall
  scores, and a `gap-fade` Portfolio sell alert.
- **Intraday close-strength** — where today's close landed within today's
  own high-low range (0–100%). A strong close under a spike or breakout
  confirms buyers won the session; a weak close is a warning even when the
  day's headline % change looks fine. Feeds the Spike continuation score.
- **Clustered support/resistance levels** — real price levels the share has
  reversed at 2+ times over the last year (swing highs/lows clustered by
  proximity), not just a simple period high/low. Strengthens support in the
  Margin rise score and headroom in the High Profit breakout strategy;
  proximity to a proven resistance (`near-key-resistance` flag) weakens the
  Margin rise/fall balance and triggers a Portfolio sell alert. Shown in the
  detail view alongside the touch count.
- **NAV, P/NAV & institutional holding trend** — `fetch_profiles.py` now also
  parses each company's **NAV per share** and true **annual EPS** from its
  audited annual filing (fixing a real bug where 150/393 companies missing
  a `latest_PE.php` entry had their P/E computed from a *quarterly* EPS
  mistaken for annual, inflating it ~4×), plus the **shareholding-split
  history** (Sponsor/Govt/Institute/Foreign/Public) and distinct
  **quarterly-EPS readings**, both accumulated across repeated runs into
  `data/fundamentals_history.json`. This powers: **P/NAV** (price below book
  value while profitable is a classic value screen — a Screener column and a
  Suggestions/Margin reason), an **institutional/foreign holding trend**
  (`institutional-accumulation`/`institutional-selling` flags — real filing
  data, not a volume proxy, blended into the Margin accumulation/distribution
  signal and the High Profit accumulation strategy), and **quarterly EPS
  momentum** (`eps-declining` flag; up/down/turned-profitable/turned-loss
  reasons in Suggestions and Margin). EPS momentum needs at least two
  `fetch_profiles.py --refresh` runs across a company's reporting calendar
  to populate (the interim table only shows this fiscal year's quarters as a
  snapshot); the holding trend and NAV populate immediately.
- **Beta** — every share's beta against a synthetic, equal-weighted market
  index built from all ~395 tracked shares' own 2-year price history (the
  real DSEX only accumulates on days someone clicks Update Data, far too
  sparse for a 180-session regression). Classified Aggressive (≥1.2) /
  Market-like / Defensive (≤0.7), capped to [-2, 4] to stop an illiquid
  share's noisy raw regression from distorting the label. Shown in the
  Screener, the detail view, and as your **portfolio beta** (value-weighted
  across current holdings) on the Portfolio tab.
- **Market cap & size class** — price × outstanding shares, bucketed Large
  (≥৳20,000mn) / Mid (৳3,000–20,000mn) / Small (<৳3,000mn); a Screener
  column, filter, and detail-view stat.
- **Seasonality** (context only, never a trading signal) — historical average
  return by calendar month, from the full 2-year daily history. The
  market-wide figure (all ~395 shares combined, tens of thousands of daily
  observations per month) is shown as a note on the Suggestions tab; each
  share's own current-month figure is shown in its detail view with its
  sample size (~40 daily observations per share per month) so you can judge
  how much to trust it — deliberately never fed into any score.
- **Portfolio diversification check** — pairwise correlation of daily returns
  among your actual holdings (not sector labels), flagging pairs at 0.7+ as
  a concentration warning: two "different" picks that move together are one
  bet wearing two tickers, not real diversification.
- **Screener upgrades** — new filters (max P/NAV, max ATR%, institutional-
  accumulation-only, cap size), a **CSV export** button (downloads exactly
  the currently filtered/sorted view), and **saved filter presets** (name,
  save, load, delete — stored in this browser only).
- **Spike** — shares that suddenly jumped **3%+ this session**, vs yesterday's
  close and vs the session open (clicking Update Data during trading hours
  makes this "right now vs the start of the day", since live prices are
  fetched). Each spike gets a 0–100 **continuation score** — the chance the
  rise keeps going: volume backing 25%, room to run (circuit distance, RSI,
  resistance headroom) 20%, trend backdrop 20%, real catalyst from the
  announcement/AGM data (dividend, results, board meeting, record date;
  exchange queries count *against*) 20%, and the share's own signal
  follow-through history 15% — with an outlook badge (Likely to continue /
  Mixed / Likely to fade) and honest ⚠ warnings (thin volume, no news,
  overbought, at the circuit).
  by seven aggressive pattern-hunting strategies scanned across every liquid,
  eligible share on each analysis run: **volatility squeeze** (tightest bands
  in 6 months + accumulation), **momentum leader** (beating the market 8%+ in
  a clean uptrend), **quiet accumulation** (OBV rising while price is flat),
  **oversold rebound** (RSI ≤ 40 at 3-month support inside a long-term
  uptrend), **volume breakout** (fresh high on 1.3×+ volume),
  **dividend runner** (record date 4–25 days away, 3.5%+ yield, uptrend), and
  **proven signal** (fresh MACD/golden cross on shares whose backtested
  signals won 60%+). Each pick shows a conviction rating (★–★★★, boosted when
  several strategies agree), an aggressive target, a tight stop, R/R, buy
  date and holding period. Ranked by edge, capped at 4 per strategy and 3 per
  sector; a warning banner appears when the market regime is Bearish.
  Higher bar than the regular lists (≥ 8 mn BDT daily liquidity, no hard risk
  flags) — but higher reward means higher risk: use the stop and the 2% rule.
- **Margin** — every share at an extreme of its own price range over a
  **selectable period** (1-Month / 2-Month / 3-Month / 6-Month / 1-Year /
  2-Year filter buttons; default 3-Month — all six windows are recomputed on
  every Update Data, so switching is instant), in two sub-tabs.
  **Lower Margin** (bottom 25% of the range) scores each share 0–100
  for the chance the price starts *rising* — reversal evidence (MACD/RSI
  turning) 35%, OBV accumulation 20%, support holding 15%, fundamentals 15%,
  catalysts (record dates, dividend/board-meeting news) 15%; trading halts and
  audit concerns crush the score, because cheap isn't the same as safe.
  **Higher Margin** (top 25%) scores the chance the price starts *falling* —
  over-extension 35%, momentum fade 20%, OBV distribution 15%, weak valuation
  15%, event risk (imminent ex-dividend drop, exchange query) 15% — useful for
  booking profit on holdings and for not chasing tops. Each row carries an
  estimated **turn date** (DSE calendar aware): confirmed reversals = next
  session, MACD-approaching-zero extrapolated at its current pace, record
  dates pull the date (run-ups start ~2 weeks before; ex-dividend drops land
  right after). Searchable, star-shortlistable, rows open the detail view.
- **Today's fresh signals** — technical events on the latest trading day:
  golden cross, MACD cross, 3-month breakout, oversold rebound, volume spike.
- **Sectors** — sector-rotation table plus a **sector performance bar
  chart** (average 1-month return per sector, horizontal bars growing from
  zero, green up / red down, sorted strongest-to-weakest, hover for 1w/3m and
  breadth): average returns, breadth, and the best pick per sector.
- **Market Update panel** — the real DSEX/DS30/DSES/DSMEX index levels and
  daily change, total exchange turnover, market capitalisation, and the
  **official** advance/decline count by category (A/B/Z/mutual funds) —
  scraped live from the DSE homepage and `market-statistics.php`, not a proxy
  from our own tracked shares. A DSEX trend line builds up automatically as
  you click Update Data on more days (stored in `data/market_history.json`).
- **Market regime** (header badge) — Bullish/Neutral/Bearish, computed
  primarily from the real DSEX daily change + official breadth ratio (falls
  back to our own SMA50-breadth proxy only if the live snapshot is
  unavailable), so you know if it's a buying environment.
- **Target & Stop-loss for every share** — screener columns and detail view
  show a volatility-scaled profit target and stop-loss price for any share you
  consider buying, plus its risk/reward ratio and its historical **signal win
  rate** (backtest of past MACD buy signals over 2 years).
- **Position-size calculator** (detail view) — enter your capital and risk %
  (the 2% rule) and it tells you exactly how many shares to buy.
- **Help / সাহায্য** — hover any dotted-underlined term for its meaning in
  English and Bengali; the Help button opens the full glossary.
- **Charts** — line charts for every share, **100 per page** with Prev/Next,
  2-year / 1-year toggle, sortable A–Z or by score, plus a **Line /
  Candlestick** toggle (candlestick mode shows the last 60 sessions'
  open/high/low/close as coloured bodies+wicks; the 2y/1y range toggle is
  disabled in this mode since it doesn't apply). Click any chart for a
  detail view (price + SMA20/50, volume, RSI, fundamentals, scoring cases)
  where a **Line / Candlestick / OHLC Bars** menu switches the main price
  panel between a plain close-price line, full candlesticks, and classic
  OHLC tick bars — all three use the real 2-year Open/High/Low/Close data,
  with the SMA20/50 overlay and hover tooltip (now showing O/H/L too) working
  identically in every mode. A **zoom control** (1M/3M/6M/1Y/All, defaulting
  to 6M so candles/bars are readable immediately instead of 2 years being
  squeezed into one canvas) sits above the chart; scroll the mouse wheel to
  zoom in/out around the cursor, or click-drag to pan through history —
  Volume and RSI below scroll in sync. Opening a different share resets the
  zoom back to the 6M default.
- **Potential Charts** — for every share (100 per page): the real past
  year in blue, then a **potential next 6 months** in violet, split by a
  dashed vertical line at today (x-axis is time-proportional, divider ~2/3
  across). The projection is deterministic math (damped 60/120/250-session
  momentum + last year's detrended seasonal shape at half strength — *a
  decision aid, not a prediction*), stored in `potential_dse_6m_history.csv`
  and regenerated from the freshest history on every Update Data, after all
  website inputs (prices, live quotes, market snapshot, announcements,
  AGM/EGM PDF) have been refreshed.
- **Screener** — sortable, searchable table of every share × every indicator.
  Tick *eligible only* to hide funds, bonds, and illiquid/category-Z shares.
  A **Columns** picker shows/hides any of the 25+ available columns (Code is
  always shown); only ~12 are visible by default to keep the table scannable,
  and your choice is remembered. A second control row groups the less common
  filters — Technical (RSI zone, min score, max ATR%), Fundamental (cap size,
  max P/NAV, min dividend yield, EPS trend), Risk & ownership (min liquidity,
  no risk flags, institutional accumulation), and **cross-tab** ("also
  appears in Spike / High Profit / Margin lower / Margin higher") — behind a
  collapsible **"More filters"** toggle. Every active filter shows as a
  removable chip above the table, with a **Clear all filters** button.
  **Quick screens** offers five curated one-click presets (★ Value picks,
  ★ Momentum breakouts, ★ Income, ★ Turnarounds, ★ Institutional
  accumulation) alongside any filter combination you save yourself under a
  name (stored in this browser only; built-ins can't be deleted). An
  **Export CSV** button downloads exactly the currently filtered, sorted,
  and visible-columns view.
- **Shortlist** — click the ☆ on any chart card, screener row, or the detail
  view's header to pin a share. Shortlisted shares appear in their own
  highlighted **★ Shortlisted** section at the top of the **Charts**,
  **Potential Charts**, and **Screener** tabs, kept in sync across all three
  (and the detail modal) instantly. Saved to this browser's `localStorage`
  only — it's personal to your machine/browser, not written to any file, and
  survives reloads and Update Data.
- **Update Data** (button, top right) — one click runs the full pipeline:
  1. Price history: fetches **only dates newer than what's stored** (one bulk
     request per ~20-day gap), auto-backfills newly listed shares.
  2. **During the trading session** it also pulls the current *live* prices, so
     clicking Update at any moment analyzes today's latest prices — each click
     replaces the previous intraday snapshot, and the official day-end numbers
     automatically replace the snapshot on the first update after the data is
     posted (tracked in `data/sync_state.json`).
  3. The official Market Update snapshot (DSEX/DS30/etc, turnover, breadth).
  4. **Company announcements** (`old_news.php`) since the last sync — see below.
  5. **AGM/EGM & record-date PDF** (`Company_AGM_EGM.pdf`) — re-downloaded and
     re-parsed every time since DSE updates it in place.
  6. Re-runs the analysis and refreshes the page.
- **Company Alerts** — material announcements matter for a buy decision, so
  every sync scrapes DSE's news feed and categorizes each entry: **trading
  halts** and **auditor concerns** (Qualified Opinion / Emphasis of Matter /
  going-concern warnings) are hard "Avoid" triggers; **exchange queries**
  (DSE asking a company to explain an abnormal price move) and **category
  changes** are risk flags; **dividend declarations**, **credit rating
  results**, and **board-meeting schedules** surface as reasons. Stored per
  ticker in `data/announcements.json` (rolling 60-day window).
- **Record-date tracking** — the AGM/EGM PDF gives each company's next
  dividend record date. Buying before that date qualifies you for the
  dividend (the price typically drops by roughly the dividend amount right
  after, the "ex-dividend" adjustment) — the app surfaces this as a
  **record-date-soon** flag and callout when it's within ~20 days, matched
  from the PDF's full company names to tickers via `data/profiles.json`'s
  captured company names. Stored in `data/agm_notices.json`.

Deep links: `#charts`, `#screener`, `#t:TICKER` (e.g. `/#t:GP` opens
Grameenphone's detail view).

## Running backend pieces individually

Each stage also works standalone from the terminal:

```bash
python3 sync.py               # incremental price sync (prints progress)
python3 analysis.py           # recompute scores, print top picks (<1 s)
python3 fetch_profiles.py     # refresh company fundamentals (~10-15 min, only
                              #   fetches missing companies; --refresh redoes all)
python3 scrape_dse.py         # FULL 2-year re-scrape (~20 min) — only needed to
                              #   rebuild dse_2y_history.csv from scratch
```

Typical routine: just click **Update Data** in the app (it runs sync + analysis
for you). Re-run `fetch_profiles.py --refresh` occasionally (e.g. monthly, or
after earnings season) to pick up new EPS/dividend/category data — this is
also what builds up the institutional-holding-trend and quarterly-EPS-momentum
history over time, so a monthly cadence directly improves those two signals.

## Scoring rules (analysis.py)

**Short-term (1–2 weeks)**: momentum 30% · trend alignment (price>SMA20>SMA50)
20% · volume surge 20% · RSI sweet-spot 15% · MACD 15%.

**Long-term (1–2 months)**: trend quality 25% · fundamentals (EPS>0, P/E ≤ 25,
dividend payer, category A) 25% · 52-week range position 20% ·
consistency/low volatility 15% · momentum quality 15%.

Pick lists exclude illiquid shares (< 5 mn BDT avg daily traded value),
non-equity instruments (funds/bonds), category-Z, and stale tickers; other
risks (overbought RSI, category-B, near 52-week high, high volatility) appear
as flags. **Rule-based signals, not financial advice.**

## Files

| File | Purpose |
|---|---|
| `server.py` | backend web server + API (`/api/summary`, `/api/charts`, `/api/history`, `/api/update`) |
| `analysis.py` | indicators + scoring → `data/analysis.json` |
| `sync.py` | incremental price sync (gap-fill + new-listing backfill) |
| `fetch_profiles.py` | company fundamentals + full company name scraper → `data/profiles.json`; also parses NAV per share, annual EPS, quarterly EPS, and shareholding-split snapshots, accumulating the latter two into `data/fundamentals_history.json` |
| `fetch_news.py` | company announcements scraper + categorizer → `data/announcements.json` |
| `fetch_agm.py` | AGM/EGM & record-date PDF parser + name-to-ticker matcher → `data/agm_notices.json` |
| `scrape_dse.py` | original full 2-year scraper (bootstrap/rebuild only) |
| `dse_common.py` | shared fetch/parse helpers and file paths |
| `static/` | frontend (HTML/CSS/JS, canvas charts) |
| `dse_2y_history.csv` | daily OHLC price history for all shares (grows via sync) |
| `data/tickers.json` | cached ticker list + company URLs (auto-refreshed on sync) |
| `data/profiles.json` | cached fundamentals: name, sector, category, EPS, P/E, dividends |
| `data/analysis.json` | computed indicators, scores, reasons, flags, alerts |
| `data/market_history.json` | daily official market snapshots (DSEX/DS30/etc, growing over time) |
| `data/announcements.json` | categorized company announcements, rolling 60-day window |
| `data/agm_notices.json` | parsed AGM/EGM PDF matched to tickers (record dates, dividends) |
| `data/fundamentals_history.json` | accumulating monthly institutional/foreign shareholding snapshots and distinct quarterly-EPS readings per ticker, built up over repeated `fetch_profiles.py` runs |

## Requirements

- Python 3.9+ (macOS system Python works)
- **`pdfplumber`** (`pip install pdfplumber`) — the one non-stdlib dependency,
  needed to parse the AGM/EGM record-date PDF's table layout reliably.
  Everything else is stdlib only.
- Internet access to dsebd.org for sync/scrape (analysis and browsing work offline)
