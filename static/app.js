/* DSE Market Analyzer frontend — vanilla JS + canvas, no dependencies. */
"use strict";

const $ = (s) => document.querySelector(s);
const state = {
  summary: null,
  chartsPage: 1, chartsSort: "alpha", chartsRange: "2y", chartsSearch: "", chartsData: null,
  potPage: 1, potSort: "alpha", potSearch: "", potData: null,
  scrSortKey: "score_short", scrSortDir: -1, scrRows: null,
  priceChartType: "line", chartsChartType: "line",
  chartZoom: null, chartZoomPreset: "all", chartDragging: false,
  mgView: "lower", mgSearch: "", mgRange: "3m",
  spSearch: "", spView: "spikes",
  txView: "value",
  topHorizon: "all",
  agmData: null, agmSearch: "",
  portfolio: null,
  detail: null, // cached /api/history payload for the open modal
  shortlist: loadShortlistSet(),
  compareSet: loadCompareSet(),
};

/* ---------------- shortlist (persisted in localStorage) ---------------- */
function loadShortlistSet() {
  try { return new Set(JSON.parse(localStorage.getItem("dse_shortlist") || "[]")); }
  catch { return new Set(); }
}
function saveShortlistSet() {
  localStorage.setItem("dse_shortlist", JSON.stringify([...state.shortlist]));
}
function starBtn(code, extraClass = "") {
  const on = state.shortlist.has(code);
  return `<button class="star-btn ${extraClass}${on ? " on" : ""}" data-code="${code}" ` +
    `title="${on ? "Remove from shortlist" : "Add to shortlist"}">${on ? "★" : "☆"}</button>`;
}
function wireStarButtons(container) {
  container.querySelectorAll(".star-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleShortlist(btn.dataset.code);
    });
  });
}
function toggleShortlist(code) {
  if (state.shortlist.has(code)) state.shortlist.delete(code);
  else state.shortlist.add(code);
  saveShortlistSet();
  refreshShortlistUI();
}
function refreshShortlistUI() {
  document.querySelectorAll(".star-btn").forEach((btn) => {
    const on = state.shortlist.has(btn.dataset.code);
    btn.classList.toggle("on", on);
    btn.textContent = on ? "★" : "☆";
    btn.title = on ? "Remove from shortlist" : "Add to shortlist";
  });
  if (state.chartsData) loadChartsShortlist();
  if (state.potData) loadPotentialShortlist();
  if (state.summary) renderScreenerShortlist();
}

/* ---------------- compare (persisted in localStorage) ---------------- */
const COMPARE_MAX = 6;
function loadCompareSet() {
  try { return new Set(JSON.parse(localStorage.getItem("dse_compare") || "[]")); }
  catch { return new Set(); }
}
function saveCompareSet() {
  localStorage.setItem("dse_compare", JSON.stringify([...state.compareSet]));
}
function compareBtn(code) {
  const on = state.compareSet.has(code);
  return `<button class="compare-btn${on ? " on" : ""}" data-code="${code}" ` +
    `title="${on ? "Remove from Compare" : "Add to Compare"}">⚖</button>`;
}
function wireCompareButtons(container) {
  container.querySelectorAll(".compare-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCompare(btn.dataset.code);
    });
  });
}
function toggleCompare(code) {
  if (state.compareSet.has(code)) {
    state.compareSet.delete(code);
  } else {
    if (state.compareSet.size >= COMPARE_MAX) {
      alert(`You can compare up to ${COMPARE_MAX} shares at once — remove one first to add another.\n` +
            `একসাথে সর্বোচ্চ ${COMPARE_MAX}টি শেয়ার তুলনা করা যায় — নতুন যোগ করতে একটি সরান।`);
      return;
    }
    state.compareSet.add(code);
  }
  saveCompareSet();
  refreshCompareUI();
}
function refreshCompareUI() {
  document.querySelectorAll(".compare-btn").forEach((btn) => {
    const on = state.compareSet.has(btn.dataset.code);
    btn.classList.toggle("on", on);
    btn.title = on ? "Remove from Compare" : "Add to Compare";
  });
  const badge = $("#compareBadge");
  if (badge) badge.textContent = state.compareSet.size ? `(${state.compareSet.size})` : "";
  if (!$("#tab-compare").classList.contains("hidden")) renderCompare();
}

