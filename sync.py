#!/usr/bin/env python3
"""Incremental price-history sync for the DSE dataset.

Two layers:
1. Historical gap-fill — fetches only dates newer than the CSV's last date,
   using the archive's "All Instrument" mode (one request per ~20-day chunk).
   New tickers get an individual 2-year backfill.
2. Live overlay — share prices move every moment during the session, and the
   day-end archive is only posted after close. So each sync also pulls the
   "latest share price" page and upserts TODAY's rows with the current
   intraday snapshot. The snapshot date is remembered in data/sync_state.json;
   the next sync deletes it and refetches, so the official day-end numbers
   always replace the intraday ones once they exist.
"""

import csv
import os
import random
import time
from datetime import date, datetime, timedelta

from dse_common import (CSV_HEADER, DATA_DIR, HISTORY_CSV, HOME_URL,
                        LIVE_PRICE_URL, MARKET_HISTORY_JSON, MARKET_STATS_URL,
                        SYNC_STATE_JSON, fetch, fetch_archive, load_json,
                        load_tickers, parse_home_snapshot, parse_live_page,
                        parse_market_statistics, save_json)


def csv_scan():
    """Single CSV pass: (max_date_str, set of (ticker, date) keys)."""
    last = None
    keys = set()
    if not os.path.exists(HISTORY_CSV):
        return None, keys
    with open(HISTORY_CSV) as f:
        reader = csv.reader(f)
        next(reader, None)
        for row in reader:
            if len(row) < 2:
                continue
            keys.add((row[0], row[1]))
            if last is None or row[1] > last:
                last = row[1]
    return last, keys


def remove_date_rows(date_str):
    """Rewrite the CSV without any rows for date_str (stale live snapshots)."""
    if not os.path.exists(HISTORY_CSV):
        return 0
    tmp = HISTORY_CSV + ".tmp"
    removed = 0
    with open(HISTORY_CSV) as fin, open(tmp, "w", newline="") as fout:
        reader = csv.reader(fin)
        writer = csv.writer(fout)
        header = next(reader, None)
        if header:
            writer.writerow(header)
        for row in reader:
            if len(row) > 1 and row[1] == date_str:
                removed += 1
                continue
            writer.writerow(row)
    os.replace(tmp, HISTORY_CSV)
    return removed


def append_rows(rows):
    new_file = not os.path.exists(HISTORY_CSV)
    with open(HISTORY_CSV, "a", newline="") as f:
        w = csv.writer(f)
        if new_file:
            w.writerow(CSV_HEADER)
        for r in rows:
            w.writerow(r)


def archive_to_csv_rows(archive_rows, wanted=None, existing_keys=None):
    """Convert archive rows (date-first) to CSV rows (ticker-first), filtered."""
    out = []
    for cells in archive_rows:
        d, code = cells[0], cells[1]
        if wanted is not None and code not in wanted:
            continue
        if existing_keys is not None and (code, d) in existing_keys:
            continue
        out.append([code, d] + cells[2:])
        if existing_keys is not None:
            existing_keys.add((code, d))
    return out


def daterange_chunks(start, end, days=20):
    cur = start
    while cur <= end:
        chunk_end = min(cur + timedelta(days=days - 1), end)
        yield cur.isoformat(), chunk_end.isoformat()
        cur = chunk_end + timedelta(days=days)


