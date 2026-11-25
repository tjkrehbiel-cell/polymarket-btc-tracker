// Polymarket BTC — Scriptable widget (iOS)
// Read-only. Does not place bets or use a wallet.
//
// Setup:
// 1. Install the Scriptable app, then create a new script and paste this file.
// 2. Put event slugs in PINNED_SLUGS. Get a slug from the tracker (or from
//    a Polymarket URL: https://polymarket.com/event/<slug>).
// 3. Run the script once to test, then add a Scriptable home-screen widget
//    and point it at this script.
//
// Optional: after starring markets in the PWA, you can also open
//   ?view=widget
// in Safari / Shortcuts for a large-type web view of those pins.

const PINNED_SLUGS = [
  "what-price-will-bitcoin-hit-in-november-2026",
  "btc-updown-1d-1795539600",
];

const TZ = "America/Chicago";
const BG = new Color("#0b0d10");
const TEXT = new Color("#f3f5f8");
const MUTED = new Color("#8b93a1");
const YES = new Color("#3dd68c");
const ACCENT = new Color("#f7931a");

function asList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch (e) { return []; }
  }
  return [];
}

function pct(price) {
  const n = Number(price);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? n * 100 : n;
}

function fmtPct(x) {
  if (x == null || isNaN(x)) return "—";
  if (x < 1) return x.toFixed(1) + "%";
  if (x < 10) return (Math.round(x * 10) / 10) + "%";
  return Math.round(x) + "%";
}

function yesPct(market) {
  const outcomes = asList(market.outcomes);
  const prices = asList(market.outcomePrices);
  for (let i = 0; i < outcomes.length; i++) {
    if (String(outcomes[i]).toLowerCase() === "yes") return pct(prices[i]);
  }
  return pct(prices[0]);
}

async function fetchEvent(slug) {
  const url = "https://gamma-api.polymarket.com/events?slug=" + encodeURIComponent(slug);
  const req = new Request(url);
  req.headers = { Accept: "application/json" };
  const data = await req.loadJSON();
  return Array.isArray(data) ? data[0] : data;
}

function pickMarket(ev) {
  const markets = (ev.markets || []).filter((m) => !m.closed);
  if (!markets.length) return null;
  if (markets.length === 1) return markets[0];
  let best = markets[0];
  let bestDist = 999;
  for (const m of markets) {
    const y = yesPct(m);
    const d = y == null ? 999 : Math.abs(50 - y);
    if (d < bestDist) {
      best = m;
      bestDist = d;
    }
  }
  return best;
}

async function loadRows() {
  const rows = [];
  for (const slug of PINNED_SLUGS) {
    try {
      const ev = await fetchEvent(slug);
      if (!ev) continue;
      const m = pickMarket(ev);
      if (!m) continue;
      const label = (m.groupItemTitle && ev.markets && ev.markets.length > 1)
        ? ev.title + " — " + m.groupItemTitle
        : (m.question || ev.title);
      rows.push({
        title: label,
        yes: yesPct(m),
        slug: ev.slug,
        end: m.endDate || ev.endDate,
      });
    } catch (err) {
      rows.push({ title: slug, yes: null, slug, end: null, error: true });
    }
  }
  return rows;
}

function fmtEnd(iso) {
  if (!iso) return "";
  const t = new Date(iso);
  return t.toLocaleString("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }) + " CT";
}

const rows = await loadRows();
const widget = new ListWidget();
widget.backgroundColor = BG;
widget.setPadding(14, 16, 14, 16);

const header = widget.addText("PINNED BTC");
header.font = Font.boldSystemFont(11);
header.textColor = ACCENT;

for (const row of rows) {
  widget.addSpacer(10);
  const t = widget.addText(row.title);
  t.font = Font.semiboldSystemFont(12);
  t.textColor = TEXT;
  t.lineLimit = 2;
  const p = widget.addText(fmtPct(row.yes));
  p.font = Font.boldSystemFont(28);
  p.textColor = YES;
  if (row.end) {
    const e = widget.addText(fmtEnd(row.end));
    e.font = Font.systemFont(11);
    e.textColor = MUTED;
  }
}

if (!rows.length) {
  widget.addSpacer(8);
  const empty = widget.addText("Edit PINNED_SLUGS in the script to add markets.");
  empty.font = Font.systemFont(12);
  empty.textColor = MUTED;
}

widget.addSpacer(8);
const foot = widget.addText("Polymarket · read-only");
foot.font = Font.systemFont(10);
foot.textColor = MUTED;

if (rows[0] && rows[0].slug) {
  widget.url = "https://polymarket.com/event/" + encodeURIComponent(rows[0].slug);
}

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  widget.presentMedium();
}
Script.complete();