/* ---------------- glossary (English + বাংলা) ---------------- */
const GLOSSARY = {
  composite: { t: "Composite score", en: "Overall 0–100 score blending short-term (35%), long-term (40%) and quality (25%) signals. Higher is better.", bn: "সামগ্রিক স্কোর (০–১০০): স্বল্পমেয়াদি, দীর্ঘমেয়াদি ও মান-সংকেতের সমন্বয়। যত বেশি, তত ভালো।" },
  verdict: { t: "Verdict", en: "Overall call. Strong Buy = high-conviction setup; Buy = good setup; Watch = wait for confirmation; Avoid = fails safety checks.", bn: "চূড়ান্ত মতামত: Strong Buy = জোরালো কেনার সংকেত, Buy = কেনা যায়, Watch = নজরে রাখুন, Avoid = এড়িয়ে চলুন।" },
  horizon: { t: "Holding period", en: "A continuous estimate, not a pick from 3 fixed buckets — how much the short-term score dominates the long-term one slides the window anywhere from a few days (pure momentum) to several months (pure fundamentals/position trade), and a more volatile share resolves sooner than a calmer one at the same score balance. Shown as a range (d = trading days, w = weeks, m = months); Target/Stop-loss scale smoothly with it too.", bn: "এটি ৩টি নির্দিষ্ট বিভাগ থেকে বেছে নেওয়া নয়, বরং ধারাবাহিক (continuous) হিসাব — স্বল্পমেয়াদি স্কোর দীর্ঘমেয়াদির তুলনায় কতটা প্রবল তার ভিত্তিতে সময়সীমা কয়েক দিন (নিছক মোমেন্টাম) থেকে কয়েক মাস (নিছক মৌলভিত্তি) পর্যন্ত যেকোনো জায়গায় হতে পারে; বেশি ওঠানামা করা শেয়ার একই স্কোরে দ্রুত সমাধান হয়। রেঞ্জ আকারে দেখানো হয় (d = লেনদেন দিবস, w = সপ্তাহ, m = মাস); Target/Stop-loss-ও এর সাথে সমানুপাতিকভাবে বদলায়।" },
  target: { t: "Profit target", en: "Price to book profit at, scaled to the share's own volatility. Consider selling (at least partially) when reached.", bn: "লক্ষ্য মূল্য — এই দামে পৌঁছালে মুনাফা তুলে নিন (অন্তত আংশিক)। শেয়ারের ওঠানামা অনুযায়ী নির্ধারিত।" },
  stop: { t: "Stop-loss", en: "If price falls below this, sell to cap the loss. Protects capital when the setup fails.", bn: "স্টপ-লস — দাম এর নিচে নামলে বিক্রি করে বড় ক্ষতি এড়ান। এটাই পুঁজি রক্ষার নিয়ম।" },
  score_short: { t: "Short-term score", en: "1–2 week outlook: momentum 30%, trend 20%, volume surge 20%, RSI zone 15%, MACD 15%.", bn: "স্বল্পমেয়াদি স্কোর (১–২ সপ্তাহ): মোমেন্টাম, ট্রেন্ড, ভলিউম, RSI ও MACD মিলিয়ে হিসাব।" },
  score_long: { t: "Long-term score", en: "1–2 month outlook: trend 25%, fundamentals 25%, 52-week position 20%, consistency 15%, momentum quality 15%.", bn: "দীর্ঘমেয়াদি স্কোর (১–২ মাস): ট্রেন্ড, মৌলভিত্তি, ৫২-সপ্তাহ অবস্থান, ধারাবাহিকতা ও গতির মান।" },
  quality: { t: "Quality score", en: "Risk quality: trading depth, low volatility, DSE category, market-beating strength, sponsor holding.", bn: "মান স্কোর: লেনদেনের গভীরতা, কম ঝুঁকি, ক্যাটাগরি, বাজারকে হারানোর ক্ষমতা ও স্পন্সর মালিকানা।" },
  momentum: { t: "Momentum", en: "Recent price velocity — blend of 1-week and 2-week returns. Rising momentum attracts more buyers.", bn: "মোমেন্টাম — সাম্প্রতিক দামের গতি (১ ও ২ সপ্তাহের রিটার্ন)। বাড়ন্ত গতি আরও ক্রেতা টানে।" },
  rsi: { t: "RSI (14)", en: "Relative Strength Index. Above 70 = overbought (pullback risk), below 30 = oversold; 45–65 is the healthy zone.", bn: "RSI (১৪ দিন): ৭০-এর বেশি মানে অতিরিক্ত কেনা (দাম কমার ঝুঁকি), ৩০-এর কম মানে অতিরিক্ত বিক্রি; ৪৫–৬৫ স্বাস্থ্যকর।" },
  sma: { t: "SMA / trend", en: "Simple Moving Average — average close over N days. Price above a rising SMA = uptrend; SMA20 above SMA50 confirms it.", bn: "সরল চলমান গড় (SMA)। দাম বাড়ন্ত গড়ের উপরে থাকা মানে ঊর্ধ্বমুখী প্রবণতা; SMA20 > SMA50 হলে তা নিশ্চিত হয়।" },
  macd: { t: "MACD", en: "Trend-momentum indicator. A bullish, strengthening histogram is a buy signal; weakening warns of a turn.", bn: "MACD — প্রবণতার গতি মাপার সূচক; পজিটিভ ও বাড়ন্ত হলে কেনার সংকেত, দুর্বল হলে সতর্কতা।" },
  vol_ratio: { t: "Volume surge", en: "Last 5 days' volume ÷ 30-day average. Above 1.5× often means big investors are accumulating.", bn: "ভলিউম সার্জ: গত ৫ দিনের লেনদেন ৩০ দিনের গড়ের কত গুণ। ১.৫-এর বেশি হলে বড় বিনিয়োগকারীদের কেনার ইঙ্গিত।" },
  pos52: { t: "52-week position", en: "Where price sits in its 52-week low→high range. Recovering from the middle is safer than chasing tops.", bn: "৫২ সপ্তাহের সর্বনিম্ন-সর্বোচ্চের মধ্যে বর্তমান অবস্থান। মাঝামাঝি থেকে ঘুরে দাঁড়ানো শেয়ার তুলনামূলক নিরাপদ।" },
  volatility: { t: "Volatility", en: "Average daily price swing (σ). Higher = riskier; targets and stop-losses scale with it.", bn: "দৈনিক দামের গড় ওঠানামা। বেশি হলে ঝুঁকি বেশি; টার্গেট ও স্টপ-লস এর অনুপাতে ঠিক হয়।" },
  liquidity: { t: "Liquidity", en: "Average daily traded value (mn BDT, 30 days). Below 5mn it's hard to exit without moving the price.", bn: "দৈনিক গড় লেনদেন মূল্য (মিলিয়ন টাকা)। ৫-এর কম হলে দরকারের সময় বেচা কঠিন।" },
  pe: { t: "P/E ratio", en: "Price ÷ earnings per share. 5–25 is reasonable on DSE; very high means expensive vs profit.", bn: "P/E — দাম ভাগ শেয়ারপ্রতি আয়। ৫–২৫ যুক্তিসঙ্গত; খুব বেশি মানে আয়ের তুলনায় দামি।" },
  eps: { t: "EPS", en: "Earnings per share. Two figures are shown: 'annual' (from the latest audited yearly filing — the correct one for P/E math) and 'last qtr' (the most recently reported quarter alone, ~1/4 the annual figure — useful for spotting momentum, not for valuation). Positive and growing = profitable, healthy company.", bn: "EPS — শেয়ারপ্রতি আয়। দুটি সংখ্যা দেখানো হয়: 'annual' (সর্বশেষ নিরীক্ষিত বার্ষিক প্রতিবেদন থেকে — P/E হিসাবের জন্য সঠিক) এবং 'last qtr' (শুধু সর্বশেষ প্রান্তিক, বার্ষিকের প্রায় ¼ — ভ্যালুয়েশনের জন্য নয়, গতি বোঝার জন্য উপযোগী)। পজিটিভ ও বাড়ন্ত হলে কোম্পানি লাভজনক ও সুস্থ।" },
  dividend_yield: { t: "Dividend yield", en: "Last cash dividend as % of today's price — income you earn just by holding.", bn: "লভ্যাংশ ফলন — আজকের দামের তুলনায় নগদ লভ্যাংশ কত শতাংশ; শুধু ধরে রাখলেই এই আয়।" },
  category: { t: "DSE category", en: "A = pays regular dividends (safest), B = irregular, N = newly listed, Z = pays none / riskiest.", bn: "DSE ক্যাটাগরি: A = নিয়মিত লভ্যাংশ (নিরাপদ), B = অনিয়মিত, N = নতুন তালিকাভুক্ত, Z = লভ্যাংশ দেয় না (ঝুঁকিপূর্ণ)।" },
  rel_1m: { t: "Relative strength", en: "1-month return minus the market average — positive means it's beating the market.", bn: "আপেক্ষিক শক্তি — বাজারের গড়ের তুলনায় ১ মাসের রিটার্ন। পজিটিভ মানে শেয়ারটি বাজারকে হারাচ্ছে।" },
  support: { t: "Support / Resistance", en: "Support = the 3-month low buyers defended; resistance = the 3-month high. Room below resistance = headroom to rise.", bn: "সাপোর্ট = ৩ মাসের সর্বনিম্ন যেখানে ক্রেতারা দাম ধরে রেখেছে; রেজিস্ট্যান্স = সর্বোচ্চ। রেজিস্ট্যান্স পর্যন্ত ফাঁকা জায়গা = বাড়ার সুযোগ।" },
  returns: { t: "Return % (past, not a prediction)", en: "How much the price has ALREADY moved over the trailing period (1w = the last week, 1m = the last month) — pure momentum history, one input into the score. For a forward-looking estimate see AI Pred. 1w/1m instead.", bn: "গত সময়ে দাম ইতিমধ্যে কতটা বদলেছে তা (1w = গত সপ্তাহ, 1m = গত মাস) — নিছক অতীতের গতিবেগ, স্কোরের একটি উপাদান মাত্র। ভবিষ্যতের আন্দাজের জন্য AI Pred. 1w/1m দেখুন।" },
  eligible: { t: "Eligible", en: "Passes safety checks for pick lists: liquid, equity (not fund/bond), not category Z, fresh data.", bn: "সুপারিশ তালিকার শর্ত পূরণ করেছে: পর্যাপ্ত লেনদেন, ইকুইটি শেয়ার, Z ক্যাটাগরি নয়, হালনাগাদ তথ্য।" },
  flags: { t: "Risk flags", en: "Warnings that need attention before buying — hover each red chip for its meaning.", bn: "ঝুঁকি-চিহ্ন — কেনার আগে খেয়াল করুন; প্রতিটি লাল চিপে মাউস রাখলে অর্থ দেখা যাবে।" },
  sector: { t: "Sector", en: "Industry group. Diversifying across sectors reduces risk.", bn: "খাত — বিভিন্ন খাতে ভাগ করে বিনিয়োগ করলে ঝুঁকি কমে।" },
  fetch_data: { t: "Fetch Data", en: "Fetches only the newest missing dates from DSE, then re-runs all analysis and saves the results to disk. Takes under a minute. This does NOT refresh what's on screen — click Update Data afterward to see it.", bn: "শুধু নতুন দিনের তথ্য DSE থেকে আনে, বিশ্লেষণ নতুন করে চালায় ও ফলাফল ফাইলে সংরক্ষণ করে। এক মিনিটের কম লাগে। এটি পাতায় দেখানো তথ্য বদলায় না — দেখতে পরে Update Data চাপুন।" },
  fetch_scoped: { t: "Scoped fetch", en: "Same current prices for every share (DSE's price feed has no per-share endpoint), but skips the market-wide announcements/AGM-EGM/rights PDFs and only recomputes the 6-month price projection for this list — so it finishes faster than Fetch Data. Does nothing if the list is empty. Doesn't refresh the screen either — click Update Data after.", bn: "সব শেয়ারের বর্তমান দামই আসে (DSE-এর দামের ফিড একটি একটি শেয়ার করে দেয় না), কিন্তু বাজারজোড়া ঘোষণা/AGM-EGM/রাইটস পিডিএফ বাদ যায় এবং শুধু এই তালিকার ৬ মাসের প্রক্ষেপণ নতুন করে হিসাব হয় — তাই Fetch Data-র চেয়ে দ্রুত শেষ হয়। তালিকা খালি হলে কিছু হয় না। পাতাও বদলায় না — পরে Update Data চাপুন।" },
  render_data: { t: "Update Data", en: "No network request — just redraws every tab from whatever was last saved to disk by Fetch Data. Instant.", bn: "কোনো নেটওয়ার্ক অনুরোধ নেই — Fetch Data সবশেষ যা ফাইলে সংরক্ষণ করেছিল তা দিয়ে শুধু পাতা নতুন করে আঁকে। তাৎক্ষণিক।" },
  help: { t: "Help", en: "Opens the full glossary of every term used in this app.", bn: "অ্যাপে ব্যবহৃত সব শব্দের পূর্ণ ব্যাখ্যা দেখায়।" },
  "flag:overbought": { t: "overbought", en: "RSI above 70 — price ran up fast and may pause or pull back. Wait for a dip.", bn: "RSI ৭০+ — দাম দ্রুত বেড়েছে, কিছুটা কমতে পারে। একটু কমলে কেনার কথা ভাবুন।" },
  "flag:illiquid": { t: "illiquid", en: "Very little daily trading — hard to buy or sell without moving the price.", bn: "লেনদেন খুব কম — দাম না বাড়িয়ে কেনা বা না কমিয়ে বেচা কঠিন।" },
  "flag:category-B": { t: "category-B", en: "Pays irregular/low dividends. Acceptable, but weaker than category A.", bn: "অনিয়মিত/কম লভ্যাংশ দেয়। চলনসই, তবে A ক্যাটাগরির চেয়ে দুর্বল।" },
  "flag:category-Z": { t: "category-Z", en: "Pays no dividends; riskiest DSE class. Excluded from suggestions.", bn: "লভ্যাংশ দেয় না; সবচেয়ে ঝুঁকিপূর্ণ শ্রেণি। সুপারিশ থেকে বাদ।" },
  "flag:near-52w-high": { t: "near-52w-high", en: "Within 8% of its 52-week high — needs a breakout for further upside.", bn: "৫২-সপ্তাহের সর্বোচ্চের খুব কাছে — আরও বাড়তে হলে রেকর্ড ভাঙতে হবে।" },
  "flag:high-volatility": { t: "high-volatility", en: "Daily swings above 4% — bigger profit potential but bigger loss risk. Buy smaller amounts.", bn: "দৈনিক ওঠানামা ৪%+ — লাভের সম্ভাবনার সাথে ক্ষতির ঝুঁকিও বেশি। কম পরিমাণে কিনুন।" },
  "flag:extended-rally": { t: "extended-rally", en: "7+ consecutive up days — statistically due for a pullback.", bn: "টানা ৭+ দিন বেড়েছে — মূল্য সংশোধনের (কমার) সম্ভাবনা বেশি।" },
  "flag:stale-data": { t: "stale-data", en: "No trades in over a week — data may be outdated; possibly suspended.", bn: "এক সপ্তাহের বেশি লেনদেন নেই — তথ্য পুরনো হতে পারে; লেনদেন স্থগিতও হতে পারে।" },
  "flag:not-equity": { t: "not-equity", en: "A mutual fund or bond, not a company share — excluded from stock suggestions.", bn: "এটি মিউচুয়াল ফান্ড বা বন্ড, কোম্পানির শেয়ার নয় — শেয়ার সুপারিশ থেকে বাদ।" },
  "flag:heavy-volume-selling": { t: "heavy-volume-selling", en: "Among today's top 10 busiest shares by traded value or volume, but the price fell — heavy trading into a falling price looks like distribution (insiders/big holders selling into demand), not accumulation.", bn: "আজকের সর্বোচ্চ ব্যস্ত শেয়ারের মধ্যে (মূল্য বা ভলিউমে), কিন্তু দাম কমেছে — পতনের মধ্যে ভারী লেনদেন সঞ্চয় নয়, বিতরণের (বড় ধারীদের বিক্রি) লক্ষণ।" },
  rr: { t: "Risk/Reward (R/R)", en: "Target % ÷ stop-loss %. Above 1.5 means the potential gain outweighs the risk taken.", bn: "ঝুঁকি-পুরস্কার অনুপাত — সম্ভাব্য লাভ ভাগ সম্ভাব্য ক্ষতি। ১.৫-এর বেশি হলে ঝুঁকি নেওয়া সার্থক।" },
  win_rate: { t: "Signal win rate", en: "Backtest of this share's past MACD buy signals over 2 years: % that gained >2% within a month. Past ≠ future, but shows how reliably this share follows its signals.", bn: "গত ২ বছরে এই শেয়ারের MACD কেনার সংকেত কত শতাংশ সময় এক মাসে ২%+ লাভ দিয়েছে। অতীত মানেই ভবিষ্যৎ নয়, তবে শেয়ারটি সংকেত কতটা মানে তার ধারণা দেয়।" },
  regime: { t: "Market regime", en: "Market health from breadth: % of shares above their SMA50. Bullish = most shares rising (better time to buy); Bearish = most falling (hold cash, be patient).", bn: "বাজারের অবস্থা: কত শতাংশ শেয়ার SMA50-এর উপরে। Bullish = বেশিরভাগ বাড়ছে (কেনার ভালো সময়); Bearish = বেশিরভাগ কমছে (অপেক্ষা করুন)।" },
  signals: { t: "Fresh signals", en: "Technical events detected on the latest trading day — early entries before the crowd notices.", bn: "সর্বশেষ লেনদেন দিবসে ধরা পড়া টেকনিক্যাল ঘটনা — সবার আগে ঢোকার সুযোগ।" },
  position: { t: "Position sizing", en: "The 2% rule: buy only as many shares as keeps your loss at the stop-loss within the chosen % of capital. This is how professionals survive losing streaks.", bn: "২% নিয়ম: স্টপ-লসে ঠেকলে যেন মূলধনের নির্ধারিত শতাংশের বেশি না হারান, ততটুকুই কিনুন। পেশাদাররা এভাবেই টিকে থাকে।" },
  "sig:golden-cross": { t: "golden-cross", en: "SMA20 crossed above SMA50 today — classic start of a medium-term uptrend.", bn: "গোল্ডেন ক্রস — SMA20 আজ SMA50-এর উপরে উঠেছে; মধ্যমেয়াদি ঊর্ধ্বগতির সূচনা হতে পারে।" },
  "sig:macd-cross": { t: "macd-cross", en: "MACD histogram turned positive today — momentum shifting upward.", bn: "MACD আজ পজিটিভ হয়েছে — দামের গতি ঊর্ধ্বমুখী হচ্ছে।" },
  "sig:breakout-3m": { t: "breakout-3m", en: "Price closed above its previous 3-month high — buyers overpowered resistance.", bn: "দাম ৩ মাসের আগের সর্বোচ্চ ভেঙে উঠেছে — ক্রেতারা রেজিস্ট্যান্স অতিক্রম করেছে।" },
  "sig:volume-spike": { t: "volume-spike", en: "Today's volume was 2.5×+ the 30-day average — unusual interest, often before a move.", bn: "আজকের লেনদেন ৩০ দিনের গড়ের ২.৫ গুণের বেশি — অস্বাভাবিক আগ্রহ, প্রায়ই বড় মুভের আগে দেখা যায়।" },
  "sig:oversold-rebound": { t: "oversold-rebound", en: "RSI recovered from oversold (<30) — potential rebound from a bottom.", bn: "RSI অতিরিক্ত বিক্রি অবস্থা (<৩০) থেকে ফিরছে — তলানি থেকে ঘুরে দাঁড়ানোর সম্ভাবনা।" },
  market_update: { t: "Market Update", en: "Official exchange-wide snapshot scraped live from the DSE homepage: the real DSEX/DS30/DSES/DSMEX indices, total turnover, and today's advance/decline count — not a proxy from our own tracked shares.", bn: "DSE-এর হোমপেজ থেকে সরাসরি নেওয়া বাজারের অফিসিয়াল তথ্য: প্রকৃত DSEX/DS30/DSES/DSMEX সূচক, মোট লেনদেন এবং আজকের বাড়া-কমার সংখ্যা।" },
  dsex: { t: "DSEX Index", en: "The DSE Broad Index — the main benchmark for the whole exchange. If DSEX is up, the market overall is up.", bn: "DSEX — পুরো বাজারের প্রধান বেঞ্চমার্ক সূচক। DSEX বাড়লে সামগ্রিক বাজার বাড়ছে বোঝায়।" },
  ds30: { t: "DS30 Index", en: "Blue-chip index of the 30 largest, most liquid companies — how the big names are doing.", bn: "DS30 — সবচেয়ে বড় ও তরল ৩০টি কোম্পানির সূচক; বড় কোম্পানিগুলোর অবস্থা বোঝায়।" },
  dses: { t: "DSES Shariah Index", en: "Index of Shariah-compliant listed companies.", bn: "DSES — শরিয়াহ সম্মত তালিকাভুক্ত কোম্পানিগুলোর সূচক।" },
  dsmex: { t: "DSMEX Index", en: "Index for the SME (small/medium enterprise) board — a smaller, higher-risk segment.", bn: "DSMEX — এসএমই (ছোট ও মাঝারি প্রতিষ্ঠান) বোর্ডের সূচক; তুলনামূলক ছোট ও বেশি ঝুঁকিপূর্ণ।" },
  turnover: { t: "Market turnover", en: "Total trades, shares traded, and value (Tk mn) across the whole exchange today — a rising trend means more market activity/interest.", bn: "আজ সারা বাজারে মোট লেনদেন সংখ্যা, শেয়ার সংখ্যা ও মূল্য (টাকা মিলিয়ন) — বাড়তে থাকলে বাজারে আগ্রহ বাড়ছে বোঝায়।" },
  official_breadth: { t: "Official advance/decline", en: "The exchange's own count of how many listed issues rose vs fell today, by category. More reliable than any single tracker's sample.", bn: "এক্সচেঞ্জের নিজস্ব হিসাবে আজ কতগুলো শেয়ার বেড়েছে বা কমেছে, ক্যাটাগরি অনুযায়ী। যেকোনো একক উৎসের চেয়ে নির্ভরযোগ্য।" },
  market_cap: { t: "Market capitalisation", en: "Total value of all listed equity + mutual funds + debt securities — the size of the whole market.", bn: "সব তালিকাভুক্ত ইকুইটি + মিউচুয়াল ফান্ড + ঋণ সিকিউরিটির মোট মূল্য — সমগ্র বাজারের আকার।" },
  company_alerts: { t: "Company Alerts", en: "Material company announcements scraped from DSE's news feed and the AGM/EGM record-date PDF: trading halts, auditor concerns, and upcoming dividend record dates — things that should change your buy decision.", bn: "DSE-এর ঘোষণা ও AGM/EGM রেকর্ড ডেট পিডিএফ থেকে নেওয়া গুরুত্বপূর্ণ তথ্য: লেনদেন বন্ধ, অডিট সংক্রান্ত উদ্বেগ, এবং আসন্ন লভ্যাংশ রেকর্ড ডেট — যা আপনার কেনার সিদ্ধান্ত বদলে দিতে পারে।" },
  record_date: { t: "Record date", en: "The cutoff date to own a share and qualify for its declared dividend. Buy before this date to capture the dividend; the price typically drops by roughly the dividend amount right after (the 'ex-dividend' adjustment).", bn: "রেকর্ড ডেট — এই তারিখের মধ্যে শেয়ার থাকলে ঘোষিত লভ্যাংশ পাবেন। এই তারিখের আগে কিনলে লভ্যাংশ পাবেন; এর পরপরই দাম লভ্যাংশের প্রায় সমপরিমাণ কমে যায় (এক্স-ডিভিডেন্ড সমন্বয়)।" },
  action_plan: { t: "Action", en: "When to buy and how long to hold, in one line — combines the suggested buy date and holding horizon. See the separate Target/Stop-loss columns for the exit prices.", bn: "কবে কিনবেন ও কতদিন ধরে রাখবেন, একলাইনে — প্রস্তাবিত কেনার তারিখ ও ধরে রাখার সময়সীমা একসাথে। বের হওয়ার দাম দেখতে Target/Stop-loss কলাম দেখুন।" },
  buy_date: { t: "Suggested buy date", en: "When to enter: next trading session for a fresh setup; 2–3 sessions later if the share is overheated (wait for a dip); and never later than 2 sessions before a record date worth capturing (DSE settles trades in T+2 days). DSE trades Sunday–Thursday.", bn: "কবে কিনবেন: নতুন সেটআপ হলে পরের কার্যদিবসে; অতিরিক্ত বেড়ে থাকলে ২–৩ দিন পরে (দাম একটু কমার অপেক্ষায়); আর লভ্যাংশ পেতে চাইলে রেকর্ড ডেটের অন্তত ২ কার্যদিবস আগে (DSE-তে লেনদেন নিষ্পত্তিতে ২ দিন লাগে)। DSE রবি–বৃহস্পতিবার খোলা থাকে।" },
  "flag:trading-halt": { t: "trading-halt", en: "DSE has halted trading in this share — you cannot buy or sell it right now. Wait for resumption news.", bn: "এই শেয়ারের লেনদেন DSE বন্ধ করে দিয়েছে — এখন কেনা-বেচা করা যাবে না। পুনরায় চালুর খবরের অপেক্ষা করুন।" },
  "flag:audit-concern": { t: "audit-concern", en: "The auditor issued a Qualified Opinion, Emphasis of Matter, or going-concern warning in the latest financials — a serious red flag on the company's accounts. Avoid until resolved.", bn: "সাম্প্রতিক আর্থিক বিবরণীতে অডিটর Qualified Opinion বা Going Concern নিয়ে সতর্ক করেছেন — কোম্পানির হিসাবে গুরুতর ঝুঁকির সংকেত। সমাধান না হওয়া পর্যন্ত এড়িয়ে চলুন।" },
  "flag:exchange-query": { t: "exchange-query", en: "DSE sent this company a formal query, usually about an abnormal price movement. Read the response before trusting the current price move.", bn: "DSE এই কোম্পানিকে আনুষ্ঠানিক প্রশ্ন পাঠিয়েছে, সাধারণত অস্বাভাবিক দাম ওঠানামা নিয়ে। বর্তমান দামের গতিবিধি বিশ্বাস করার আগে জবাব পড়ুন।" },
  "flag:category-change-news": { t: "category-change-news", en: "This company's DSE category (A/B/N/Z) recently changed — check which direction, as it affects dividend eligibility and risk perception.", bn: "কোম্পানির DSE ক্যাটাগরি (A/B/N/Z) সম্প্রতি পরিবর্তিত হয়েছে — কোন দিকে পরিবর্তন হয়েছে দেখে নিন, এটি লভ্যাংশ যোগ্যতা ও ঝুঁকিকে প্রভাবিত করে।" },
  "flag:top-of-range": { t: "top-of-range", en: "Trading in the top quarter of its 2-year range with a meaningful fall score — the Margin analysis sees this as a profit-taking zone, not an entry zone. Blocks a Strong Buy verdict.", bn: "২ বছরের সীমার উপরের ২৫%-এ আছে এবং পতনের স্কোর উল্লেখযোগ্য — Margin বিশ্লেষণ একে মুনাফা তোলার জায়গা মনে করে, ঢোকার নয়। Strong Buy রায় আটকে দেয়।" },
  "flag:spike-fade-risk": { t: "spike-fade-risk", en: "This share spiked today but the continuation score is low (thin volume / no news / weak trend) — the Spike analysis expects the jump to fade. Don't chase it.", bn: "শেয়ারটি আজ স্পাইক করেছে কিন্তু ধারাবাহিকতা-স্কোর কম (কম ভলিউম / খবর নেই / দুর্বল ট্রেন্ড) — Spike বিশ্লেষণ ধারণা করছে লাফটি মিলিয়ে যাবে। পেছনে ছুটবেন না।" },
  "flag:spike-down-risk": { t: "spike-down-risk", en: "This share dropped sharply recently and the Spike analysis sees signs the decline continues (volume backing, downtrend context, bad news) — a reason to reassess a holding or avoid buying the dip.", bn: "শেয়ারটি সম্প্রতি ব্যাপক পড়েছে এবং Spike বিশ্লেষণ পতন চলতে থাকার লক্ষণ দেখছে (ভলিউম সমর্থন, নিম্নগতির প্রেক্ষাপট, খারাপ খবর) — হোল্ডিং পুনর্মূল্যায়ন করার বা কমা দামে না কেনার কারণ।" },
  why_col: { t: "Why · কেন", en: "The detailed, data-backed reasons behind this row — trend, relative strength, volume, fundamentals, signal history, record dates, plus cross-checks against today's Spike list, the 2-year Margin extremes, and today's Top 10 Transaction activity (turnover/volume confirmation). Hover the text itself to read it in Bengali.", bn: "এই সারির পেছনের বিস্তারিত, তথ্যভিত্তিক কারণ — ট্রেন্ড, আপেক্ষিক শক্তি, ভলিউম, মৌলভিত্তি, সংকেতের ইতিহাস, রেকর্ড ডেট, এবং আজকের Spike, Margin ও Today's Top 10 Transaction কার্যকলাপের (লেনদেন/ভলিউম নিশ্চিতকরণ) সাথে মিলিয়ে দেখা। লেখাটির উপর মাউস রাখলে বাংলায় পড়া যাবে।" },
  "flag:record-date-soon": { t: "record-date-soon", en: "The dividend record date is within ~20 days — a near-term reason to hold through that date if you want the dividend.", bn: "লভ্যাংশের রেকর্ড ডেট প্রায় ২০ দিনের মধ্যে — লভ্যাংশ পেতে চাইলে ওই তারিখ পর্যন্ত ধরে রাখার একটি কারণ।" },
  "news:dividend": { t: "dividend news", en: "Company announced or disbursed a dividend.", bn: "কোম্পানি লভ্যাংশ ঘোষণা বা বিতরণ করেছে।" },
  "news:financials": { t: "financials news", en: "Quarterly or annual financial results were published — may move EPS/P/E.", bn: "ত্রৈমাসিক বা বার্ষিক আর্থিক ফলাফল প্রকাশিত হয়েছে — EPS/P/E বদলাতে পারে।" },
  "news:credit-rating": { t: "credit rating news", en: "A credit rating agency published a new rating for this company.", bn: "একটি ক্রেডিট রেটিং সংস্থা এই কোম্পানির জন্য নতুন রেটিং প্রকাশ করেছে।" },
  "news:board-meeting": { t: "board meeting scheduled", en: "A board meeting is scheduled, often to approve dividends or financials — a potential upcoming catalyst.", bn: "বোর্ড মিটিং নির্ধারিত হয়েছে, প্রায়ই লভ্যাংশ বা আর্থিক ফলাফল অনুমোদনের জন্য — সম্ভাব্য আসন্ন ঘটনা।" },
  "news:rights-issue": { t: "rights issue news", en: "A rights share issue was announced or approved — this dilutes existing shareholders unless you subscribe.", bn: "রাইট শেয়ার ইস্যু ঘোষণা বা অনুমোদিত হয়েছে — সাবস্ক্রাইব না করলে বিদ্যমান শেয়ারহোল্ডারদের অংশ কমে যায় (ডাইলিউশন)।" },
  "news:suspension": { t: "suspension", en: "Trading was temporarily suspended, typically around a record date — normal and expected, not necessarily bad news.", bn: "রেকর্ড ডেটের আশেপাশে সাময়িকভাবে লেনদেন স্থগিত — এটি স্বাভাবিক, খারাপ খবর নয়।" },
  "news:resumption": { t: "resumption", en: "Trading resumed after a suspension.", bn: "স্থগিতাদেশের পর লেনদেন আবার শুরু হয়েছে।" },
  "news:other": { t: "other announcement", en: "A company announcement that didn't fall into a specific tracked category — read the title for context.", bn: "নির্দিষ্ট কোনো শ্রেণিতে না পড়া কোম্পানি ঘোষণা — বিস্তারিত জানতে শিরোনাম দেখুন।" },
  theme_toggle: { t: "Theme", en: "Click to cycle Auto (follows your browser/OS setting) → Light → Dark. Useful when your browser reports a color scheme you don't want here (e.g. Safari showing light while Chrome shows dark) — pick Light or Dark to force it, independent of the browser. Saved in this browser only.", bn: "ক্লিক করলে Auto (ব্রাউজার/OS-এর সেটিং অনুসরণ করে) → Light → Dark ক্রমে বদলায়। ব্রাউজার ভুল থিম দেখালে (যেমন Safari-তে হালকা কিন্তু Chrome-এ গাঢ়) Light বা Dark বেছে জোর করে নির্ধারণ করুন। শুধু এই ব্রাউজারে সংরক্ষিত হয়।" },
  shortlist: { t: "Shortlist", en: "Click the ☆ on any share to shortlist it — shortlisted shares are pinned in their own section at the top of the Charts, AI Prediction Chart, and Screener tabs. Saved in this browser only (not shared across devices).", bn: "যেকোনো শেয়ারের ☆ চিহ্নে ক্লিক করলে তা শর্টলিস্টে যোগ হয় — শর্টলিস্ট করা শেয়ারগুলো Charts, AI Prediction Chart ও Screener ট্যাবের উপরে আলাদা অংশে দেখা যাবে। শুধু এই ব্রাউজারে সংরক্ষিত হয় (অন্য ডিভাইসে নয়)।" },
  compare: { t: "Compare", en: "Click the ⚖ on any share (Suggestions, Spike, High Profit, Margin, Charts, AI Prediction Chart, or Screener) to add it to the Compare tab — up to 6 at once. Compare shows every share side by side and ranks them against EACH OTHER, unlike every other tab which ranks against the whole market. Saved in this browser only.", bn: "যেকোনো শেয়ারের ⚖ চিহ্নে ক্লিক করলে তা Compare ট্যাবে যোগ হয় — একসাথে সর্বোচ্চ ৬টি। Compare শেয়ারগুলোকে পাশাপাশি দেখায় ও একে অপরের তুলনায় র‍্যাঙ্ক করে — বাকি সব ট্যাব যেখানে পুরো বাজারের তুলনায় র‍্যাঙ্ক করে। শুধু এই ব্রাউজারে সংরক্ষিত হয়।" },
  compare_tab: { t: "Compare", en: "Side-by-side comparison of shares you've marked with ⚖ across the app (up to 6). Every metric — score, target/stop, technicals, fundamentals, record dates, risk flags, and whether each is currently flagged in Spike/High Profit/Margin — sits in one table so you can weigh them at a glance before deciding which to actually buy.", bn: "অ্যাপ জুড়ে ⚖ দিয়ে চিহ্নিত শেয়ারগুলোর পাশাপাশি তুলনা (সর্বোচ্চ ৬টি)। প্রতিটি তথ্য — স্কোর, টার্গেট/স্টপ, টেকনিক্যাল, মৌলভিত্তি, রেকর্ড ডেট, ঝুঁকি-চিহ্ন এবং Spike/High Profit/Margin-এ চিহ্নিত কিনা — একই টেবিলে থাকে যাতে কোনটি আসলে কিনবেন তা এক নজরে বিবেচনা করতে পারেন।" },
  compare_insights: { t: "Head-to-head insights", en: "Automatically generated callouts comparing ONLY the shares you've selected against each other — best composite, best risk/reward, earliest buy date, closest record date, and any risk flags — ending with which one looks like the strongest overall pick among this specific group.", bn: "শুধুমাত্র আপনার নির্বাচিত শেয়ারগুলোকে একে অপরের সাথে তুলনা করে স্বয়ংক্রিয়ভাবে তৈরি পর্যবেক্ষণ — সেরা কম্পোজিট, সেরা ঝুঁকি-পুরস্কার, সবচেয়ে আগের কেনার তারিখ, নিকটতম রেকর্ড ডেট এবং ঝুঁকি-চিহ্ন — শেষে কোনটি এই নির্দিষ্ট দলের মধ্যে সবচেয়ে শক্তিশালী তার সিদ্ধান্তসহ।" },
  high_profit: { t: "High Profit (exceptional setups)", en: "Aggressive 1–2 month plays found by 7 pattern-hunting strategies, scanned across every liquid eligible share on each Update Data. Each pick shows the strategy that flagged it, a conviction rating (★), an aggressive profit target, and a tight stop-loss. Higher reward = higher risk: position-size with the 2% rule and honour the stop.", bn: "৭টি কৌশলে খুঁজে পাওয়া ১–২ মাসের আক্রমণাত্মক সুযোগ, প্রতি Update Data-তে সব যোগ্য শেয়ার স্ক্যান করে। প্রতিটিতে কৌশল, আস্থা (★), উচ্চ লক্ষ্যমূল্য ও আঁটসাঁট স্টপ-লস দেখানো হয়। বেশি লাভ = বেশি ঝুঁকি: ২% নিয়ম মেনে কিনুন ও স্টপ-লস মানুন।" },
  hp_conf: { t: "Conviction (★)", en: "How many extra confirmations the setup has beyond the minimum: ★ = valid setup, ★★ = strong, ★★★ = multiple confirmations or several independent strategies agreeing on the same share.", bn: "সেটআপটির অতিরিক্ত নিশ্চয়তা কতটুকু: ★ = বৈধ সেটআপ, ★★ = শক্তিশালী, ★★★ = একাধিক নিশ্চিতকরণ বা একাধিক কৌশল একই শেয়ারে একমত।" },
  "hp:squeeze": { t: "Volatility squeeze", en: "The share's daily range has contracted to its tightest in ~6 months while volume quietly flows in above SMA50. Like a coiled spring, tight ranges resolve in explosive moves — this enters BEFORE the breakout, so the reward is large if it breaks up and the stop is tight if it doesn't.", bn: "শেয়ারটির দৈনিক ওঠানামা ৬ মাসের মধ্যে সবচেয়ে সংকুচিত, অথচ SMA50-এর উপরে থেকে চুপচাপ ভলিউম ঢুকছে। স্প্রিংয়ের মতো — সংকুচিত অবস্থা বিস্ফোরক মুভে শেষ হয়; ব্রেকআউটের আগেই ঢোকা হয় বলে লাভের সম্ভাবনা বড়, ক্ষতির সীমা ছোট।" },
  "hp:momentum-leader": { t: "Momentum leader", en: "Beating the market by 8%+ this month in a clean uptrend, but not yet parabolic or overbought. Academic finding and market reality agree: over 1–2 months, leaders tend to keep leading.", bn: "এই মাসে বাজারকে ৮%+ ব্যবধানে হারাচ্ছে, পরিষ্কার ঊর্ধ্বগতিতে, কিন্তু এখনো অতিরিক্ত বাড়েনি। ১–২ মাসের মেয়াদে যারা এগিয়ে, তারা সাধারণত এগিয়েই থাকে।" },
  "hp:accumulation": { t: "Quiet accumulation", en: "On-balance volume is rising sharply while the price has barely moved — a classic footprint of big investors building a position slowly so they don't push the price up. The markup phase, when price finally moves, often follows within weeks.", bn: "দাম প্রায় না বদলালেও অন-ব্যালেন্স ভলিউম দ্রুত বাড়ছে — বড় বিনিয়োগকারীরা দাম না বাড়িয়ে ধীরে শেয়ার জমাচ্ছে, এটি তারই ছাপ। এর কয়েক সপ্তাহের মধ্যেই সাধারণত দাম বাড়ার পর্ব শুরু হয়।" },
  "hp:rebound": { t: "Oversold rebound", en: "A profitable company in a long-term uptrend (above SMA200) that has dipped to oversold RSI right at its 3-month support. Buying quality on a dip at support gives a tight stop (just below support) and a quick snap-back target.", bn: "দীর্ঘমেয়াদি ঊর্ধ্বগতির (SMA200-এর উপরে) লাভজনক কোম্পানি, RSI অতিরিক্ত-বিক্রি অঞ্চলে নেমে ৩ মাসের সাপোর্টে ঠেকেছে। সাপোর্টে মানসম্পন্ন শেয়ার কিনলে স্টপ-লস খুব কাছে রাখা যায়, আর দাম দ্রুত ফিরে আসার সম্ভাবনা থাকে।" },
  "hp:breakout": { t: "Volume breakout", en: "Price just cleared its 3-month high (or is pressing the 52-week high) on 1.3×+ volume. Everyone who wanted to sell at that level already has — with sellers cleared and demand proven, breakouts from a base tend to run for weeks.", bn: "১.৩ গুণের বেশি ভলিউমে দাম ৩ মাসের সর্বোচ্চ ভেঙেছে (বা ৫২-সপ্তাহের সর্বোচ্চ ছুঁইছুঁই)। ওই স্তরে বিক্রেতারা বিক্রি করে ফেলেছে — বাধা পরিষ্কার ও চাহিদা প্রমাণিত হলে ব্রেকআউট কয়েক সপ্তাহ ধরে চলে।" },
  "hp:dividend-runner": { t: "Dividend runner", en: "A 3.5%+ cash-yield share in an uptrend with its record date 4–25 days away. Prices typically run up as the record date approaches (buyers want the dividend) — you can ride the run-up AND keep the dividend by holding through the date.", bn: "রেকর্ড ডেটের ৪–২৫ দিন আগে থাকা ৩.৫%+ নগদ লভ্যাংশের ঊর্ধ্বমুখী শেয়ার। রেকর্ড ডেট যত কাছে আসে দাম তত বাড়ে (সবাই লভ্যাংশ চায়) — দাম বাড়ার সুবিধাও নিতে পারেন, আবার ধরে রাখলে লভ্যাংশও পাবেন।" },
  "hp:proven-signal": { t: "Proven signal", en: "A fresh MACD/golden cross on the latest session — but only on shares whose past signals actually worked (60%+ backtested win rate over 2 years). Entering on day one of a historically reliable signal, instead of chasing after the move.", bn: "সর্বশেষ সেশনে নতুন MACD/গোল্ডেন ক্রস — তবে শুধু সেই শেয়ারে যার আগের সংকেতগুলো সত্যিই কাজ করেছে (২ বছরের ব্যাকটেস্টে ৬০%+ সফল)। মুভের পেছনে না ছুটে নির্ভরযোগ্য সংকেতের প্রথম দিনেই ঢোকা।" },
  portfolio: { t: "Portfolio", en: "Your trade journal: record actual purchases and the app tracks each one with live P&L, target/stop distances, holding time vs plan, and sell alerts from every engine (Margin fall risk, unbacked spikes, bearish divergence, halts/audit news, momentum turns). Stored in data/portfolio.json on this machine.", bn: "আপনার লেনদেন খাতা: প্রকৃত কেনাগুলো লিখে রাখুন — অ্যাপ প্রতিটিতে লাভ-ক্ষতি, টার্গেট/স্টপের দূরত্ব, পরিকল্পনার তুলনায় ধরে রাখার সময় এবং সব ইঞ্জিনের বিক্রি-সতর্কতা দেখাবে। এই কম্পিউটারের data/portfolio.json ফাইলে সংরক্ষিত।" },
  trailing_stop: { t: "Trailing stop", en: "Highest close since you bought minus 2.5× ATR (the share's true daily range). It ratchets UP as the price rises and never moves down — locking in profit while giving the trade normal breathing room.", bn: "কেনার পর সর্বোচ্চ ক্লোজ বিয়োগ ২.৫ × ATR (শেয়ারটির প্রকৃত দৈনিক পরিসর)। দাম বাড়লে স্টপও উপরে ওঠে, কখনো নামে না — স্বাভাবিক ওঠানামার জায়গা রেখে মুনাফা আটকে রাখে।" },
  breakeven_stop: { t: "Break-even rule", en: "Once a holding is up 5%+, the stop never sits below your entry price — from that point the worst case is getting out even, not a loss.", bn: "কোনো শেয়ার ৫%+ লাভে গেলে স্টপ আর আপনার কেনা দামের নিচে থাকে না — তখন সবচেয়ে খারাপ ফল হলো সমান-সমানে বেরিয়ে আসা, ক্ষতি নয়।" },
  time_stop: { t: "Time stop", en: "If a holding is past its planned holding period and still below +2%, the thesis didn't work — exit and move the capital to a live setup. Held shows sessions held vs the plan.", bn: "পরিকল্পিত সময় পেরিয়েও লাভ +২%-এর নিচে থাকলে ধারণাটি কাজ করেনি — বেরিয়ে এসে পুঁজি সক্রিয় সুযোগে দিন। Held কলামে পরিকল্পনার তুলনায় কত সেশন ধরে রেখেছেন তা দেখায়।" },
  eff_stop: { t: "Effective stop", en: "The highest of three protections: the static volatility stop, the ATR trailing stop, and the break-even rule — with the rule that's currently active shown in brackets. Sell if price closes below it.", bn: "তিনটি সুরক্ষার মধ্যে সর্বোচ্চটি: স্থির স্টপ, ATR ট্রেইলিং স্টপ ও ব্রেক-ইভেন নিয়ম — বন্ধনীতে বর্তমানে কার্যকর নিয়মটি দেখানো হয়। দাম এর নিচে ক্লোজ করলে বিক্রি করুন।" },
  sell_alerts: { t: "Sell alerts", en: "Signals to exit or lighten a holding: target hit, stop broken, Higher-Margin fall risk, bearish divergence, momentum turned negative, unbacked spike (sell into strength), time stop, or a hard risk flag (halt/audit). Red = act now, amber = decide, blue = information.", bn: "বেরিয়ে আসা বা কমানোর সংকেত: টার্গেট অর্জিত, স্টপ ভাঙা, Higher Margin পতন-ঝুঁকি, বিয়ারিশ ডাইভারজেন্স, নেতিবাচক গতি, সমর্থনহীন স্পাইক, টাইম স্টপ বা গুরুতর ঝুঁকি-চিহ্ন। লাল = এখনই পদক্ষেপ, হলুদ = সিদ্ধান্ত নিন, নীল = তথ্য।" },
  report_card: { t: "Report card", en: "Self-grading: each analysis run snapshots its Strong Buy / Buy / Top 20 / High Profit lists; later runs measure what those shares actually returned over the next 1w/2w/1m vs the whole-market average. Builds up as you Update Data across days — trust the categories that beat the baseline.", bn: "স্ব-মূল্যায়ন: প্রতিটি বিশ্লেষণ তার সুপারিশ তালিকা সংরক্ষণ করে; পরের রানগুলো মাপে সেই শেয়ারগুলো পরের ১ সপ্তাহ/২ সপ্তাহ/১ মাসে বাজারের গড়ের তুলনায় আসলে কত দিল। দিনে দিনে Update Data চাপলে তথ্য জমে — যে তালিকা বাজারকে হারায় সেটিতে ভরসা করুন।" },
  atr: { t: "ATR (Average True Range)", en: "The share's real average daily trading range including gaps, from High/Low data — a better risk unit than close-to-close moves. Trailing stops are set 2.5 ATR below the highest close since purchase.", bn: "হাই/লো ডেটা থেকে হিসাব করা প্রকৃত গড় দৈনিক পরিসর (গ্যাপসহ) — ঝুঁকির মাপকাঠি হিসেবে শুধু ক্লোজের চেয়ে ভালো। ট্রেইলিং স্টপ বসে কেনার পরের সর্বোচ্চ ক্লোজের ২.৫ ATR নিচে।" },
  "flag:bearish-divergence": { t: "bearish-divergence", en: "Price made a higher high but RSI made a lower high — the rally is running on fewer buyers. One of the most reliable early warnings of a top; a reason to take profit, not to enter.", bn: "দাম নতুন চূড়ায় উঠেছে কিন্তু RSI ওঠেনি — কম ক্রেতা নিয়ে দাম বাড়ছে। চূড়ার সবচেয়ে নির্ভরযোগ্য আগাম সংকেতগুলোর একটি; এটি মুনাফা তোলার কারণ, ঢোকার নয়।" },
  "sig:bullish-divergence": { t: "bullish-divergence", en: "Price made a lower low but RSI made a higher low — selling pressure is exhausting even as price dips. An early bottoming signal, strongest at support in a quality share.", bn: "দাম নতুন নিচে নামলেও RSI নামেনি — দাম কমলেও বিক্রির চাপ ফুরিয়ে আসছে। তলানির আগাম সংকেত; মানসম্পন্ন শেয়ারের সাপোর্টে সবচেয়ে জোরালো।" },
  candle_pattern: { t: "Candlestick pattern", en: "A classic 1-2 candle reversal shape, only checked right at a recent price extreme. Hammer / bullish-engulfing at a low = buyers rejected further downside. Shooting-star / bearish-engulfing at a high = sellers rejected further upside.", bn: "সাম্প্রতিক দামের প্রান্তে যাচাই করা ক্লাসিক ১-২ ক্যান্ডেল রিভার্সাল আকৃতি। তলানিতে হ্যামার/বুলিশ এনগাল্ফিং = ক্রেতারা আরও পতন ঠেকিয়েছে। চূড়ায় শুটিং স্টার/বিয়ারিশ এনগাল্ফিং = বিক্রেতারা আরও বৃদ্ধি ঠেকিয়েছে।" },
  "sig:hammer": { t: "hammer", en: "A small body near the top of today's range with a long lower wick (2×+ the body) and little upper wick, right at a recent low — buyers stepped in hard and rejected further downside. One of the most recognised bullish reversal candles.", bn: "আজকের পরিসরের উপরের দিকে ছোট বডি, লম্বা নিচের বাতি (বডির ২ গুণ+), সামান্য উপরের বাতি — সাম্প্রতিক তলানিতে ক্রেতারা জোরালোভাবে ঢুকে আরও পতন ঠেকিয়েছে। সবচেয়ে পরিচিত বুলিশ রিভার্সাল ক্যান্ডেল।" },
  "sig:bullish-engulfing": { t: "bullish-engulfing", en: "Today's green candle body completely swallows yesterday's red body, right at a recent low — today's buying erased all of yesterday's selling in one session. A strong, fast reversal signal.", bn: "সাম্প্রতিক তলানিতে আজকের সবুজ ক্যান্ডেল-বডি গতকালের লাল বডিকে সম্পূর্ণ গ্রাস করেছে — এক সেশনেই আজকের কেনাকাটা গতকালের সব বিক্রি মুছে দিয়েছে। শক্তিশালী ও দ্রুত রিভার্সাল সংকেত।" },
  "flag:shooting-star": { t: "shooting-star", en: "A small body near the bottom of today's range with a long upper wick, right at a recent high — buyers pushed up but sellers took it all back. A classic top-warning candle.", bn: "আজকের পরিসরের নিচের দিকে ছোট বডি, লম্বা উপরের বাতি, সাম্প্রতিক চূড়ায় — ক্রেতারা দাম তুললেও বিক্রেতারা সব ফিরিয়ে নিয়েছে। চূড়ার ক্লাসিক সতর্কতা ক্যান্ডেল।" },
  "flag:bearish-engulfing": { t: "bearish-engulfing", en: "Today's red candle body completely swallows yesterday's green body, right at a recent high — today's selling erased all of yesterday's buying in one session. A strong, fast reversal-down signal.", bn: "সাম্প্রতিক চূড়ায় আজকের লাল ক্যান্ডেল-বডি গতকালের সবুজ বডিকে সম্পূর্ণ গ্রাস করেছে — এক সেশনেই আজকের বিক্রি গতকালের সব কেনাকাটা মুছে দিয়েছে। শক্তিশালী ও দ্রুত পতন-রিভার্সাল সংকেত।" },
  gap_analysis: { t: "Gap", en: "The % jump between today's opening price and yesterday's close. A gap of 1.5%+ is genuine. 'Follow-through' = the close stayed on the gap's side of yesterday's close (the move held); 'faded' = price fully round-tripped back through yesterday's close by the close — a classic trap for chasers.", bn: "আজকের শুরুর দাম ও গতকালের ক্লোজের মধ্যে %ব্যবধান। ১.৫%+ হলে প্রকৃত গ্যাপ। 'Follow-through' = ক্লোজ গ্যাপের দিকেই থেকে গেছে (মুভ টিকেছে); 'faded' = দাম ক্লোজ পর্যন্ত গতকালের ক্লোজের নিচে ফিরে গেছে — তাড়াহুড়ো করে কেনাদের জন্য ক্লাসিক ফাঁদ।" },
  "sig:gap-up-held": { t: "gap-up-held", en: "The share gapped up 1.5%+ at the open and the close stayed above yesterday's close — buyers defended the gap through the whole session, a bullish sign of real demand.", bn: "শেয়ারটি শুরুতে ১.৫%+ গ্যাপ-আপ হয়েছে এবং ক্লোজ গতকালের ক্লোজের উপরেই থেকেছে — পুরো সেশন জুড়ে ক্রেতারা গ্যাপ রক্ষা করেছে, প্রকৃত চাহিদার বুলিশ ইঙ্গিত।" },
  "flag:gap-fade": { t: "gap-fade", en: "The share gapped up 1.5%+ at the open but fully round-tripped back below yesterday's close by the end of the session — a classic trap: it looked like a breakout but sellers took full control.", bn: "শেয়ারটি শুরুতে ১.৫%+ গ্যাপ-আপ হয়েও সেশন শেষে গতকালের ক্লোজের নিচে সম্পূর্ণ ফিরে গেছে — ক্লাসিক ফাঁদ: ব্রেকআউট মনে হলেও বিক্রেতারা পুরো নিয়ন্ত্রণ নিয়ে নিয়েছে।" },
  close_strength: { t: "Close strength", en: "Where today's price landed within today's own high-low range: 100% = closed at the day's high (buyers won the session), 0% = closed at the day's low (sellers won). A strong close under a spike or breakout is a good sign; a weak one is a warning even if the day's % change looks fine.", bn: "আজকের নিজস্ব হাই-লো পরিসরে দাম কোথায় থেমেছে: ১০০% = দিনের সর্বোচ্চে ক্লোজ (ক্রেতারা জিতেছে), ০% = সর্বনিম্নে ক্লোজ (বিক্রেতারা জিতেছে)। স্পাইক বা ব্রেকআউটের নিচে শক্তিশালী ক্লোজ ভালো লক্ষণ; দুর্বল ক্লোজ সতর্কতা, দিনের %পরিবর্তন ভালো দেখালেও।" },
  key_level: { t: "Key support / resistance", en: "A price level clustered from actual swing highs/lows the share has reversed at 2+ times over the last year — real support/resistance the market has defended or rejected before, not just a simple period high/low.", bn: "গত ১ বছরে শেয়ারটি যে দামে ২+ বার ঘুরে দাঁড়িয়েছে তার স্তর — শুধু একটি সময়সীমার সর্বোচ্চ/সর্বনিম্ন নয়, বাজার আগে যে দামে সত্যিই রক্ষা বা প্রত্যাখ্যান করেছে তা।" },
  "flag:near-key-resistance": { t: "near-key-resistance", en: "Within 2% of a resistance level the price has already been rejected at 3+ times — a proven ceiling, not just a recent high. Higher chance of a stall or reversal here.", bn: "এমন একটি রেজিস্ট্যান্স স্তরের ২%-এর মধ্যে যেখানে দাম আগে ৩+ বার প্রত্যাখ্যাত হয়েছে — শুধু সাম্প্রতিক উচ্চতা নয়, প্রমাণিত সীমা। এখানে থমকে যাওয়া বা পতনের সম্ভাবনা বেশি।" },
  "hp:reversal-candle": { t: "Reversal candle at a proven level", en: "A hammer or bullish-engulfing candle appearing right on a support level the market has defended 2+ times before, in a profitable company. One of the clearest, earliest visual reversal signals — day-one entry, tight stop just below a level that's already proven itself.", bn: "লাভজনক কোম্পানিতে এমন একটি সাপোর্ট স্তরে হ্যামার বা বুলিশ এনগাল্ফিং ক্যান্ডেল যা বাজার আগে ২+ বার রক্ষা করেছে। সবচেয়ে স্পষ্ট ও প্রথম দিকের ভিজ্যুয়াল রিভার্সাল সংকেতগুলোর একটি — প্রথম দিনেই প্রবেশ, প্রমাণিত স্তরের ঠিক নিচে আঁটসাঁট স্টপ।" },
  nav_per_share: { t: "NAV per share", en: "Net Asset Value per share from the latest audited annual filing — what one share is worth on the company's own books. Compared against the market price as P/NAV.", bn: "সর্বশেষ নিরীক্ষিত বার্ষিক প্রতিবেদন থেকে শেয়ারপ্রতি নিট সম্পদ মূল্য (NAV) — কোম্পানির নিজস্ব হিসাবে এক শেয়ারের মূল্য কত। বাজার দামের সাথে তুলনা করা হয় P/NAV হিসেবে।" },
  p_nav: { t: "P/NAV", en: "Price ÷ NAV per share. Below 1.0 means the share trades below its own book value — a classic value screen, especially powerful when the company is also profitable (not cheap for a reason). Above 1.0 is normal for a healthy, growing business.", bn: "দাম ÷ শেয়ারপ্রতি NAV। ১.০-এর নিচে মানে শেয়ারটি তার বুক ভ্যালুর নিচে লেনদেন হচ্ছে — একটি ক্লাসিক ভ্যালু স্ক্রিন, বিশেষত কোম্পানি লাভজনক হলে শক্তিশালী (কারণ ছাড়া সস্তা নয়)। ১.০-এর উপরে একটি সুস্থ, বর্ধনশীল ব্যবসার জন্য স্বাভাবিক।" },
  holding_trend: { t: "Institutional/foreign holding trend", en: "Change in combined institute + foreign ownership % over the last few monthly snapshots from the company's own filings — real 'smart money' flow, not a volume proxy. Builds up as fetch_profiles.py is re-run over time (each page shows only the latest ~3 months). Rising = accumulation, falling = distribution.", bn: "কোম্পানির নিজস্ব ফাইলিং থেকে গত কয়েক মাসের স্ন্যাপশটে প্রাতিষ্ঠানিক + বিদেশি মালিকানার সম্মিলিত %পরিবর্তন — প্রকৃত 'স্মার্ট মানি' প্রবাহ, ভলিউম প্রক্সি নয়। সময়ের সাথে fetch_profiles.py পুনরায় চালালে জমে ওঠে (প্রতি পাতায় শুধু সাম্প্রতিক ~৩ মাস দেখা যায়)। বাড়লে = সঞ্চয়, কমলে = বিতরণ।" },
  "flag:institutional-accumulation": { t: "institutional-accumulation", en: "Institute + foreign ownership has risen 1.5pp+ over the last few monthly filings — real accumulation confirmed in the company's own shareholding disclosure, a stronger signal than any volume-based proxy.", bn: "গত কয়েক মাসের ফাইলিংয়ে প্রাতিষ্ঠানিক + বিদেশি মালিকানা ১.৫pp+ বেড়েছে — কোম্পানির নিজস্ব শেয়ারহোল্ডিং প্রকাশে নিশ্চিত প্রকৃত সঞ্চয়, যেকোনো ভলিউম-ভিত্তিক প্রক্সির চেয়ে শক্তিশালী সংকেত।" },
  "flag:institutional-selling": { t: "institutional-selling", en: "Institute + foreign ownership has fallen 1.5pp+ over the last few monthly filings — real distribution confirmed in the company's own shareholding disclosure. Worth understanding why before buying.", bn: "গত কয়েক মাসের ফাইলিংয়ে প্রাতিষ্ঠানিক + বিদেশি মালিকানা ১.৫pp+ কমেছে — কোম্পানির নিজস্ব শেয়ারহোল্ডিং প্রকাশে নিশ্চিত প্রকৃত বিতরণ। কেনার আগে কারণ বোঝা দরকার।" },
  eps_trend: { t: "Quarterly EPS momentum", en: "Direction of the company's most recently reported quarter's EPS vs the one before it, from the interim financial statements. 'Up'/'turned-profitable' = earnings momentum improving; 'down'/'turned-loss' = deteriorating — a reason to double-check a price rally that isn't backed by better earnings.", bn: "অন্তর্বর্তী আর্থিক বিবরণী থেকে কোম্পানির সর্বশেষ প্রান্তিকের EPS আগের প্রান্তিকের তুলনায় কোন দিকে যাচ্ছে। 'Up'/'turned-profitable' = আয়ের গতি উন্নত হচ্ছে; 'down'/'turned-loss' = অবনতি — আয় দ্বারা অসমর্থিত মূল্যবৃদ্ধি নিয়ে সতর্ক হওয়ার কারণ।" },
  "flag:eps-declining": { t: "eps-declining", en: "The company's most recently reported quarter's EPS fell (or turned to a loss) vs the quarter before it — a rally happening despite weakening earnings is worth extra scrutiny.", bn: "কোম্পানির সর্বশেষ প্রান্তিকের EPS আগের প্রান্তিকের তুলনায় কমেছে (বা লোকসানে পড়েছে) — দুর্বল আয় সত্ত্বেও দাম বাড়লে বাড়তি যাচাই দরকার।" },
  beta: { t: "Beta", en: "How much a share tends to move relative to the whole market (an equal-weighted average of every tracked share, since DSEX history is too sparse for this). 1.0 = moves with the market; above ~1.2 = aggressive (bigger swings both ways); below ~0.7 = defensive (steadier). Capped to [-2, 4] since illiquid shares can produce noisy raw values.", bn: "একটি শেয়ার সামগ্রিক বাজারের (প্রতিটি ট্র্যাক করা শেয়ারের সমান-ওজনী গড়, কারণ DSEX ইতিহাস এই হিসাবের জন্য যথেষ্ট নয়) তুলনায় কতটা ওঠানামা করে। ১.০ = বাজারের সাথে চলে; ~১.২-এর বেশি = আক্রমণাত্মক (বড় ওঠানামা); ~০.৭-এর কম = রক্ষণাত্মক (স্থিতিশীল)। কম লেনদেনের শেয়ারে গোলমেলে মান এড়াতে [-2, 4]-এ সীমাবদ্ধ।" },
  cap_class: { t: "Market cap size", en: "Large (≥৳20,000mn / ~২,০০০ crore), Mid (৳3,000–20,000mn), or Small (<৳3,000mn) — from price × outstanding shares. Larger caps tend to be steadier and more liquid; smaller caps can move faster in both directions.", bn: "মার্কেট ক্যাপ আকার: Large (≥৳২০,০০০ মিলিয়ন), Mid (৳৩,০০০–২০,০০০ মিলিয়ন), Small (<৳৩,০০০ মিলিয়ন) — দাম × মোট শেয়ার সংখ্যা থেকে। বড় ক্যাপ সাধারণত স্থিতিশীল ও তরল; ছোট ক্যাপ দুই দিকেই দ্রুত নড়তে পারে।" },
  seasonality: { t: "Seasonality", en: "Historical average return for this calendar month, from 2 years of daily price data — context only, NEVER a trading signal or prediction. Market-wide figures (all tracked shares combined) are statistically meaningful; a single share's own monthly figure has a small sample (shown with its count) and should be treated as a curiosity, not a reason to buy or sell.", bn: "এই ক্যালেন্ডার মাসের ঐতিহাসিক গড় রিটার্ন, ২ বছরের দৈনিক দামের তথ্য থেকে — শুধু প্রেক্ষাপট, কখনোই ট্রেডিং সংকেত বা ভবিষ্যদ্বাণী নয়। সামগ্রিক বাজারের (সব শেয়ার মিলিয়ে) হিসাব পরিসংখ্যানগতভাবে অর্থবহ; একটি একক শেয়ারের নিজস্ব মাসিক হিসাব ছোট নমুনার (সংখ্যা দেখানো আছে) এবং কেনা-বেচার কারণ নয়, নিছক কৌতূহলের বিষয় হিসেবে দেখুন।" },
  portfolio_beta: { t: "Portfolio beta", en: "Your holdings' beta, weighted by current position value — tells you whether your portfolio as a whole is more aggressive or more defensive than the market.", bn: "আপনার হোল্ডিংগুলোর বিটা, বর্তমান অবস্থানের মূল্য দিয়ে ওজনযুক্ত — আপনার পুরো পোর্টফোলিও বাজারের তুলনায় বেশি আক্রমণাত্মক নাকি রক্ষণাত্মক তা বলে।" },
  diversification: { t: "Diversification check", en: "Pairwise correlation of daily returns among your current holdings, computed from real price history — not just sector labels. A pair at 0.7+ moves together closely: holding both is largely one bet wearing two tickers, not real diversification, even if they're in 'different' sectors.", bn: "আপনার বর্তমান হোল্ডিংগুলোর মধ্যে দৈনিক রিটার্নের জোড়ার-হারে সহসম্পর্ক, প্রকৃত দামের ইতিহাস থেকে হিসাব করা — শুধু সেক্টরের লেবেল নয়। ০.৭+ মানে দুটি একসাথে চলে: 'ভিন্ন' সেক্টরে থাকলেও দুটো ধরে রাখা মূলত একই বাজি দুই টিকারে, প্রকৃত বৈচিত্র্য নয়।" },
  csv_export: { t: "Export CSV", en: "Downloads the currently filtered and sorted Screener table as a CSV file — exactly what you see on screen, ready for a spreadsheet.", bn: "বর্তমানে ফিল্টার ও সাজানো Screener টেবিলটি CSV ফাইল হিসেবে ডাউনলোড করে — স্ক্রিনে যা দেখছেন ঠিক তাই, স্প্রেডশিটের জন্য প্রস্তুত।" },
  saved_filters: { t: "Quick screens", en: "A few built-in curated screens (Value picks, Momentum breakouts, Income, Turnarounds, Institutional accumulation) plus any you save yourself under a name — stored in this browser only (localStorage), not shared across devices. Loading a screen replaces your current filters; built-ins can't be deleted.", bn: "কয়েকটি বিল্ট-ইন কিউরেটেড স্ক্রিন (Value picks, Momentum breakouts, Income, Turnarounds, Institutional accumulation) এবং আপনার নিজের সংরক্ষিত ফিল্টার — শুধু এই ব্রাউজারে (localStorage) সংরক্ষিত। স্ক্রিন লোড করলে বর্তমান ফিল্টার প্রতিস্থাপিত হয়; বিল্ট-ইন মোছা যাবে না।" },
  group_decide: { t: "Decide", en: "Everything that helps you choose what to buy or watch right now: Suggestions (Top 20 + scored picks), ⚡High Profit (aggressive setups), Spike (sudden movers), and Margin (range-extreme reversal candidates).", bn: "এখন কী কিনবেন বা নজরে রাখবেন তা ঠিক করতে সাহায্য করে এমন সবকিছু: Suggestions, ⚡High Profit, Spike, এবং Margin।" },
  group_manage: { t: "Manage", en: "Your own holdings — the Portfolio tab: trade journal, exit engine, sell alerts, and diversification check.", bn: "আপনার নিজের শেয়ার — Portfolio ট্যাব: লেনদেন খাতা, এক্সিট ইঞ্জিন, বিক্রির সতর্কতা, বৈচিত্র্য পরীক্ষা।" },
  group_explore: { t: "Explore", en: "Tools for digging through the data yourself: Charts, AI Prediction Chart, the full Screener table, and Sectors.", bn: "নিজে তথ্য ঘেঁটে দেখার সরঞ্জাম: Charts, AI Prediction Chart, পূর্ণ Screener টেবিল, এবং Sectors।" },
  market_overview_toggle: { t: "Market overview & report card", en: "Click to expand: the official DSEX/DS30/DSES/DSMEX snapshot, turnover, breadth, and the report card grading past recommendations. Collapsed by default to keep the Top 20 and picks front and centre — this is supporting context, not something to check every visit.", bn: "ক্লিক করে বিস্তারিত দেখুন: অফিসিয়াল DSEX/DS30/DSES/DSMEX স্ন্যাপশট, টার্নওভার, ব্রেডথ, এবং অতীত সুপারিশের রিপোর্ট কার্ড। ডিফল্টে সংকুচিত থাকে যাতে Top 20 ও পিকস সামনে থাকে — এটি সহায়ক প্রেক্ষাপট, প্রতিবার দেখার প্রয়োজন নেই।" },
  more_filters: { t: "More filters", en: "Additional Screener filters grouped by theme: Technical (RSI, score, ATR), Fundamental (size, P/NAV, dividend yield, EPS trend), Risk & ownership (liquidity, flags, institutional accumulation), and cross-tab (also appears in Spike/High Profit/Margin).", bn: "থিম অনুযায়ী গোষ্ঠীবদ্ধ অতিরিক্ত Screener ফিল্টার: টেকনিক্যাল, মৌলভিত্তি, ঝুঁকি ও মালিকানা, এবং ক্রস-ট্যাব (অন্য ট্যাবেও আছে কিনা)।" },
  cross_tab_filter: { t: "Also appears in", en: "Filter to shares that also show up in one of the other analysis tabs right now — e.g. a share that's both eligible here AND currently in the Spike list has extra same-day momentum confirmation.", bn: "যেসব শেয়ার এই মুহূর্তে অন্য কোনো বিশ্লেষণ ট্যাবেও দেখা যাচ্ছে সেগুলো ফিল্টার করুন — যেমন এখানে যোগ্য এবং একই সাথে Spike তালিকায় থাকা শেয়ারের অতিরিক্ত একইদিনের নিশ্চয়তা আছে।" },
  columns_picker: { t: "Columns", en: "Choose which Screener columns are visible — Code is always shown so you can always identify a row. Your choice is remembered in this browser.", bn: "Screener-এ কোন কলামগুলো দেখা যাবে বেছে নিন — Code সবসময় দেখানো হয় যাতে সারি শনাক্ত করা যায়। আপনার পছন্দ এই ব্রাউজারে মনে রাখা হয়।" },
  clear_filters: { t: "Clear all filters", en: "Resets every Screener filter (search, dropdowns, checkboxes, and the More Filters section) back to its default — the full unfiltered list.", bn: "সব Screener ফিল্টার (সার্চ, ড্রপডাউন, চেকবক্স, More Filters) ডিফল্টে ফিরিয়ে দেয় — সম্পূর্ণ তালিকা দেখায়।" },
  chart_type: { t: "Chart type", en: "Line = the closing price only (smoothest to read trend). Candlestick = each session's open/high/low/close as a coloured body + wick (green = closed above open, red = below) — shows intraday strength/rejection a line hides. OHLC Bars = the same open/high/low/close as classic tick bars (left tick = open, right tick = close). SMA20/50 overlay stays visible in every mode.", bn: "Line = শুধু ক্লোজিং দাম (প্রবণতা বোঝার জন্য সবচেয়ে মসৃণ)। Candlestick = প্রতিটি সেশনের open/high/low/close রঙিন বডি ও উইক আকারে (সবুজ = ক্লোজ ওপেনের উপরে, লাল = নিচে) — লাইনে যা লুকানো থাকে সেই দিনের ভেতরের শক্তি/প্রত্যাখ্যান দেখায়। OHLC Bars = একই তথ্য ক্লাসিক টিক বার আকারে (বাম টিক = ওপেন, ডান টিক = ক্লোজ)। SMA20/50 ওভারলে সব মোডেই দেখা যায়।" },
  pred_accuracy: { t: "AI Pred. price accuracy", en: "Every AI Pred. 1w/1m shown for the Top 20 gets snapshotted, then graded once enough trading days pass — same self-grading principle as the Report card above, applied to the price forecast itself. Direction accuracy is compared against a naive \"always guess up\" baseline so you can tell if the model is actually adding anything beyond the market's normal upward drift.", bn: "টপ ২০-এর প্রতিটি AI Pred. 1w/1m সংরক্ষণ হয়, পর্যাপ্ত ট্রেডিং দিন পার হলে নম্বর দেওয়া হয় — উপরের Report card-এর মতোই নীতি, দামের পূর্বাভাসের জন্য প্রয়োগ করা। দিকনির্দেশনার নির্ভুলতা একটি সরল \"সবসময় বাড়বে ধরে নাও\" মানদণ্ডের সাথে তুলনা করা হয়, যাতে বোঝা যায় মডেলটি বাজারের স্বাভাবিক ঊর্ধ্বমুখী প্রবণতার চেয়ে বাড়তি কিছু দিচ্ছে কিনা।" },
  pred_price: { t: "AI Pred. price", en: "Labeled \"AI Pred.\" but — to be precise — the method is a deterministic statistical projection (drift from recent momentum + a damped seasonal shape from the last year) anchored to today's price, not a trained machine-learning model, and not a promise. Same inputs always produce the same output. See Pred. accuracy under Report card for real graded results, and the AI Prediction Chart tab for the full 6-month curve.", bn: "লেবেলে \"AI Pred.\" লেখা থাকলেও পদ্ধতিটি একটি নির্ধারক পরিসংখ্যানগত প্রক্ষেপণ (সাম্প্রতিক গতির প্রবণতা + গত বছরের ঋতুভিত্তিক আকৃতি) আজকের দামের ভিত্তিতে — প্রশিক্ষিত মেশিন-লার্নিং মডেল নয়, প্রতিশ্রুতিও নয়। একই তথ্যে সবসময় একই ফল আসে। প্রকৃত গ্রেড করা ফলাফলের জন্য Report card-এর নিচে Pred. accuracy দেখুন, আর পূর্ণ ৬ মাসের রেখার জন্য AI Prediction Chart ট্যাব দেখুন।" },
  chart_zoom: { t: "Zoom", en: "1M/3M/6M/1Y/All jump to a preset window (defaults to All — the full price history). Scroll the mouse wheel over the chart to zoom in/out around the cursor; click and drag to pan left/right through history. Manual zoom/pan deselects the preset buttons; click one again to snap back. Volume and RSI below scroll in sync.", bn: "1M/3M/6M/1Y/All প্রি-সেট সময়সীমায় লাফ দেয় (ডিফল্ট All — সম্পূর্ণ দামের ইতিহাস)। চার্টের উপর মাউস হুইল স্ক্রল করলে কার্সারকে কেন্দ্র করে জুম ইন/আউট হয়; ক্লিক করে টেনে ধরলে বাম/ডানে ইতিহাসে চলাচল করা যায়। ম্যানুয়াল জুম/প্যান প্রিসেট বাটন থেকে সরিয়ে দেয়; আবার ক্লিক করলে ফিরে আসে। নিচের Volume ও RSI একসাথে স্ক্রল হয়।" },
  sector_bar_chart: { t: "Sector performance chart", en: "Average 1-month return per sector as horizontal bars growing from zero — green bars (sectors moving up) vs red bars (moving down) make sector rotation visible at a glance, sorted strongest-to-weakest. Hover a bar for its 1w/3m returns and breadth too.", bn: "প্রতিটি খাতের গড় ১ মাসের রিটার্ন অনুভূমিক বার আকারে, শূন্য থেকে বাড়ে — সবুজ বার (বাড়ছে) বনাম লাল বার (কমছে) থেকে সেক্টর রোটেশন এক নজরে বোঝা যায়, শক্তিশালী থেকে দুর্বল ক্রমে সাজানো। বারে মাউস রাখলে ১ সপ্তাহ/৩ মাসের রিটার্ন ও ব্রেডথও দেখা যাবে।" },
  spike_tab: { t: "Spike & Trend Break", en: "Two kinds of alert, each its own sub-tab, both sorted by how recently it happened (today first; same day, sorted by price). ⚡ Spike: shares that suddenly moved 3%+ — up ▲ or down ▼ — today or yesterday, CONFIRMED by abnormal volume (≥2× the 30-day average — real buying/selling demand, not a thin-volume wobble) and a close that backs the direction (upper half of that day's own range for an up-move, lower half for a down-move); a price move without both is excluded, not just down-scored, which is why this list stays short and actionable instead of listing every small wiggle. Update Data during trading hours fetches live prices, so 'today' compares right now against the start of the day. 📐 Trend Break: shares that held a clean uptrend, downtrend, or tight sideways range for a long time (up to a year) and have just broken that established pattern in the last few sessions — flagged even without a big single-day % move, since the alert here is 'the character of the price action changed'. Both get a 0–100 score weighing volume, trend, catalysts and (for spikes) this share's own follow-through history.", bn: "দুই ধরনের সতর্কতা, প্রতিটির নিজস্ব সাব-ট্যাব, উভয়ই কতদিন আগে ঘটেছে তা অনুযায়ী সাজানো (আজকেরটি আগে; একই দিনে দাম অনুযায়ী)। ⚡ Spike: আজ বা গতকাল হঠাৎ ৩%+ ওঠা ▲ বা নামা ▼ শেয়ার, তবে শুধু তখনই যখন অস্বাভাবিক ভলিউম (৩০ দিনের গড়ের ≥২ গুণ) ও দিক-নিশ্চিতকারী ক্লোজ (ওঠার জন্য দিনের উপরের অর্ধেক, নামার জন্য নিচের অর্ধেক) দুটোই মেলে — শুধু দাম পরিবর্তন হলেই তালিকায় আসে না, তাই তালিকা ছোট ও কার্যকর থাকে। লেনদেন চলাকালে Update Data চাপলে এই মুহূর্তের দামের সাথে দিনের শুরুর তুলনা হয়। 📐 Trend Break: যে শেয়ার দীর্ঘদিন (এক বছর পর্যন্ত) পরিষ্কার ঊর্ধ্বমুখী, নিম্নমুখী বা সংকীর্ণ সীমায় ছিল এবং গত কয়েক সেশনে তা ভেঙেছে। উভয়ই ভলিউম, ট্রেন্ড ও উপলক্ষ মিলিয়ে ০–১০০ স্কোর পায়।" },
  day_change: { t: "Δ vs yesterday", en: "Today's price change vs yesterday's closing price (YCP). The DSE daily circuit limit is ±10%, so 3%+ is a genuine jolt.", bn: "গতকালের ক্লোজিং দামের তুলনায় আজকের পরিবর্তন। DSE-র দৈনিক সীমা ±১০%, তাই ৩%+ মানে সত্যিকারের ঝাঁকুনি।" },
  intraday_change: { t: "Δ since open", en: "Price change from today's opening price to the latest price — during trading hours this is the move from the session start to right now (refresh with Update Data).", bn: "আজকের শুরুর দাম থেকে সর্বশেষ দামের পরিবর্তন — লেনদেন চলাকালে এটি দিনের শুরু থেকে এই মুহূর্ত পর্যন্ত ওঠানামা (Update Data চাপলে হালনাগাদ)।" },
  vol_today: { t: "Today's volume ratio", en: "Today's traded volume ÷ the 30-day average. A spike on 2×+ volume has real money behind it; a spike on thin volume is usually a trap.", bn: "আজকের লেনদেন ÷ ৩০ দিনের গড়। ২ গুণের বেশি ভলিউমে স্পাইক মানে সত্যিকারের টাকা ঢুকছে; কম ভলিউমের স্পাইক সাধারণত ফাঁদ।" },
  spike_score: { t: "Continuation score", en: "For Spikes: 0–100 chance the move keeps going in its own direction — volume backing 25%, room to run (circuit distance, RSI, resistance/support headroom) 20%, trend backdrop 20%, real catalyst (dividend/results/board meeting/record date/exchange query — direction-appropriate) 20%, this share's signal follow-through history 15%. Up-spikes: 60+ = likely to continue, below 40 = likely to fade. Down-spikes: 60+ = likely to keep falling, below 40 = likely to bounce. For Trend Breaks the same 0–100 scale instead measures conviction the break is real: how far past the established trend/range (40%), volume confirmation (30%), and agreement from MACD/candles/divergence (30%).", bn: "স্পাইকের জন্য: মুভটি নিজের দিকে চলতে থাকার সম্ভাবনা ০–১০০ — ভলিউম ২৫%, জায়গা ২০%, ট্রেন্ড ২০%, প্রকৃত উপলক্ষ ২০%, অতীতের ধারাবাহিকতা ১৫%। ঊর্ধ্বমুখী স্পাইক: ৬০+ = চলার সম্ভাবনা, ৪০-এর নিচে = মিলিয়ে যাওয়ার সম্ভাবনা। নিম্নমুখী স্পাইক: ৬০+ = পড়তে থাকার সম্ভাবনা, ৪০-এর নিচে = ফিরে আসার সম্ভাবনা। Trend Break-এর জন্য একই স্কেল ব্রেকটি সত্যি হওয়ার আস্থা মাপে।" },
  trend_break: { t: "Pattern (Trend Break)", en: "How many sessions the established regime held, what it was (downtrend/uptrend/range), the exact date span, and which way (▲/▼) it just broke — hover the chip for the full sentence in Bengali.", bn: "প্রতিষ্ঠিত প্রবণতা কত সেশন ধরে ছিল, কী ছিল (নিম্নমুখী/ঊর্ধ্বমুখী/সীমা), সঠিক তারিখ পরিসীমা, এবং কোন দিকে (▲/▼) তা ভেঙেছে — সম্পূর্ণ বাক্যের জন্য চিপে হোভার করুন।" },
  days_ago: { t: "Days ago", en: "How many sessions ago this happened — 'Today' at the top, then 1 day ago, 2 days ago, and so on, out to the lookback window. Same day, ties are broken by price (highest first) so the list stays deterministic.", bn: "এটি কতদিন আগে ঘটেছে — 'আজ' সবার উপরে, তারপর ১ দিন আগে, ২ দিন আগে, ইত্যাদি, লুকব্যাক উইন্ডো পর্যন্ত। একই দিনে সমতা হলে দাম অনুযায়ী (বেশি আগে) সাজানো হয় যাতে তালিকা নির্দিষ্ট থাকে।" },
  spike_direction: { t: "Direction", en: "▲ = an upward jump (buyers pushed the price up), ▼ = a downward drop (sellers pushed it down). Both are alert-worthy — a sudden fall after a long calm period matters just as much as a sudden rise.", bn: "▲ = ঊর্ধ্বমুখী লাফ (ক্রেতারা দাম বাড়িয়েছে), ▼ = নিম্নমুখী পতন (বিক্রেতারা দাম কমিয়েছে)। উভয়ই সতর্কতার যোগ্য — দীর্ঘ শান্ত সময়ের পর হঠাৎ পতনও হঠাৎ উত্থানের মতোই গুরুত্বপূর্ণ।" },
  margin_history: { t: "Margin cycle history", en: "Over this share's own 2-year price range, how many times has it cycled to the bottom 25% ('bottom episode') and top 25% ('top episode'), with exact dates — and of the past COMPLETED episodes, what % actually reverted (bounced from bottoms / corrected from tops) within a month. A share with a high reversion rate is more trustworthy to buy at the bottom or sell at the top than one with no such history; used as extra evidence in the Rise/Fall scores and reasons.", bn: "শেয়ারটির নিজের ২ বছরের দামের সীমায়, এটি কতবার নিচের ২৫% ('bottom episode') ও উপরের ২৫% ('top episode')-এ গেছে, সঠিক তারিখসহ — এবং অতীতের সম্পন্ন এপিসোডগুলোর মধ্যে কত শতাংশ সত্যিই এক মাসের মধ্যে ঘুরে দাঁড়িয়েছে (তলানি থেকে) বা সংশোধিত হয়েছে (চূড়া থেকে)। বেশি reversion rate থাকা শেয়ার তলানিতে কেনা বা চূড়ায় বেচার জন্য বেশি বিশ্বাসযোগ্য; Rise/Fall স্কোর ও কারণে অতিরিক্ত প্রমাণ হিসেবে ব্যবহৃত হয়।" },
  margin_tab: { t: "Margin", en: "Shares trading at the extremes of their own price range over a period you pick (1 month – 2 years, default 3 months). Lower Margin = bottom 25% of that range (candidates to buy before a rise); Higher Margin = top 25% (candidates to sell / avoid before a fall). All six ranges are recomputed on every Update Data; switching the filter is instant.", bn: "আপনার বেছে নেওয়া সময়ের (১ মাস – ২ বছর, ডিফল্ট ৩ মাস) দামের সীমার প্রান্তে থাকা শেয়ার। Lower Margin = সীমার নিচের ২৫% (বাড়ার আগে কেনার প্রার্থী); Higher Margin = উপরের ২৫% (কমার আগে বেচা/এড়ানোর প্রার্থী)। প্রতি Update Data-তে ছয়টি সীমাই নতুন করে হিসাব হয়; ফিল্টার বদলানো তাৎক্ষণিক।" },
  agm_tab: { t: "AGM/EGM/Record", en: "Two tables parsed directly from DSE's own PDFs on every Update Data: the AGM/EGM & Record Date notice (dividend declarations, AGM/EGM meeting dates, and the record date to qualify for the dividend) and the Rights Entitlement notice (rights-share ratio, issue price, record date, and the subscription window to apply). Both are searchable by code, company name or sector, sorted with the nearest upcoming record date first.", bn: "প্রতি Update Data-তে DSE-এর নিজস্ব পিডিএফ থেকে সরাসরি সংগ্রহ করা দুটি টেবিল: AGM/EGM ও রেকর্ড ডেট নোটিশ (লভ্যাংশ ঘোষণা, সভার তারিখ, যোগ্যতার রেকর্ড ডেট) এবং রাইট শেয়ার নোটিশ (অনুপাত, ইস্যু মূল্য, রেকর্ড ডেট, আবেদনের সময়সীমা)। দুটোই কোড, কোম্পানির নাম বা সেক্টর দিয়ে খোঁজা যায়, নিকটতম রেকর্ড ডেট আগে দেখানো হয়।" },
  lower_margin: { t: "Lower Margin", en: "All shares in the bottom quarter of the selected period's range, scored 0–100 for the chance the price starts rising: reversal evidence (MACD/RSI turning) 35%, OBV accumulation 20%, support holding 15%, fundamentals 15%, catalysts (record date, dividend/board-meeting news) 15%. The score uses the full 2-year evidence whichever range filter you pick. Trading halts and audit concerns crush the score — cheap is not the same as safe.", bn: "নির্বাচিত সময়ের সীমার নিচের ২৫%-এ থাকা সব শেয়ার, দাম বাড়া শুরুর সম্ভাবনায় ০–১০০ স্কোর: রিভার্সাল প্রমাণ ৩৫%, OBV সঞ্চয় ২০%, সাপোর্ট ধরে রাখা ১৫%, মৌলভিত্তি ১৫%, উপলক্ষ (রেকর্ড ডেট, লভ্যাংশ/বোর্ড মিটিং) ১৫%। যে ফিল্টারই বাছুন, স্কোর পূর্ণ ২ বছরের প্রমাণ ব্যবহার করে। লেনদেন বন্ধ বা অডিট উদ্বেগ থাকলে স্কোর প্রায় শূন্য — সস্তা মানেই নিরাপদ নয়।" },
  higher_margin: { t: "Higher Margin", en: "All shares in the top quarter of the selected period's range, scored 0–100 for the chance the price starts falling: over-extension (RSI, streaks, parabolic month) 35%, momentum fade 20%, OBV distribution 15%, weak valuation 15%, event risk (imminent ex-dividend drop, exchange query, audit concern) 15%. The score uses the full 2-year evidence whichever range filter you pick. Use it to book profit on holdings and to avoid chasing tops.", bn: "নির্বাচিত সময়ের সীমার উপরের ২৫%-এ থাকা সব শেয়ার, দাম কমা শুরুর সম্ভাবনায় ০–১০০ স্কোর: অতিরিক্ত বৃদ্ধি ৩৫%, গতি হ্রাস ২০%, OBV বিতরণ ১৫%, দুর্বল ভ্যালুয়েশন ১৫%, ঘটনা-ঝুঁকি (এক্স-ডিভিডেন্ড পতন, এক্সচেঞ্জ কোয়েরি) ১৫%। যে ফিল্টারই বাছুন, স্কোর পূর্ণ ২ বছরের প্রমাণ ব্যবহার করে। ধরে রাখা শেয়ারে মুনাফা তুলতে ও চূড়ায় না কিনতে ব্যবহার করুন।" },
  rise_score: { t: "Rise score", en: "0–100 chance this bottom-of-range share starts rising soon. 60+ = reversal underway with support; 40–60 = bottoming, watch; below 40 = no evidence yet, falling knife risk.", bn: "০–১০০: তলানিতে থাকা শেয়ারটির দাম শিগগির বাড়া শুরুর সম্ভাবনা। ৬০+ = রিভার্সাল চলছে; ৪০–৬০ = তলানি গড়ছে, নজরে রাখুন; ৪০-এর নিচে = এখনো প্রমাণ নেই, পড়ন্ত ছুরি ধরার ঝুঁকি।" },
  fall_score: { t: "Fall score", en: "0–100 chance this top-of-range share starts falling soon. 50+ = overheated with fade signs — take profit / don't chase; below 30 = strong trend that may simply continue.", bn: "০–১০০: চূড়ায় থাকা শেয়ারটির দাম শিগগির কমা শুরুর সম্ভাবনা। ৫০+ = অতিরিক্ত গরম, মুনাফা তুলুন / পিছে ছুটবেন না; ৩০-এর নিচে = শক্তিশালী প্রবণতা, চলতেও পারে।" },
  turn_date: { t: "Estimated turn date", en: "A calendar-aware estimate (DSE trades Sunday–Thursday) of when the move could begin: confirmed reversals = next session; MACD-approaching-zero = extrapolated at its current pace; record dates pull the date (run-ups start ~2 weeks before; ex-dividend drops come right after). An estimate to plan around, NOT a guarantee.", bn: "পরিবর্তন কবে শুরু হতে পারে তার আনুমানিক তারিখ (DSE রবি–বৃহস্পতিবার খোলা): নিশ্চিত রিভার্সাল = পরের সেশন; MACD শূন্যের দিকে এগোলে বর্তমান গতিতে হিসাব; রেকর্ড ডেটের ~২ সপ্তাহ আগে দাম বাড়া শুরু হয়, আর ঠিক পরে এক্স-ডিভিডেন্ড পতন আসে। পরিকল্পনার সহায়ক অনুমান, নিশ্চয়তা নয়।" },
  pos2y: { t: "Range position", en: "Where the price sits in the selected period's low→high range (pick 1-Month to 2-Year with the filter; default 3-Month): 0 = at the period low, 1 = at the period high. ≤ 0.25 lands in Lower Margin, ≥ 0.75 in Higher Margin.", bn: "নির্বাচিত সময়ের (ফিল্টারে ১ মাস – ২ বছর, ডিফল্ট ৩ মাস) সর্বনিম্ন→সর্বোচ্চ সীমায় দামের অবস্থান: ০ = সর্বনিম্নে, ১ = সর্বোচ্চে। ≤ ০.২৫ হলে Lower Margin, ≥ ০.৭৫ হলে Higher Margin।" },
  from_low: { t: "Above period low", en: "How far the price has already recovered above the selected period's low. Small = still at the very bottom of that range.", bn: "নির্বাচিত সময়ের সর্বনিম্ন থেকে দাম কতটা উঠেছে। কম মানে ওই সীমার একেবারে তলানিতে।" },
  from_high: { t: "Below period high", en: "How far the price sits below the selected period's high. Small = right at the top of that range.", bn: "নির্বাচিত সময়ের সর্বোচ্চ থেকে দাম কতটা নিচে। কম মানে ওই সীমার একেবারে চূড়ায়।" },
  potential: { t: "AI Prediction Chart", en: "Left of the divider: the real past year, plus past 1w/1m/2m returns (what already happened). Right of the divider, and in the AI Pred. 1w/1m badges: a deterministic 6-month projection — momentum of the last 60/120/250 sessions, damped over time, plus last year's detrended seasonal shape at half strength. Despite the \"AI\" label this is a statistical shape to support your decision, NOT a trained model or a guarantee; regenerated from the freshest history on every Update Data. See Pred. accuracy under Report card for its real graded track record.", bn: "দাগের বাঁয়ে: গত ১ বছরের প্রকৃত দাম, সাথে past 1w/1m/2m রিটার্ন (যা ইতিমধ্যে ঘটেছে)। দাগের ডানে ও AI Pred. 1w/1m ব্যাজে: পরবর্তী ৬ মাসের গাণিতিক অভিক্ষেপ — সাম্প্রতিক গতি (ক্রমশ ক্ষীয়মাণ) ও গত বছরের ঋতুভিত্তিক আকৃতির অর্ধেক মিলিয়ে। \"AI\" লেখা থাকলেও এটি সিদ্ধান্তে সহায়ক পরিসংখ্যানিক আকৃতি, প্রশিক্ষিত মডেল বা গ্যারান্টি নয়; প্রতি Update Data-তে সর্বশেষ ইতিহাস থেকে নতুন করে তৈরি হয়। প্রকৃত গ্রেড করা ফলাফলের জন্য Report card-এর নিচে Pred. accuracy দেখুন।" },
  toptx_tab: { t: "Today's Top 10 Transaction", en: "The exchange's actual trading activity today, independent of the pick-list rules — three views of the same session: By Value (highest turnover, mn BDT), By Volume (most shares traded) and By % Change (biggest movers, up or down). A share can top this list purely on activity even if its Verdict is Avoid — heavy volume alone isn't a buy signal, check the Verdict/Score and Why before acting.", bn: "আজকের প্রকৃত লেনদেন কার্যকলাপ, পছন্দ তালিকার নিয়মের বাইরে — একই সেশনের তিনটি দৃষ্টিকোণ: By Value (সর্বোচ্চ লেনদেন মূল্য), By Volume (সর্বোচ্চ শেয়ার সংখ্যা), By % Change (সবচেয়ে বেশি ওঠা/নামা)। কেবল কার্যকলাপের ভিত্তিতে একটি শেয়ার এই তালিকায় আসতে পারে, এমনকি তার Verdict Avoid হলেও — শুধু বেশি ভলিউম মানেই কেনার সংকেত নয়, আগে Verdict/Score ও Why দেখুন।" },
  value_today: { t: "Today's traded value", en: "Total money (mn BDT) traded in this share today — price × volume, summed across every trade. The market's own measure of how much capital is actually moving through a share right now.", bn: "আজ এই শেয়ারে লেনদেন হওয়া মোট টাকা (মিলিয়ন) — দাম × ভলিউম, সব লেনদেন মিলিয়ে। এই মুহূর্তে শেয়ারটিতে আসলে কত টাকা ঘুরছে তার প্রকৃত পরিমাপ।" },
  volume_today: { t: "Today's volume", en: "Total number of shares traded today (raw count, not a ratio). High volume with a price rise suggests real buying interest; high volume with a flat/falling price can mean distribution.", bn: "আজ লেনদেন হওয়া মোট শেয়ার সংখ্যা (আসল সংখ্যা, অনুপাত নয়)। দাম বাড়ার সাথে বেশি ভলিউম মানে সত্যিকারের কেনার আগ্রহ; দাম স্থির/কমার সাথে বেশি ভলিউম বিতরণের ইঙ্গিত হতে পারে।" },
};
const VERDICT_BN = { "Strong Buy": "জোরালো ক্রয়", "Buy": "ক্রয়", "Watch": "পর্যবেক্ষণ", "Neutral": "নিরপেক্ষ", "Avoid": "এড়িয়ে চলুন" };

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function fmt(v, d = 1) {
  return v === null || v === undefined ? "–" : Number(v).toFixed(d);
}
function pct(v) {
  if (v === null || v === undefined) return "–";
  const cls = v > 0 ? "pos" : v < 0 ? "neg" : "";
  const sign = v > 0 ? "+" : "";
  return `<span class="${cls}">${sign}${Number(v).toFixed(1)}%</span>`;
}
/* LTP colour vs YCP (yesterday's close): green if up, red if down, default (black/white per theme) if unchanged */
function ltpCls(price, ycp) {
  if (price === null || price === undefined || ycp === null || ycp === undefined) return "";
  return price > ycp ? "pos" : price < ycp ? "neg" : "";
}
/* LTP stacked over YCP (yesterday's close) — used everywhere a share's price is shown */
function ltpYcp(price, ycp, d = 1) {
  return `<span class="${ltpCls(price, ycp)}">${fmt(price, d)}</span><br><small style="color:var(--muted)">YCP ${fmt(ycp, d)}</small>`;
}

