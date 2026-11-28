// Writes a delayed MSTR + BTC snapshot (JSON) for the tracker's mNAV panel.
// Run by .github/workflows/mstr-snapshot.yml; output goes to the `data` branch.
// Node 20+. Read-only public quote endpoints only. No keys, no wallets.
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = process.argv[2] || "out/mstr.json";
const UA = "Mozilla/5.0 (compatible; pm-btc-tracker snapshot)";
const YF = "https://query1.finance.yahoo.com/v8/finance/chart/MSTR";

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function yahooLatest() {
  const j = await getJSON(`${YF}?interval=1m&range=1d&includePrePost=true`);
  const r = j.chart.result[0];
  const meta = r.meta;
  const ts = r.timestamp || [];
  const closes = r.indicators.quote[0].close || [];
  let last = null;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] != null) { last = { t: ts[i], p: closes[i] }; break; }
  }
  const tp = meta.currentTradingPeriod || {};
  const now = Math.floor(Date.now() / 1000);
  let session = "closed";
  if (tp.regular && now >= tp.regular.start && now < tp.regular.end) session = "regular";
  else if (tp.pre && now >= tp.pre.start && now < tp.pre.end) session = "pre";
  else if (tp.post && now >= tp.post.start && now < tp.post.end) session = "post";
  return {
    source: "Yahoo Finance chart API (delayed/unofficial)",
    price: last ? last.p : meta.regularMarketPrice,
    priceTime: last ? last.t : meta.regularMarketTime,
    regularClose: meta.regularMarketPrice,
    regularTime: meta.regularMarketTime,
    prevClose: meta.previousClose ?? meta.chartPreviousClose ?? null,
    session,
  };
}

async function yahooHistory() {
  const j = await getJSON(`${YF}?interval=5m&range=5d&includePrePost=true`);
  const r = j.chart.result[0];
  const ts = r.timestamp || [];
  const closes = r.indicators.quote[0].close || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) if (closes[i] != null) out.push([ts[i], closes[i]]);
  return out;
}

async function nasdaqLatest() {
  const j = await getJSON("https://api.nasdaq.com/api/quote/MSTR/info?assetclass=stocks");
  const d = j.data.primaryData;
  const p = Number(String(d.lastSalePrice).replace(/[$,]/g, ""));
  if (!Number.isFinite(p)) throw new Error("nasdaq parse");
  return {
    source: "Nasdaq quote API (delayed)",
    price: p, priceTime: Math.floor(Date.now() / 1000), regularClose: p, regularTime: null,
    prevClose: null, session: "unknown",
  };
}

async function btcNow() {
  const j = await getJSON("https://api.exchange.coinbase.com/products/BTC-USD/ticker");
  return Number(j.price);
}

async function btcCandles(fromSec, toSec) {
  // Coinbase Exchange: max 300 candles per request, 300s granularity.
  const map = new Map();
  const span = 300 * 300;
  for (let s = fromSec; s < toSec; s += span) {
    const e = Math.min(s + span, toSec);
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=300&start=${new Date(s * 1000).toISOString()}&end=${new Date(e * 1000).toISOString()}`;
    try {
      const rows = await getJSON(url); // [time, low, high, open, close, volume]
      for (const c of rows) map.set(c[0], c[4]);
    } catch (err) {
      console.warn("candle chunk failed", err.message);
    }
  }
  return map;
}

let latest;
let latestErr = [];
for (const fn of [yahooLatest, nasdaqLatest]) {
  try { latest = await fn(); break; } catch (e) { latestErr.push(`${fn.name}: ${e.message}`); }
}
if (!latest) { console.error("No MSTR quote source worked:", latestErr); process.exit(1); }

let hist = [];
try { hist = await yahooHistory(); } catch (e) { console.warn("history failed:", e.message); }

const btc = await btcNow();
let history = [];
if (hist.length) {
  const candles = await btcCandles(hist[0][0] - 600, Math.floor(Date.now() / 1000) + 300);
  for (const [t, p] of hist) {
    const b = candles.get(t);
    if (b != null) history.push([t, Number(p.toFixed(3)), Number(b.toFixed(2))]);
  }
}

// BTC at (about) the moment of the MSTR quote, so the mNAV pair is time-consistent.
let btcAtQuote = btc;
try {
  const bucket = Math.floor(latest.priceTime / 300) * 300;
  const c = await btcCandles(bucket - 300, bucket + 600);
  const v = c.get(bucket) ?? c.get(bucket - 300);
  if (v != null) btcAtQuote = v;
} catch { /* keep live */ }
latest.btcAtQuote = btcAtQuote;

const out = {
  generatedAt: new Date().toISOString(),
  mstr: latest,
  btc: { price: btc, source: "Coinbase Exchange BTC-USD ticker", time: new Date().toISOString() },
  // [unixSeconds, MSTR close, BTC close] for each 5-minute bar (pre/regular/post), last ~5 days
  history,
  notes: latestErr,
};
mkdirSync(OUT.split("/").slice(0, -1).join("/") || ".", { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.log("wrote", OUT, "mstr", latest.price, latest.session, "btc", btc, "history", history.length);
