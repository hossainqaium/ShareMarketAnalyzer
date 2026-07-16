/* DSE Market Analyzer frontend — vanilla JS + canvas, no dependencies. */
"use strict";

const $ = (s) => document.querySelector(s);
const state = {
  summary: null,
  chartsPage: 1, chartsSort: "alpha", chartsRange: "2y", chartsSearch: "", chartsData: null,
  potPage: 1, potSort: "alpha", potSearch: "", potData: null,
  scrSortKey: "score_short", scrSortDir: -1, scrRows: null,
  mgView: "lower", mgSearch: "", mgRange: "3m",
  spSearch: "",
  portfolio: null,
  detail: null, // cached /api/history payload for the open modal
  shortlist: loadShortlistSet(),
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

/* ---------------- glossary (English + বাংলা) ---------------- */
const GLOSSARY = {
  composite: { t: "Composite score", en: "Overall 0–100 score blending short-term (35%), long-term (40%) and quality (25%) signals. Higher is better.", bn: "সামগ্রিক স্কোর (০–১০০): স্বল্পমেয়াদি, দীর্ঘমেয়াদি ও মান-সংকেতের সমন্বয়। যত বেশি, তত ভালো।" },
  verdict: { t: "Verdict", en: "Overall call. Strong Buy = high-conviction setup; Buy = good setup; Watch = wait for confirmation; Avoid = fails safety checks.", bn: "চূড়ান্ত মতামত: Strong Buy = জোরালো কেনার সংকেত, Buy = কেনা যায়, Watch = নজরে রাখুন, Avoid = এড়িয়ে চলুন।" },
  horizon: { t: "Holding period", en: "How long to hold the share to realise the expected gain, chosen from whichever score (short vs long) is stronger.", bn: "শেয়ারটি কত দিন ধরে রাখার পরামর্শ — স্বল্প না দীর্ঘমেয়াদি স্কোর শক্তিশালী তার ভিত্তিতে।" },
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
  returns: { t: "Return %", en: "Percentage price change over the period (1w = 1 week, 1m = 1 month...).", bn: "নির্দিষ্ট সময়ে দামের শতকরা পরিবর্তন (1w = ১ সপ্তাহ, 1m = ১ মাস...)।" },
  eligible: { t: "Eligible", en: "Passes safety checks for pick lists: liquid, equity (not fund/bond), not category Z, fresh data.", bn: "সুপারিশ তালিকার শর্ত পূরণ করেছে: পর্যাপ্ত লেনদেন, ইকুইটি শেয়ার, Z ক্যাটাগরি নয়, হালনাগাদ তথ্য।" },
  flags: { t: "Risk flags", en: "Warnings that need attention before buying — hover each red chip for its meaning.", bn: "ঝুঁকি-চিহ্ন — কেনার আগে খেয়াল করুন; প্রতিটি লাল চিপে মাউস রাখলে অর্থ দেখা যাবে।" },
  sector: { t: "Sector", en: "Industry group. Diversifying across sectors reduces risk.", bn: "খাত — বিভিন্ন খাতে ভাগ করে বিনিয়োগ করলে ঝুঁকি কমে।" },
  update: { t: "Update Data", en: "Fetches only the newest missing dates from DSE, then re-runs all analysis. Takes under a minute.", bn: "শুধু নতুন দিনের তথ্য DSE থেকে আনে ও বিশ্লেষণ নতুন করে চালায়। এক মিনিটের কম লাগে।" },
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
  buy_date: { t: "Suggested buy date", en: "When to enter: next trading session for a fresh setup; 2–3 sessions later if the share is overheated (wait for a dip); and never later than 2 sessions before a record date worth capturing (DSE settles trades in T+2 days). DSE trades Sunday–Thursday.", bn: "কবে কিনবেন: নতুন সেটআপ হলে পরের কার্যদিবসে; অতিরিক্ত বেড়ে থাকলে ২–৩ দিন পরে (দাম একটু কমার অপেক্ষায়); আর লভ্যাংশ পেতে চাইলে রেকর্ড ডেটের অন্তত ২ কার্যদিবস আগে (DSE-তে লেনদেন নিষ্পত্তিতে ২ দিন লাগে)। DSE রবি–বৃহস্পতিবার খোলা থাকে।" },
  "flag:trading-halt": { t: "trading-halt", en: "DSE has halted trading in this share — you cannot buy or sell it right now. Wait for resumption news.", bn: "এই শেয়ারের লেনদেন DSE বন্ধ করে দিয়েছে — এখন কেনা-বেচা করা যাবে না। পুনরায় চালুর খবরের অপেক্ষা করুন।" },
  "flag:audit-concern": { t: "audit-concern", en: "The auditor issued a Qualified Opinion, Emphasis of Matter, or going-concern warning in the latest financials — a serious red flag on the company's accounts. Avoid until resolved.", bn: "সাম্প্রতিক আর্থিক বিবরণীতে অডিটর Qualified Opinion বা Going Concern নিয়ে সতর্ক করেছেন — কোম্পানির হিসাবে গুরুতর ঝুঁকির সংকেত। সমাধান না হওয়া পর্যন্ত এড়িয়ে চলুন।" },
  "flag:exchange-query": { t: "exchange-query", en: "DSE sent this company a formal query, usually about an abnormal price movement. Read the response before trusting the current price move.", bn: "DSE এই কোম্পানিকে আনুষ্ঠানিক প্রশ্ন পাঠিয়েছে, সাধারণত অস্বাভাবিক দাম ওঠানামা নিয়ে। বর্তমান দামের গতিবিধি বিশ্বাস করার আগে জবাব পড়ুন।" },
  "flag:category-change-news": { t: "category-change-news", en: "This company's DSE category (A/B/N/Z) recently changed — check which direction, as it affects dividend eligibility and risk perception.", bn: "কোম্পানির DSE ক্যাটাগরি (A/B/N/Z) সম্প্রতি পরিবর্তিত হয়েছে — কোন দিকে পরিবর্তন হয়েছে দেখে নিন, এটি লভ্যাংশ যোগ্যতা ও ঝুঁকিকে প্রভাবিত করে।" },
  "flag:top-of-range": { t: "top-of-range", en: "Trading in the top quarter of its 2-year range with a meaningful fall score — the Margin analysis sees this as a profit-taking zone, not an entry zone. Blocks a Strong Buy verdict.", bn: "২ বছরের সীমার উপরের ২৫%-এ আছে এবং পতনের স্কোর উল্লেখযোগ্য — Margin বিশ্লেষণ একে মুনাফা তোলার জায়গা মনে করে, ঢোকার নয়। Strong Buy রায় আটকে দেয়।" },
  "flag:spike-fade-risk": { t: "spike-fade-risk", en: "This share spiked today but the continuation score is low (thin volume / no news / weak trend) — the Spike analysis expects the jump to fade. Don't chase it.", bn: "শেয়ারটি আজ স্পাইক করেছে কিন্তু ধারাবাহিকতা-স্কোর কম (কম ভলিউম / খবর নেই / দুর্বল ট্রেন্ড) — Spike বিশ্লেষণ ধারণা করছে লাফটি মিলিয়ে যাবে। পেছনে ছুটবেন না।" },
  why_col: { t: "Why · কেন", en: "The detailed, data-backed reasons behind this row — trend, relative strength, volume, fundamentals, signal history, record dates, plus cross-checks against today's Spike list and the 2-year Margin extremes. Hover the text itself to read it in Bengali.", bn: "এই সারির পেছনের বিস্তারিত, তথ্যভিত্তিক কারণ — ট্রেন্ড, আপেক্ষিক শক্তি, ভলিউম, মৌলভিত্তি, সংকেতের ইতিহাস, রেকর্ড ডেট, এবং আজকের Spike ও Margin-এর সাথে মিলিয়ে দেখা। লেখাটির উপর মাউস রাখলে বাংলায় পড়া যাবে।" },
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
  shortlist: { t: "Shortlist", en: "Click the ☆ on any share to shortlist it — shortlisted shares are pinned in their own section at the top of the Charts, Potential Charts, and Screener tabs. Saved in this browser only (not shared across devices).", bn: "যেকোনো শেয়ারের ☆ চিহ্নে ক্লিক করলে তা শর্টলিস্টে যোগ হয় — শর্টলিস্ট করা শেয়ারগুলো Charts, Potential Charts ও Screener ট্যাবের উপরে আলাদা অংশে দেখা যাবে। শুধু এই ব্রাউজারে সংরক্ষিত হয় (অন্য ডিভাইসে নয়)।" },
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
  group_explore: { t: "Explore", en: "Tools for digging through the data yourself: Charts, Potential Charts, the full Screener table, and Sectors.", bn: "নিজে তথ্য ঘেঁটে দেখার সরঞ্জাম: Charts, Potential Charts, পূর্ণ Screener টেবিল, এবং Sectors।" },
  market_overview_toggle: { t: "Market overview & report card", en: "Click to expand: the official DSEX/DS30/DSES/DSMEX snapshot, turnover, breadth, and the report card grading past recommendations. Collapsed by default to keep the Top 20 and picks front and centre — this is supporting context, not something to check every visit.", bn: "ক্লিক করে বিস্তারিত দেখুন: অফিসিয়াল DSEX/DS30/DSES/DSMEX স্ন্যাপশট, টার্নওভার, ব্রেডথ, এবং অতীত সুপারিশের রিপোর্ট কার্ড। ডিফল্টে সংকুচিত থাকে যাতে Top 20 ও পিকস সামনে থাকে — এটি সহায়ক প্রেক্ষাপট, প্রতিবার দেখার প্রয়োজন নেই।" },
  more_filters: { t: "More filters", en: "Additional Screener filters grouped by theme: Technical (RSI, score, ATR), Fundamental (size, P/NAV, dividend yield, EPS trend), Risk & ownership (liquidity, flags, institutional accumulation), and cross-tab (also appears in Spike/High Profit/Margin).", bn: "থিম অনুযায়ী গোষ্ঠীবদ্ধ অতিরিক্ত Screener ফিল্টার: টেকনিক্যাল, মৌলভিত্তি, ঝুঁকি ও মালিকানা, এবং ক্রস-ট্যাব (অন্য ট্যাবেও আছে কিনা)।" },
  cross_tab_filter: { t: "Also appears in", en: "Filter to shares that also show up in one of the other analysis tabs right now — e.g. a share that's both eligible here AND currently in the Spike list has extra same-day momentum confirmation.", bn: "যেসব শেয়ার এই মুহূর্তে অন্য কোনো বিশ্লেষণ ট্যাবেও দেখা যাচ্ছে সেগুলো ফিল্টার করুন — যেমন এখানে যোগ্য এবং একই সাথে Spike তালিকায় থাকা শেয়ারের অতিরিক্ত একইদিনের নিশ্চয়তা আছে।" },
  columns_picker: { t: "Columns", en: "Choose which Screener columns are visible — Code is always shown so you can always identify a row. Your choice is remembered in this browser.", bn: "Screener-এ কোন কলামগুলো দেখা যাবে বেছে নিন — Code সবসময় দেখানো হয় যাতে সারি শনাক্ত করা যায়। আপনার পছন্দ এই ব্রাউজারে মনে রাখা হয়।" },
  clear_filters: { t: "Clear all filters", en: "Resets every Screener filter (search, dropdowns, checkboxes, and the More Filters section) back to its default — the full unfiltered list.", bn: "সব Screener ফিল্টার (সার্চ, ড্রপডাউন, চেকবক্স, More Filters) ডিফল্টে ফিরিয়ে দেয় — সম্পূর্ণ তালিকা দেখায়।" },
  spike_tab: { t: "Spike", en: "Shares that suddenly rose 3%+ today — vs yesterday's close (Δ vs yesterday) or vs the session open (Δ since open). Update Data during trading hours fetches live prices, so the comparison is 'right now vs the start of the day'. Each spike gets a continuation score; most unexplained spikes fade, so the score weighs volume, trend, headroom, catalysts and this share's own follow-through history.", bn: "আজ হঠাৎ ৩%+ বেড়ে যাওয়া শেয়ার — গতকালের ক্লোজ বা আজকের শুরুর দামের তুলনায়। লেনদেন চলাকালে Update Data চাপলে এই মুহূর্তের দামের সাথে দিনের শুরুর তুলনা হয়। প্রতিটি স্পাইকের ধারাবাহিকতা-স্কোর দেওয়া হয়; কারণহীন স্পাইক সাধারণত মিলিয়ে যায়, তাই ভলিউম, ট্রেন্ড, জায়গা, উপলক্ষ ও ইতিহাস মিলিয়ে স্কোর হয়।" },
  day_change: { t: "Δ vs yesterday", en: "Today's price change vs yesterday's closing price (YCP). The DSE daily circuit limit is ±10%, so 3%+ is a genuine jolt.", bn: "গতকালের ক্লোজিং দামের তুলনায় আজকের পরিবর্তন। DSE-র দৈনিক সীমা ±১০%, তাই ৩%+ মানে সত্যিকারের ঝাঁকুনি।" },
  intraday_change: { t: "Δ since open", en: "Price change from today's opening price to the latest price — during trading hours this is the move from the session start to right now (refresh with Update Data).", bn: "আজকের শুরুর দাম থেকে সর্বশেষ দামের পরিবর্তন — লেনদেন চলাকালে এটি দিনের শুরু থেকে এই মুহূর্ত পর্যন্ত ওঠানামা (Update Data চাপলে হালনাগাদ)।" },
  vol_today: { t: "Today's volume ratio", en: "Today's traded volume ÷ the 30-day average. A spike on 2×+ volume has real money behind it; a spike on thin volume is usually a trap.", bn: "আজকের লেনদেন ÷ ৩০ দিনের গড়। ২ গুণের বেশি ভলিউমে স্পাইক মানে সত্যিকারের টাকা ঢুকছে; কম ভলিউমের স্পাইক সাধারণত ফাঁদ।" },
  spike_score: { t: "Continuation score", en: "0–100 chance today's spike keeps rising: volume backing 25%, room to run (circuit distance, RSI, resistance headroom) 20%, trend backdrop 20%, real catalyst (dividend/results/board meeting/record date; exchange query counts against) 20%, this share's signal follow-through history 15%. 60+ = likely to continue; below 40 = likely to fade.", bn: "০–১০০: আজকের স্পাইক চলতে থাকার সম্ভাবনা — ভলিউম ২৫%, বাড়ার জায়গা ২০%, ট্রেন্ড ২০%, প্রকৃত উপলক্ষ ২০%, অতীতের ধারাবাহিকতা ১৫%। ৬০+ = চলার সম্ভাবনা; ৪০-এর নিচে = মিলিয়ে যাওয়ার সম্ভাবনা।" },
  margin_tab: { t: "Margin", en: "Shares trading at the extremes of their own price range over a period you pick (1 month – 2 years, default 3 months). Lower Margin = bottom 25% of that range (candidates to buy before a rise); Higher Margin = top 25% (candidates to sell / avoid before a fall). All six ranges are recomputed on every Update Data; switching the filter is instant.", bn: "আপনার বেছে নেওয়া সময়ের (১ মাস – ২ বছর, ডিফল্ট ৩ মাস) দামের সীমার প্রান্তে থাকা শেয়ার। Lower Margin = সীমার নিচের ২৫% (বাড়ার আগে কেনার প্রার্থী); Higher Margin = উপরের ২৫% (কমার আগে বেচা/এড়ানোর প্রার্থী)। প্রতি Update Data-তে ছয়টি সীমাই নতুন করে হিসাব হয়; ফিল্টার বদলানো তাৎক্ষণিক।" },
  lower_margin: { t: "Lower Margin", en: "All shares in the bottom quarter of the selected period's range, scored 0–100 for the chance the price starts rising: reversal evidence (MACD/RSI turning) 35%, OBV accumulation 20%, support holding 15%, fundamentals 15%, catalysts (record date, dividend/board-meeting news) 15%. The score uses the full 2-year evidence whichever range filter you pick. Trading halts and audit concerns crush the score — cheap is not the same as safe.", bn: "নির্বাচিত সময়ের সীমার নিচের ২৫%-এ থাকা সব শেয়ার, দাম বাড়া শুরুর সম্ভাবনায় ০–১০০ স্কোর: রিভার্সাল প্রমাণ ৩৫%, OBV সঞ্চয় ২০%, সাপোর্ট ধরে রাখা ১৫%, মৌলভিত্তি ১৫%, উপলক্ষ (রেকর্ড ডেট, লভ্যাংশ/বোর্ড মিটিং) ১৫%। যে ফিল্টারই বাছুন, স্কোর পূর্ণ ২ বছরের প্রমাণ ব্যবহার করে। লেনদেন বন্ধ বা অডিট উদ্বেগ থাকলে স্কোর প্রায় শূন্য — সস্তা মানেই নিরাপদ নয়।" },
  higher_margin: { t: "Higher Margin", en: "All shares in the top quarter of the selected period's range, scored 0–100 for the chance the price starts falling: over-extension (RSI, streaks, parabolic month) 35%, momentum fade 20%, OBV distribution 15%, weak valuation 15%, event risk (imminent ex-dividend drop, exchange query, audit concern) 15%. The score uses the full 2-year evidence whichever range filter you pick. Use it to book profit on holdings and to avoid chasing tops.", bn: "নির্বাচিত সময়ের সীমার উপরের ২৫%-এ থাকা সব শেয়ার, দাম কমা শুরুর সম্ভাবনায় ০–১০০ স্কোর: অতিরিক্ত বৃদ্ধি ৩৫%, গতি হ্রাস ২০%, OBV বিতরণ ১৫%, দুর্বল ভ্যালুয়েশন ১৫%, ঘটনা-ঝুঁকি (এক্স-ডিভিডেন্ড পতন, এক্সচেঞ্জ কোয়েরি) ১৫%। যে ফিল্টারই বাছুন, স্কোর পূর্ণ ২ বছরের প্রমাণ ব্যবহার করে। ধরে রাখা শেয়ারে মুনাফা তুলতে ও চূড়ায় না কিনতে ব্যবহার করুন।" },
  rise_score: { t: "Rise score", en: "0–100 chance this bottom-of-range share starts rising soon. 60+ = reversal underway with support; 40–60 = bottoming, watch; below 40 = no evidence yet, falling knife risk.", bn: "০–১০০: তলানিতে থাকা শেয়ারটির দাম শিগগির বাড়া শুরুর সম্ভাবনা। ৬০+ = রিভার্সাল চলছে; ৪০–৬০ = তলানি গড়ছে, নজরে রাখুন; ৪০-এর নিচে = এখনো প্রমাণ নেই, পড়ন্ত ছুরি ধরার ঝুঁকি।" },
  fall_score: { t: "Fall score", en: "0–100 chance this top-of-range share starts falling soon. 50+ = overheated with fade signs — take profit / don't chase; below 30 = strong trend that may simply continue.", bn: "০–১০০: চূড়ায় থাকা শেয়ারটির দাম শিগগির কমা শুরুর সম্ভাবনা। ৫০+ = অতিরিক্ত গরম, মুনাফা তুলুন / পিছে ছুটবেন না; ৩০-এর নিচে = শক্তিশালী প্রবণতা, চলতেও পারে।" },
  turn_date: { t: "Estimated turn date", en: "A calendar-aware estimate (DSE trades Sunday–Thursday) of when the move could begin: confirmed reversals = next session; MACD-approaching-zero = extrapolated at its current pace; record dates pull the date (run-ups start ~2 weeks before; ex-dividend drops come right after). An estimate to plan around, NOT a guarantee.", bn: "পরিবর্তন কবে শুরু হতে পারে তার আনুমানিক তারিখ (DSE রবি–বৃহস্পতিবার খোলা): নিশ্চিত রিভার্সাল = পরের সেশন; MACD শূন্যের দিকে এগোলে বর্তমান গতিতে হিসাব; রেকর্ড ডেটের ~২ সপ্তাহ আগে দাম বাড়া শুরু হয়, আর ঠিক পরে এক্স-ডিভিডেন্ড পতন আসে। পরিকল্পনার সহায়ক অনুমান, নিশ্চয়তা নয়।" },
  pos2y: { t: "Range position", en: "Where the price sits in the selected period's low→high range (pick 1-Month to 2-Year with the filter; default 3-Month): 0 = at the period low, 1 = at the period high. ≤ 0.25 lands in Lower Margin, ≥ 0.75 in Higher Margin.", bn: "নির্বাচিত সময়ের (ফিল্টারে ১ মাস – ২ বছর, ডিফল্ট ৩ মাস) সর্বনিম্ন→সর্বোচ্চ সীমায় দামের অবস্থান: ০ = সর্বনিম্নে, ১ = সর্বোচ্চে। ≤ ০.২৫ হলে Lower Margin, ≥ ০.৭৫ হলে Higher Margin।" },
  from_low: { t: "Above period low", en: "How far the price has already recovered above the selected period's low. Small = still at the very bottom of that range.", bn: "নির্বাচিত সময়ের সর্বনিম্ন থেকে দাম কতটা উঠেছে। কম মানে ওই সীমার একেবারে তলানিতে।" },
  from_high: { t: "Below period high", en: "How far the price sits below the selected period's high. Small = right at the top of that range.", bn: "নির্বাচিত সময়ের সর্বোচ্চ থেকে দাম কতটা নিচে। কম মানে ওই সীমার একেবারে চূড়ায়।" },
  potential: { t: "Potential future chart", en: "Left of the divider: the real past year. Right: a deterministic 6-month projection — momentum of the last 60/120/250 sessions, damped over time, plus last year's detrended seasonal shape at half strength. A statistical shape to support your decision, NOT a prediction; regenerated from the freshest history on every Update Data.", bn: "দাগের বাঁয়ে: গত ১ বছরের প্রকৃত দাম। ডানে: পরবর্তী ৬ মাসের গাণিতিক অভিক্ষেপ — সাম্প্রতিক গতি (ক্রমশ ক্ষীয়মাণ) ও গত বছরের ঋতুভিত্তিক আকৃতির অর্ধেক মিলিয়ে। সিদ্ধান্তে সহায়ক পরিসংখ্যানিক আকৃতি, ভবিষ্যদ্বাণী নয়; প্রতি Update Data-তে সর্বশেষ ইতিহাস থেকে নতুন করে তৈরি হয়।" },
};
const VERDICT_BN = { "Strong Buy": "জোরালো ক্রয়", "Buy": "ক্রয়", "Watch": "পর্যবেক্ষণ", "Neutral": "নিরপেক্ষ", "Avoid": "এড়িয়ে চলুন" };
const HORIZON_BN = { short: "১–২ সপ্তাহ", long: "১–২ মাস", swing: "২ সপ্তাহ – ২ মাস" };

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

/* help modal: full glossary */
$("#btnHelp").addEventListener("click", () => {
  $("#helpTable tbody").innerHTML = Object.values(GLOSSARY)
    .map((g) => `<tr><td class="lft"><b>${g.t}</b></td><td class="lft" style="white-space:normal">${g.en}</td><td class="lft" style="white-space:normal">${g.bn}</td></tr>`)
    .join("");
  $("#helpBg").classList.remove("hidden");
});
$("#helpClose").addEventListener("click", () => $("#helpBg").classList.add("hidden"));
$("#helpBg").addEventListener("click", (e) => {
  if (e.target === $("#helpBg")) $("#helpBg").classList.add("hidden");
});

/* ---------------- tabs (two-level: group -> sub-tab) ---------------- */
const TAB_GROUPS = {
  decide: ["suggestions", "highprofit", "spike", "margin"],
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
  document.querySelectorAll("nav.tabs[data-group-tabs]").forEach((nav) =>
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
}

function pickRow(code, m, scoreKey, reasonsKey, rank) {
  const score = m[scoreKey];
  const reasons = (m[reasonsKey] || []).slice(0, 3);
  const flags = (m.flags || []).filter((f) => f !== "near-52w-high" || scoreKey === "score_short");
  return `<div class="pick" data-code="${code}">
    <div class="rank">${rank}</div>
    <div class="code">${code}<small>${m.sector || ""}</small></div>
    <div class="price">${fmt(m.price, 1)}</div>
    <div class="rets">1w ${pct(m.r_1w)}<br>1m ${pct(m.r_1m)}</div>
    <div class="scorebar"><div class="bar"><div style="width:${score}%"></div></div>
      <div class="num">${fmt(score, 0)}/100</div></div>
    <div class="chips">${reasons.map((r) => `<span class="chip">${r}</span>`).join("")}
      ${flags.map((f) => `<span class="chip flag" data-term="flag:${f}">${f}</span>`).join("")}</div>
  </div>`;
}

function verdictBadge(v) {
  const cls = { "Strong Buy": "v-strong", "Buy": "v-buy", "Watch": "v-watch",
                "Neutral": "v-neutral", "Avoid": "v-avoid" }[v] || "v-neutral";
  return `<span class="verdict ${cls}" data-term="verdict">${v}<small>${VERDICT_BN[v] || ""}</small></span>`;
}

function renderTop10() {
  const t = state.summary.tickers;
  const codes = state.summary.top20 || state.summary.top10 || [];
  $("#top10Table tbody").innerHTML = codes.map((c, i) => {
    const m = t[c];
    const why = (m.why && m.why.length)
      ? m.why.slice(0, 4)
      : [...(m.reasons_long || []), ...(m.reasons_short || [])].slice(0, 2);
    const whyBn = (m.why_bn || []).slice(0, 4);
    const buyNote = m.buy_note || "";
    const buyShort = buyNote.includes("dividend") ? "before record date"
      : buyNote.startsWith("Overheated") ? "wait for a dip"
      : buyNote.startsWith("Wait") ? "after confirmation" : "next session";
    return `<tr data-code="${c}">
      <td>${i + 1}</td>
      <td class="lft"><b>${c}</b><br><small style="color:var(--muted)">${m.sector || ""}</small></td>
      <td>${fmt(m.price, 1)}</td>
      <td class="lft">${verdictBadge(m.verdict)}</td>
      <td><b>${fmt(m.composite, 0)}</b><small style="color:var(--muted)">/100</small></td>
      <td class="lft" data-term="buy_date"><b>${m.buy_date || "–"}</b><br><small style="color:var(--muted)">${buyShort}</small></td>
      <td class="lft" data-term="horizon">${m.horizon}<br><small style="color:var(--muted)">${HORIZON_BN[m.horizon_key] || ""}</small></td>
      <td class="pos" data-term="target">${fmt(m.target_price, 1)}<br><small>+${fmt(m.target_pct, 0)}%</small></td>
      <td class="neg" data-term="stop">${fmt(m.stop_price, 1)}<br><small>−${fmt(m.stop_pct, 0)}%</small></td>
      <td class="lft why-cell" style="max-width:380px"><small data-bn="${escAttr(whyBn.map((w) => "• " + w).join("<br>"))}">${why.map((w) => "• " + w).join("<br>")}</small></td>
    </tr>`;
  }).join("") || `<tr><td colspan="10" class="loading">No qualifying shares today</td></tr>`;
  $("#top10Table tbody").querySelectorAll("tr[data-code]").forEach((tr) =>
    tr.addEventListener("click", () => openDetail(tr.dataset.code)));
}

function renderSuggestions() {
  const t = state.summary.tickers;
  renderTop10();
  const eligible = Object.entries(t).filter(([, m]) => m.eligible);
  const topN = (key) => eligible.slice().sort((a, b) => b[1][key] - a[1][key]).slice(0, 15);
  $("#shortPicks").innerHTML = topN("score_short")
    .map(([c, m], i) => pickRow(c, m, "score_short", "reasons_short", i + 1)).join("") || "No data";
  $("#longPicks").innerHTML = topN("score_long")
    .map(([c, m], i) => pickRow(c, m, "score_long", "reasons_long", i + 1)).join("") || "No data";
  document.querySelectorAll(".pick").forEach((el) =>
    el.addEventListener("click", () => openDetail(el.dataset.code)));
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
      ${starBtn(p.code)}
      <b class="hp-code">${p.code}</b>
      <small class="hp-sec">${p.sector || ""}</small>
      <span class="hp-badge ${s.cls} term" data-term="hp:${p.strategy}">${s.label}<small>${s.bn}</small></span>
      <span class="hp-conf term" data-term="hp_conf">${"★".repeat(p.conf)}${"☆".repeat(3 - p.conf)}</span>
    </div>
    <div class="hp-nums">
      <div class="mstat"><div class="k">Price</div><div class="v">${fmt(p.price, 1)}</div></div>
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
  const cls = { bad: "v-avoid", warn: "v-watch", good: "v-strong", info: "v-buy" }[a.level] || "v-neutral";
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
    <td class="lft"><b>${h.code}</b><br><small style="color:var(--muted)">${h.sector || ""}</small></td>
    <td>${h.qty}</td>
    <td class="lft">${h.buy_date}</td>
    <td>${fmt(h.buy_price)}</td>
    <td><b>${fmt(h.price)}</b></td>
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
  </tr>`).join("") || `<tr><td colspan="13" class="loading">No holdings yet — add your first purchase above. · এখনো কিছু নেই — উপরে প্রথম কেনাটি যোগ করুন।</td></tr>`;

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

function renderReportCard() {
  const rc = state.summary.report_card;
  if (!rc) { $("#reportCardPanel").classList.add("hidden"); return; }
  $("#reportCardPanel").classList.remove("hidden");
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

/* ---------------- spike (sudden risers today) ---------------- */
function spikeLabelBadge(s) {
  const cls = s.score >= 60 ? "v-strong" : s.score >= 40 ? "v-watch" : "v-avoid";
  const bn = s.score >= 60 ? "চলতে পারে" : s.score >= 40 ? "নিশ্চিত হয়ে কিনুন" : "মিলিয়ে যেতে পারে";
  return `<span class="verdict ${cls}">${s.label}<small>${bn}</small></span>`;
}

function renderSpike() {
  const sp = state.summary.spike;
  if (!sp) return;
  const q = (state.spSearch || "").toUpperCase();
  let rows = sp.spikes || [];
  if (q) rows = rows.filter((s) => s.code.includes(q) || (s.sector || "").toUpperCase().includes(q));
  $("#spMeta").textContent = sp.date ? `session ${sp.date} · threshold +${sp.min_pct}%` : "";
  $("#spCount").textContent = `${rows.length} shares spiked ${sp.min_pct}%+ this session`;
  $("#spTable tbody").innerHTML = rows.map((s, i) => {
    const flags = (s.flags || [])
      .filter((f) => ["trading-halt", "audit-concern", "illiquid", "exchange-query", "category-Z"].includes(f))
      .map((f) => `<span class="chip flag" data-term="flag:${f}">${f}</span>`).join(" ");
    return `<tr data-code="${s.code}">
      <td>${i + 1}</td>
      <td>${starBtn(s.code)}</td>
      <td class="lft"><b>${s.code}</b></td>
      <td class="lft">${s.sector || "–"}</td>
      <td class="lft">${s.category || "–"}</td>
      <td>${fmt(s.price)}</td>
      <td>${pct(s.day_change)}</td>
      <td>${pct(s.intraday_change)}</td>
      <td><b>${fmt(s.vol_today_ratio, 1)}×</b></td>
      <td>${fmt(s.rsi14, 0)}</td>
      <td>${fmt(s.dist_resistance)}</td>
      <td><b class="${s.score >= 60 ? "pos" : ""}">${fmt(s.score, 0)}</b><small style="color:var(--muted)">/100</small></td>
      <td class="lft">${spikeLabelBadge(s)}</td>
      <td class="lft why-cell"><small data-bn="${escAttr((s.why_bn || []).map((w) => "• " + w).join("<br>"))}">${(s.why || []).join(" · ")}</small> ${flags}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="14" class="loading">No shares spiked ${sp.min_pct}%+ this session — check again after the next Update Data during trading hours.</td></tr>`;
  wireScreenerTable($("#spTable"));
}

$("#spSearch").addEventListener("input", debounce(() => {
  state.spSearch = $("#spSearch").value;
  renderSpike();
}, 250));

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
    <td class="lft"><b>${e.code}</b></td>
    <td class="lft">${e.sector || "–"}</td>
    <td class="lft">${e.category || "–"}</td>
    <td>${fmt(e.price)}</td>
    <td>${fmt(e.pos, 2)}</td>
    <td>${dist}</td>
    <td>${fmt(e.rsi14, 0)}</td>
    <td>${pct(e.r_1w)}</td><td>${pct(e.r_1m)}</td>
    ${mgScoreCell(e.score, dir)}
    <td class="lft"><b>${e.turn_date}</b><br><small style="color:var(--muted);white-space:normal">${e.turn_note}</small></td>
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
    const common = { ...e, price: t.price, sector: t.sector, category: t.category,
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
    `<tr><td colspan="14" class="loading">No shares in the lower margin of the ${label} range right now</td></tr>`;
  $("#mgHigherTable tbody").innerHTML =
    higher.map((e, i) => mgRowHtml(e, i, "higher")).join("") ||
    `<tr><td colspan="14" class="loading">No shares in the higher margin of the ${label} range right now</td></tr>`;
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
  { key: "price", label: "Price", cls: "", term: null, def: true, td: (r) => `<td>${fmt(r.price)}</td>` },
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

function renderScreener() {
  const cols = currentVisibleCols();
  const head = $("#scrTable thead tr");
  head.innerHTML = `<th>★</th><th class="lft" data-key="code">Code${state.scrSortKey === "code" ? (state.scrSortDir < 0 ? " ↓" : " ↑") : ""}</th>` +
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
    <td class="lft"><b>${r.code}</b></td>
    ${cols.map((c) => c.td(r)).join("")}
  </tr>`;
}

function wireScreenerTable(table) {
  wireStarButtons(table);
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
      <div class="top">${starBtn(it.code)}<span class="t">${it.code}</span><span class="p">${fmt(it.price)}</span></div>
      <div class="delta">${state.chartsRange} ${pct(delta)} · <span class="term" data-term="score_short">S ${fmt(it.score_short, 0)}</span> · <span class="term" data-term="score_long">L ${fmt(it.score_long, 0)}</span></div>
      <canvas></canvas>
    </div>`;
}

function wireChartCards(grid, items) {
  wireStarButtons(grid);
  grid.querySelectorAll(".card").forEach((card, i) => {
    const it = items[i];
    const values = sliceRange(it.dates, it.closes, state.chartsRange);
    drawSparkline(card.querySelector("canvas"), values);
    card.addEventListener("click", () => openDetail(it.code));
    const cv = card.querySelector("canvas");
    cv.addEventListener("mousemove", (e) => {
      const rect = cv.getBoundingClientRect();
      const frac = (e.clientX - rect.left) / rect.width;
      const dates2 = it.dates.slice(it.dates.length - values.length);
      const idx = Math.max(0, Math.min(values.length - 1, Math.round(frac * (values.length - 1))));
      showTooltip(`<div class="tt-d">${dates2[idx] || ""}</div><b>${fmt(values[idx], 2)}</b>`, e.clientX, e.clientY);
    });
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
      <div class="top">${starBtn(it.code)}<span class="t">${it.code}</span><span class="p">${fmt(it.price)}</span></div>
      <div class="delta">potential 6m ${pct(it.proj_6m)} · <span class="term" data-term="score_short">S ${fmt(it.score_short, 0)}</span> · <span class="term" data-term="score_long">L ${fmt(it.score_long, 0)}</span></div>
      <canvas></canvas>
    </div>`;
}

function wirePotCards(grid, items) {
  wireStarButtons(grid);
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
  $("#mPrice").textContent = fmt(a.price, 2);
  $("#mDelta").innerHTML = `1w ${pct(a.r_1w)} · 1m ${pct(a.r_1m)} · 1y ${pct(a.r_1y)}`;
  $("#mSub").textContent = [
    p.sector || a.sector, p.category ? "Category " + p.category : null,
    p.listing_year ? "Listed " + Math.round(p.listing_year) : null,
    p.instrument_type,
  ].filter(Boolean).join(" · ");

  $("#mPlan").innerHTML = a.verdict ? `${verdictBadge(a.verdict)}
    ${a.buy_date ? `<span data-term="buy_date">Buy <b>${a.buy_date}</b></span>` : ""}
    <span data-term="horizon"><b>${a.horizon}</b> <small>(${HORIZON_BN[a.horizon_key] || ""})</small></span>
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

function drawDetailCharts() {
  const d = state.detail;
  if (!d) return;
  const geo = drawLineChart($("#dPrice"), d.dates, [
    { values: d.closes, color: css("--series-1"), width: 2 },
    { values: d.sma20, color: css("--series-sma20"), width: 1.5 },
    { values: d.sma50, color: css("--series-sma50"), width: 1.5 },
  ]);
  drawBars($("#dVol"), d.dates, d.volumes, css("--muted"));
  drawLineChart($("#dRsi"), d.dates, [
    { values: d.rsi, color: css("--series-1"), width: 1.5 },
  ], { min: 0, max: 100, ticks: 2, guides: [30, 70] });

  const cv = $("#dPrice");
  cv.onmousemove = (e) => {
    if (!geo) return;
    const rect = cv.getBoundingClientRect();
    const fx = e.clientX - rect.left;
    const frac = (fx - geo.padL) / (geo.w - geo.padL - geo.padR);
    const idx = Math.max(0, Math.min(d.dates.length - 1, Math.round(frac * (d.dates.length - 1))));
    showTooltip(
      `<div class="tt-d">${d.dates[idx]}</div>` +
      `Close <b>${fmt(d.closes[idx], 2)}</b><br>` +
      `SMA20 ${fmt(d.sma20[idx], 2)} · SMA50 ${fmt(d.sma50[idx], 2)}<br>` +
      `Vol ${Number(d.volumes[idx]).toLocaleString()}`,
      e.clientX, e.clientY);
  };
  cv.onmouseleave = hideTooltip;
}

$("#mClose").addEventListener("click", () => { $("#modalBg").classList.add("hidden"); hideTooltip(); });
$("#modalBg").addEventListener("click", (e) => {
  if (e.target === $("#modalBg")) { $("#modalBg").classList.add("hidden"); hideTooltip(); }
});
window.addEventListener("resize", () => {
  if (!$("#modalBg").classList.contains("hidden")) drawDetailCharts();
});

/* ---------------- update data ---------------- */
$("#btnUpdate").addEventListener("click", async () => {
  const r = await (await fetch("/api/update", { method: "POST" })).json();
  if (r.started) pollUpdate();
});

async function pollUpdate() {
  $("#btnUpdate").disabled = true;
  $("#updBarWrap").classList.remove("hidden");
  const timer = setInterval(async () => {
    const st = await (await fetch("/api/update/status")).json();
    $("#updateStatus").textContent = st.message;
    $("#updBar").style.width = (st.pct || 0) + "%";
    if (!st.running) {
      clearInterval(timer);
      $("#btnUpdate").disabled = false;
      setTimeout(() => $("#updBarWrap").classList.add("hidden"), 1500);
      if (!st.error) {
        state.chartsData = null;
        await loadSummary();
        if (!$("#tab-charts").classList.contains("hidden")) loadCharts();
      }
    }
  }, 1200);
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