/* ---------------- canvas helpers ---------------- */
function prepCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: rect.height };
}

function drawSparkline(canvas, values) {
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!values || values.length < 2) return;
  const lo = Math.min(...values), hi = Math.max(...values);
  const pad = 3, span = hi - lo || 1;
  const x = (i) => pad + (i / (values.length - 1)) * (w - 2 * pad);
  const y = (v) => h - pad - ((v - lo) / span) * (h - 2 * pad);
  const color = css("--series-1");
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  ctx.stroke();
  // soft area fill toward baseline
  ctx.lineTo(x(values.length - 1), h - pad);
  ctx.lineTo(x(0), h - pad);
  ctx.closePath();
  ctx.globalAlpha = 0.10;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;
}

/* Line chart with y-axis gridlines + optional extra series. Returns geometry
   for crosshair hit-testing. */
function drawLineChart(canvas, dates, seriesList, opts = {}) {
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 46, padR = 10, padT = 8, padB = 18;
  const all = seriesList.flatMap((s) => s.values.filter((v) => v !== null));
  if (!all.length) return null;
  let lo = opts.min !== undefined ? opts.min : Math.min(...all);
  let hi = opts.max !== undefined ? opts.max : Math.max(...all);
  if (hi === lo) { hi += 1; lo -= 1; }
  const n = dates.length;
  const x = (i) => padL + (i / Math.max(n - 1, 1)) * (w - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);

  // gridlines + y labels
  ctx.strokeStyle = css("--grid");
  ctx.fillStyle = css("--muted");
  ctx.font = "10.5px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.lineWidth = 1;
  const ticks = opts.ticks || 4;
  for (let t = 0; t <= ticks; t++) {
    const v = lo + ((hi - lo) * t) / ticks;
    const yy = y(v);
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
    ctx.fillText(v >= 1000 ? (v / 1000).toFixed(1) + "k" : v.toFixed(v < 10 ? 1 : 0), padL - 5, yy + 3.5);
  }
  // x labels: ~5 dates
  ctx.textAlign = "center";
  const steps = Math.min(5, n);
  for (let t = 0; t < steps; t++) {
    const i = Math.round((t / Math.max(steps - 1, 1)) * (n - 1));
    ctx.fillText((dates[i] || "").slice(0, 7), x(i), h - 5);
  }
  // guides (e.g. RSI 30/70)
  (opts.guides || []).forEach((g) => {
    ctx.strokeStyle = css("--muted");
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(padL, y(g)); ctx.lineTo(w - padR, y(g)); ctx.stroke();
    ctx.setLineDash([]);
  });
  // series
  seriesList.forEach((s) => {
    ctx.beginPath();
    let started = false;
    s.values.forEach((v, i) => {
      if (v === null || v === undefined) { return; }
      if (!started) { ctx.moveTo(x(i), y(v)); started = true; }
      else ctx.lineTo(x(i), y(v));
    });
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width || 2;
    ctx.lineJoin = "round";
    ctx.stroke();
  });
  return { x, y, padL, padR, padT, padB, w, h, n };
}

