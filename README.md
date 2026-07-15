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

- **Top 20 preferred shares** — the analyst view: best overall picks across
  price history, announcements and AGM/EGM record dates (diversified, max 3
  per sector), each with a verdict (Strong Buy/Buy), a suggested **purchase
  date** (DSE Sunday–Thursday calendar aware: fresh setups buy next session,
  overheated ones wait 2–3 sessions, record-date captures buy ≥2 sessions
  before the date), a **holding period**, a **profit target price** and a
  **stop-loss price** scaled to that share's volatility.
- **Suggestions** — top short-term (1–2 week) and long-term (1–2 month) picks,
  each with a 0–100 score, the reasons behind it, and risk flags.
- **⚡ High Profit** — exceptional setups for high profit in 1–2 months, found
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
- **Today's fresh signals** — technical events on the latest trading day:
  golden cross, MACD cross, 3-month breakout, oversold rebound, volume spike.
- **Sectors** — sector-rotation table: average returns, breadth, and the best
  pick per sector.
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
  2-year / 1-year toggle, sortable A–Z or by score. Click any chart for a
  detail view (price + SMA20/50, volume, RSI, fundamentals, scoring cases).
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
for you). Re-run `fetch_profiles.py` occasionally (e.g. monthly, or after
earnings season) to pick up new EPS/dividend/category data.

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
| `fetch_profiles.py` | company fundamentals + full company name scraper → `data/profiles.json` |
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

## Requirements

- Python 3.9+ (macOS system Python works)
- **`pdfplumber`** (`pip install pdfplumber`) — the one non-stdlib dependency,
  needed to parse the AGM/EGM record-date PDF's table layout reliably.
  Everything else is stdlib only.
- Internet access to dsebd.org for sync/scrape (analysis and browsing work offline)
