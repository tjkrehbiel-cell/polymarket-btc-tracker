# Polymarket BTC

A phone-first, read-only web app that tracks live odds on [Polymarket](https://polymarket.com) Bitcoin markets. It does not place bets, open a wallet, or sign you in.

Live: **https://tjkrehbiel-cell.github.io/polymarket-btc-tracker/**

## Add to your home screen

This is a Progressive Web App (PWA). It can sit on your home screen like an app. It cannot create a true iPhone or Android OS widget; those APIs are reserved for native apps. Use the compact **widget view** or the Scriptable snippet below if you want large-type pins on the home screen.

**iPhone (Safari)**

1. Open the live URL in Safari (Add to Home Screen is not available in Chrome on iOS).
2. Tap the Share button.
3. Tap **Add to Home Screen**, then Add.

**Android (Chrome, and most Chromium browsers)**

1. Open the live URL in Chrome.
2. Tap the menu (⋮) and choose **Add to Home screen** or **Install app**.

**Compact widget view**

Open [widget view](https://tjkrehbiel-cell.github.io/polymarket-btc-tracker/?view=widget) after you have starred markets in the full app. It shows only pinned markets in large type, auto-refreshes every 60 seconds, and is meant for:

- iOS Shortcuts (Open URL, or a Safari web view)
- An Android “web widget” / website shortcut app
- The Scriptable snippet in `scriptable-btc-widget.js` for a real iOS home-screen widget (edit `PINNED_SLUGS` first)

Pins are stored in `localStorage` on that device and browser.

## Data source

The app talks to Polymarket’s public **Gamma API** from the browser. No backend and no API key.

- Events: `GET https://gamma-api.polymarket.com/events/keyset`
- Filters: `tag_id=235` (Bitcoin), `closed=false`, `end_date_min` = now, `limit=100`, ordered by 24h volume
- Pagination: pass each page’s `next_cursor` back as `after_cursor`
- Prices: `outcomePrices` on each market (no CLOB call is required)
- CORS: the Gamma API sends `Access-Control-Allow-Origin: *`, so GitHub Pages can call it directly
- Requests with `limit` above 50 must send `Accept-Encoding: gzip` (browsers do this automatically)

The older `/events` list endpoint is deprecated (warning: use `/events/keyset`). `/events?slug=...` still works and is what the Scriptable widget uses for a single market.

## Features

- Active Bitcoin markets grouped as price targets / ladders, daily and hourly (and multi-hour) up-or-down, short-interval 5m/15m, and other BTC questions
- Question, Yes/No (or outcome) odds as a percent, 24h volume, end time in US Central Time, and a one-tap link to `https://polymarket.com/event/<slug>`
- Star / pin markets; pins stay at the top (localStorage)
- Search and filter chips
- Pull-to-refresh, a refresh button, and auto-refresh about every 60 seconds (pauses while the tab is hidden)
- Offline shell via a service worker; last successful snapshot is cached for a failed refresh

Short-interval 5- and 15-minute markets are pre-listed in large numbers. The default list shows ones that are live or starting soon; open the **5m / 15m** filter for the full set.


## v2: odds charts and MSTR mNAV tab

- **Tap any percentage** (Yes/No box or a ladder row) to open a sheet with Polymarket's official embed (`embed.polymarket.com/market?market=<market-slug>&theme=dark&showChart=true`). If the embed stays blank, the **Built-in chart** tab draws Yes odds from `clob.polymarket.com/prices-history` (CORS-open; 1D / 1W / 1M / All). Both have an "Open on Polymarket" link.
- **MSTR mNAV tab** (bottom nav, or `#mstr`): estimated mNAV with three definitions, a 5-minute feed and sparkline, three rolling wheels (mNAV x BTC price -> implied MSTR price, odometer-style), and a price grid for every mNAV and every $2,500 BTC step within $20,000 of the current price.
- **Data sources**
  - BTC: Coinbase Exchange `BTC-USD` ticker, live from the browser every 30 s (CORS-open).
  - MSTR: no free CORS-open quote exists, so `.github/workflows/mstr-snapshot.yml` runs `scripts/update-mstr.mjs` about every 5 min (US pre-market to after-hours, weekdays; hourly otherwise) and force-pushes `data/mstr.json` to the `data` branch. The app reads it from `raw.githubusercontent.com` every 60 s. The quote is a delayed Yahoo Finance quote (Nasdaq API as fallback). GitHub cron can run late, so a snapshot may be 5-15 min old.
  - Constants (`mstr-config.json`): BTC held, USD assets, debt and preferred (notional), diluted and basic shares, each with an as-of date, from Strategy's Investor Briefing and 8-K. Update this file after each Monday 8-K.
- **mNAV definitions**: Strategy's own (price / Net BTC per share, diluted shares; default), EV / BTC NAV (basic shares), and market cap / BTC NAV.
- All mNAV figures are estimates. Read-only; no trading or wallet access.

## Limitations

- Odds come from Gamma and can lag the order book by a short interval.
- A PWA cannot add a real iOS or Android home-screen widget.
- Pins do not sync across phones or browsers.
- This app will not place bets or connect a wallet.
- Some Bitcoin-tagged events are only loosely about BTC (for example a broader bankruptcy slate that includes a crypto firm).

## Develop

This is a static site. Serve the folder over HTTP (required for the service worker) and open it on a phone or in a desktop browser:

```bash
python3 -m http.server 8080
```