function drawBars(canvas, dates, values, color) {
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 46, padR = 10, padT = 4, padB = 4;
  const hi = Math.max(...values, 1);
  const n = values.length;
  const bw = Math.max((w - padL - padR) / n - 0.5, 0.5);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.75;
  values.forEach((v, i) => {
    const x = padL + (i / Math.max(n - 1, 1)) * (w - padL - padR);
    const bh = (v / hi) * (h - padT - padB);
    ctx.fillRect(x, h - padB - bh, bw, bh);
  });
  ctx.globalAlpha = 1;
}

/* Shared axis/grid scaffold for the candlestick and OHLC-bar price charts —
   mirrors drawLineChart's layout so switching chart type doesn't shift the
   canvas. Returns the same {x, y, ...} geometry so SMA overlays and the
   hover tooltip work identically across all three chart types. */
function drawPriceAxes(ctx, w, h, dates, lo, hi, opts = {}) {
  const padL = 46, padR = 10, padT = 8, padB = 18;
  const n = dates.length;
  const x = (i) => padL + (i / Math.max(n - 1, 1)) * (w - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  ctx.strokeStyle = css("--grid");
  ctx.fillStyle = css("--muted");
  ctx.font = "10.5px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.lineWidth = 1;
  const ticks = opts.ticks || 4;
  for (let t = 0; t <= ticks; t++) {
    const v = lo + ((hi - lo) * t) / ticks;
    const yy = y(v);
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
    ctx.fillText(v >= 1000 ? (v / 1000).toFixed(1) + "k" : v.toFixed(v < 10 ? 1 : 0), padL - 5, yy + 3.5);
  }
  ctx.textAlign = "center";
  const steps = Math.min(5, n);
  for (let t = 0; t < steps; t++) {
    const i = Math.round((t / Math.max(steps - 1, 1)) * (n - 1));
    ctx.fillText((dates[i] || "").slice(0, 7), x(i), h - 5);
  }
  return { x, y, padL, padR, padT, padB, w, h, n };
}

function drawCandlestick(canvas, dates, opens, highs, lows, closes) {
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const n = closes.length;
  if (!n) return null;
  const range = highs.concat(lows).filter((v) => v !== null && v !== undefined);
  let lo = Math.min(...range), hi = Math.max(...range);
  if (hi === lo) { hi += 1; lo -= 1; }
  const geo = drawPriceAxes(ctx, w, h, dates, lo, hi);
  const bw = Math.max(((w - geo.padL - geo.padR) / n) * 0.6, 1);
  for (let i = 0; i < n; i++) {
    const o = opens[i], hgh = highs[i], low = lows[i], c = closes[i];
    if (o == null || hgh == null || low == null || c == null) continue;
    const color = c >= o ? css("--up") : css("--down");
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(geo.x(i), geo.y(hgh));
    ctx.lineTo(geo.x(i), geo.y(low));
    ctx.stroke();
    const yOpen = geo.y(o), yClose = geo.y(c);
    const bodyTop = Math.min(yOpen, yClose);
    const bodyH = Math.max(Math.abs(yClose - yOpen), 1);
    ctx.fillRect(geo.x(i) - bw / 2, bodyTop, bw, bodyH);
  }
  return geo;
}

function drawOhlcBars(canvas, dates, opens, highs, lows, closes) {
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const n = closes.length;
  if (!n) return null;
  const range = highs.concat(lows).filter((v) => v !== null && v !== undefined);
  let lo = Math.min(...range), hi = Math.max(...range);
  if (hi === lo) { hi += 1; lo -= 1; }
  const geo = drawPriceAxes(ctx, w, h, dates, lo, hi);
  const tick = Math.max(((w - geo.padL - geo.padR) / n) * 0.35, 2);
  for (let i = 0; i < n; i++) {
    const o = opens[i], hgh = highs[i], low = lows[i], c = closes[i];
    if (o == null || hgh == null || low == null || c == null) continue;
    ctx.strokeStyle = c >= o ? css("--up") : css("--down");
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(geo.x(i), geo.y(hgh)); ctx.lineTo(geo.x(i), geo.y(low)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(geo.x(i) - tick, geo.y(o)); ctx.lineTo(geo.x(i), geo.y(o)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(geo.x(i), geo.y(c)); ctx.lineTo(geo.x(i) + tick, geo.y(c)); ctx.stroke();
  }
  return geo;
}

/* Draws extra line series (e.g. SMA20/50) onto a canvas already painted by
   drawCandlestick/drawOhlcBars, reusing that draw's exact x/y scale — must
   NOT call prepCanvas again, since resizing the canvas clears it. */
function drawOverlayLines(canvas, geo, series) {
  if (!geo) return;
  const ctx = canvas.getContext("2d");
  series.forEach((s) => {
    ctx.beginPath();
    let started = false;
    s.values.forEach((v, i) => {
      if (v === null || v === undefined) return;
      if (!started) { ctx.moveTo(geo.x(i), geo.y(v)); started = true; }
      else ctx.lineTo(geo.x(i), geo.y(v));
    });
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width || 1.5;
    ctx.lineJoin = "round";
    ctx.stroke();
  });
}

/* Compact candlestick renderer for the small Charts-tab grid cards — no
   axes/labels, mirrors drawSparkline's minimalism at that size. */
function drawMiniCandles(canvas, opens, highs, lows, closes) {
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const n = closes.length;
  if (n < 2) return;
  const range = highs.concat(lows);
  const lo = Math.min(...range), hi = Math.max(...range);
  const pad = 3, span = hi - lo || 1;
  const x = (i) => pad + (i / Math.max(n - 1, 1)) * (w - 2 * pad);
  const y = (v) => h - pad - ((v - lo) / span) * (h - 2 * pad);
  const bw = Math.max(((w - 2 * pad) / n) * 0.6, 1);
  for (let i = 0; i < n; i++) {
    const o = opens[i], hgh = highs[i], low = lows[i], c = closes[i];
    const color = c >= o ? css("--up") : css("--down");
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x(i), y(hgh)); ctx.lineTo(x(i), y(low)); ctx.stroke();
    const yo = y(o), yc = y(c);
    const top = Math.min(yo, yc), bh = Math.max(Math.abs(yc - yo), 1);
    ctx.fillRect(x(i) - bw / 2, top, bw, bh);
  }
}

/* Horizontal bar chart for sector performance (Sectors tab) — sorted order
   from the caller is preserved; positive/negative bars grow from a zero line. */
function drawSectorBars(canvas, sectors) {
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!sectors.length) return null;
  const padL = 150, padR = 55, padT = 4, padB = 4;
  const rowH = (h - padT - padB) / sectors.length;
  const vals = sectors.map((s) => s.avg_1m || 0);
  const maxAbs = Math.max(1, ...vals.map((v) => Math.abs(v)));
  const zeroX = padL + (w - padL - padR) / 2;
  const scale = ((w - padL - padR) / 2) / maxAbs;
  ctx.font = "11px system-ui, sans-serif";
  ctx.strokeStyle = css("--grid");
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(zeroX, padT); ctx.lineTo(zeroX, h - padB); ctx.stroke();
  const rows = [];
  sectors.forEach((s, i) => {
    const y0 = padT + i * rowH;
    const v = s.avg_1m || 0;
    const barW = Math.abs(v) * scale;
    const x0 = v >= 0 ? zeroX : zeroX - barW;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = v >= 0 ? css("--up") : css("--down");
    ctx.fillRect(x0, y0 + rowH * 0.2, Math.max(barW, 1), rowH * 0.6);
    ctx.globalAlpha = 1;
    ctx.fillStyle = css("--ink-2");
    ctx.textAlign = "right";
    const label = s.name.length > 20 ? s.name.slice(0, 19) + "…" : s.name;
    ctx.fillText(label, padL - 8, y0 + rowH * 0.63);
    ctx.fillStyle = css("--ink");
    ctx.textAlign = v >= 0 ? "left" : "right";
    ctx.fillText(`${v > 0 ? "+" : ""}${v.toFixed(1)}%`, v >= 0 ? x0 + barW + 5 : x0 - 5, y0 + rowH * 0.63);
    rows.push({ y0, y1: y0 + rowH, sector: s });
  });
  return { rows, w, h };
}

/* ---------------- tooltip ---------------- */
const tooltip = $("#tooltip");
function showTooltip(html, cx, cy) {
  tooltip.innerHTML = html;
  tooltip.classList.remove("hidden");
  const r = tooltip.getBoundingClientRect();
  let x = cx + 14, y = cy + 14;
  if (x + r.width > window.innerWidth - 8) x = cx - r.width - 14;
  if (y + r.height > window.innerHeight - 8) y = cy - r.height - 14;
  tooltip.style.left = x + "px";
  tooltip.style.top = y + "px";
}
function hideTooltip() { tooltip.classList.add("hidden"); }

/* term tooltips: any element with data-term shows its glossary entry on hover */
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest("[data-term]");
  if (!el) return;
  const g = GLOSSARY[el.dataset.term];
  if (!g) return;
  showTooltip(
    `<b>${g.t}</b><div style="max-width:300px;margin-top:3px">${g.en}</div>` +
    `<div style="max-width:300px;margin-top:5px;color:var(--ink-2)">${g.bn}</div>`,
    e.clientX, e.clientY);
});
document.addEventListener("mouseout", (e) => {
  if (e.target.closest("[data-term]")) hideTooltip();
});

/* Bengali-on-hover: any element with data-bn shows its বাংলা meaning */
function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
document.addEventListener("mouseover", (e) => {
  if (e.target.closest("[data-term]")) return; // glossary tooltip wins
  const el = e.target.closest("[data-bn]");
  if (!el || !el.dataset.bn) return;
  showTooltip(
    `<b>অর্থ · Meaning</b><div style="max-width:340px;margin-top:3px">${el.dataset.bn}</div>`,
    e.clientX, e.clientY);
});
document.addEventListener("mouseout", (e) => {
  if (e.target.closest("[data-bn]")) hideTooltip();
});

/* help modal: full glossary, filterable — 157+ terms is too many to scan unaided */
$("#btnHelp").addEventListener("click", () => {
  $("#helpTable tbody").innerHTML = Object.values(GLOSSARY)
    .map((g) => `<tr><td class="lft"><b>${g.t}</b></td><td class="lft" style="white-space:normal">${g.en}</td><td class="lft" style="white-space:normal">${g.bn}</td></tr>`)
    .join("");
  $("#helpBg").classList.remove("hidden");
  $("#helpSearch").value = "";
  $("#helpSearch").focus();
});
$("#helpSearch").addEventListener("input", () => {
  const q = $("#helpSearch").value.trim().toLowerCase();
  $("#helpTable tbody").querySelectorAll("tr").forEach((tr) => {
    tr.style.display = !q || tr.textContent.toLowerCase().includes(q) ? "" : "none";
  });
});
$("#helpClose").addEventListener("click", () => $("#helpBg").classList.add("hidden"));
$("#helpBg").addEventListener("click", (e) => {
  if (e.target === $("#helpBg")) $("#helpBg").classList.add("hidden");
});

/* ---------------- tabs (two-level: group -> sub-tab) ---------------- */
const TAB_GROUPS = {
  decide: ["suggestions", "highprofit", "spike", "margin", "toptx", "agm", "compare"],
  manage: ["portfolio"],
  explore: ["charts", "potential", "screener", "sectors"],
};
const ALL_TABS = Object.values(TAB_GROUPS).flat();
function tabGroupOf(tab) {
  return Object.keys(TAB_GROUPS).find((g) => TAB_GROUPS[g].includes(tab));
}
const lastTabInGroup = { decide: "suggestions", manage: "portfolio", explore: "charts" };

function activateTab(tabName) {
  const group = tabGroupOf(tabName);
  if (!group) return;
  lastTabInGroup[group] = tabName;
  document.querySelectorAll(".tab-groups button").forEach((x) =>
    x.classList.toggle("active", x.dataset.group === group));
  document.querySelectorAll("[data-group-tabs]").forEach((nav) =>
    nav.classList.toggle("hidden", nav.dataset.groupTabs !== group));
  document.querySelectorAll(`nav.tabs[data-group-tabs="${group}"] button`).forEach((x) =>
    x.classList.toggle("active", x.dataset.tab === tabName));
  ALL_TABS.forEach((t) => $("#tab-" + t).classList.toggle("hidden", t !== tabName));

  if (tabName === "portfolio") loadPortfolio(); // always fresh — prices/alerts move
  // canvases drawn while their tab was hidden (display:none) end up blank —
  // e.g. a star toggled from another tab redraws the shortlist grid at 0×0.
  // Redraw from cached data (cheap) now that the section is visible again.
  if (tabName === "charts") {
    if (!state.chartsData) loadCharts();
    else { renderCharts(); loadChartsShortlist(); }
  }
  if (tabName === "potential") {
    if (!state.potData) loadPotential();
    else { renderPotential(); loadPotentialShortlist(); }
  }
  if (tabName === "sectors" && state.summary) renderSectors(); // sector bar chart needs real dimensions
  if (tabName === "compare" && state.summary) renderCompare(); // ditto for the mini sparklines
  if (tabName === "toptx" && state.summary) renderTopTx(); // ditto for the 1-month sparklines
  if (tabName === "agm") { if (!state.agmData) loadAgm(); else renderAgm(); }
}

document.querySelectorAll(".tab-groups button").forEach((b) => {
  b.addEventListener("click", () => activateTab(lastTabInGroup[b.dataset.group]));
});
document.querySelectorAll("nav.tabs[data-group-tabs] button").forEach((b) => {
  b.addEventListener("click", () => activateTab(b.dataset.tab));
});

/* ---------------- summary / suggestions / screener ---------------- */
async function loadSummary() {
  const res = await fetch("/api/summary");
  state.summary = await res.json();
  renderOverview();
  renderSuggestions();
  renderHighProfit();
  renderMargin();
  renderSpike();
  renderSpikeSummary();
  renderTopTx();
  renderReportCard();
  renderMarket();
  // portfolio add-form helpers: ticker autocomplete + default date
  $("#pfCodeList").innerHTML = Object.keys(state.summary.tickers).sort()
    .map((c) => `<option value="${c}">`).join("");
  if (!$("#pfDate").value) $("#pfDate").value = new Date().toISOString().slice(0, 10);
  if (state.portfolio) loadPortfolio(); // re-price holdings after fresh analysis
  renderAlerts();
  renderSignals();
  renderSectors();
  populateSectorFilter();
  renderScreener();
}

function renderOverview() {
  const ov = state.summary.overview || {};
  const regCls = { Bullish: "v-strong", Bearish: "v-avoid", Neutral: "v-watch" }[ov.regime] || "v-neutral";
  const regBn = { Bullish: "ঊর্ধ্বমুখী বাজার", Bearish: "নিম্নমুখী বাজার", Neutral: "মিশ্র বাজার" }[ov.regime] || "";
  $("#overview").innerHTML =
    `<span class="verdict ${regCls}" data-term="regime">${ov.regime || "–"}<small>${regBn}</small></span>` +
    `<span data-term="regime">above SMA50 <b>${ov.pct_above_sma50 ?? "–"}%</b></span>` +
    `<span>Market date <b>${ov.market_date || "–"}</b></span>` +
    `<span><b>${ov.tickers_analyzed || 0}</b> shares</span>` +
    `<span>1w advancers <b class="pos">${ov.advancers_1w || 0}</b> / <b class="neg">${ov.decliners_1w || 0}</b></span>` +
    `<span>avg 1w ${pct(ov.avg_return_1w)}</span>`;
}

function bnTk(v) {
  if (v === null || v === undefined) return "–";
  if (v >= 1e12) return (v / 1e12).toFixed(2) + " লক্ষ কোটি"; // 1e12 = 1 lakh crore
  if (v >= 1e7) return (v / 1e7).toFixed(1) + " কোটি"; // 1e7 = 1 crore
  return Number(v).toLocaleString();
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
                     "July", "August", "September", "October", "November", "December"];
const MONTH_NAMES_BN = ["জানুয়ারি", "ফেব্রুয়ারি", "মার্চ", "এপ্রিল", "মে", "জুন",
                        "জুলাই", "আগস্ট", "সেপ্টেম্বর", "অক্টোবর", "নভেম্বর", "ডিসেম্বর"];
function renderSeasonalityNote() {
  const season = state.summary.seasonality || {};
  const m = new Date().getMonth() + 1;
  const s = season[String(m)];
  const el = $("#seasonalityNote");
  if (!s) { el.innerHTML = ""; return; }
  const sign = s.approx_monthly > 0 ? "+" : "";
  el.innerHTML = `<span class="term" data-term="seasonality">Seasonality</span>: ${MONTH_NAMES[m - 1]} has historically ` +
    `averaged ${sign}${fmt(s.approx_monthly, 1)}% across all tracked shares over 2 years (n=${s.n} daily observations) — ` +
    `context only, not a prediction. · ${MONTH_NAMES_BN[m - 1]} মাসে ২ বছরে গড়ে ${sign}${fmt(s.approx_monthly, 1)}% ` +
    `হয়েছে সব শেয়ার মিলিয়ে (n=${s.n}) — শুধু প্রেক্ষাপট, ভবিষ্যদ্বাণী নয়।`;
}

function renderMarket() {
  renderSeasonalityNote();
  const mkt = state.summary.market;
  $("#marketPanel").classList.toggle("hidden", !mkt && !state.summary.seasonality);
  if (!mkt) return;
  $("#marketAsOf").textContent = mkt.as_of ? `as of ${mkt.as_of}` : "";

  const idxOrder = [["DSEX", "dsex"], ["DS30", "ds30"], ["DSES", "dses"], ["DSMEX", "dsmex"]];
  const idxHtml = idxOrder.filter(([k]) => mkt.indices && mkt.indices[k]).map(([k, term]) => {
    const ix = mkt.indices[k];
    const cls = ix.change_pct > 0 ? "pos" : ix.change_pct < 0 ? "neg" : "";
    const sign = ix.change_pct > 0 ? "+" : "";
    return `<div class="mstat" data-term="${term}"><div class="k">${k}</div>
      <div class="v">${fmt(ix.level, 1)}</div>
      <div class="${cls}" style="font-size:11.5px">${sign}${fmt(ix.change, 1)} (${sign}${fmt(ix.change_pct, 2)}%)</div></div>`;
  }).join("");

  const cats = mkt.categories || {};
  const catRow = (key, label) => {
    const c = cats[key];
    if (!c) return "";
    return `<tr><td class="lft">${label}</td><td>${c.total}</td>
      <td class="pos">${c.advanced}</td><td class="neg">${c.declined}</td><td>${c.unchanged}</td></tr>`;
  };

  const spark = mkt.dsex_history && mkt.dsex_history.length > 1
    ? `<div style="margin-top:8px"><div class="axis-note" data-term="dsex">DSEX trend (${mkt.dsex_history.length} sessions tracked)</div>
        <canvas id="dsexSpark" style="width:100%;height:50px;display:block"></canvas></div>`
    : `<div class="axis-note" style="margin-top:8px">DSEX trend will build up as you click Update Data on more days · প্রতিদিন Update করলে সূচকের ধারা তৈরি হবে</div>`;

  $("#marketBody").innerHTML = `
    <div class="mgrid" style="margin-top:6px">${idxHtml}
      <div class="mstat" data-term="turnover"><div class="k">Total trades</div><div class="v">${Number(mkt.total_trades || 0).toLocaleString()}</div></div>
      <div class="mstat" data-term="turnover"><div class="k">Turnover</div><div class="v">৳${fmt(mkt.total_value_mn, 0)} mn</div></div>
      <div class="mstat" data-term="market_cap"><div class="k">Market cap</div><div class="v">৳${bnTk(mkt.market_cap && mkt.market_cap.total_taka)}</div></div>
    </div>
    ${spark}
    <div class="tbl-wrap" style="margin-top:10px" data-term="official_breadth">
      <table><thead><tr><th class="lft">Category</th><th>Traded</th><th>Up</th><th>Down</th><th>Flat</th></tr></thead>
      <tbody>${catRow("All", "All issues")}${catRow("A", "Category A")}${catRow("B", "Category B")}${catRow("Z", "Category Z")}${catRow("MF", "Mutual funds")}</tbody></table>
    </div>`;

  if (mkt.dsex_history && mkt.dsex_history.length > 1) {
    drawSparkline($("#dsexSpark"), mkt.dsex_history.map((d) => d[1]));
  }
}

function renderAlerts() {
  const a = state.summary.alerts || {};
  const t = state.summary.tickers;
  const halts = a.trading_halt || [];
  const audits = a.audit_concern || [];
  const recDates = a.record_dates_soon || [];
  $("#alertsPanel").classList.toggle("hidden", !halts.length && !audits.length && !recDates.length);

  const codeLink = (c, extra = "") => `<a class="sig-code" data-code="${c}">${c}${extra}</a>`;
  let html = "";
  if (halts.length) {
    html += `<div class="sig-row"><span class="chip sig alert-bad" data-term="flag:trading-halt">trading halted</span>
      <span class="sig-codes">${halts.map((c) => codeLink(c)).join("")}</span></div>`;
  }
  if (audits.length) {
    html += `<div class="sig-row"><span class="chip sig alert-bad" data-term="flag:audit-concern">audit concern</span>
      <span class="sig-codes">${audits.map((c) => codeLink(c)).join("")}</span></div>`;
  }
  if (recDates.length) {
    html += `<div class="sig-row"><span class="chip sig alert-good" data-term="record_date">record date soon</span>
      <span class="sig-codes">${recDates.slice(0, 20).map((r) =>
        codeLink(r.ticker, `<small> ${r.days}d${r.dividend_pct ? `, ${r.dividend_pct.toFixed(0)}%` : ""}</small>`)).join("")}</span></div>`;
  }
  $("#alertsBody").innerHTML = html || `<div class="axis-note">No active alerts today.</div>`;
  $("#alertsBody").querySelectorAll(".sig-code").forEach((el) =>
    el.addEventListener("click", () => openDetail(el.dataset.code)));
}

function renderSignals() {
  const sig = state.summary.signals || {};
  const t = state.summary.tickers;
  const order = ["golden-cross", "macd-cross", "breakout-3m", "oversold-rebound", "volume-spike",
                "bullish-divergence", "hammer", "bullish-engulfing", "gap-up-held"];
  const groups = order.filter((s) => (sig[s] || []).length);
  $("#signalsPanel").classList.toggle("hidden", !groups.length);
  $("#signalGroups").innerHTML = groups.map((s) => {
    const codes = sig[s].slice(0, 20);
    return `<div class="sig-row">
      <span class="chip sig term" data-term="sig:${s}">${s}</span>
      <span class="sig-codes">${codes.map((c) =>
        `<a class="sig-code" data-code="${c}">${c}<small> ${fmt(t[c].composite, 0)}</small></a>`).join("")}
        ${sig[s].length > 20 ? `<small style="color:var(--muted)">+${sig[s].length - 20} more</small>` : ""}</span>
    </div>`;
  }).join("");
  $("#signalGroups").querySelectorAll(".sig-code").forEach((el) =>
    el.addEventListener("click", () => openDetail(el.dataset.code)));
}

function renderSectors() {
  const secs = state.summary.sectors || [];
  const t = state.summary.tickers;
  $("#secTable tbody").innerHTML = secs.map((s) => `<tr>
    <td class="lft"><b>${s.name}</b></td>
    <td>${s.count}</td>
    <td>${pct(s.avg_1w)}</td><td>${pct(s.avg_1m)}</td><td>${pct(s.avg_3m)}</td>
    <td>${s.pct_above_sma50}%</td>
    <td class="lft">${s.best ? `<a class="sig-code" data-code="${s.best}"><b>${s.best}</b><small> ${fmt(s.best_score, 0)}/100 ${t[s.best] ? "· " + (t[s.best].verdict || "") : ""}</small></a>` : "–"}</td>
  </tr>`).join("");
  $("#secTable tbody").querySelectorAll(".sig-code").forEach((el) =>
    el.addEventListener("click", () => openDetail(el.dataset.code)));

  const cv = $("#sectorBars");
  const barsGeo = drawSectorBars(cv, secs);
  cv.onmousemove = (e) => {
    if (!barsGeo) return;
    const rect = cv.getBoundingClientRect();
    const my = e.clientY - rect.top;
    const row = barsGeo.rows.find((r) => my >= r.y0 && my < r.y1);
    if (!row) { hideTooltip(); return; }
    const s = row.sector;
    showTooltip(
      `<b>${s.name}</b><br>1w ${pct(s.avg_1w)} · 1m ${pct(s.avg_1m)} · 3m ${pct(s.avg_3m)}<br>` +
      `${s.count} shares · ${s.pct_above_sma50}% above SMA50`,
      e.clientX, e.clientY);
  };
  cv.onmouseleave = hideTooltip;
}