def run_sync(progress=lambda msg, pct: None, refresh_tickers=True, codes=None):
    """Incremental sync + live intraday overlay. Returns a summary dict.

    codes=None does the full job (every share's price data, plus the
    market-wide announcements/AGM-EGM/rights PDFs and a full 6-month
    projection refresh). A codes list (Fetch Shortlisted/Portfolio/Compare)
    still pulls current prices for EVERY share — DSE's archive/live-price
    endpoints only come in an all-shares shape, there's no per-ticker
    equivalent — but skips the announcements/AGM-EGM/rights fetches (they're
    market-wide anyway, not scopeable) and narrows the 6-month projection
    recompute to just the requested tickers, so it finishes faster."""
    progress("Loading ticker list...", 2)
    cache = load_tickers(refresh=refresh_tickers)
    tickers = set(cache["tickers"])
    state = load_json(SYNC_STATE_JSON, {}) or {}
    today = date.today()

    # drop the previous live snapshot so official archive data can replace it
    stale_live = state.get("live_date")
    if stale_live:
        progress(f"Refreshing provisional data for {stale_live}...", 4)
        remove_date_rows(stale_live)

    progress("Scanning existing CSV...", 6)
    last_date, keys = csv_scan()
    tickers_in_csv = {t for t, _ in keys}

    added = 0
    if last_date is None:
        start = today - timedelta(days=730)
    else:
        start = datetime.strptime(last_date, "%Y-%m-%d").date() + timedelta(days=1)

    chunks = list(daterange_chunks(start, today)) if start <= today else []
    for i, (s, e) in enumerate(chunks):
        progress(f"Fetching {s} → {e} (all instruments)...", 10 + int(50 * i / max(len(chunks), 1)))
        rows = fetch_archive(s, e)  # All Instrument
        new_rows = archive_to_csv_rows(rows, wanted=tickers, existing_keys=keys)
        append_rows(new_rows)
        added += len(new_rows)
        time.sleep(0.5)

    # Backfill any ticker that has no history at all (new listing)
    missing = sorted(tickers - tickers_in_csv)
    backfilled = 0
    for i, t in enumerate(missing):
        progress(f"Backfilling new ticker {t} ({i + 1}/{len(missing)})...",
                 62 + int(15 * i / max(len(missing), 1)))
        try:
            rows = fetch_archive((today - timedelta(days=730)).isoformat(),
                                 today.isoformat(), inst=t)
            new_rows = archive_to_csv_rows(rows, existing_keys=keys)
            append_rows(new_rows)
            backfilled += len(new_rows)
        except Exception as exc:
            progress(f"Backfill failed for {t}: {exc}", None)
        time.sleep(0.8)

    # ---- live intraday overlay (prices as of right now) ----
    progress("Fetching live prices (current session)...", 82)
    live_added = 0
    live_date = None
    page_time = ""
    try:
        page_date, page_time, live_rows = parse_live_page(fetch(LIVE_PRICE_URL))
        if page_date and live_rows:
            fresh = []
            for cells in live_rows:
                code, ltp, high, low, closep, ycp, trade, value_mn, volume = cells
                if code not in tickers or (code, page_date) in keys:
                    continue  # archive already has the official row
                try:
                    if float(ltp or 0) <= 0 and float(volume or 0) <= 0:
                        continue  # not traded in this session
                except ValueError:
                    continue
                # OpenP isn't shown intraday; day-end data replaces this row
                # later. The live page's own "CLOSEP" field is just a stale
                # intraday snapshot too — it can lag the true LTP by a
                # meaningful margin mid-session (confirmed: e.g. LTP 202 vs
                # that field showing 198.4 for the same share/moment) — so it
                # is deliberately dropped here rather than trusted. Writing it
                # as "0" makes every downstream reader's existing
                # CloseP-else-LTP fallback correctly resolve to the real LTP
                # for this provisional row, while official day-end rows
                # (where CloseP is the exchange's true computed close, not
                # just the last tick) are completely unaffected.
                fresh.append([code, page_date, ltp, high, low, "0", "0", ycp,
                              trade, value_mn, volume])
                keys.add((code, page_date))
            if fresh:
                append_rows(fresh)
                live_added = len(fresh)
                live_date = page_date
    except Exception as exc:
        progress(f"Live price fetch failed (archive data kept): {exc}", None)

    # ---- official market-wide snapshot (DSEX/DS30/DSES, turnover, breadth, market cap) ----
    progress("Fetching official market update (DSEX/DS30/breadth)...", 90)
    try:
        home = parse_home_snapshot(fetch(HOME_URL))
        stats = parse_market_statistics(fetch(MARKET_STATS_URL))
        snapshot_date = live_date or today.isoformat()
        history = load_json(MARKET_HISTORY_JSON, {}) or {}
        history[snapshot_date] = {
            **home, **stats,
            "date": snapshot_date,
            "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        # keep the last ~2 years of daily snapshots
        for d in sorted(history)[:-731]:
            del history[d]
        save_json(MARKET_HISTORY_JSON, history)
    except Exception as exc:
        progress(f"Market update fetch failed (non-fatal): {exc}", None)

    # ---- company announcements (dividends, audit flags, halts, queries...) ----
    announce_added, announce_tickers = 0, 0
    news_added, news_total = 0, 0
    agm_matched, agm_total = 0, 0
    rights_matched, rights_total = 0, 0
    if codes:
        progress(f"Scoped fetch for {len(codes)} shares — skipping market-wide "
                 f"announcements/AGM-EGM/rights (not scopeable, unchanged since last full Fetch Data)...", 93)
    else:
        progress("Fetching company announcements...", 93)
        try:
            import fetch_news
            state_prev = load_json(SYNC_STATE_JSON, {}) or {}
            news_since = state_prev.get("news_last_date")
            news_start = (datetime.strptime(news_since, "%Y-%m-%d").date()
                         if news_since else today - timedelta(days=14))
            announce_added, announce_tickers = fetch_news.merge_announcements(
                news_start.isoformat(), today.isoformat())
        except Exception as exc:
            progress(f"Announcements fetch failed (non-fatal): {exc}", None)

        # ---- amarstock news feed (news.csv; merged into analysis + News tab) ----
        progress("Fetching latest DSE news from amarstock...", 94)
        try:
            import fetch_amarstock_news
            ns = fetch_amarstock_news.run_news_fetch(progress=progress)
            news_added, news_total = ns["added"], ns["total"]
        except Exception as exc:
            progress(f"News fetch failed (non-fatal): {exc}", None)

        # ---- AGM/EGM & record-date PDF (dividend declarations + record dates) ----
        progress("Fetching AGM/EGM and record-date notices...", 96)
        try:
            import fetch_agm
            pdf_path = os.path.join(DATA_DIR, "Company_AGM_EGM.pdf")
            fetch_agm.download_pdf(pdf_path)
            agm_result = fetch_agm.build_agm_notices(pdf_path)
            save_json(fetch_agm.AGM_JSON, agm_result)
            agm_matched, agm_total = agm_result["matched_count"], agm_result["total_rows"]
        except Exception as exc:
            progress(f"AGM/EGM fetch failed (non-fatal): {exc}", None)

        # ---- rights-entitlement record-date PDF ----
        time.sleep(0.8 + random.random() * 0.6)  # same jittered spacing as the other sequential fetches
        progress("Fetching rights-entitlement record dates...", 96)
        try:
            import fetch_rights
            rights_pdf_path = os.path.join(DATA_DIR, "Company_RecordDate_RightsEntitlement.pdf")
            fetch_rights.download_pdf(rights_pdf_path)
            rights_result = fetch_rights.build_rights_notices(rights_pdf_path)
            save_json(fetch_rights.RIGHTS_JSON, rights_result)
            rights_matched, rights_total = rights_result["matched_count"], rights_result["total_rows"]
        except Exception as exc:
            progress(f"Rights-entitlement fetch failed (non-fatal): {exc}", None)

    # ---- potential-future projection (regenerated from the fresh history) ----
    scope_note = f"{len(codes)} selected shares" if codes else "all shares"
    progress(f"Regenerating potential 6-month projections for {scope_note}...", 97)
    try:
        import forecast
        forecast.run_forecast(codes=codes)
    except Exception as exc:
        progress(f"Projection failed (non-fatal): {exc}", None)

    save_json(SYNC_STATE_JSON, {"live_date": live_date, "live_time": page_time,
                                "news_last_date": today.isoformat(),
                                "synced_at": time.strftime("%Y-%m-%d %H:%M:%S")})

    summary = {
        "previous_last_date": last_date,
        "rows_added": added,
        "new_tickers_backfilled": len(missing),
        "backfill_rows": backfilled,
        "live_rows": live_added,
        "live_date": live_date,
        "live_time": page_time,
        "announcements_added": announce_added,
        "announcement_tickers": announce_tickers,
        "news_added": news_added,
        "news_total": news_total,
        "agm_matched": agm_matched,
        "agm_total": agm_total,
        "rights_matched": rights_matched,
        "rights_total": rights_total,
        "synced_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    live_note = f", {live_added} live prices ({page_time})" if live_added else ""
    news_note = f", +{announce_added} announcements" if announce_added else ""
    progress(f"Sync done: +{added + backfilled} archive rows{live_note}{news_note}.", 95)
    return summary


if __name__ == "__main__":
    def show(msg, pct):
        print(f"[{pct if pct is not None else '--'}%] {msg}")
    print(run_sync(progress=show))
