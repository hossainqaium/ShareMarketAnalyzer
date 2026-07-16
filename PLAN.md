# PLAN — DSE Market Analyzer

Implementation plan and architecture for the requirements in [PRD.md](PRD.md).
Python 3 stdlib + vanilla JS/canvas throughout, with one pip dependency
(`pdfplumber`, for the AGM/EGM record-date PDF table).

## Architecture

```
┌───────────────────────────────── browser ─────────────────────────────────┐
│  static/index.html + app.js + style.css                                  │
│  Suggestions (Top10/Alerts/Signals) │ Charts │ Screener │ Sectors │ Help  │
└────────────────────┬───────────────────────────────────────────────────────┘
                     │ HTTP (localhost:8765)
┌────────────────────▼───────────────────────────────────────────────────────┐
│  server.py — stdlib ThreadingHTTPServer                                   │
│  /api/summary /api/charts /api/history /api/update(+status)               │
│  in-memory caches: history CSV, analysis.json, profiles.json              │
└──────────┬──────────────────┬──────────────────────────────────────────────┘
           │ update thread    │ reads
┌──────────▼──────────┐ ┌─────▼───────────────────────────────────────┐
│  sync.py             │ │  analysis.py                              │
│  1. price gap-fill   │ │  indicators, scoring, recommend(), alerts │
│  2. live overlay     │ └─────▲──────────────────────────────────────┘
│  3. market snapshot  │       │ reads
│  4. fetch_news.py    │       │
│  5. fetch_agm.py     │       │
└──────────┬───────────┘       │
           │ writes            │
┌──────────▼────────────────────┴───────────────────────────────────────────┐
│ dse_2y_history.csv        data/tickers.json        data/profiles.json     │
│ data/market_history.json  data/announcements.json  data/agm_notices.json  │
│ data/analysis.json  (consumed by the API layer)                          │
└──────────▲──────────────────────────────────────────────────────────────┘
           │ scrapes (throttled, retried, unverified TLS)
   dsebd.org — day_end_archive.php · displayCompany.php · latest_PE.php
               latest_share_price_alpha.php · homepage · market-statistics.php
               old_news.php · Company_AGM_EGM.pdf
```

## Key design decisions

1. **Incremental sync is O(1), not O(tickers).** The DSE day-end archive
   accepts `inst=All Instrument`, returning every share's rows for a date range
   in one request. Sync reads the CSV's max date, fetches only the gap (chunked
   ~20 days per request), and appends de-duplicated on (ticker, date).
2. **Ticker/URL cache** (`data/tickers.json`) — the alphabetical listing page
   is scraped once and cached; sync refreshes it cheaply (1 request) and any
   ticker present in the list but absent from the CSV gets an automatic
   per-ticker 2-year backfill (handles new listings).
3. **Analysis is a pure function of local files** — reads CSV + profiles,
   writes `data/analysis.json` (~0.5 s for 389 shares). Re-run after every sync
   by the server's update thread. No network, no tokens.
4. **Stdlib-only server** — `ThreadingHTTPServer` with a tiny router; the
   update job runs in a daemon thread and exposes progress via
   `GET /api/update/status` for the UI's progress bar.
5. **Canvas-drawn charts** — no chart library. Sparklines for the grid
   (downsampled to ≤150 points server-side), full-resolution detail chart with
   SMA overlays, volume bars, RSI strip, and crosshair tooltips. Palette is
   CVD-validated for light and dark modes.
6. **TLS quirk** — dsebd.org's certificate chain doesn't verify with default
   clients; all fetches use an unverified SSL context (public data, read-only).
7. **Official market data over a self-computed proxy.** The homepage's live
   widget and `market-statistics.php` give the real DSEX/DS30/DSES/DSMEX index
   levels, official advance/decline, and market cap. Market regime is computed
   from these first, falling back to our own SMA50-breadth proxy only if the
   snapshot is ever unavailable. Snapshots accumulate in
   `data/market_history.json` keyed by date, building a DSEX trend over time
   without needing DSE's paid historical-index data.
8. **Announcements are categorized by regex against the title, not the body.**
   `old_news.php`'s per-record table already tags each entry with its trading
   code, so no name matching is needed there. Rules are ordered
   most-specific-first (e.g. "halt of trading" before generic "suspension");
   anything uncategorized falls to `other` unless it's a DSE-wide admin notice
   (dropped), and `daily NAV` noise (168 of ~380 entries in a week) is dropped
   entirely to keep the per-ticker file small. A 60-day rolling window is
   enforced on every merge.
9. **AGM/EGM PDF names require fuzzy matching, not exact lookup.** The PDF
   lists full legal company names ("Al-Arafah Islami Bank PLC"); our own
   ticker index only had short codes. Fixed by also capturing each company's
   full legal name during the existing `fetch_profiles.py` scrape (it was
   already on the page, just unused), then matching PDF names against it:
   normalize (strip Ltd/Limited/PLC/Co, punctuation) → exact match → substring
   containment → token-Jaccard ≥ 0.6. Unmatched entries are kept in the JSON
   under `unmatched` for visibility rather than silently dropped or guessed.
10. **Hard risk flags override technical scores.** `trading-halt` and
    `audit-concern` (Qualified Opinion / Emphasis of Matter / going concern)
    force `eligible = False` regardless of how strong the technical setup
    looks — a share can't be bought during a halt, and an auditor red flag
    should not be papered over by a good chart.