/* one glanceable "when to act" sentence — merges the Buy-on date + Hold-for
   horizon that used to be two separate cells. Target/Stop-loss stay as their
   OWN columns (not folded in here) since compact numbers are easier to scan
   down a column than to extract from prose. */
function actionSentence(m) {
  if (!m.eligible || m.verdict === "Avoid") return m.buy_note || "Not recommended for purchase";
  if (m.verdict === "Watch" || m.verdict === "Neutral") {
    return `Wait — ${m.buy_note || "no confirmed entry yet"}`;
  }
  const note = m.buy_note || "";
  const semi = note.indexOf(";");
  const extra = semi >= 0 ? ` (${note.slice(semi + 1).trim()})`
    : note.startsWith("Overheated") ? ` — ${note}` : "";
  return `Buy ${m.buy_date}${extra}, hold ${m.horizon}`;
}

function verdictBadge(v) {
  const cls = { "Strong Buy": "v-strong", "Buy": "v-buy", "Watch": "v-watch",
                "Neutral": "v-neutral", "Avoid": "v-avoid" }[v] || "v-neutral";
  return `<span class="verdict ${cls}" data-term="verdict">${v}<small>${VERDICT_BN[v] || ""}</small></span>`;
}

const TOP10_HORIZON_META = {
  all: {
    title: `Top 20 preferred shares · আজকের সেরা ২০ <span class="term" data-term="composite">ⓘ</span>`,
    sub: `Best overall picks across price history, announcements and AGM/EGM record dates —
      cross-checked against today's <b>Spike</b> list and the 2-year <b>Margin</b> extremes (backed spikes and
      bottom-of-range reversals earn a bonus; unbacked spikes and top-of-range shares are penalised). Diversified
      (max 3 per sector), each with a purchase date, holding period, profit target and stop-loss. Hover the Why
      text for বাংলা.
      · দামের ইতিহাস, ঘোষণা ও রেকর্ড ডেটের সাথে আজকের Spike ও ২ বছরের Margin প্রান্তও মিলিয়ে দেখা হয়েছে; প্রতিটির জন্য
      কবে কিনবেন, কত দিন রাখবেন, কোন দামে মুনাফা তুলবেন ও ক্ষতি সীমিত করবেন তা দেখানো হয়েছে। "কেন" লেখায় মাউস রাখলে বাংলা।`,
  },
  "1w_2w": {
    title: `Top 20 preferred shares · Short Term (1w–2w) · স্বল্পমেয়াদি (১–২ সপ্তাহ)`,
    sub: `The same Top 20 analysis, restricted to shares whose OWN suggested hold range (see the Action column)
      overlaps 1–2 weeks — fast-resolving, momentum-led setups. A share can appear here AND in the Medium/Long Term
      tabs when its estimated range spans the boundary; that's expected, not a bug.
      · একই Top 20 বিশ্লেষণ, কিন্তু শুধু সেই শেয়ার যাদের নিজের প্রস্তাবিত ধরে রাখার সময় ১–২ সপ্তাহের সাথে মিলে যায় —
      দ্রুত সমাধানকারী, মোমেন্টাম-চালিত সেটআপ। একটি শেয়ার একাধিক ট্যাবে থাকতে পারে যদি তার রেঞ্জ সীমারেখা ছুঁয়ে যায়।`,
  },
  "2w_1m": {
    title: `Top 20 preferred shares · Medium Term (2w–1m) · মধ্যমেয়াদি (২ সপ্তাহ–১ মাস)`,
    sub: `The same Top 20 analysis, restricted to shares whose OWN suggested hold range overlaps 2 weeks – 1 month.
      A share can appear here AND in the Short/Long Term tabs when its estimated range spans the boundary.
      · একই Top 20 বিশ্লেষণ, কিন্তু শুধু সেই শেয়ার যাদের ধরে রাখার সময় ২ সপ্তাহ–১ মাসের সাথে মিলে যায়। রেঞ্জ সীমারেখা
      ছুঁয়ে গেলে একটি শেয়ার একাধিক ট্যাবে থাকতে পারে।`,
  },
  "1m_3m": {
    title: `Top 20 preferred shares · Long Term (1m–3m) · দীর্ঘমেয়াদি (১–৩ মাস)`,
    sub: `The same Top 20 analysis, restricted to shares whose OWN suggested hold range overlaps 1–3 months —
      slower, fundamentals/position-trade setups. A share can appear here AND in the Short/Medium Term tabs when its
      estimated range spans the boundary.
      · একই Top 20 বিশ্লেষণ, কিন্তু শুধু সেই শেয়ার যাদের ধরে রাখার সময় ১–৩ মাসের সাথে মিলে যায় — ধীর, মৌলভিত্তি-চালিত
      সেটআপ। রেঞ্জ সীমারেখা ছুঁয়ে গেলে একটি শেয়ার একাধিক ট্যাবে থাকতে পারে।`,
  },
};

function renderTop10() {
  const t = state.summary.tickers;
  const view = state.topHorizon || "all";
  const codes = (view === "all"
    ? state.summary.top20 || state.summary.top10
    : (state.summary.top20_by_horizon || {})[view]) || [];
  const meta = TOP10_HORIZON_META[view];
  $("#top10Title").innerHTML = meta.title;
  $("#top10Sub").innerHTML = meta.sub;
  $("#top10Meta").textContent = `${codes.length} shares shown`;
  $("#top10Table tbody").innerHTML = codes.map((c, i) => {
    const m = t[c];
    const why = (m.why && m.why.length)
      ? m.why.slice(0, 4)
      : [...(m.reasons_long || []), ...(m.reasons_short || [])].slice(0, 2);
    const whyBn = (m.why_bn || []).slice(0, 4);
    return `<tr data-code="${c}">
      <td>${i + 1}</td>
      <td>${starBtn(c)}</td>
      <td>${compareBtn(c)}</td>
      <td class="lft"><b>${c}</b><br><small style="color:var(--muted)">${m.sector || ""}</small></td>
      <td>${ltpYcp(m.price, m.ycp)}</td>
      <td class="lft">${verdictBadge(m.verdict)}</td>
      <td><b>${fmt(m.composite, 0)}</b><small style="color:var(--muted)">/100</small></td>
      <td class="lft" data-term="action_plan" style="max-width:160px;white-space:normal">${actionSentence(m)}</td>
      <td class="pos" data-term="target">${fmt(m.target_price, 1)}<br><small>+${fmt(m.target_pct, 0)}%</small></td>
      <td class="neg" data-term="stop">${fmt(m.stop_price, 1)}<br><small>−${fmt(m.stop_pct, 0)}%</small></td>
      <td data-term="pred_price">${fmt(m.pred_1w_price, 1)}<br><small class="${m.pred_1w_pct > 0 ? "pos" : m.pred_1w_pct < 0 ? "neg" : ""}">${m.pred_1w_pct > 0 ? "+" : ""}${fmt(m.pred_1w_pct, 1)}%</small></td>
      <td data-term="pred_price">${fmt(m.pred_1m_price, 1)}<br><small class="${m.pred_1m_pct > 0 ? "pos" : m.pred_1m_pct < 0 ? "neg" : ""}">${m.pred_1m_pct > 0 ? "+" : ""}${fmt(m.pred_1m_pct, 1)}%</small></td>
      <td class="lft why-cell" style="max-width:380px"><small data-bn="${escAttr(whyBn.map((w) => "• " + w).join("<br>"))}">${why.map((w) => "• " + w).join("<br>")}</small></td>
    </tr>`;
  }).join("") || `<tr><td colspan="13" class="loading">No qualifying shares in this hold-range window today</td></tr>`;
  wireStarButtons($("#top10Table"));
  wireCompareButtons($("#top10Table"));
  $("#top10Table tbody").querySelectorAll("tr[data-code]").forEach((tr) =>
    tr.addEventListener("click", () => openDetail(tr.dataset.code)));
}

$("#top10HorizonSeg").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
  $("#top10HorizonSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
  state.topHorizon = b.dataset.h;
  renderTop10();
}));

function renderSuggestions() {
  renderTop10();
}

/* ---------------- high profit (exceptional setups) ---------------- */
const HP_STRATEGY = {
  "squeeze": { label: "Volatility squeeze", bn: "ভোলাটিলিটি স্কুইজ", cls: "hps-squeeze" },
  "momentum-leader": { label: "Momentum leader", bn: "মোমেন্টাম লিডার", cls: "hps-momo" },
  "accumulation": { label: "Quiet accumulation", bn: "নীরব সঞ্চয়", cls: "hps-accum" },
  "rebound": { label: "Oversold rebound", bn: "রিবাউন্ড", cls: "hps-rebound" },
  "breakout": { label: "Volume breakout", bn: "ব্রেকআউট", cls: "hps-breakout" },
  "dividend-runner": { label: "Dividend runner", bn: "ডিভিডেন্ড রানার", cls: "hps-div" },
  "proven-signal": { label: "Proven signal", bn: "প্রমাণিত সংকেত", cls: "hps-signal" },
  "reversal-candle": { label: "Reversal candle", bn: "রিভার্সাল ক্যান্ডেল", cls: "hps-candle" },
};

function hpCardHtml(p, rank) {
  const s = HP_STRATEGY[p.strategy] || { label: p.strategy, bn: "", cls: "" };
  const others = (p.matched || []).filter((x) => x !== p.strategy);
  return `<div class="hp-card" data-code="${p.code}">
    <div class="hp-head">
      <span class="rank">${rank}</span>
      ${starBtn(p.code)}${compareBtn(p.code)}
      <b class="hp-code">${p.code}</b>
      <small class="hp-sec">${p.sector || ""}</small>
      <span class="hp-badge ${s.cls} term" data-term="hp:${p.strategy}">${s.label}<small>${s.bn}</small></span>
      <span class="hp-conf term" data-term="hp_conf">${"★".repeat(p.conf)}${"☆".repeat(3 - p.conf)}</span>
    </div>
    <div class="hp-nums">
      <div class="mstat"><div class="k">LTP</div><div class="v ${ltpCls(p.price, p.ycp)}">${fmt(p.price, 1)}</div></div>
      <div class="mstat"><div class="k">YCP</div><div class="v">${fmt(p.ycp, 1)}</div></div>
      <div class="mstat" data-term="target"><div class="k">Target</div><div class="v pos">${fmt(p.target_price, 1)}<small> +${fmt(p.target_pct, 0)}%</small></div></div>
      <div class="mstat" data-term="stop"><div class="k">Stop</div><div class="v neg">${fmt(p.stop_price, 1)}<small> −${fmt(p.stop_pct, 0)}%</small></div></div>
      <div class="mstat" data-term="rr"><div class="k">R/R</div><div class="v">${fmt(p.rr, 1)}</div></div>
      <div class="mstat" data-term="buy_date"><div class="k">Buy on</div><div class="v hp-small">${p.buy_date || "–"}</div></div>
      <div class="mstat" data-term="horizon"><div class="k">Hold</div><div class="v hp-small">${p.hold}</div></div>
    </div>
    <ul class="hp-why">${(p.why || []).map((w) => `<li>${w}</li>`).join("")}</ul>
    ${others.length ? `<div class="hp-multi">✓ Confluence — also matches: ${others.map((x) => (HP_STRATEGY[x] || { label: x }).label).join(", ")}</div>` : ""}
  </div>`;
}

function renderHighProfit() {
  const hp = state.summary.high_profit;
  const grid = $("#hpGrid");
  if (!hp || !(hp.picks || []).length) {
    $("#hpMeta").textContent = "";
    $("#hpWarn").classList.add("hidden");
    grid.innerHTML = `<div class="loading">No exceptional setups today — that's normal: these appear only when
      strict conditions line up. Check again after the next Update Data.
      · আজ কোনো ব্যতিক্রমী সুযোগ নেই — কড়া শর্ত মিললেই কেবল এখানে শেয়ার আসে। পরের Update Data-র পরে আবার দেখুন।</div>`;
    return;
  }
  $("#hpMeta").textContent = `${hp.picks.length} setups from ${hp.scanned} liquid eligible shares · regime: ${hp.regime}`;
  $("#hpWarn").classList.toggle("hidden", hp.regime !== "Bearish");
  grid.innerHTML = hp.picks.map((p, i) => hpCardHtml(p, i + 1)).join("");
  wireStarButtons(grid);
  wireCompareButtons(grid);
  grid.querySelectorAll(".hp-card").forEach((el) =>
    el.addEventListener("click", () => openDetail(el.dataset.code)));
}

/* ---------------- portfolio (trade journal + exit engine) ---------------- */
async function loadPortfolio() {
  const res = await fetch("/api/portfolio");
  state.portfolio = await res.json();
  renderPortfolio();
}

function pfAlertBadge(a) {
  const cls = { bad: "v-avoid", warn: "v-watch", good: "v-strong", info: "v-info" }[a.level] || "v-neutral";
  return `<span class="verdict ${cls}" data-bn="${escAttr(a.bn)}" style="margin:1px 2px 1px 0">${a.kind}</span>`;
}

function renderPortfolio() {
  const pf = state.portfolio;
  if (!pf) return;
  const s = pf.summary || {};
  const nf = (v) => v === null || v === undefined ? "–" : Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const pcls = (v) => v > 0 ? "pos" : v < 0 ? "neg" : "";

  $("#pfSummary").innerHTML = `
    <div class="mstat"><div class="k">Invested</div><div class="v">৳${nf(s.invested)}</div></div>
    <div class="mstat"><div class="k">Current value</div><div class="v">৳${nf(s.value)}</div></div>
    <div class="mstat"><div class="k">Unrealized P&L</div><div class="v ${pcls(s.unrealized)}">৳${nf(s.unrealized)}${s.unrealized_pct !== null && s.unrealized_pct !== undefined ? ` <small>(${s.unrealized_pct > 0 ? "+" : ""}${fmt(s.unrealized_pct)}%)</small>` : ""}</div></div>
    <div class="mstat"><div class="k">Realized P&L</div><div class="v ${pcls(s.realized)}">৳${nf(s.realized)}</div></div>
    <div class="mstat"><div class="k">Closed trades</div><div class="v">${s.closed_trades || 0}${s.closed_win_rate !== null && s.closed_win_rate !== undefined ? ` <small>(${s.closed_win_rate}% wins)</small>` : ""}</div></div>
    <div class="mstat" data-term="portfolio_beta"><div class="k">Portfolio beta</div><div class="v">${s.portfolio_beta !== null && s.portfolio_beta !== undefined ? fmt(s.portfolio_beta, 2) : "–"}</div></div>`;

  // diversification: pairwise correlation among current holdings
  const div = pf.diversification || { pairs: [], concentration_risk: false };
  $("#pfDiversify").classList.toggle("hidden", div.pairs.length === 0);
  if (div.pairs.length) {
    const rows = div.pairs.slice(0, 8).map((p) => `<div class="sig-row">
      <span>${p.a} × ${p.b}</span>
      <b class="${p.corr >= 0.7 ? "neg" : ""}">${p.corr.toFixed(2)}</b>
    </div>`).join("");
    $("#pfDiversifyBody").innerHTML = (div.concentration_risk
      ? `<div class="axis-note neg" style="margin-bottom:6px">⚠ Some holdings move together closely (0.7+) — that's one bet wearing two tickers, not real diversification.
         · কিছু হোল্ডিং একসাথে চলে (০.৭+) — এটি একই বাজি দুই টিকারে, প্রকৃত বৈচিত্র্য নয়।</div>`
      : `<div class="axis-note" style="margin-bottom:6px">No pair moves together strongly — your holdings look reasonably diversified.
         · কোনো জোড়া জোরালোভাবে একসাথে চলছে না — আপনার হোল্ডিং মোটামুটি বৈচিত্র্যময়।</div>`) + rows;
  }

  // cross-holding alert strip
  const alerts = pf.alerts || [];
  $("#pfAlertsPanel").classList.toggle("hidden", !alerts.length);
  $("#pfAlerts").innerHTML = alerts.map((a) =>
    `<div class="sig-row"><a class="sig-code" data-code="${a.code}"><b>${a.code}</b></a>
      <span class="chip sig ${a.level === "bad" ? "alert-bad" : ""}" data-bn="${escAttr(a.bn)}">${a.kind}</span>
      <span style="font-size:12.5px;color:var(--ink-2)">${a.en}</span></div>`).join("");
  $("#pfAlerts").querySelectorAll(".sig-code").forEach((el) =>
    el.addEventListener("click", () => openDetail(el.dataset.code)));

  const rows = pf.holdings || [];
  $("#pfCount").textContent = rows.length ? `(${rows.length})` : "";
  $("#pfTable tbody").innerHTML = rows.map((h) => `<tr data-code="${h.code}">
    <td>${starBtn(h.code)}</td>
    <td class="lft"><b>${h.code}</b><br><small style="color:var(--muted)">${h.sector || ""}</small></td>
    <td>${h.qty}</td>
    <td class="lft">${h.buy_date}</td>
    <td>${fmt(h.buy_price)}</td>
    <td><b class="${ltpCls(h.price, h.ycp)}">${fmt(h.price)}</b><br><small style="color:var(--muted)">YCP ${fmt(h.ycp)}</small></td>
    <td>${nf(h.value)}</td>
    <td class="${pcls(h.pnl)}">${nf(h.pnl)}</td>
    <td class="${pcls(h.pnl_pct)}"><b>${h.pnl_pct > 0 ? "+" : ""}${fmt(h.pnl_pct)}%</b></td>
    <td>${h.sessions_held}<small style="color:var(--muted)">/${h.horizon_sessions}d</small></td>
    <td class="pos">${fmt(h.target_price, 1)}</td>
    <td class="neg">${fmt(h.eff_stop, 1)}<br><small style="color:var(--muted)">${h.stop_rule || ""}</small></td>
    <td class="lft" style="white-space:normal;max-width:260px">${(h.alerts || []).map(pfAlertBadge).join("") || '<small style="color:var(--muted)">none — holding is healthy</small>'}</td>
    <td class="lft">
      <button class="pf-sell" data-id="${h.id}" data-price="${h.price}">Sell</button>
      <button class="pf-del" data-id="${h.id}" title="Remove without recording a sale">✕</button>
    </td>
  </tr>`).join("") || `<tr><td colspan="14" class="loading">No holdings yet — add your first purchase above. · এখনো কিছু নেই — উপরে প্রথম কেনাটি যোগ করুন।</td></tr>`;
  wireStarButtons($("#pfTable"));

  $("#pfTable tbody").querySelectorAll("tr[data-code]").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      openDetail(tr.dataset.code);
    });
  });
  $("#pfTable").querySelectorAll(".pf-sell").forEach((b) => b.addEventListener("click", async () => {
    const p = prompt("Sell price ৳ · বিক্রির দাম", b.dataset.price);
    if (p === null) return;
    const r = await (await fetch("/api/portfolio/sell", { method: "POST",
      body: JSON.stringify({ id: b.dataset.id, sell_price: parseFloat(p) }) })).json();
    if (!r.ok) alert(r.error || "Failed");
    loadPortfolio();
  }));
  $("#pfTable").querySelectorAll(".pf-del").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Remove this holding without recording a sale?")) return;
    await fetch("/api/portfolio/delete", { method: "POST", body: JSON.stringify({ id: b.dataset.id }) });
    loadPortfolio();
  }));

  const closed = pf.closed || [];
  $("#pfClosedPanel").classList.toggle("hidden", !closed.length);
  $("#pfClosedCount").textContent = closed.length ? `(${closed.length})` : "";
  $("#pfClosedTable tbody").innerHTML = closed.map((c) => {
    const pnl = c.qty * (c.sell_price - c.buy_price);
    const pct = (c.sell_price / c.buy_price - 1) * 100;
    return `<tr>
      <td class="lft"><b>${c.code}</b></td><td>${c.qty}</td>
      <td class="lft">${c.buy_date}</td><td>${fmt(c.buy_price)}</td>
      <td class="lft">${c.sell_date}</td><td>${fmt(c.sell_price)}</td>
      <td class="${pcls(pnl)}">${nf(pnl)}</td>
      <td class="${pcls(pct)}">${pct > 0 ? "+" : ""}${fmt(pct)}%</td>
      <td class="lft">${c.id ? `<button class="pf-del-closed" data-id="${c.id}" title="Delete this closed trade — it leaves realized P&L and win rate">✕</button>` : ""}</td>
    </tr>`;
  }).join("");
  $("#pfClosedTable").querySelectorAll(".pf-del-closed").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this closed trade? It will no longer count in realized P&L and win rate. · এই সম্পন্ন লেনদেনটি মুছবেন?")) return;
    await fetch("/api/portfolio/delete", { method: "POST", body: JSON.stringify({ id: b.dataset.id }) });
    loadPortfolio();
  }));
}

$("#pfAdd").addEventListener("click", async () => {
  const body = {
    code: ($("#pfCode").value || "").trim().toUpperCase(),
    qty: parseInt($("#pfQty").value, 10),
    buy_price: parseFloat($("#pfPrice").value),
    buy_date: $("#pfDate").value || undefined,
  };
  const r = await (await fetch("/api/portfolio/add", { method: "POST", body: JSON.stringify(body) })).json();
  $("#pfAddMsg").textContent = r.ok ? `Added ${body.code} ✓` : (r.error || "Failed");
  if (r.ok) { $("#pfCode").value = ""; loadPortfolio(); }
});
$("#pfCode").addEventListener("input", () => {
  const code = $("#pfCode").value.trim().toUpperCase();
  const m = state.summary && state.summary.tickers[code];
  if (m && !$("#pfPrice").value) $("#pfPrice").value = m.price;
});

/* ---------------- report card (self-grading) ---------------- */
const RC_LABELS = { strong_buy: "Strong Buy calls", buy: "Buy calls",
                    top20: "Top 20 list", high_profit: "⚡ High Profit picks" };

/* one-line teaser shown ABOVE the collapsed Market overview/Report card
   details — so the trust signal ("does this app's advice actually work?")
   isn't hidden from a first-time or skeptical user behind a closed toggle. */
function renderReportCardTeaser() {
  const el = $("#rcTeaser");
  if (!el) return;
  const rc = state.summary.report_card;
  const sb = rc && rc.graded_snapshots && rc.categories.strong_buy ? rc.categories.strong_buy["1w"] : null;
  const base = rc && rc.baseline ? rc.baseline["1w"] : null;
  if (!sb || sb.n < 3 || base === null || base === undefined) { el.innerHTML = ""; return; }
  const edge = sb.avg - base;
  const beat = edge > 0;
  el.innerHTML = beat
    ? `<span class="term" data-term="report_card">Strong Buy picks</span> beat the market by <b class="pos">+${fmt(edge)}pp</b> over the next week (${sb.win_rate}% win rate, n=${sb.n}) — see Report card below.`
    : `<span class="term" data-term="report_card">Strong Buy picks</span> are <b class="neg">${fmt(Math.abs(edge))}pp behind</b> the market over the next week this run (n=${sb.n}) — see Report card below.`;
}

function renderReportCard() {
  const rc = state.summary.report_card;
  if (!rc) { $("#reportCardPanel").classList.add("hidden"); renderReportCardTeaser(); return; }
  $("#reportCardPanel").classList.remove("hidden");
  renderReportCardTeaser();
  renderPredAccuracy(rc.pred_accuracy);
  if (!rc.graded_snapshots) {
    $("#rcMeta").textContent = `${rc.snapshots} snapshot${rc.snapshots === 1 ? "" : "s"} recorded (since ${rc.first_date})`;
    $("#rcBody").innerHTML = `<div class="axis-note">Grades appear once recommendations are at least a week old —
      keep clicking Update Data across trading days and this fills in automatically.
      · সুপারিশগুলোর বয়স অন্তত এক সপ্তাহ হলে নম্বর আসবে — প্রতিদিন Update Data চাপতে থাকুন, নিজে নিজেই পূরণ হবে।</div>`;
    return;
  }
  $("#rcMeta").textContent = `${rc.graded_snapshots} graded day${rc.graded_snapshots === 1 ? "" : "s"} since ${rc.first_date}`;
  const cell = (a, baseAvg) => {
    if (!a) return "<td>–</td>";
    const beat = baseAvg !== null && baseAvg !== undefined && a.avg > baseAvg;
    return `<td><b class="${a.avg > 0 ? "pos" : a.avg < 0 ? "neg" : ""}">${a.avg > 0 ? "+" : ""}${fmt(a.avg)}%</b>
      <small style="color:var(--muted)"> ${a.win_rate}% win · n=${a.n}</small>${beat ? " ✓" : ""}</td>`;
  };
  const rows = Object.entries(RC_LABELS).map(([k, label]) => {
    const c = rc.categories[k] || {};
    return `<tr><td class="lft"><b>${label}</b></td>
      ${cell(c["1w"], rc.baseline["1w"])}${cell(c["2w"], rc.baseline["2w"])}${cell(c["1m"], rc.baseline["1m"])}</tr>`;
  }).join("");
  const baseRow = `<tr style="color:var(--muted)"><td class="lft">Market baseline (all shares)</td>
    <td>${rc.baseline["1w"] !== null ? (rc.baseline["1w"] > 0 ? "+" : "") + fmt(rc.baseline["1w"]) + "%" : "–"}</td>
    <td>${rc.baseline["2w"] !== null ? (rc.baseline["2w"] > 0 ? "+" : "") + fmt(rc.baseline["2w"]) + "%" : "–"}</td>
    <td>${rc.baseline["1m"] !== null ? (rc.baseline["1m"] > 0 ? "+" : "") + fmt(rc.baseline["1m"]) + "%" : "–"}</td></tr>`;
  $("#rcBody").innerHTML = `<div class="tbl-wrap"><table>
    <thead><tr><th class="lft">Category</th><th>Next 1w</th><th>Next 2w</th><th>Next 1m</th></tr></thead>
    <tbody>${rows}${baseRow}</tbody></table></div>
    <div class="axis-note" style="margin-top:6px">✓ = beat the market baseline · avg return, win = &gt;+${fmt(rc.win_threshold, 0)}%</div>`;
}

function renderPredAccuracy(pa) {
  if (!pa || (!pa["1w"] && !pa["1m"])) {
    $("#rcPredBody").innerHTML = `<div class="axis-note">Not enough graded history yet — AI Pred. 1w needs 1 week and
      AI Pred. 1m needs about a month of Update Data snapshots to grade. Keep using the app and this fills in.
      · এখনো পর্যাপ্ত নম্বর জমেনি — AI Pred. 1w-এর জন্য ১ সপ্তাহ, AI Pred. 1m-এর জন্য প্রায় ১ মাসের স্ন্যাপশট লাগবে। ব্যবহার চালিয়ে গেলে এটি নিজে নিজে পূরণ হবে।</div>`;
    return;
  }
  const row = (h, label) => {
    const a = pa[h];
    if (!a) return `<tr><td class="lft">${label}</td><td colspan="4">–</td></tr>`;
    const beatsNaive = a.direction_accuracy > a.always_up_baseline;
    return `<tr><td class="lft">${label}</td>
      <td>±${fmt(a.mae_pct)}%<small style="color:var(--muted)"> avg error</small></td>
      <td><b>${a.direction_accuracy}%</b><small style="color:var(--muted)"> direction right</small>${beatsNaive ? " ✓" : ""}</td>
      <td><small style="color:var(--muted)">vs ${a.always_up_baseline}% "always up"</small></td>
      <td><small style="color:var(--muted)">predicted ${a.avg_predicted_pct > 0 ? "+" : ""}${fmt(a.avg_predicted_pct)}% · actual ${a.avg_actual_pct > 0 ? "+" : ""}${fmt(a.avg_actual_pct)}% · n=${a.n}</small></td>
    </tr>`;
  };
  $("#rcPredBody").innerHTML = `<div class="tbl-wrap"><table>
    <thead><tr><th class="lft">Horizon</th><th>Avg error</th><th>Direction</th><th>Naive baseline</th><th class="lft">Detail</th></tr></thead>
    <tbody>${row("1w", "AI Pred. 1w")}${row("1m", "AI Pred. 1m")}</tbody></table></div>
    <div class="axis-note" style="margin-top:6px">✓ = beats a naive "always guess up" baseline · avg error is mean absolute
      percentage-point gap between predicted and actual move.</div>`;
}

/* ---------------- spike (sudden movers) + trend break (regime changes) ---------------- */
const TREND_BREAK_LABEL_BN = {
  "Breakout": "ব্রেকআউট", "Breakdown": "ব্রেকডাউন",
  "Reversal likely": "ঘুরে দাঁড়ানোর সম্ভাবনা", "Early reversal — watch for confirmation": "প্রাথমিক ঘুরে দাঁড়ানো — নিশ্চিতকরণের অপেক্ষা",
};
const SPIKE_LABEL_BN = {
  "Likely to continue": "চলতে পারে", "Likely to continue falling": "পড়তে থাকতে পারে",
  "Mixed — wait for confirmation": "নিশ্চিত হয়ে সিদ্ধান্ত নিন", "Likely to fade": "মিলিয়ে যেতে পারে",
  "Likely to bounce": "ফিরে আসতে পারে",
};
function daysAgoLabel(n) { return n === 0 ? "Today" : n === 1 ? "1d ago" : `${n}d ago`; }
function daysAgoLabelBn(n) { return n === 0 ? "আজ" : `${n} দিন আগে`; }
function dirArrow(direction) {
  return `<span class="${direction === "up" ? "pos" : "neg"}">${direction === "up" ? "▲" : "▼"}</span>`;
}
function spikeOutlookBadge(s) {
  const cls = s.score >= 60 ? "v-strong" : s.score >= 40 ? "v-watch" : "v-avoid";
  return `<span class="verdict ${cls}">${s.label}<small>${SPIKE_LABEL_BN[s.label] || ""}</small></span>`;
}
function trendBreakOutlookBadge(s) {
  const cls = s.score >= 55 ? "v-strong" : "v-watch";
  return `<span class="verdict ${cls}">${s.label}<small>${TREND_BREAK_LABEL_BN[s.label] || ""}</small></span>`;
}
function trendBreakPatternCell(s) {
  const regimeLabel = { downtrend: "downtrend", uptrend: "uptrend", range: "range" }[s.regime] || s.regime;
  const bnLabel = { downtrend: "নিম্নমুখী প্রবণতা", uptrend: "ঊর্ধ্বমুখী প্রবণতা", range: "সীমা" }[s.regime] || "";
  const detail = `${s.regime_sessions}-session ${regimeLabel} (${s.regime_start} to ${s.regime_end})`;
  const detailBn = `${s.regime_sessions}-সেশনের ${bnLabel} (${s.regime_start} থেকে ${s.regime_end})`;
  return `<td class="lft"><span class="chip sig" data-bn="${escAttr(detailBn)}" title="${detail}">${s.regime_sessions}d ${regimeLabel}</span></td>`;
}
function spikeFlagsHtml(s) {
  return (s.flags || [])
    .filter((f) => ["trading-halt", "audit-concern", "illiquid", "exchange-query", "category-Z"].includes(f))
    .map((f) => `<span class="chip flag" data-term="flag:${f}">${f}</span>`).join(" ");
}

