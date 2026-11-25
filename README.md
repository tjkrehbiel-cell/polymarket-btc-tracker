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
