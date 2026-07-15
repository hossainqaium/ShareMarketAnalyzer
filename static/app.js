/* DSE Market Analyzer frontend — vanilla JS + canvas, no dependencies. */
"use strict";

const $ = (s) => document.querySelector(s);
const state = {
  summary: null,
  chartsPage: 1, chartsSort: "alpha", chartsRange: "2y", chartsSearch: "", chartsData: null,
  potPage: 1, potSort: "alpha", potSearch: "", potData: null,
  scrSortKey: "score_short", scrSortDir: -1,
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
  eps: { t: "EPS", en: "Earnings per share. Positive and growing EPS = profitable, healthy company.", bn: "EPS — শেয়ারপ্রতি আয়। পজিটিভ ও বাড়ন্ত হলে কোম্পানি লাভজনক।" },
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

/* ---------------- tabs ---------------- */
document.querySelectorAll("nav.tabs button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll("nav.tabs button").forEach((x) => x.classList.toggle("active", x === b));
    ["suggestions", "highprofit", "charts", "screener", "sectors", "potential"].forEach((t) =>
      $("#tab-" + t).classList.toggle("hidden", t !== b.dataset.tab));
    // canvases drawn while their tab was hidden (display:none) end up blank —
    // e.g. a star toggled from another tab redraws the shortlist grid at 0×0.
    // Redraw from cached data (cheap) now that the section is visible again.
    if (b.dataset.tab === "charts") {
      if (!state.chartsData) loadCharts();
      else { renderCharts(); loadChartsShortlist(); }
    }
    if (b.dataset.tab === "potential") {
      if (!state.potData) loadPotential();
      else { renderPotential(); loadPotentialShortlist(); }
    }
  });
});

/* ---------------- summary / suggestions / screener ---------------- */
async function loadSummary() {
  const res = await fetch("/api/summary");
  state.summary = await res.json();
  renderOverview();
  renderSuggestions();
  renderHighProfit();
  renderMarket();
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
  if (v >= 1e11) return (v / 1e11).toFixed(2) + " লক্ষ কোটি"; // ~lakh crore
  if (v >= 1e7) return (v / 1e7).toFixed(1) + " কোটি";
  return Number(v).toLocaleString();
}