function renderSpike() {
  const sp = state.summary.spike;
  if (!sp) return;
  const isSpikes = state.spView !== "trend-breaks";
  $("#spSpikesPanel").classList.toggle("hidden", !isSpikes);
  $("#spTrendBreaksPanel").classList.toggle("hidden", isSpikes);

  const q = (state.spSearch || "").toUpperCase();
  const filt = (rows) => q ? rows.filter((s) => s.code.includes(q) || (s.sector || "").toUpperCase().includes(q)) : rows;
  const spikes = filt(sp.spikes || []);
  const breaks = filt(sp.trend_breaks || []);

  $("#spMeta").textContent = sp.date ? `session ${sp.date} · last ${sp.lookback} sessions · ≥${sp.min_pct}% either direction` : "";
  $("#tbMeta").textContent = sp.date ? `session ${sp.date} · last ${sp.lookback} sessions` : "";
  $("#spCount").textContent = isSpikes ? `${spikes.length} spikes shown` : `${breaks.length} trend breaks shown`;

  $("#spTable tbody").innerHTML = spikes.map((s, i) => {
    const room = s.direction === "up" ? s.dist_resistance : s.dist_support;
    return `<tr data-code="${s.code}">
      <td>${i + 1}</td>
      <td>${starBtn(s.code)}</td>
      <td>${compareBtn(s.code)}</td>
      <td class="lft"><b>${s.code}</b></td>
      <td class="lft">${s.sector || "–"}</td>
      <td class="lft">${s.category || "–"}</td>
      <td data-bn="${escAttr(daysAgoLabelBn(s.days_ago))}">${daysAgoLabel(s.days_ago)}</td>
      <td>${dirArrow(s.direction)}</td>
      <td class="${s.direction === "up" ? "pos" : "neg"}"><b>${s.change_pct > 0 ? "+" : ""}${fmt(s.change_pct, 1)}%</b></td>
      <td>${fmt(s.price)}</td>
      <td><b>${fmt(s.vol_today_ratio, 1)}×</b></td>
      <td>${fmt(s.rsi14, 0)}</td>
      <td>${fmt(room)}</td>
      <td><b class="${s.score >= 60 ? "pos" : ""}">${fmt(s.score, 0)}</b><small style="color:var(--muted)">/100</small></td>
      <td class="lft">${spikeOutlookBadge(s)}</td>
      <td class="lft why-cell"><small data-bn="${escAttr((s.why_bn || []).map((w) => "• " + w).join("<br>"))}">${(s.why || []).join(" · ")}</small> ${spikeFlagsHtml(s)}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="16" class="loading">No spikes in the last ${sp.lookback || 5} sessions — check again after the next Update Data.</td></tr>`;
  wireScreenerTable($("#spTable"));

  $("#tbTable tbody").innerHTML = breaks.map((s, i) => `<tr data-code="${s.code}">
      <td>${i + 1}</td>
      <td>${starBtn(s.code)}</td>
      <td>${compareBtn(s.code)}</td>
      <td class="lft"><b>${s.code}</b></td>
      <td class="lft">${s.sector || "–"}</td>
      <td class="lft">${s.category || "–"}</td>
      <td data-bn="${escAttr(daysAgoLabelBn(s.days_ago))}">${daysAgoLabel(s.days_ago)}</td>
      <td>${dirArrow(s.direction)}</td>
      ${trendBreakPatternCell(s)}
      <td>${fmt(s.price)}</td>
      <td><b>${fmt(s.vol_today_ratio, 1)}×</b></td>
      <td>${fmt(s.rsi14, 0)}</td>
      <td><b class="${s.score >= 55 ? "pos" : ""}">${fmt(s.score, 0)}</b><small style="color:var(--muted)">/100</small></td>
      <td class="lft">${trendBreakOutlookBadge(s)}</td>
      <td class="lft why-cell"><small data-bn="${escAttr((s.why_bn || []).map((w) => "• " + w).join("<br>"))}">${(s.why || []).join(" · ")}</small> ${spikeFlagsHtml(s)}</td>
    </tr>`).join("") || `<tr><td colspan="15" class="loading">No trend breaks in the last ${sp.lookback || 5} sessions — check again after the next Update Data.</td></tr>`;
  wireScreenerTable($("#tbTable"));
}

/* Suggestions-tab summary: today's freshest spikes/trend-breaks only (days_ago
   === 0), ranked by score — a quick pulse, not the full multi-day list. */
const SUG_SPIKE_SHOW = 6;
function sugSpikeItem(s) {
  const cls = s.direction === "up" ? "pos" : "neg";
  return `<div class="sug-spike-item" data-code="${s.code}">
    ${starBtn(s.code)}${compareBtn(s.code)}
    <span class="code">${s.code}</span>
    <span class="sector">${s.sector || ""}</span>
    <span class="chg ${cls}">${dirArrow(s.direction)} ${s.change_pct > 0 ? "+" : ""}${fmt(s.change_pct, 1)}%</span>
    <b class="${s.score >= 60 ? "pos" : ""}">${fmt(s.score, 0)}</b>
  </div>`;
}
function sugBreakItem(s) {
  const regimeLabel = { downtrend: "downtrend", uptrend: "uptrend", range: "range" }[s.regime] || s.regime;
  return `<div class="sug-spike-item" data-code="${s.code}">
    ${starBtn(s.code)}${compareBtn(s.code)}
    <span class="code">${s.code}</span>
    <span class="sector">${s.sector || ""}</span>
    <span class="chip sig pattern-chip">${dirArrow(s.direction)} ${s.regime_sessions}d ${regimeLabel}</span>
    <b class="${s.score >= 55 ? "pos" : ""}">${fmt(s.score, 0)}</b>
  </div>`;
}
function wireSugSpikeItems(container, view) {
  container.querySelectorAll(".sug-spike-item").forEach((el) =>
    el.addEventListener("click", () => openDetail(el.dataset.code)));
  wireStarButtons(container);
  wireCompareButtons(container);
  const more = container.querySelector(".sug-spike-more");
  if (more) more.addEventListener("click", () => {
    activateTab("spike");
    state.spView = view;
    $("#spViewSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x.dataset.view === view));
    renderSpike();
  });
}
function renderSpikeSummary() {
  const sp = state.summary.spike;
  if (!sp) return;
  const todaySpikes = (sp.spikes || []).filter((s) => s.days_ago === 0).sort((a, b) => b.score - a.score);
  const todayBreaks = (sp.trend_breaks || []).filter((s) => s.days_ago === 0).sort((a, b) => b.score - a.score);
  $("#sugSpikeMeta").textContent = sp.date ? `session ${sp.date}` : "";

  const spikesBody = $("#sugSpikesBody");
  spikesBody.innerHTML = todaySpikes.slice(0, SUG_SPIKE_SHOW).map(sugSpikeItem).join("") ||
    `<div class="axis-note" style="padding:7px 0">No spikes today yet — check the Spike tab for recent days.</div>`;
  if (todaySpikes.length > SUG_SPIKE_SHOW || todaySpikes.length)
    spikesBody.insertAdjacentHTML("beforeend",
      `<span class="sug-spike-more">${todaySpikes.length} today · View all in Spike tab →</span>`);
  wireSugSpikeItems(spikesBody, "spikes");

  const breaksBody = $("#sugBreaksBody");
  breaksBody.innerHTML = todayBreaks.slice(0, SUG_SPIKE_SHOW).map(sugBreakItem).join("") ||
    `<div class="axis-note" style="padding:7px 0">No fresh trend breaks today — check the Spike tab for recent days.</div>`;
  if (todayBreaks.length > SUG_SPIKE_SHOW || todayBreaks.length)
    breaksBody.insertAdjacentHTML("beforeend",
      `<span class="sug-spike-more">${todayBreaks.length} today · View all in Spike tab →</span>`);
  wireSugSpikeItems(breaksBody, "trend-breaks");
}

$("#spSearch").addEventListener("input", debounce(() => {
  state.spSearch = $("#spSearch").value;
  renderSpike();
}, 250));
$("#spViewSeg").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
  $("#spViewSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
  state.spView = b.dataset.view;
  renderSpike();
}));

/* ---------------- margin (2-year range extremes) ---------------- */
function mgScoreCell(score, dir) {
  // rise score: green when high (good entry). fall score: red when high (danger).
  const cls = dir === "lower" ? (score >= 60 ? "pos" : "") : (score >= 50 ? "neg" : "");
  return `<td><b class="${cls}">${fmt(score, 0)}</b><small style="color:var(--muted)">/100</small></td>`;
}

function mgRowHtml(e, i, dir) {
  const dist = dir === "lower"
    ? `+${fmt(e.from_low, 0)}%`
    : `−${fmt(e.from_high, 0)}%`;
  const flags = (e.flags || [])
    .filter((f) => ["trading-halt", "audit-concern", "stale-data", "illiquid", "exchange-query"].includes(f))
    .map((f) => `<span class="chip flag" data-term="flag:${f}">${f}</span>`).join(" ");
  return `<tr data-code="${e.code}">
    <td>${i + 1}</td>
    <td>${starBtn(e.code)}</td>
    <td>${compareBtn(e.code)}</td>
    <td class="lft"><b>${e.code}</b></td>
    <td class="lft">${e.sector || "–"}</td>
    <td class="lft">${e.category || "–"}</td>
    <td>${ltpYcp(e.price, e.ycp)}</td>
    <td>${fmt(e.pos, 2)}</td>
    <td>${dist}</td>
    <td>${fmt(e.rsi14, 0)}</td>
    <td>${pct(e.r_1w)}</td><td>${pct(e.r_1m)}</td>
    ${mgScoreCell(e.score, dir)}
    <td class="lft turn-cell"><b>${e.turn_date}</b><br><small style="color:var(--muted);white-space:normal">${e.turn_note}</small></td>
    <td class="lft why-cell"><small data-bn="${escAttr((e.why_bn || []).map((w) => "• " + w).join("<br>"))}">${(e.why || []).join(" · ")}</small> ${flags}</td>
  </tr>`;
}

const MG_RANGE_LABEL = { "1m": "1-month", "2m": "2-month", "3m": "3-month",
                         "6m": "6-month", "1y": "1-year", "2y": "2-year" };

/* join a window's membership entry with the shared per-ticker assessment
   and the main analysis record into one row object */
function mgAssemble(list, dir) {
  const T = state.summary.tickers;
  const MT = state.summary.margin.tickers || {};
  return list.map((e) => {
    const t = T[e.code] || {};
    const mt = MT[e.code] || {};
    const common = { ...e, price: t.price, ycp: t.ycp, sector: t.sector, category: t.category,
                     rsi14: t.rsi14, r_1w: t.r_1w, r_1m: t.r_1m, flags: t.flags };
    return dir === "lower"
      ? { ...common, score: mt.rise_score, turn_date: mt.rise_date, turn_note: mt.rise_note,
          why: mt.rise_why, why_bn: mt.rise_why_bn }
      : { ...common, score: mt.fall_score, turn_date: mt.fall_date, turn_note: mt.fall_note,
          why: mt.fall_why, why_bn: mt.fall_why_bn };
  });
}

function renderMargin() {
  const mg = state.summary.margin;
  if (!mg || !mg.windows) return;
  const rk = state.mgRange;
  const label = MG_RANGE_LABEL[rk] || rk;
  const win = mg.windows[rk] || { lower: [], higher: [] };
  const q = (state.mgSearch || "").toUpperCase();
  const filt = (list) => q
    ? list.filter((e) => e.code.includes(q) || (e.sector || "").toUpperCase().includes(q))
    : list;
  const lower = filt(mgAssemble(win.lower || [], "lower"));
  const higher = filt(mgAssemble(win.higher || [], "higher"));
  const isLower = state.mgView === "lower";
  $("#mgLowerPanel").classList.toggle("hidden", !isLower);
  $("#mgHigherPanel").classList.toggle("hidden", isLower);
  $("#mgLowerTitle").textContent = `▼ Lower Margin — bottom 25% of the ${label} range`;
  $("#mgHigherTitle").textContent = `▲ Higher Margin — top 25% of the ${label} range`;
  $("#mgLowerPosTh").textContent = `${rk} pos`;
  $("#mgLowerDistTh").textContent = `Above ${rk} low`;
  $("#mgHigherPosTh").textContent = `${rk} pos`;
  $("#mgHigherDistTh").textContent = `Below ${rk} high`;
  $("#mgCount").textContent = isLower
    ? `${lower.length} shares in the bottom 25% of their ${label} range`
    : `${higher.length} shares in the top 25% of their ${label} range`;
  $("#mgLowerTable tbody").innerHTML =
    lower.map((e, i) => mgRowHtml(e, i, "lower")).join("") ||
    `<tr><td colspan="15" class="loading">No shares in the lower margin of the ${label} range right now</td></tr>`;
  $("#mgHigherTable tbody").innerHTML =
    higher.map((e, i) => mgRowHtml(e, i, "higher")).join("") ||
    `<tr><td colspan="15" class="loading">No shares in the higher margin of the ${label} range right now</td></tr>`;
  wireScreenerTable($("#mgLowerTable"));
  wireScreenerTable($("#mgHigherTable"));
}

$("#mgSeg").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
  $("#mgSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
  state.mgView = b.dataset.mg;
  renderMargin();
}));
$("#mgRangeSeg").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
  $("#mgRangeSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
  state.mgRange = b.dataset.range;
  renderMargin();
}));
$("#mgSearch").addEventListener("input", debounce(() => {
  state.mgSearch = $("#mgSearch").value;
  renderMargin();
}, 250));

/* ---------------- Today's Top 10 Transaction (by value / volume / % change) ---------------- */
const TX_VIEW_META = {
  value: { title: "💰 Top 10 by traded value · আজকের সর্বোচ্চ লেনদেন",
    sub: "Sorted by today's traded value (turnover, mn BDT) — the shares moving the most money right now. " +
      "· আজকের লেনদেন মূল্য (টাকা) অনুযায়ী সাজানো — এই মুহূর্তে সবচেয়ে বেশি টাকা লেনদেন হওয়া শেয়ার।" },
  volume: { title: "📦 Top 10 by volume · আজকের সর্বোচ্চ শেয়ার সংখ্যা",
    sub: "Sorted by today's share count traded — the most actively changing hands, regardless of price. " +
      "· আজকের লেনদেন হওয়া শেয়ার সংখ্যা অনুযায়ী সাজানো — দাম নির্বিশেষে সবচেয়ে বেশি হাতবদল।" },
  change: { title: "📈 Top 10 by % change · আজকের সবচেয়ে বেশি ওঠা/নামা",
    sub: "Sorted by size of today's move either direction (▲ or ▼) vs yesterday's close — the day's biggest swings. " +
      "· গতকালের ক্লোজের তুলনায় আজকের পরিবর্তনের আকার অনুযায়ী সাজানো (▲ বা ▼) — দিনের সবচেয়ে বড় ওঠানামা।" },
};

function txRowHtml(e, i) {
  const chgCls = e.day_change > 0 ? "pos" : e.day_change < 0 ? "neg" : "";
  const flags = (e.flags || [])
    .filter((f) => ["trading-halt", "audit-concern", "illiquid", "exchange-query", "category-Z", "heavy-volume-selling"].includes(f))
    .map((f) => `<span class="chip flag" data-term="flag:${f}">${f}</span>`).join(" ");
  return `<tr data-code="${e.code}">
    <td>${i + 1}</td>
    <td>${starBtn(e.code)}</td>
    <td>${compareBtn(e.code)}</td>
    <td class="lft"><b>${e.code}</b></td>
    <td class="lft">${e.sector || "–"}</td>
    <td class="lft">${e.category || "–"}</td>
    <td>${ltpYcp(e.price, e.ycp)}</td>
    <td class="${chgCls}"><b>${e.day_change > 0 ? "+" : ""}${fmt(e.day_change, 1)}%</b></td>
    <td>${fmt(e.value_today_mn, 2)}</td>
    <td>${Number(e.volume_today || 0).toLocaleString()}</td>
    <td>${fmt(e.rsi14, 0)}</td>
    <td class="lft">${verdictBadge(e.verdict)} ${flags}</td>
    <td><b>${fmt(e.composite, 0)}</b><small style="color:var(--muted)">/100</small></td>
    <td class="pos" data-term="target">${fmt(e.target_price, 1)}<br><small>+${fmt(e.target_pct, 0)}%</small></td>
    <td class="neg" data-term="stop">${fmt(e.stop_price, 1)}<br><small>−${fmt(e.stop_pct, 0)}%</small></td>
    <td><canvas class="tx-spark" data-code="${e.code}" title="Click for full details"></canvas></td>
  </tr>`;
}

function renderTopTx() {
  const tx = state.summary.top_transactions;
  if (!tx) return;
  const view = state.txView || "value";
  const rows = tx[`by_${view}`] || [];
  const meta = TX_VIEW_META[view];
  $("#txTitle").textContent = meta.title;
  $("#txSub").innerHTML = meta.sub;
  $("#txMeta").textContent = tx.date ? `session ${tx.date} · top ${rows.length}` : "";
  $("#txTable tbody").innerHTML = rows.map((e, i) => txRowHtml(e, i)).join("") ||
    `<tr><td colspan="16" class="loading">No trading activity yet today — check again after the next Update Data.</td></tr>`;
  wireScreenerTable($("#txTable"));
  $("#txTable tbody").querySelectorAll("canvas.tx-spark").forEach((cv) => {
    const e = rows.find((r) => r.code === cv.dataset.code);
    if (e && e.spark_1m && e.spark_1m.length) drawSparkline(cv, e.spark_1m);
  });
}

$("#txViewSeg").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
  $("#txViewSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
  state.txView = b.dataset.view;
  renderTopTx();
}));

/* ---------------- AGM/EGM/Record (parsed from DSE's own PDFs) ---------------- */
async function loadAgm() {
  const res = await fetch("/api/agm");
  state.agmData = await res.json();
  renderAgm();
}

function agmMatchesSearch(e, q) {
  if (!q) return true;
  return e.ticker.toUpperCase().includes(q) || (e.sector || "").toUpperCase().includes(q)
    || (e.company_name || "").toUpperCase().includes(q);
}

// upcoming record dates first (soonest first), already-passed dates sink below
// them (most recently passed first), unparsed/unknown dates sink to the very end
function daysFromToday(iso) {
  if (!iso) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(iso + "T00:00:00") - today) / 86400000);
}
function byRecordDate(a, b) {
  const da = daysFromToday(a.record_date), db = daysFromToday(b.record_date);
  const rank = (d) => (d === null ? 2 : d < 0 ? 1 : 0);
  const ra = rank(da), rb = rank(db);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return da - db;
  if (ra === 1) return db - da;
  return 0;
}

function wireAgmTable(table) {
  table.querySelectorAll("tbody tr[data-code]").forEach((tr) =>
    tr.addEventListener("click", () => openDetail(tr.dataset.code)));
}

const DIV_KIND_BN = { cash: "নগদ", stock: "স্টক", bonus: "বোনাস", mixed: "মিশ্র" };

/* Bengali hover suggestion — the PDF's own text (purpose/ratio/remarks) stays
   English since it's scraped free text, but the actionable summary (record
   date, what it means, dividend/ratio facts) is generated in Bengali here. */
function agmRowBn(e) {
  const parts = [];
  parts.push(e.record_date
    ? `রেকর্ড ডেট <b>${e.record_date}</b> — এই তারিখে শেয়ার থাকলে যোগ্য বিবেচিত হবেন।`
    : `রেকর্ড ডেট এখনও ঘোষণা করা হয়নি (${e.record_date_text || "অপেক্ষমাণ"})।`);
  if (e.dividend_pct) {
    parts.push(`${fmt(e.dividend_pct, e.dividend_pct % 1 ? 2 : 0)}% ${DIV_KIND_BN[e.dividend_kind] || ""} লভ্যাংশ ঘোষিত হয়েছে।`);
  } else if (e.dividend_kind === "none") {
    parts.push("এবার কোনো লভ্যাংশ ঘোষণা করা হয়নি।");
  }
  if (e.agm_date_text) parts.push(`সভার তারিখ: ${e.agm_date_text}।`);
  return parts.join(" ");
}

function rightsRowBn(e) {
  const parts = [];
  parts.push(e.record_date
    ? `রেকর্ড ডেট <b>${e.record_date}</b> — এই তারিখে শেয়ার থাকলে রাইট শেয়ারের যোগ্যতা পাবেন।`
    : `রেকর্ড ডেট এখনও ঘোষণা করা হয়নি (${e.record_date_text || "অপেক্ষমাণ"})।`);
  parts.push(`অনুপাত: ${e.ratio_text || "–"}, ইস্যু মূল্য ${e.issue_price_text || "–"}।`);
  if (e.sub_open || e.sub_close) {
    parts.push(`আবেদনের সময়: ${e.sub_open || e.sub_open_text || "–"} থেকে ${e.sub_close || e.sub_close_text || "–"} পর্যন্ত।`);
  }
  return parts.join(" ");
}

function agmRowHtml(e) {
  return `<tr data-code="${e.ticker}" data-bn="${escAttr(agmRowBn(e))}">
    <td class="lft"><b>${e.ticker}</b></td>
    <td class="lft">${e.sector || "–"}</td>
    <td class="lft" style="white-space:normal">${e.purpose || "–"}</td>
    <td>${e.dividend_pct !== null && e.dividend_pct !== undefined ? `${fmt(e.dividend_pct, 1)}% ${e.dividend_kind || ""}` : "–"}</td>
    <td class="lft"><b>${e.record_date || e.record_date_text || "–"}</b></td>
    <td class="lft">${e.agm_date_text || "–"}</td>
  </tr>`;
}

function rightsRowHtml(e) {
  return `<tr data-code="${e.ticker}" data-bn="${escAttr(rightsRowBn(e))}">
    <td class="lft"><b>${e.ticker}</b></td>
    <td class="lft">${e.sector || "–"}</td>
    <td class="lft" style="white-space:normal">${e.ratio_text || "–"}</td>
    <td>${e.issue_price_text || "–"}</td>
    <td class="lft"><b>${e.record_date || e.record_date_text || "–"}</b></td>
    <td class="lft">${e.sub_open || e.sub_open_text || "–"} → ${e.sub_close || e.sub_close_text || "–"}</td>
    <td class="lft" style="white-space:normal"><small>${e.remarks || "–"}</small></td>
  </tr>`;
}

function renderAgm() {
  const d = state.agmData;
  if (!d) return;
  const q = (state.agmSearch || "").toUpperCase();
  const agm = (d.agm || []).filter((e) => agmMatchesSearch(e, q)).sort(byRecordDate);
  const rights = (d.rights || []).filter((e) => agmMatchesSearch(e, q)).sort(byRecordDate);

  $("#agmMeta").textContent = [
    d.agm_fetched_at ? `AGM/EGM fetched ${d.agm_fetched_at} (${d.agm_matched}/${d.agm_total} matched)` : null,
    d.rights_fetched_at ? `Rights fetched ${d.rights_fetched_at} (${d.rights_matched}/${d.rights_total} matched)` : null,
  ].filter(Boolean).join(" · ");
  $("#agmCount").textContent = `(${agm.length})`;
  $("#rightsCount").textContent = `(${rights.length})`;

  $("#agmTable tbody").innerHTML = agm.map(agmRowHtml).join("") ||
    `<tr><td colspan="6" class="loading">No AGM/EGM notices match.</td></tr>`;
  $("#rightsTable tbody").innerHTML = rights.map(rightsRowHtml).join("") ||
    `<tr><td colspan="7" class="loading">No rights-entitlement notices match.</td></tr>`;
  wireAgmTable($("#agmTable"));
  wireAgmTable($("#rightsTable"));
}

$("#agmSearch").addEventListener("input", debounce(() => {
  state.agmSearch = $("#agmSearch").value;
  renderAgm();
}, 250));

/* Each column: key (matches ticker field, mostly), label, header class, glossary
   term, def (shown by default), td (full <td> renderer). Star and Code are
   fixed/always-shown, outside this list, so a user can never hide the one
   thing that identifies a row. */
const SCR_COLS = [
  { key: "sector", label: "Sector", cls: "lft", term: "sector", def: true, td: (r) => `<td class="lft">${r.sector || "–"}</td>` },
  { key: "category", label: "Cat", cls: "lft", term: "category", def: false, td: (r) => `<td class="lft">${r.category || "–"}</td>` },
  { key: "cap_class", label: "Cap", cls: "lft", term: "cap_class", def: false, td: (r) => `<td class="lft">${r.cap_class || "–"}</td>` },
  { key: "flags", label: "Flags", cls: "lft", term: "flags", def: true,
    td: (r) => `<td class="lft">${(r.flags || []).map((f) => `<span class="chip flag" data-term="flag:${f}">${f}</span>`).join(" ")}</td>` },
  { key: "price", label: "LTP", cls: "", term: null, def: true, td: (r) => `<td>${ltpYcp(r.price, r.ycp)}</td>` },
  { key: "target_price", label: "Target", cls: "", term: "target", def: true,
    td: (r) => `<td class="pos">${fmt(r.target_price, 1)}<br><small>+${fmt(r.target_pct, 0)}%</small></td>` },
  { key: "stop_price", label: "Stop", cls: "", term: "stop", def: true,
    td: (r) => `<td class="neg">${fmt(r.stop_price, 1)}<br><small>−${fmt(r.stop_pct, 0)}%</small></td>` },
  { key: "r_1w", label: "1w%", cls: "", term: "returns", def: false, td: (r) => `<td>${pct(r.r_1w)}</td>` },
  { key: "r_1m", label: "1m%", cls: "", term: "returns", def: true, td: (r) => `<td>${pct(r.r_1m)}</td>` },
  { key: "r_3m", label: "3m%", cls: "", term: "returns", def: false, td: (r) => `<td>${pct(r.r_3m)}</td>` },
  { key: "r_1y", label: "1y%", cls: "", term: "returns", def: false, td: (r) => `<td>${pct(r.r_1y)}</td>` },
  { key: "rel_1m", label: "RelStr", cls: "", term: "rel_1m", def: false, td: (r) => `<td>${pct(r.rel_1m)}</td>` },
  { key: "rsi14", label: "RSI", cls: "", term: "rsi", def: true, td: (r) => `<td>${fmt(r.rsi14, 0)}</td>` },
  { key: "vol_ratio", label: "Vol×", cls: "", term: "vol_ratio", def: false, td: (r) => `<td>${fmt(r.vol_ratio, 2)}</td>` },
  { key: "pe", label: "P/E", cls: "", term: "pe", def: false, td: (r) => `<td>${fmt(r.pe)}</td>` },
  { key: "p_nav", label: "P/NAV", cls: "", term: "p_nav", def: false,
    td: (r) => `<td class="${r.p_nav !== null && r.p_nav !== undefined && r.p_nav < 1 ? "pos" : ""}">${fmt(r.p_nav, 2)}</td>` },
  { key: "dividend_yield", label: "DivY%", cls: "", term: "dividend_yield", def: false, td: (r) => `<td>${fmt(r.dividend_yield)}</td>` },
  { key: "avg_value_mn_30d", label: "Liq mn", cls: "", term: "liquidity", def: false, td: (r) => `<td>${fmt(r.avg_value_mn_30d)}</td>` },
  { key: "pos_52w", label: "52w pos", cls: "", term: "pos52", def: false, td: (r) => `<td>${fmt(r.pos_52w, 2)}</td>` },
  { key: "dist_resistance", label: "Headroom%", cls: "", term: "support", def: false, td: (r) => `<td>${fmt(r.dist_resistance)}</td>` },
  { key: "score_short", label: "S-score", cls: "", term: "score_short", def: true, td: (r) => `<td><b>${fmt(r.score_short, 0)}</b></td>` },
  { key: "score_long", label: "L-score", cls: "", term: "score_long", def: true, td: (r) => `<td><b>${fmt(r.score_long, 0)}</b></td>` },
  { key: "composite", label: "Score", cls: "", term: "composite", def: true, td: (r) => `<td><b>${fmt(r.composite, 0)}</b></td>` },
  { key: "verdict", label: "Verdict", cls: "lft", term: "verdict", def: true, td: (r) => `<td class="lft">${r.verdict || "–"}</td>` },
  { key: "rr", label: "R/R", cls: "", term: "rr", def: false, td: (r) => `<td>${fmt(r.rr, 1)}</td>` },
  { key: "win_rate", label: "Win%", cls: "", term: "win_rate", def: false,
    td: (r) => `<td>${r.win_rate !== null && r.win_rate !== undefined ? r.win_rate + `<small style="color:var(--muted)">/${r.signal_trades}</small>` : "–"}</td>` },
  { key: "beta", label: "Beta", cls: "", term: "beta", def: false, td: (r) => `<td>${fmt(r.beta, 2)}</td>` },
];

function loadVisibleCols() {
  try {
    const saved = JSON.parse(localStorage.getItem("dse_screener_cols") || "null");
    if (Array.isArray(saved) && saved.length) return saved;
  } catch { /* fall through to defaults */ }
  return SCR_COLS.filter((c) => c.def).map((c) => c.key);
}
let scrVisibleCols = loadVisibleCols();
function saveVisibleCols() { localStorage.setItem("dse_screener_cols", JSON.stringify(scrVisibleCols)); }
function currentVisibleCols() { return SCR_COLS.filter((c) => scrVisibleCols.includes(c.key)); }

function renderColumnPicker() {
  $("#colPickerPop").innerHTML = SCR_COLS.map((c) =>
    `<label><input type="checkbox" data-col="${c.key}" ${scrVisibleCols.includes(c.key) ? "checked" : ""}> ${c.label}</label>`).join("");
  $("#colPickerPop").querySelectorAll("input").forEach((cb) => cb.addEventListener("change", () => {
    const key = cb.dataset.col;
    scrVisibleCols = cb.checked
      ? [...new Set([...scrVisibleCols, key])]
      : scrVisibleCols.filter((k) => k !== key);
    saveVisibleCols();
    renderScreener();
  }));
}
$("#btnColumns").addEventListener("click", () => {
  renderColumnPicker();
  $("#colPickerPop").classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".col-picker-wrap")) $("#colPickerPop").classList.add("hidden");
});

function populateSectorFilter() {
  const sectors = [...new Set(Object.values(state.summary.tickers)
    .map((m) => m.sector).filter(Boolean))].sort();
  const sel = $("#fltSector");
  const cur = sel.value;
  sel.innerHTML = `<option value="">All sectors</option>` +
    sectors.map((s) => `<option${s === cur ? " selected" : ""}>${s}</option>`).join("");
}

/* which shares currently appear in each of the other analysis tabs — powers
   the "also appears in" cross-tab filters */
function crossTabSets() {
  const s = state.summary;
  const spike = new Set((s.spike?.spikes || []).map((x) => x.code));
  const highProfit = new Set((s.high_profit?.picks || []).map((x) => x.code));
  const marginLower = new Set(), marginHigher = new Set();
  for (const w of Object.values(s.margin?.windows || {})) {
    (w.lower || []).forEach((x) => marginLower.add(x.code));
    (w.higher || []).forEach((x) => marginHigher.add(x.code));
  }
  return { spike, highProfit, marginLower, marginHigher };
}