## Modules

| File | Responsibility |
|---|---|
| `dse_common.py` | fetch with retries, HTML/PDF-adjacent parsing helpers, paths, ticker/JSON cache, name matching |
| `scrape_dse.py` | one-off full 2-year scrape (bootstrap only) |
| `sync.py` | orchestrates every sync step (price gap-fill, live overlay, market snapshot, news, AGM), progress callbacks |
| `fetch_profiles.py` | per-company fundamentals + full name scrape + bulk trailing P/E; checkpointed |
| `fetch_news.py` | announcements fetch + categorization + 60-day merge |
| `fetch_agm.py` | AGM/EGM PDF download + `pdfplumber` table extraction + name matching |
| `analysis.py` | indicators, two scores, `recommend()` (quality/composite/verdict/target/stop), news/AGM overlay, alerts, sectors, regime, `build_high_profit()` (7 exceptional-setup strategies over `accum_20d` OBV slope + `squeeze_pctile` bandwidth percentile, edge-ranked with strategy/sector caps), `build_margin()` (2y-range extremes: rise/fall scores + calendar-aware turn-date estimates), `build_spike()` (3%+ session jumps vs YCP/open, continuation-scored), `apply_market_wisdom()` (spike/margin cross-signal composite adjustments + verdict re-derivation), `build_pick_why()` (detailed EN+BN reason pairs per ticker) |
| `server.py` | HTTP API + static serving + background update job |
| `static/*` | UI: eight tabs (incl. Spike, ⚡ High Profit strategy cards, Margin lower/higher sub-tabs), modal detail view with position calculator, update progress, EN+BN glossary |

## API surface

| Endpoint | Returns |
|---|---|
| `GET /api/summary` | overview + all tickers' metrics/scores/reasons/flags |
| `GET /api/charts?page&per&sort` | one page of downsampled series for the grid |
| `GET /api/history?ticker=X` | full daily series + SMA/RSI series + profile + analysis |
| `POST /api/update` | kicks off sync→analysis in a background thread |
| `GET /api/update/status` | `{running, message, pct, done, error}` for polling |

## Build phases (as executed)

1. **Bootstrap data** — scrape ticker list + 2 years of history per share into
   the CSV (`scrape_dse.py`, ~20 min, one-time).
2. **Shared plumbing** — `dse_common.py`, ticker cache.
3. **Profiles** — `fetch_profiles.py` scraped all 389 companies (background,
   checkpoint-saved every 20).
4. **Sync** — verified All-Instrument mode, gap detection, dedupe, backfill.
5. **Analysis** — indicators, two scoring models, eligibility + flags.
6. **Server + UI** — API, tabs, canvas charts, pagination, update flow.
7. **Live overlay + official market data** — intraday price snapshot with
   automatic replacement; DSEX/DS30/DSES/DSMEX + official breadth scraped each
   sync into a growing `market_history.json`; regime computed from the real
   index move + breadth ratio.
8. **Recommendation engine** — Bollinger position, support/resistance,
   higher-lows, dividend yield, relative strength, MACD-signal backtest (win
   rate), fresh-signal detection (golden cross, breakout, volume spike,
   oversold rebound); `recommend()` composite score → verdict → holding
   horizon → target/stop-loss; diversified Top 10 (max 2/sector); position-size
   calculator (2% rule) in the UI.
9. **Announcements + AGM/EGM integration** — `fetch_news.py` categorizes DSE's
   announcement feed; `fetch_profiles.py` extended to capture each company's
   full legal name; `fetch_agm.py` parses the record-date PDF via `pdfplumber`
   and matches names to tickers; `analysis.py`'s `apply_news_and_agm()` turns
   these into hard eligibility flags, risk flags, reasons, and a
   record-date-soon catalyst; a new Company Alerts panel and per-share news
   feed surface it in the UI.
10. **Verification** — smoke-tested every endpoint; screenshot-verified all
    tabs, the detail modal, and the alerts panel in headless Chrome; exercised
    the live update loop (including the news/AGM steps) end-to-end.

## Verification checklist

- `python3 sync.py` — fetches only the gap; +0 rows when already current;
  reports announcements added and AGM rows matched.
- `python3 analysis.py` — prints top short/long picks; <1 s runtime.
- `curl localhost:8765/api/summary | jq .overview,.market,.alerts` — sane
  counts, dates, real index values, and alert lists.
- Charts page 1 and last page render 100/89 cards; 2y↔1y toggle redraws.
- Detail modal (`/#t:UPGDCL`) shows chart + fundamentals + both cases + recent
  news + record-date callout + position calculator.
- Update button: progress bar advances through all five steps, finishes, UI
  data refreshes (Top 10, Alerts, Market Update panel all repaint).
- `python3 fetch_agm.py` — reports a high match rate (>90% once
  `fetch_profiles.py` has captured all company names); unmatched names printed
  for visibility.

## Future ideas (not committed)

- Portfolio tracking (holdings, cost basis, P&L vs suggestions).
- Backtesting harness to tune scoring weights against the stored history.
- Parse announcement *body* text (not just title) for more nuanced signals
  (e.g. extracting the exact dividend % from a Dividend Declaration's text).
- Historical announcement backfill beyond the rolling 60-day window, for a
  longer-horizon "event calendar" view.