function renderMarket() {
  const mkt = state.summary.market;
  $("#marketPanel").classList.toggle("hidden", !mkt);
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
  const order = ["golden-cross", "macd-cross", "breakout-3m", "oversold-rebound", "volume-spike"];
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
    const why = [...(m.reasons_long || []), ...(m.reasons_short || [])].slice(0, 2);
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
      <td class="lft" style="white-space:normal;max-width:300px"><small>${why.join(" · ")}</small></td>
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

const SCR_COLS = [
  ["star", "★", "", null],
  ["code", "Code", "lft", null], ["sector", "Sector", "lft", "sector"], ["category", "Cat", "lft", "category"],
  ["flags", "Flags", "lft", "flags"],
  ["price", "Price", "", null],
  ["target_price", "Target", "", "target"], ["stop_price", "Stop", "", "stop"],
  ["r_1w", "1w%", "", "returns"], ["r_1m", "1m%", "", "returns"],
  ["r_3m", "3m%", "", "returns"], ["r_1y", "1y%", "", "returns"], ["rel_1m", "RelStr", "", "rel_1m"],
  ["rsi14", "RSI", "", "rsi"], ["vol_ratio", "Vol×", "", "vol_ratio"], ["pe", "P/E", "", "pe"],
  ["dividend_yield", "DivY%", "", "dividend_yield"], ["avg_value_mn_30d", "Liq mn", "", "liquidity"],
  ["pos_52w", "52w pos", "", "pos52"], ["dist_resistance", "Headroom%", "", "support"],
  ["score_short", "S-score", "", "score_short"], ["score_long", "L-score", "", "score_long"],
  ["composite", "Score", "", "composite"], ["verdict", "Verdict", "lft", "verdict"],
  ["rr", "R/R", "", "rr"], ["win_rate", "Win%", "", "win_rate"],
];

function populateSectorFilter() {
  const sectors = [...new Set(Object.values(state.summary.tickers)
    .map((m) => m.sector).filter(Boolean))].sort();
  const sel = $("#fltSector");
  const cur = sel.value;
  sel.innerHTML = `<option value="">All sectors</option>` +
    sectors.map((s) => `<option${s === cur ? " selected" : ""}>${s}</option>`).join("");
}

function renderScreener() {
  const head = $("#scrTable thead tr");
  head.innerHTML = SCR_COLS.map(([k, label, cls, term]) =>
    `<th class="${cls || ""}" data-key="${k}" ${term ? `data-term="${term}"` : ""}>${label}${state.scrSortKey === k ? (state.scrSortDir < 0 ? " ↓" : " ↑") : ""}</th>`).join("");
  head.querySelectorAll("th").forEach((th) => {
    if (th.dataset.key === "star") return; // not sortable
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

  const k = state.scrSortKey, dir = state.scrSortDir;
  rows.sort((a, b) => {
    let va = a[k], vb = b[k];
    if (k === "flags") { va = (va || []).length; vb = (vb || []).length; }
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * dir;
  });
  $("#scrCount").textContent = `${rows.length} shares`;
  $("#scrTable tbody").innerHTML = rows.map(screenerRowHtml).join("");
  wireScreenerTable($("#scrTable"));
  renderScreenerShortlist();
}

function screenerRowHtml(r) {
  return `<tr data-code="${r.code}">
    <td>${starBtn(r.code)}</td>
    <td class="lft"><b>${r.code}</b></td>
    <td class="lft">${r.sector || "–"}</td><td class="lft">${r.category || "–"}</td>
    <td class="lft">${(r.flags || []).map((f) => `<span class="chip flag" data-term="flag:${f}">${f}</span>`).join(" ")}</td>
    <td>${fmt(r.price)}</td>
    <td class="pos">${fmt(r.target_price, 1)}<br><small>+${fmt(r.target_pct, 0)}%</small></td>
    <td class="neg">${fmt(r.stop_price, 1)}<br><small>−${fmt(r.stop_pct, 0)}%</small></td>
    <td>${pct(r.r_1w)}</td><td>${pct(r.r_1m)}</td>
    <td>${pct(r.r_3m)}</td><td>${pct(r.r_1y)}</td><td>${pct(r.rel_1m)}</td>
    <td>${fmt(r.rsi14, 0)}</td><td>${fmt(r.vol_ratio, 2)}</td><td>${fmt(r.pe)}</td>
    <td>${fmt(r.dividend_yield)}</td><td>${fmt(r.avg_value_mn_30d)}</td>
    <td>${fmt(r.pos_52w, 2)}</td><td>${fmt(r.dist_resistance)}</td>
    <td><b>${fmt(r.score_short, 0)}</b></td><td><b>${fmt(r.score_long, 0)}</b></td>
    <td><b>${fmt(r.composite, 0)}</b></td>
    <td class="lft">${r.verdict || "–"}</td>
    <td>${fmt(r.rr, 1)}</td>
    <td>${r.win_rate !== null && r.win_rate !== undefined ? r.win_rate + `<small style="color:var(--muted)">/${r.signal_trades}</small>` : "–"}</td>
  </tr>`;
}

function wireScreenerTable(table) {
  wireStarButtons(table);
  table.querySelectorAll("tbody tr").forEach((tr) =>
    tr.addEventListener("click", () => openDetail(tr.dataset.code)));
}

function renderScreenerShortlist() {
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
  table.querySelector("tbody").innerHTML = rows.map(screenerRowHtml).join("");
  wireScreenerTable(table);
  panel.classList.remove("hidden");
}
["#scrSearch", "#fltLiq", "#fltComposite"].forEach((s) =>
  $(s).addEventListener("input", renderScreener));
["#scrEligible", "#fltNoFlags", "#fltSector", "#fltCategory", "#fltVerdict", "#fltRsi"].forEach((s) =>
  $(s).addEventListener("change", renderScreener));

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
    ["EPS", fmt(a.eps, 2), "eps"], ["P/E", fmt(a.pe), "pe"],
    ["Dividend yield", a.dividend_yield ? a.dividend_yield + "%" : "–", "dividend_yield"],
    ["RSI 14", fmt(a.rsi14, 0), "rsi"], ["Volume ×30d", fmt(a.vol_ratio, 2), "vol_ratio"],
    ["Avg traded/day", fmt(a.avg_value_mn_30d) + " mn", "liquidity"],
    ["Rel. strength 1m", (a.rel_1m > 0 ? "+" : "") + fmt(a.rel_1m) + "%", "rel_1m"],
    ["52w position", fmt(a.pos_52w * 100, 0) + "%", "pos52"],
    ["Above support", fmt(a.dist_support) + "%", "support"],
    ["Below resistance", fmt(a.dist_resistance) + "%", "support"],
    ["Volatility (daily σ)", fmt(a.volatility, 2) + "%", "volatility"],
    ["Risk/Reward", fmt(a.rr, 1), "rr"],
    ["Signal win rate", a.win_rate !== null && a.win_rate !== undefined
      ? `${a.win_rate}% <small>of ${a.signal_trades} signals, avg ${a.signal_avg > 0 ? "+" : ""}${a.signal_avg}%</small>` : "–", "win_rate"],
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
  if (["highprofit", "charts", "screener", "sectors", "potential"].includes(tab)) {
    document.querySelector(`nav.tabs button[data-tab="${tab}"]`).click();
  } else if (tab.startsWith("t:")) {
    openDetail(decodeURIComponent(tab.slice(2)));
  } else if (tab === "help") {
    $("#btnHelp").click();
  }
});