/* ---------------- compare tab: side-by-side + head-to-head insights ---------------- */
const COMPARE_GROUPS = [
  { group: "Overall", rows: [
    { label: "Verdict", term: "verdict", val: (m) => verdictBadge(m.verdict) },
    { label: "Composite score", term: "composite", val: (m) => `<b>${fmt(m.composite, 0)}</b>/100` },
    { label: "Short-term score", term: "score_short", val: (m) => `${fmt(m.score_short, 0)}/100` },
    { label: "Long-term score", term: "score_long", val: (m) => `${fmt(m.score_long, 0)}/100` },
    { label: "Quality score", term: "quality", val: (m) => `${fmt(m.quality, 0)}/100` },
  ] },
  { group: "Trade plan", rows: [
    { label: "LTP", term: null, val: (m) => `<span class="${ltpCls(m.price, m.ycp)}">${fmt(m.price, 1)}</span>` },
    { label: "YCP", term: null, val: (m) => fmt(m.ycp, 1) },
    { label: "Buy on", term: "buy_date", val: (m) => m.buy_date || "–" },
    { label: "Hold for", term: "horizon", val: (m) => m.horizon || "–" },
    { label: "Target", term: "target", val: (m) => m.target_price ? `<span class="pos">${fmt(m.target_price, 1)} (+${fmt(m.target_pct, 0)}%)</span>` : "–" },
    { label: "Stop-loss", term: "stop", val: (m) => m.stop_price ? `<span class="neg">${fmt(m.stop_price, 1)} (−${fmt(m.stop_pct, 0)}%)</span>` : "–" },
    { label: "Risk/Reward", term: "rr", val: (m) => fmt(m.rr, 1) },
    { label: "Signal win rate", term: "win_rate", val: (m) => m.win_rate != null ? `${m.win_rate}%` : "–" },
  ] },
  { group: "Technical", rows: [
    { label: "RSI (14)", term: "rsi", val: (m) => fmt(m.rsi14, 0) },
    { label: "Volume ×30d", term: "vol_ratio", val: (m) => fmt(m.vol_ratio, 2) },
    { label: "ATR%", term: "atr", val: (m) => m.atr_pct != null ? fmt(m.atr_pct, 1) + "%" : "–" },
    { label: "Beta", term: "beta", val: (m) => fmt(m.beta, 2) },
    { label: "52-week position", term: "pos52", val: (m) => m.pos_52w != null ? fmt(m.pos_52w * 100, 0) + "%" : "–" },
  ] },
  { group: "Fundamentals", rows: [
    { label: "P/E", term: "pe", val: (m) => fmt(m.pe) },
    { label: "P/NAV", term: "p_nav", val: (m) => fmt(m.p_nav, 2) },
    { label: "Dividend yield", term: "dividend_yield", val: (m) => m.dividend_yield ? fmt(m.dividend_yield) + "%" : "–" },
    { label: "Market cap", term: "cap_class", val: (m) => m.cap_class || "–" },
    { label: "EPS (annual)", term: "eps", val: (m) => fmt(m.eps_annual, 2) },
  ] },
  { group: "Catalysts & risk", rows: [
    { label: "Record date", term: "record_date", val: (m) => m.upcoming_record_date
      ? `${m.upcoming_record_date} (${m.days_to_record_date}d)${m.upcoming_dividend_pct ? `, ${fmt(m.upcoming_dividend_pct, 0)}%` : ""}` : "–" },
    { label: "Risk flags", term: "flags", val: (m) => (m.flags || []).length
      ? m.flags.map((f) => `<span class="chip flag" data-term="flag:${f}">${f}</span>`).join(" ") : "<small style=\"color:var(--muted)\">none</small>" },
  ] },
];

/* Margin membership at the precise 2-year window + score threshold the
   analysis engine itself uses for its wisdom pass (rise>=55 / fall>=50) —
   NOT the broad "in any of the 6 range windows" union crossTabSets() uses
   for Screener filtering, which fires on short-term noise far too often to
   be a meaningful callout here (e.g. a share merely at its OWN 1-month high
   would otherwise count, even with a harmless fall score of 20/100). */
function compareMarginSignal(code) {
  const mt = state.summary.margin?.tickers?.[code];
  const win2y = state.summary.margin?.windows?.["2y"];
  if (!mt || !win2y) return null;
  if (win2y.lower.some((e) => e.code === code) && (mt.rise_score || 0) >= 55)
    return { dir: "lower", score: mt.rise_score };
  if (win2y.higher.some((e) => e.code === code) && (mt.fall_score || 0) >= 50)
    return { dir: "higher", score: mt.fall_score };
  return null;
}

function compareCrossTabLine(code, sets) {
  const bits = [];
  if (sets.spike.has(code)) bits.push('<span class="chip sig">Spike</span>');
  if (sets.highProfit.has(code)) bits.push('<span class="chip sig">⚡ High Profit</span>');
  const mg = compareMarginSignal(code);
  if (mg?.dir === "lower") bits.push(`<span class="chip sig">▼ Lower Margin (${fmt(mg.score, 0)})</span>`);
  if (mg?.dir === "higher") bits.push(`<span class="chip sig">▲ Higher Margin (${fmt(mg.score, 0)})</span>`);
  return bits.join(" ") || "<small style=\"color:var(--muted)\">none today</small>";
}

/* Ranks the compared shares against EACH OTHER (not the whole market) and
   generates short, specific callouts — the value-add over just viewing each
   share's own tab separately. */
function buildCompareInsights(rows, sets) {
  if (rows.length < 2) return { ranked: rows, insights: [] };
  const ranked = [...rows].sort((a, b) => (b.composite || 0) - (a.composite || 0));
  const insights = [];
  const add = (code, en, bn) => insights.push({ code, en, bn });

  const top = ranked[0];
  add(top.code, `Highest composite score in this comparison (${fmt(top.composite, 0)}/100)`,
      `এই তুলনায় সর্বোচ্চ কম্পোজিট স্কোর (${fmt(top.composite, 0)}/100)`);

  const rrRanked = rows.filter((r) => r.rr).sort((a, b) => b.rr - a.rr);
  if (rrRanked[0] && rrRanked[0].code !== top.code)
    add(rrRanked[0].code, `Best risk/reward ratio here (${fmt(rrRanked[0].rr, 1)})`,
        `এখানে সেরা ঝুঁকি-পুরস্কার অনুপাত (${fmt(rrRanked[0].rr, 1)})`);

  const buyable = rows.filter((r) => ["Strong Buy", "Buy"].includes(r.verdict) && r.buy_date)
    .sort((a, b) => a.buy_date.localeCompare(b.buy_date));
  if (buyable[0])
    add(buyable[0].code, `Earliest suggested buy date among these (${buyable[0].buy_date})`,
        `এদের মধ্যে সবচেয়ে আগের কেনার তারিখ (${buyable[0].buy_date})`);

  const withRecord = rows.filter((r) => r.days_to_record_date != null)
    .sort((a, b) => a.days_to_record_date - b.days_to_record_date);
  if (withRecord[0])
    add(withRecord[0].code, `Closest dividend record date (${withRecord[0].days_to_record_date}d away)`,
        `সবচেয়ে কাছের লভ্যাংশ রেকর্ড ডেট (${withRecord[0].days_to_record_date} দিন বাকি)`);

  rows.forEach((r) => {
    const hard = (r.flags || []).filter((f) => ["trading-halt", "audit-concern", "bearish-divergence", "top-of-range", "spike-fade-risk", "spike-down-risk"].includes(f));
    if (hard.length) add(r.code, `⚠ Carries a risk flag here: ${hard.join(", ")} — weigh this against the others`,
        `⚠ এখানে ঝুঁকি-চিহ্ন আছে: ${hard.join(", ")} — বাকিদের সাথে তুলনা করে বিবেচনা করুন`);
    if (sets.spike.has(r.code)) add(r.code, "Recently spiked or dropped 3%+ — check the Spike tab's continuation score before acting",
        "সম্প্রতি ৩%+ স্পাইক বা পতন হয়েছে — সিদ্ধান্তের আগে Spike ট্যাবের ধারাবাহিকতা-স্কোর দেখুন");
    const mg = compareMarginSignal(r.code);
    if (mg?.dir === "higher") add(r.code, `At the top of its 2-year range with a real fall risk (${fmt(mg.score, 0)}/100) — a profit-taking zone, not an entry one`,
        `২ বছরের সীমার চূড়ায়, প্রকৃত পতনের ঝুঁকি (${fmt(mg.score, 0)}/100) — এটি মুনাফা তোলার জায়গা, ঢোকার নয়`);
    if (mg?.dir === "lower") add(r.code, `At the bottom of its 2-year range with reversal evidence (rise score ${fmt(mg.score, 0)}/100) — a genuine dip-buy candidate`,
        `২ বছরের সীমার তলানিতে, ঘুরে দাঁড়ানোর প্রমাণসহ (রাইজ স্কোর ${fmt(mg.score, 0)}/100) — সত্যিকারের কম দামে কেনার প্রার্থী`);
  });

  const eligibleRanked = ranked.filter((r) => r.eligible && ["Strong Buy", "Buy"].includes(r.verdict));
  const winner = eligibleRanked[0] || ranked[0];
  const runnerUp = ranked.find((r) => r.code !== winner.code);
  const verdictLine = runnerUp
    ? { code: winner.code,
        en: `Of these ${rows.length} shares, <b>${winner.code}</b> looks the strongest overall pick right now — ` +
            `composite ${fmt(winner.composite, 0)} vs ${runnerUp.code}'s ${fmt(runnerUp.composite, 0)}` +
            (winner.verdict !== runnerUp.verdict ? `, and rated ${winner.verdict} vs ${runnerUp.verdict}` : "") +
            `. This ranks them against each other only — check each one's own tabs for the full picture.`,
        bn: `এই ${rows.length}টির মধ্যে <b>${winner.code}</b> এই মুহূর্তে সবচেয়ে শক্তিশালী পছন্দ মনে হচ্ছে — ` +
            `কম্পোজিট ${fmt(winner.composite, 0)} বনাম ${runnerUp.code}-এর ${fmt(runnerUp.composite, 0)}। ` +
            `এটি শুধু এদের একে অপরের সাথে তুলনা করছে — পূর্ণ চিত্রের জন্য প্রতিটির নিজস্ব ট্যাব দেখুন।` }
    : null;
  return { ranked, insights, verdictLine };
}

async function renderCompare() {
  const codes = [...state.compareSet];
  $("#compareEmptyPanel").classList.toggle("hidden", codes.length > 0);
  $("#comparePanel").classList.toggle("hidden", codes.length === 0);
  $("#compareInsightsPanel").classList.toggle("hidden", codes.length < 2);
  if (!codes.length) return;

  const T = state.summary.tickers;
  const rows = codes.map((c) => ({ code: c, ...T[c] })).filter((r) => r.composite !== undefined);
  $("#compareCount").textContent = `(${rows.length}/${COMPARE_MAX})`;

  let sparkByCode = {};
  try {
    const res = await fetch(`/api/charts?codes=${encodeURIComponent(codes.join(","))}`);
    const d = await res.json();
    sparkByCode = Object.fromEntries(d.items.map((it) => [it.code, it]));
  } catch { /* sparkline is a nice-to-have; table still renders without it */ }

  const headCells = rows.map((r) => `<th class="lft compare-col">
    <div class="compare-head"><b>${r.code}</b>
      <button class="compare-remove" data-code="${r.code}" title="Remove from Compare">✕</button></div>
    <small style="color:var(--muted)">${r.sector || ""}</small>
    <canvas class="compare-spark" data-code="${r.code}" title="Click for full details"></canvas>
  </th>`).join("");
  const bodyGroups = COMPARE_GROUPS.map((g) => `
    <tr class="compare-group-row"><td colspan="${rows.length + 1}">${g.group}</td></tr>
    ${g.rows.map((rowDef) => `<tr>
      <td class="lft" ${rowDef.term ? `data-term="${rowDef.term}"` : ""}>${rowDef.label}</td>
      ${rows.map((r) => `<td class="lft">${rowDef.val(r)}</td>`).join("")}
    </tr>`).join("")}
  `).join("");
  const sets = crossTabSets();
  const crossRow = `<tr><td class="lft" data-term="compare">Also flagged in</td>
    ${rows.map((r) => `<td class="lft">${compareCrossTabLine(r.code, sets)}</td>`).join("")}</tr>`;
  const whyRow = `<tr><td class="lft" data-term="why_col">Why · কেন</td>
    ${rows.map((r) => `<td class="lft why-cell" style="max-width:260px">
      <small data-bn="${escAttr((r.why_bn || []).map((w) => "• " + w).join("<br>"))}">${(r.why || []).slice(0, 4).map((w) => "• " + w).join("<br>")}</small>
    </td>`).join("")}</tr>`;

  $("#compareTable").innerHTML =
    `<thead><tr><th></th>${headCells}</tr></thead><tbody>${bodyGroups}${crossRow}${whyRow}</tbody>`;
  $("#compareTable").querySelectorAll(".compare-remove").forEach((btn) =>
    btn.addEventListener("click", () => toggleCompare(btn.dataset.code)));
  $("#compareTable").querySelectorAll(".compare-spark").forEach((cv) => {
    const it = sparkByCode[cv.dataset.code];
    if (it) drawSparkline(cv, it.closes);
    cv.addEventListener("click", () => openDetail(cv.dataset.code));
  });

  const { insights, verdictLine } = buildCompareInsights(rows, sets);
  const insightRow = (i) => `<div class="sig-row"><a class="sig-code" data-code="${i.code}"><b>${i.code}</b></a>
    <span style="font-size:12.5px" data-bn="${escAttr(i.bn)}">${i.en}</span></div>`;
  $("#compareInsightsBody").innerHTML =
    (verdictLine ? `<div class="mplan" data-bn="${escAttr(verdictLine.bn)}">${verdictLine.en}</div>` : "") +
    insights.map(insightRow).join("");
  $("#compareInsightsBody").querySelectorAll(".sig-code").forEach((el) =>
    el.addEventListener("click", () => openDetail(el.dataset.code)));
}

$("#btnClearCompare").addEventListener("click", () => {
  if (!state.compareSet.size) return;
  if (!confirm("Clear all shares from Compare? · সব শেয়ার তুলনা থেকে সরাবেন?")) return;
  state.compareSet.clear();
  saveCompareSet();
  refreshCompareUI();
});

function renderScreener() {
  const cols = currentVisibleCols();
  const head = $("#scrTable thead tr");
  head.innerHTML = `<th>★</th><th data-term="compare">⚖</th><th class="lft" data-key="code">Code${state.scrSortKey === "code" ? (state.scrSortDir < 0 ? " ↓" : " ↑") : ""}</th>` +
    cols.map((c) =>
      `<th class="${c.cls || ""}" data-key="${c.key}" ${c.term ? `data-term="${c.term}"` : ""}>${c.label}${state.scrSortKey === c.key ? (state.scrSortDir < 0 ? " ↓" : " ↑") : ""}</th>`).join("");
  head.querySelectorAll("th[data-key]").forEach((th) => {
    th.addEventListener("click", () => {
      const k = th.dataset.key;
      if (state.scrSortKey === k) state.scrSortDir *= -1;
      else { state.scrSortKey = k; state.scrSortDir = -1; }
      renderScreener();
    });
  });

  const search = ($("#scrSearch").value || "").toUpperCase();
  const eligibleOnly = $("#scrEligible").checked;
  const fSector = $("#fltSector").value;
  const fCat = $("#fltCategory").value;
  const fVerdict = $("#fltVerdict").value;
  const fRsi = $("#fltRsi").value;
  const fLiq = parseFloat($("#fltLiq").value);
  const fComp = parseFloat($("#fltComposite").value);
  const noFlags = $("#fltNoFlags").checked;
  const fCap = $("#fltCapClass").value;
  const fPnav = parseFloat($("#fltPnav").value);
  const fAtr = parseFloat($("#fltAtr").value);
  const fInstAccum = $("#fltInstAccum").checked;
  const fDivYield = parseFloat($("#fltDivYield").value);
  const fEpsTrend = $("#fltEpsTrend").value;
  const fAlsoSpike = $("#fltAlsoSpike").checked;
  const fAlsoHp = $("#fltAlsoHp").checked;
  const fAlsoMgLower = $("#fltAlsoMgLower").checked;
  const fAlsoMgHigher = $("#fltAlsoMgHigher").checked;

  let rows = Object.entries(state.summary.tickers).map(([code, m]) => ({ code, ...m }));
  if (eligibleOnly) rows = rows.filter((r) => r.eligible);
  if (search) rows = rows.filter((r) =>
    r.code.includes(search) || (r.sector || "").toUpperCase().includes(search));
  if (fSector) rows = rows.filter((r) => r.sector === fSector);
  if (fCat) rows = rows.filter((r) => r.category === fCat);
  if (fVerdict) rows = rows.filter((r) => r.verdict === fVerdict);
  if (fRsi === "oversold") rows = rows.filter((r) => r.rsi14 !== null && r.rsi14 < 30);
  else if (fRsi === "neutral") rows = rows.filter((r) => r.rsi14 >= 30 && r.rsi14 <= 70);
  else if (fRsi === "sweet") rows = rows.filter((r) => r.rsi14 >= 45 && r.rsi14 <= 65);
  else if (fRsi === "overbought") rows = rows.filter((r) => r.rsi14 > 70);
  if (!isNaN(fLiq)) rows = rows.filter((r) => (r.avg_value_mn_30d || 0) >= fLiq);
  if (!isNaN(fComp)) rows = rows.filter((r) => (r.composite || 0) >= fComp);
  if (noFlags) rows = rows.filter((r) => !(r.flags || []).length);
  if (fCap) rows = rows.filter((r) => r.cap_class === fCap);
  if (!isNaN(fPnav)) rows = rows.filter((r) => r.p_nav !== null && r.p_nav !== undefined && r.p_nav <= fPnav);
  if (!isNaN(fAtr)) rows = rows.filter((r) => r.atr_pct !== null && r.atr_pct !== undefined && r.atr_pct <= fAtr);
  if (fInstAccum) rows = rows.filter((r) => (r.flags || []).includes("institutional-accumulation"));
  if (!isNaN(fDivYield)) rows = rows.filter((r) => (r.dividend_yield || 0) >= fDivYield);
  if (fEpsTrend) rows = rows.filter((r) => r.eps_trend === fEpsTrend);
  if (fAlsoSpike || fAlsoHp || fAlsoMgLower || fAlsoMgHigher) {
    const sets = crossTabSets();
    rows = rows.filter((r) =>
      (fAlsoSpike && sets.spike.has(r.code)) || (fAlsoHp && sets.highProfit.has(r.code)) ||
      (fAlsoMgLower && sets.marginLower.has(r.code)) || (fAlsoMgHigher && sets.marginHigher.has(r.code)));
  }

  const k = state.scrSortKey, dir = state.scrSortDir;
  rows.sort((a, b) => {
    let va = a[k], vb = b[k];
    if (k === "flags") { va = (va || []).length; vb = (vb || []).length; }
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * dir;
  });
  $("#scrCount").textContent = `${rows.length} shares`;
  $("#scrTable tbody").innerHTML = rows.map((r) => screenerRowHtml(r, cols)).join("");
  wireScreenerTable($("#scrTable"));
  renderScreenerShortlist(cols);
  renderFilterChips();
  state.scrRows = rows; // last filtered+sorted set, for CSV export
  state.scrCols = cols;
}

function screenerRowHtml(r, cols = currentVisibleCols()) {
  return `<tr data-code="${r.code}">
    <td>${starBtn(r.code)}</td>
    <td>${compareBtn(r.code)}</td>
    <td class="lft"><b>${r.code}</b></td>
    ${cols.map((c) => c.td(r)).join("")}
  </tr>`;
}

function wireScreenerTable(table) {
  wireStarButtons(table);
  wireCompareButtons(table);
  table.querySelectorAll("tbody tr").forEach((tr) =>
    tr.addEventListener("click", () => openDetail(tr.dataset.code)));
}

function renderScreenerShortlist(cols = currentVisibleCols()) {
  const panel = $("#scrShortlistPanel");
  const codes = [...state.shortlist];
  if (!codes.length || !state.summary) { panel.classList.add("hidden"); return; }
  const t = state.summary.tickers;
  const rows = codes.map((c) => t[c] ? { code: c, ...t[c] } : null).filter(Boolean);
  if (!rows.length) { panel.classList.add("hidden"); return; }
  $("#scrShortlistCount").textContent = `(${rows.length})`;
  const table = $("#scrShortlistTable");
  table.querySelector("thead tr").innerHTML = $("#scrTable thead tr").innerHTML
    .replace(/<th/g, '<th style="cursor:default"').replace(/ ↓| ↑/g, "");
  table.querySelector("tbody").innerHTML = rows.map((r) => screenerRowHtml(r, cols)).join("");
  wireScreenerTable(table);
  panel.classList.remove("hidden");
}
["#scrSearch", "#fltLiq", "#fltComposite", "#fltPnav", "#fltAtr", "#fltDivYield"].forEach((s) =>
  $(s).addEventListener("input", renderScreener));
["#scrEligible", "#fltNoFlags", "#fltSector", "#fltCategory", "#fltVerdict", "#fltRsi",
 "#fltCapClass", "#fltInstAccum", "#fltEpsTrend",
 "#fltAlsoSpike", "#fltAlsoHp", "#fltAlsoMgLower", "#fltAlsoMgHigher"].forEach((s) =>
  $(s).addEventListener("change", renderScreener));

/* ---- active filter chips (what's narrowing the table right now) ---- */
const RSI_LABELS = { oversold: "Oversold <30", neutral: "Neutral 30–70", sweet: "Sweet spot 45–65", overbought: "Overbought >70" };
const EPS_TREND_LABELS = { up: "Improving", "turned-profitable": "Turned profitable", down: "Declining", "turned-loss": "Turned loss" };
const FILTER_DEFS = [
  { id: "scrSearch", label: (v) => `Search "${v}"`, get: () => $("#scrSearch").value.trim(), clear: () => { $("#scrSearch").value = ""; } },
  { id: "fltSector", label: (v) => `Sector: ${v}`, get: () => $("#fltSector").value, clear: () => { $("#fltSector").value = ""; } },
  { id: "fltCategory", label: (v) => `Category ${v}`, get: () => $("#fltCategory").value, clear: () => { $("#fltCategory").value = ""; } },
  { id: "fltVerdict", label: (v) => `Verdict: ${v}`, get: () => $("#fltVerdict").value, clear: () => { $("#fltVerdict").value = ""; } },
  { id: "scrEligible", label: () => "Eligible only", get: () => $("#scrEligible").checked, clear: () => { $("#scrEligible").checked = false; } },
  { id: "fltRsi", label: (v) => `RSI: ${RSI_LABELS[v] || v}`, get: () => $("#fltRsi").value, clear: () => { $("#fltRsi").value = ""; } },
  { id: "fltComposite", label: (v) => `Min score ${v}`, get: () => $("#fltComposite").value, clear: () => { $("#fltComposite").value = ""; } },
  { id: "fltAtr", label: (v) => `Max ATR ${v}%`, get: () => $("#fltAtr").value, clear: () => { $("#fltAtr").value = ""; } },
  { id: "fltCapClass", label: (v) => `${v} cap`, get: () => $("#fltCapClass").value, clear: () => { $("#fltCapClass").value = ""; } },
  { id: "fltPnav", label: (v) => `Max P/NAV ${v}`, get: () => $("#fltPnav").value, clear: () => { $("#fltPnav").value = ""; } },
  { id: "fltDivYield", label: (v) => `Min DivY ${v}%`, get: () => $("#fltDivYield").value, clear: () => { $("#fltDivYield").value = ""; } },
  { id: "fltEpsTrend", label: (v) => `EPS trend: ${EPS_TREND_LABELS[v] || v}`, get: () => $("#fltEpsTrend").value, clear: () => { $("#fltEpsTrend").value = ""; } },
  { id: "fltLiq", label: (v) => `Min liq ${v}mn`, get: () => $("#fltLiq").value, clear: () => { $("#fltLiq").value = ""; } },
  { id: "fltNoFlags", label: () => "No risk flags", get: () => $("#fltNoFlags").checked, clear: () => { $("#fltNoFlags").checked = false; } },
  { id: "fltInstAccum", label: () => "Institutional accumulation", get: () => $("#fltInstAccum").checked, clear: () => { $("#fltInstAccum").checked = false; } },
  { id: "fltAlsoSpike", label: () => "Also in Spike", get: () => $("#fltAlsoSpike").checked, clear: () => { $("#fltAlsoSpike").checked = false; } },
  { id: "fltAlsoHp", label: () => "Also in High Profit", get: () => $("#fltAlsoHp").checked, clear: () => { $("#fltAlsoHp").checked = false; } },
  { id: "fltAlsoMgLower", label: () => "Also in Margin (lower)", get: () => $("#fltAlsoMgLower").checked, clear: () => { $("#fltAlsoMgLower").checked = false; } },
  { id: "fltAlsoMgHigher", label: () => "Also in Margin (higher)", get: () => $("#fltAlsoMgHigher").checked, clear: () => { $("#fltAlsoMgHigher").checked = false; } },
];
function renderFilterChips() {
  const active = FILTER_DEFS.filter((f) => {
    const v = f.get();
    return typeof v === "boolean" ? v : (v !== "" && v !== null && !(typeof v === "number" && isNaN(v)));
  });
  $("#filterChips").innerHTML = active.map((f) =>
    `<span class="chip filter-chip">${f.label(f.get())}<button data-id="${f.id}" title="Remove this filter">✕</button></span>`).join("");
  $("#filterChips").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    FILTER_DEFS.find((f) => f.id === b.dataset.id).clear();
    renderScreener();
  }));
}
$("#btnClearFilters").addEventListener("click", () => {
  FILTER_DEFS.forEach((f) => f.clear());
  renderScreener();
});

/* ---- CSV export (current filtered+sorted view, respecting visible columns) ---- */
function csvEscape(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
$("#btnExportCsv").addEventListener("click", () => {
  const rows = state.scrRows || [];
  const cols = state.scrCols || currentVisibleCols();
  const flatten = (r, key) => (key === "flags" ? (r.flags || []).join("; ") : r[key]);
  const lines = [["Code", ...cols.map((c) => c.label)].map(csvEscape).join(",")];
  for (const r of rows) lines.push([r.code, ...cols.map((c) => flatten(r, c.key))].map(csvEscape).join(","));
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `dse_screener_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

/* ---- filter presets: a few curated built-in screens + user-saved (localStorage) ---- */
const PRESET_FIELDS = ["scrSearch:#scrSearch", "fltSector:#fltSector", "fltCategory:#fltCategory",
  "fltVerdict:#fltVerdict", "fltRsi:#fltRsi", "fltLiq:#fltLiq", "fltComposite:#fltComposite",
  "scrEligible:#scrEligible:checked", "fltNoFlags:#fltNoFlags:checked",
  "fltCapClass:#fltCapClass", "fltPnav:#fltPnav", "fltAtr:#fltAtr", "fltInstAccum:#fltInstAccum:checked",
  "fltDivYield:#fltDivYield", "fltEpsTrend:#fltEpsTrend",
  "fltAlsoSpike:#fltAlsoSpike:checked", "fltAlsoHp:#fltAlsoHp:checked",
  "fltAlsoMgLower:#fltAlsoMgLower:checked", "fltAlsoMgHigher:#fltAlsoMgHigher:checked"];
const BUILTIN_PRESETS = {
  "★ Value picks": { scrEligible: true, fltPnav: "1" },
  "★ Momentum breakouts": { fltAlsoSpike: true, fltComposite: "60" },
  "★ Income": { scrEligible: true, fltDivYield: "3" },
  "★ Turnarounds": { fltEpsTrend: "turned-profitable" },
  "★ Institutional accumulation": { fltInstAccum: true, scrEligible: true },
};
function loadPresets() {
  try { return JSON.parse(localStorage.getItem("dse_screener_presets") || "{}"); }
  catch { return {}; }
}
function savePresets(p) { localStorage.setItem("dse_screener_presets", JSON.stringify(p)); }
function refreshPresetSelect() {
  const presets = loadPresets();
  const sel = $("#presetSelect");
  const cur = sel.value;
  const builtinOpts = Object.keys(BUILTIN_PRESETS).map((n) => `<option${n === cur ? " selected" : ""}>${n}</option>`).join("");
  const userOpts = Object.keys(presets).sort().map((n) => `<option${n === cur ? " selected" : ""}>${n}</option>`).join("");
  sel.innerHTML = `<option value="">Quick screens…</option>${builtinOpts}` +
    (Object.keys(presets).length ? `<optgroup label="Your saved filters">${userOpts}</optgroup>` : "");
}
function applyPreset(preset) {
  FILTER_DEFS.forEach((f) => f.clear()); // start clean so presets don't layer onto stale filters
  for (const spec of PRESET_FIELDS) {
    const [key, sel, prop] = spec.split(":");
    if (!(key in preset)) continue;
    if (prop === "checked") $(sel).checked = preset[key];
    else $(sel).value = preset[key];
  }
}
$("#presetSave").addEventListener("click", () => {
  const name = prompt("Save current filters as · নাম দিন");
  if (!name) return;
  if (BUILTIN_PRESETS[name]) { alert("That name is reserved for a built-in screen — pick another. · এই নামটি সংরক্ষিত, অন্য নাম দিন।"); return; }
  const presets = loadPresets();
  const st = {};
  for (const spec of PRESET_FIELDS) {
    const [key, sel, prop] = spec.split(":");
    st[key] = prop === "checked" ? $(sel).checked : $(sel).value;
  }
  presets[name] = st;
  savePresets(presets);
  refreshPresetSelect();
  $("#presetSelect").value = name;
});
$("#presetLoad").addEventListener("click", () => {
  const name = $("#presetSelect").value;
  const preset = BUILTIN_PRESETS[name] || loadPresets()[name];
  if (!name || !preset) return;
  applyPreset(preset);
  renderScreener();
});
$("#presetDelete").addEventListener("click", () => {
  const name = $("#presetSelect").value;
  if (!name) return;
  if (BUILTIN_PRESETS[name]) { alert("Built-in screens can't be deleted. · বিল্ট-ইন স্ক্রিন মোছা যাবে না।"); return; }
  if (!confirm(`Delete saved filter "${name}"? · এই সংরক্ষিত ফিল্টারটি মুছবেন?`)) return;
  const presets = loadPresets();
  delete presets[name];
  savePresets(presets);
  refreshPresetSelect();
});
refreshPresetSelect();

/* ---------------- charts tab ---------------- */
async function loadCharts() {
  $("#chartGrid").innerHTML = `<div class="loading">Loading…</div>`;
  const q = encodeURIComponent(state.chartsSearch || "");
  const res = await fetch(`/api/charts?page=${state.chartsPage}&per=100&sort=${state.chartsSort}&q=${q}`);
  state.chartsData = await res.json();
  renderCharts();
  loadChartsShortlist();
}

function sliceRange(dates, closes, range) {
  if (range === "2y" || !dates.length) return closes;
  const last = new Date(dates[dates.length - 1]);
  const cut = new Date(last); cut.setFullYear(cut.getFullYear() - 1);
  const cutS = cut.toISOString().slice(0, 10);
  const i = dates.findIndex((d) => d >= cutS);
  return closes.slice(Math.max(i, 0));
}

function chartCardHtml(it) {
  const delta = state.chartsRange === "2y" ? it.r_2y : it.r_1y;
  return `<div class="card" data-code="${it.code}">
      <div class="top">${starBtn(it.code)}${compareBtn(it.code)}<span class="t">${it.code}</span><span class="p"><span class="${ltpCls(it.price, it.ycp)}">${fmt(it.price)}</span> <small style="color:var(--muted)">Y ${fmt(it.ycp)}</small></span></div>
      <div class="delta">${state.chartsRange} ${pct(delta)} · <span class="term" data-term="score_short">S ${fmt(it.score_short, 0)}</span> · <span class="term" data-term="score_long">L ${fmt(it.score_long, 0)}</span></div>
      <canvas></canvas>
    </div>`;
}

function wireChartCards(grid, items) {
  wireStarButtons(grid);
  wireCompareButtons(grid);
  grid.querySelectorAll(".card").forEach((card, i) => {
    const it = items[i];
    const cv = card.querySelector("canvas");
    card.addEventListener("click", () => openDetail(it.code));
    if (state.chartsChartType === "candlestick" && it.copen && it.copen.length > 1) {
      drawMiniCandles(cv, it.copen, it.chigh, it.clow, it.cclose);
      cv.addEventListener("mousemove", (e) => {
        const rect = cv.getBoundingClientRect();
        const frac = (e.clientX - rect.left) / rect.width;
        const idx = Math.max(0, Math.min(it.cclose.length - 1, Math.round(frac * (it.cclose.length - 1))));
        showTooltip(
          `<div class="tt-d">${it.cdates[idx] || ""}</div>` +
          `O ${fmt(it.copen[idx], 2)} H ${fmt(it.chigh[idx], 2)}<br>L ${fmt(it.clow[idx], 2)} C ${fmt(it.cclose[idx], 2)}`,
          e.clientX, e.clientY);
      });
    } else {
      const values = sliceRange(it.dates, it.closes, state.chartsRange);
      drawSparkline(cv, values);
      cv.addEventListener("mousemove", (e) => {
        const rect = cv.getBoundingClientRect();
        const frac = (e.clientX - rect.left) / rect.width;
        const dates2 = it.dates.slice(it.dates.length - values.length);
        const idx = Math.max(0, Math.min(values.length - 1, Math.round(frac * (values.length - 1))));
        showTooltip(`<div class="tt-d">${dates2[idx] || ""}</div><b>${fmt(values[idx], 2)}</b>`, e.clientX, e.clientY);
      });
    }
    cv.addEventListener("mouseleave", hideTooltip);
  });
}

function renderCharts() {
  const d = state.chartsData;
  const first = (d.page - 1) * d.per + 1;
  const lastN = Math.min(d.page * d.per, d.total);
  $("#pageInfo").textContent = `Page ${d.page} of ${d.pages} — ${first}–${lastN} of ${d.total}`;
  $("#btnPrev").disabled = d.page <= 1;
  $("#btnNext").disabled = d.page >= d.pages;
  const grid = $("#chartGrid");
  grid.innerHTML = d.items.map(chartCardHtml).join("");
  wireChartCards(grid, d.items);
}

async function loadChartsShortlist() {
  const codes = [...state.shortlist];
  const panel = $("#chartsShortlistPanel");
  if (!codes.length) { panel.classList.add("hidden"); return; }
  const res = await fetch(`/api/charts?codes=${encodeURIComponent(codes.join(","))}`);
  const d = await res.json();
  $("#chartsShortlistCount").textContent = `(${d.items.length})`;
  const grid = $("#chartsShortlistGrid");
  grid.innerHTML = d.items.map(chartCardHtml).join("");
  panel.classList.remove("hidden"); // unhide BEFORE drawing — canvases need real dimensions
  wireChartCards(grid, d.items);
}

$("#btnPrev").addEventListener("click", () => { state.chartsPage--; loadCharts(); });
$("#btnNext").addEventListener("click", () => { state.chartsPage++; loadCharts(); });
$("#rangeSeg").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
  $("#rangeSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
  state.chartsRange = b.dataset.range;
  renderCharts();
}));
$("#sortSeg").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
  $("#sortSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
  state.chartsSort = b.dataset.sort;
  state.chartsPage = 1;
  loadCharts();
}));
$("#chartTypeSeg").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
  $("#chartTypeSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
  state.chartsChartType = b.dataset.ctype;
  const isCandle = state.chartsChartType === "candlestick";
  $("#candleNote").classList.toggle("hidden", !isCandle);
  $("#rangeSeg").querySelectorAll("button").forEach((x) => { x.disabled = isCandle; });
  renderCharts();
  if (state.shortlist.size) loadChartsShortlist();
}));

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

$("#chartSearch").addEventListener("input", debounce(() => {
  state.chartsSearch = $("#chartSearch").value;
  state.chartsPage = 1;
  loadCharts();
}, 300));

/* ---------------- potential future charts ---------------- */
/* Past year ≈ 250 sessions, projection ≈ 125 (6 months) — x-axis is
   TIME-proportional, so the "today" divider sits ~2/3 across and the future
   isn't visually stretched. */
const PAST_SESSIONS = 250, FUT_SESSIONS = 125;
const PAST_FRAC = PAST_SESSIONS / (PAST_SESSIONS + FUT_SESSIONS);

function drawPotential(canvas, past, fut) {
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const all = past.concat(fut);
  if (all.length < 3) return;
  const lo = Math.min(...all), hi = Math.max(...all);
  const pad = 3, span = hi - lo || 1;
  const plotW = w - 2 * pad;
  const xd = pad + PAST_FRAC * plotW; // "today" divider
  const xPast = (i) => pad + (i / Math.max(past.length - 1, 1)) * (xd - pad);
  const xFut = (i) => xd + ((i + 1) / fut.length) * (w - pad - xd);
  const y = (v) => h - pad - ((v - lo) / span) * (h - 2 * pad);

  // past year — blue
  ctx.beginPath();
  past.forEach((v, i) => (i ? ctx.lineTo(xPast(i), y(v)) : ctx.moveTo(xPast(i), y(v))));
  ctx.strokeStyle = css("--series-1");
  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  ctx.stroke();

  // projected 2 months — violet, continuous from the last real point
  ctx.beginPath();
  ctx.moveTo(xd, y(past[past.length - 1]));
  fut.forEach((v, i) => ctx.lineTo(xFut(i), y(v)));
  ctx.strokeStyle = css("--series-sma50");
  ctx.lineWidth = 1.8;
  ctx.stroke();

  // vertical "today" divider at the junction
  ctx.beginPath();
  ctx.setLineDash([3, 3]);
  ctx.moveTo(xd, 2);
  ctx.lineTo(xd, h - 2);
  ctx.strokeStyle = css("--muted");
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
}

async function loadPotential() {
  $("#potGrid").innerHTML = `<div class="loading">Loading…</div>`;
  const q = encodeURIComponent(state.potSearch || "");
  const res = await fetch(`/api/potential?page=${state.potPage}&per=100&sort=${state.potSort}&q=${q}`);
  state.potData = await res.json();
  renderPotential();
  loadPotentialShortlist();
}

function potCardHtml(it) {
  return `<div class="card" data-code="${it.code}">
      <div class="top">${starBtn(it.code)}${compareBtn(it.code)}<span class="t">${it.code}</span><span class="p"><span class="${ltpCls(it.price, it.ycp)}">${fmt(it.price)}</span> <small style="color:var(--muted)">Y ${fmt(it.ycp)}</small></span></div>
      <div class="delta">6m ${pct(it.proj_6m)} · <span class="term" data-term="score_short">S ${fmt(it.score_short, 0)}</span> · <span class="term" data-term="score_long">L ${fmt(it.score_long, 0)}</span></div>
      <div class="delta" data-term="returns">past 1w ${pct(it.r_1w)} · 1m ${pct(it.r_1m)} · 2m ${pct(it.r_2m)}</div>
      <div class="delta" data-term="pred_price">AI Pred 1w ${fmt(it.pred_1w_price, 1)} (${pct(it.pred_1w_pct)}) · 1m ${fmt(it.pred_1m_price, 1)} (${pct(it.pred_1m_pct)})</div>
      <canvas></canvas>
    </div>`;
}

function wirePotCards(grid, items) {
  wireStarButtons(grid);
  wireCompareButtons(grid);
  grid.querySelectorAll(".card").forEach((card, i) => {
    const it = items[i];
    drawPotential(card.querySelector("canvas"), it.past_closes, it.fut_closes);
    card.addEventListener("click", () => openDetail(it.code));
    const cv = card.querySelector("canvas");
    cv.addEventListener("mousemove", (e) => {
      const rect = cv.getBoundingClientRect();
      const frac = (e.clientX - rect.left) / rect.width;
      let dt, v, inPast;
      if (frac <= PAST_FRAC) {
        inPast = true;
        const idx = Math.max(0, Math.min(it.past_closes.length - 1,
          Math.round((frac / PAST_FRAC) * (it.past_closes.length - 1))));
        v = it.past_closes[idx];
        dt = it.past_dates[idx];
      } else {
        inPast = false;
        const idx = Math.max(0, Math.min(it.fut_closes.length - 1,
          Math.round(((frac - PAST_FRAC) / (1 - PAST_FRAC)) * it.fut_closes.length) - 1));
        v = it.fut_closes[idx];
        dt = it.fut_dates[idx];
      }
      showTooltip(`<div class="tt-d">${dt || ""} · ${inPast ? "actual" : "potential"}</div><b>${fmt(v, 2)}</b>`,
        e.clientX, e.clientY);
    });
    cv.addEventListener("mouseleave", hideTooltip);
  });
}

function renderPotential() {
  const d = state.potData;
  const first = (d.page - 1) * d.per + 1;
  const lastN = Math.min(d.page * d.per, d.total);
  $("#potPageInfo").textContent = `Page ${d.page} of ${d.pages} — ${first}–${lastN} of ${d.total}`;
  $("#potPrev").disabled = d.page <= 1;
  $("#potNext").disabled = d.page >= d.pages;
  const grid = $("#potGrid");
  grid.innerHTML = d.items.map(potCardHtml).join("");
  wirePotCards(grid, d.items);
}

async function loadPotentialShortlist() {
  const codes = [...state.shortlist];
  const panel = $("#potShortlistPanel");
  if (!codes.length) { panel.classList.add("hidden"); return; }
  const res = await fetch(`/api/potential?codes=${encodeURIComponent(codes.join(","))}`);
  const d = await res.json();
  $("#potShortlistCount").textContent = `(${d.items.length})`;
  const grid = $("#potShortlistGrid");
  grid.innerHTML = d.items.map(potCardHtml).join("");
  panel.classList.remove("hidden"); // unhide BEFORE drawing — canvases need real dimensions
  wirePotCards(grid, d.items);
}

$("#potPrev").addEventListener("click", () => { state.potPage--; loadPotential(); });
$("#potNext").addEventListener("click", () => { state.potPage++; loadPotential(); });
$("#potSortSeg").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
  $("#potSortSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
  state.potSort = b.dataset.sort;
  state.potPage = 1;
  loadPotential();
}));

$("#potSearch").addEventListener("input", debounce(() => {
  state.potSearch = $("#potSearch").value;
  state.potPage = 1;
  loadPotential();
}, 300));

/* ---------------- detail modal ---------------- */
async function openDetail(code) {
  const res = await fetch(`/api/history?ticker=${encodeURIComponent(code)}`);
  if (!res.ok) return;
  const d = await res.json();
  state.detail = d;
  const a = d.analysis, p = d.profile || {};
  $("#mCode").textContent = code;
  const on = state.shortlist.has(code);
  $("#mStar").dataset.code = code;
  $("#mStar").classList.toggle("on", on);
  $("#mStar").textContent = on ? "★" : "☆";
  $("#mStar").title = on ? "Remove from shortlist" : "Add to shortlist";
  $("#mStar").onclick = () => toggleShortlist(code);
  const onCompare = state.compareSet.has(code);
  $("#mCompare").dataset.code = code;
  $("#mCompare").classList.toggle("on", onCompare);
  $("#mCompare").title = onCompare ? "Remove from Compare" : "Add to Compare";
  $("#mCompare").onclick = () => toggleCompare(code);
  $("#mPrice").innerHTML = `<span class="${ltpCls(a.price, a.ycp)}">${fmt(a.price, 2)}</span> <small style="color:var(--muted);font-weight:400">YCP ${fmt(a.ycp, 2)}</small>`;
  $("#mDelta").innerHTML = `1w ${pct(a.r_1w)} · 1m ${pct(a.r_1m)} · 1y ${pct(a.r_1y)}`;
  $("#mSub").innerHTML = [
    p.sector || a.sector ? escAttr(p.sector || a.sector) : null,
    p.category ? `<b class="cat-${escAttr(p.category)}">Category ${escAttr(p.category)}</b>` : null,
    p.listing_year ? "Listed " + Math.round(p.listing_year) : null,
    p.instrument_type ? escAttr(p.instrument_type) : null,
  ].filter(Boolean).join(" · ");

  $("#mPlan").innerHTML = a.verdict ? `${verdictBadge(a.verdict)}
    ${a.buy_date ? `<span data-term="buy_date">Buy <b>${a.buy_date}</b></span>` : ""}
    <span data-term="horizon"><b>${a.horizon}</b> <small>(${a.horizon_bn || ""})</small></span>
    ${a.plan ? `<span class="plan-text">${a.plan}</span>` : ""}
    ${a.buy_note ? `<span class="plan-text">${a.buy_note}</span>` : ""}` : "";

  const stats = [
    ["Composite score", fmt(a.composite, 0) + "/100", "composite"],
    ["Quality", fmt(a.quality, 0) + "/100", "quality"],
    ["Target", a.target_price ? fmt(a.target_price, 1) + ` (+${fmt(a.target_pct, 0)}%)` : "–", "target"],
    ["Stop-loss", a.stop_price ? fmt(a.stop_price, 1) + ` (−${fmt(a.stop_pct, 0)}%)` : "–", "stop"],
    ["EPS (annual)", a.eps_annual ? fmt(a.eps_annual, 2) : "–", "eps"],
    ["EPS (last qtr)", fmt(a.eps, 2), "eps"], ["P/E", fmt(a.pe), "pe"],
    ["Dividend yield", a.dividend_yield ? a.dividend_yield + "%" : "–", "dividend_yield"],
    ["RSI 14", fmt(a.rsi14, 0), "rsi"], ["Volume ×30d", fmt(a.vol_ratio, 2), "vol_ratio"],
    ["Avg traded/day", fmt(a.avg_value_mn_30d) + " mn", "liquidity"],
    ["Rel. strength 1m", (a.rel_1m > 0 ? "+" : "") + fmt(a.rel_1m) + "%", "rel_1m"],
    ["52w position", fmt(a.pos_52w * 100, 0) + "%", "pos52"],
    ["Above support", fmt(a.dist_support) + "%", "support"],
    ["Below resistance", fmt(a.dist_resistance) + "%", "support"],
    ["Volatility (daily σ)", fmt(a.volatility, 2) + "%", "volatility"],
    ["ATR (14)", a.atr_pct !== null && a.atr_pct !== undefined ? fmt(a.atr_pct) + "%" : "–", "atr"],
    ["Risk/Reward", fmt(a.rr, 1), "rr"],
    ["Signal win rate", a.win_rate !== null && a.win_rate !== undefined
      ? `${a.win_rate}% <small>of ${a.signal_trades} signals, avg ${a.signal_avg > 0 ? "+" : ""}${a.signal_avg}%</small>` : "–", "win_rate"],
    ["Candle pattern", a.candle_pattern ? a.candle_pattern.replace("-", " ") : "– none today", "candle_pattern"],
    ["Gap today", a.gap_status ? `${fmt(a.gap_pct, 1)}% (${a.gap_status})` : (a.gap_pct ? fmt(a.gap_pct, 1) + "%" : "–"), "gap_analysis"],
    ["Close strength", a.close_strength !== null && a.close_strength !== undefined ? fmt(a.close_strength * 100, 0) + "%" : "–", "close_strength"],
    ["Key support", a.key_support ? `${fmt(a.key_support, 1)} <small>(${a.key_support_touches}× touched)</small>` : "–", "key_level"],
    ["Key resistance", a.key_resistance ? `${fmt(a.key_resistance, 1)} <small>(${a.key_resistance_touches}× touched)</small>` : "–", "key_level"],
    ["NAV per share", a.nav_per_share ? fmt(a.nav_per_share, 1) : "–", "nav_per_share"],
    ["P/NAV", a.p_nav !== null && a.p_nav !== undefined ? fmt(a.p_nav, 2) : "–", "p_nav"],
    ["Institutional/foreign trend", a.holding_trend_3m !== null && a.holding_trend_3m !== undefined
      ? `${a.holding_trend_3m > 0 ? "+" : ""}${fmt(a.holding_trend_3m, 1)}pp` : "– building up", "holding_trend"],
    ["Quarterly EPS momentum", a.eps_trend
      ? a.eps_trend.replace("-", " ") + (a.eps_qoq_growth ? ` (${a.eps_qoq_growth > 0 ? "+" : ""}${fmt(a.eps_qoq_growth, 0)}%)` : "")
      : "– building up", "eps_trend"],
    ["Beta", a.beta !== null && a.beta !== undefined
      ? `${fmt(a.beta, 2)} <small>(${a.beta >= 1.2 ? "aggressive" : a.beta <= 0.7 ? "defensive" : "market-like"})</small>` : "–", "beta"],
    ["Market cap", a.market_cap_mn ? `${bnTk(a.market_cap_mn * 1e6)} <small>(${a.cap_class})</small>` : "–", "cap_class"],
    ["Seasonality (this month)", a.season_this_month
      ? `${a.season_this_month.approx_monthly > 0 ? "+" : ""}${fmt(a.season_this_month.approx_monthly, 1)}% <small>(n=${a.season_this_month.n}, context only)</small>` : "– building up", "seasonality"],
    ["Sponsor holding", p.holding ? fmt(p.holding.sponsor, 1) + "%" : "–", null],
  ];
  $("#mStats").innerHTML = stats.map(([k, v, term]) =>
    `<div class="mstat" ${term ? `data-term="${term}"` : ""}><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
  $("#mScoreS").textContent = fmt(a.score_short, 0);
  $("#mScoreL").textContent = fmt(a.score_long, 0);
  $("#mReasonsS").innerHTML = (a.reasons_short.length ? a.reasons_short : ["No strong short-term signals"])
    .map((r) => `<li>${r}</li>`).join("") +
    (a.flags || []).map((f) => `<li class="neg">⚠ ${f}</li>`).join("");
  $("#mReasonsL").innerHTML = (a.reasons_long.length ? a.reasons_long : ["No strong long-term signals"])
    .map((r) => `<li>${r}</li>`).join("");

  $("#mRecordDate").innerHTML = a.upcoming_record_date
    ? `<div class="mplan" data-term="record_date"><b>Record date ${a.upcoming_record_date}</b>
        (${a.days_to_record_date} days away)${a.upcoming_dividend_pct ? ` — ${a.upcoming_dividend_pct.toFixed(0)}% dividend` : ""}
        <span class="plan-text">Buy before this date to qualify for the dividend.</span></div>`
    : "";
  const news = a.recent_news || [];
  $("#mNews").innerHTML = news.length
    ? news.map((n) => `<div class="news-row"><span class="chip news-cat term" data-term="news:${n.category}">${n.category}</span>
        <span class="news-date">${n.date}</span> <span class="news-title">${n.title}</span></div>`).join("")
    : `<div class="axis-note">No recent announcements in the last 30 days.</div>`;

  updateCalc();
  $("#modalBg").classList.remove("hidden");
  resetChartZoom("all"); // fresh share opens showing the full history by default
  requestAnimationFrame(drawDetailCharts);
}

/* position-size calculator: the 2% rule */
function updateCalc() {
  const a = state.detail && state.detail.analysis;
  const out = $("#calcOut");
  if (!a || !a.stop_price) { out.textContent = ""; return; }
  const amount = parseFloat($("#calcAmount").value) || 0;
  const riskPct = parseFloat($("#calcRisk").value) || 2;
  const perShareRisk = a.price - a.stop_price;
  if (!amount || perShareRisk <= 0) { out.textContent = ""; return; }
  const qty = Math.max(0, Math.min(
    Math.floor((amount * riskPct / 100) / perShareRisk),
    Math.floor(amount / a.price)));
  if (!qty) { out.textContent = "Capital too small for this share at this risk level"; return; }
  const nf = (v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  out.innerHTML = `→ buy <b>${qty}</b> shares (≈ ৳${nf(qty * a.price)}); if the stop-loss hits you lose ` +
    `≈ ৳${nf(qty * perShareRisk)} = ${riskPct}% of capital · <b>${qty}</b>টি কিনুন, স্টপ-লসে সর্বোচ্চ ক্ষতি ৳${nf(qty * perShareRisk)}`;
}
$("#calcAmount").addEventListener("input", updateCalc);
$("#calcRisk").addEventListener("change", updateCalc);

/* ---------------- detail-chart zoom (preset buttons + wheel + drag-pan) ---------------- */
const ZOOM_PRESET_SESSIONS = { "1m": 21, "3m": 63, "6m": 126, "1y": 250, all: Infinity };
const ZOOM_PAD_L = 46, ZOOM_PAD_R = 10; // must match drawPriceAxes/drawLineChart's own padding

function resetChartZoom(preset) {
  state.chartZoomPreset = preset;
  $("#chartZoomSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.zoom === preset));
  const d = state.detail;
  const n = d ? d.dates.length : 0;
  const span = Math.max(1, Math.min(ZOOM_PRESET_SESSIONS[preset] || n, n) - 1);
  state.chartZoom = { start: Math.max(0, n - 1 - span), end: Math.max(0, n - 1) };
}

function sliceWin(arr) {
  if (!arr || !state.chartZoom) return arr;
  return arr.slice(state.chartZoom.start, state.chartZoom.end + 1);
}

function drawDetailCharts() {
  const d = state.detail;
  if (!d) return;
  if (!state.chartZoom) resetChartZoom(state.chartZoomPreset || "all");
  const dates = sliceWin(d.dates), closes = sliceWin(d.closes);
  const sma20 = sliceWin(d.sma20), sma50 = sliceWin(d.sma50);
  const volumes = sliceWin(d.volumes), rsi = sliceWin(d.rsi);
  const opens = sliceWin(d.opens), highs = sliceWin(d.highs), lows = sliceWin(d.lows);

  const chartType = state.priceChartType || "line";
  const smaOverlay = [
    { values: sma20, color: css("--series-sma20"), width: 1.5 },
    { values: sma50, color: css("--series-sma50"), width: 1.5 },
  ];
  let geo;
  if (chartType === "candlestick" && opens) {
    geo = drawCandlestick($("#dPrice"), dates, opens, highs, lows, closes);
    drawOverlayLines($("#dPrice"), geo, smaOverlay);
  } else if (chartType === "ohlc" && opens) {
    geo = drawOhlcBars($("#dPrice"), dates, opens, highs, lows, closes);
    drawOverlayLines($("#dPrice"), geo, smaOverlay);
  } else {
    geo = drawLineChart($("#dPrice"), dates, [
      { values: closes, color: css("--series-1"), width: 2 },
      ...smaOverlay,
    ]);
  }
  drawBars($("#dVol"), dates, volumes, css("--muted"));
  drawLineChart($("#dRsi"), dates, [
    { values: rsi, color: css("--series-1"), width: 1.5 },
  ], { min: 0, max: 100, ticks: 2, guides: [30, 70] });

  const cv = $("#dPrice");
  cv.onmousemove = (e) => {
    if (state.chartDragging || !geo) return;
    const rect = cv.getBoundingClientRect();
    const fx = e.clientX - rect.left;
    const frac = (fx - geo.padL) / (geo.w - geo.padL - geo.padR);
    const idx = Math.max(0, Math.min(dates.length - 1, Math.round(frac * (dates.length - 1))));
    const ohlcLine = opens
      ? `O ${fmt(opens[idx], 2)} · H ${fmt(highs[idx], 2)} · L ${fmt(lows[idx], 2)}<br>`
      : "";
    showTooltip(
      `<div class="tt-d">${dates[idx]}</div>` +
      ohlcLine +
      `Close <b>${fmt(closes[idx], 2)}</b><br>` +
      `SMA20 ${fmt(sma20[idx], 2)} · SMA50 ${fmt(sma50[idx], 2)}<br>` +
      `Vol ${Number(volumes[idx]).toLocaleString()}`,
      e.clientX, e.clientY);
  };
  cv.onmouseleave = () => { if (!state.chartDragging) hideTooltip(); };
}

$("#priceChartTypeSeg").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
  $("#priceChartTypeSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
  state.priceChartType = b.dataset.type;
  drawDetailCharts();
}));

$("#chartZoomSeg").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
  resetChartZoom(b.dataset.zoom);
  drawDetailCharts();
}));

const dPriceCanvas = $("#dPrice");
dPriceCanvas.addEventListener("wheel", (e) => {
  const d = state.detail;
  if (!d || !state.chartZoom) return;
  e.preventDefault();
  const rect = dPriceCanvas.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left - ZOOM_PAD_L) / (rect.width - ZOOM_PAD_L - ZOOM_PAD_R)));
  const { start, end } = state.chartZoom;
  const span = end - start;
  const pivot = start + frac * span;
  const factor = e.deltaY < 0 ? 0.85 : 1 / 0.85; // scroll up = zoom in (shrink window)
  const maxEnd = d.dates.length - 1;
  const newSpan = Math.max(9, Math.min(maxEnd, Math.round(span * factor)));
  let newStart = Math.round(pivot - frac * newSpan);
  let newEnd = newStart + newSpan;
  if (newStart < 0) { newEnd -= newStart; newStart = 0; }
  if (newEnd > maxEnd) { newStart -= (newEnd - maxEnd); newEnd = maxEnd; }
  state.chartZoom = { start: Math.max(0, newStart), end: Math.min(maxEnd, newEnd) };
  state.chartZoomPreset = null;
  $("#chartZoomSeg").querySelectorAll("button").forEach((b) => b.classList.remove("active"));
  drawDetailCharts();
}, { passive: false });

let dragStartX = null, dragStartWindow = null;
dPriceCanvas.addEventListener("mousedown", (e) => {
  if (!state.detail || !state.chartZoom) return;
  state.chartDragging = true;
  dragStartX = e.clientX;
  dragStartWindow = { ...state.chartZoom };
  hideTooltip();
});
window.addEventListener("mousemove", (e) => {
  if (!state.chartDragging) return;
  const d = state.detail;
  if (!d) return;
  const rect = dPriceCanvas.getBoundingClientRect();
  const plotW = rect.width - ZOOM_PAD_L - ZOOM_PAD_R;
  const span = dragStartWindow.end - dragStartWindow.start;
  const dxFrac = (e.clientX - dragStartX) / Math.max(plotW, 1);
  const idxShift = Math.round(-dxFrac * span); // drag right -> reveal earlier dates
  const maxEnd = d.dates.length - 1;
  let newStart = dragStartWindow.start + idxShift;
  let newEnd = dragStartWindow.end + idxShift;
  if (newStart < 0) { newEnd -= newStart; newStart = 0; }
  if (newEnd > maxEnd) { newStart -= (newEnd - maxEnd); newEnd = maxEnd; }
  state.chartZoom = { start: Math.max(0, newStart), end: Math.min(maxEnd, newEnd) };
  drawDetailCharts();
});
window.addEventListener("mouseup", () => {
  if (!state.chartDragging) return;
  state.chartDragging = false;
});

$("#mClose").addEventListener("click", () => { $("#modalBg").classList.add("hidden"); hideTooltip(); });
$("#modalBg").addEventListener("click", (e) => {
  if (e.target === $("#modalBg")) { $("#modalBg").classList.add("hidden"); hideTooltip(); }
});
window.addEventListener("resize", () => {
  if (!$("#modalBg").classList.contains("hidden")) drawDetailCharts();
});

/* ---------------- fetch data (network) / update data (render from disk) ---------------- */
// #updateStatus is CSS-truncated (single line, ellipsis) so a long message can
// never force the header buttons to wrap onto a new line; the full text still
// reaches the user via the native title tooltip on hover.
function setUpdateStatus(msg) {
  $("#updateStatus").textContent = msg;
  $("#updateStatus").title = msg;
}

// only one fetch job can run at a time (server-enforced) — all fetch-family
// buttons disable together so a second click can't collide with the first
const FETCH_BUTTON_IDS = ["#btnFetch", "#btnFetchShortlist", "#btnFetchPortfolio", "#btnFetchCompare"];
function setFetchButtonsDisabled(v) {
  FETCH_BUTTON_IDS.forEach((id) => { $(id).disabled = v; });
}

async function startFetch(codes) {
  const r = await (await fetch("/api/update", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(codes ? { codes } : {}),
  })).json();
  if (r.started) pollFetch();
  else setUpdateStatus("A fetch is already running — wait for it to finish.");
}

$("#btnFetch").addEventListener("click", () => startFetch(null));

$("#btnFetchShortlist").addEventListener("click", () => {
  const codes = [...state.shortlist];
  if (!codes.length) { setUpdateStatus("Shortlist is empty — star a share first."); return; }
  startFetch(codes);
});
$("#btnFetchCompare").addEventListener("click", () => {
  const codes = [...state.compareSet];
  if (!codes.length) { setUpdateStatus("Compare list is empty — add a share first."); return; }
  startFetch(codes);
});
$("#btnFetchPortfolio").addEventListener("click", async () => {
  if (!state.portfolio) await loadPortfolio();
  const codes = [...new Set((state.portfolio?.holdings || []).map((h) => h.code))];
  if (!codes.length) { setUpdateStatus("Portfolio is empty — add a holding first."); return; }
  startFetch(codes);
});

async function pollFetch() {
  setFetchButtonsDisabled(true);
  $("#updBarWrap").classList.remove("hidden");
  const timer = setInterval(async () => {
    const st = await (await fetch("/api/update/status")).json();
    setUpdateStatus(st.message);
    $("#updBar").style.width = (st.pct || 0) + "%";
    if (!st.running) {
      clearInterval(timer);
      setFetchButtonsDisabled(false);
      setTimeout(() => $("#updBarWrap").classList.add("hidden"), 1500);
      // Fetch Data only pulls fresh files from DSE and saves them to disk —
      // it never touches what's on screen. Click Update Data to render it.
    }
  }, 1200);
}

$("#btnRender").addEventListener("click", () => renderFromStorage());

async function renderFromStorage() {
  $("#btnRender").disabled = true;
  setUpdateStatus("Rendering from saved data…");
  // tell the server to reload the local files (written by Fetch Data) into the
  // caches it serves — otherwise /api/summary keeps returning the old in-memory copy
  await fetch("/api/reload", { method: "POST" });
  state.chartsData = null;
  state.potData = null;
  state.agmData = null;
  await loadSummary();
  if (!$("#tab-charts").classList.contains("hidden")) loadCharts();
  if (!$("#tab-potential").classList.contains("hidden")) loadPotential();
  if (!$("#tab-agm").classList.contains("hidden")) loadAgm();
  if (!$("#tab-portfolio").classList.contains("hidden")) loadPortfolio();
  $("#btnRender").disabled = false;
  setUpdateStatus(`Rendered from saved data · ${new Date().toLocaleTimeString()}`);
  setTimeout(() => setUpdateStatus(""), 3000);
}

/* ---------------- theme toggle (Auto / Light / Dark, persisted) ---------------- */
const THEME_CYCLE = ["auto", "light", "dark"];
const THEME_LABEL = { auto: "Theme: Auto", light: "Theme: Light", dark: "Theme: Dark" };
function applyTheme(pref) {
  if (pref === "light" || pref === "dark") document.documentElement.dataset.theme = pref;
  else delete document.documentElement.dataset.theme;
  localStorage.setItem("dse_theme", pref);
  $("#btnTheme").textContent = THEME_LABEL[pref] || THEME_LABEL.auto;
}
$("#btnTheme").addEventListener("click", () => {
  const cur = localStorage.getItem("dse_theme") || "auto";
  applyTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(cur) + 1) % THEME_CYCLE.length]);
});
applyTheme(localStorage.getItem("dse_theme") || "auto");

/* ---------------- first-visit orientation hint ---------------- */
if (!localStorage.getItem("dse_onboarded")) {
  $("#onboardHint").classList.remove("hidden");
}
$("#onboardDismiss").addEventListener("click", () => {
  localStorage.setItem("dse_onboarded", "1");
  $("#onboardHint").classList.add("hidden");
});

/* ---------------- init ---------------- */
loadSummary().then(() => {
  const tab = location.hash.replace("#", "");
  if (ALL_TABS.includes(tab)) {
    activateTab(tab);
  } else if (tab.startsWith("t:")) {
    openDetail(decodeURIComponent(tab.slice(2)));
  } else if (tab === "help") {
    $("#btnHelp").click();
  }
});
