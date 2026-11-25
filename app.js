/* Polymarket BTC tracker — read-only public Gamma API. No wallet, no orders. */
(() => {
  const API = "https://gamma-api.polymarket.com/events/keyset";
  const TAG_BITCOIN = 235;
  const TZ = "America/Chicago";
  const PIN_KEY = "pm-btc-pins-v1";
  const SNAP_KEY = "pm-btc-snap-v1";
  const HINT_KEY = "pm-btc-hint-v1";
  const FILTER_KEY = "pm-btc-filter-v1";
  const REFRESH_MS = 60_000;
  const EVENT_URL = (slug) => `https://polymarket.com/event/${encodeURIComponent(slug)}`;

  const params = new URLSearchParams(location.search);
  const isWidget = params.get("view") === "widget";

  const state = {
    events: [],
    pins: loadPins(),
    filter: localStorage.getItem(FILTER_KEY) || "all",
    query: "",
    loading: true,
    error: null,
    updatedAt: null,
    stale: false,
    expanding: new Set(),
    showAllShort: false,
    refreshing: false,
  };

  function loadPins() {
    try {
      const raw = JSON.parse(localStorage.getItem(PIN_KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }
  function savePins() {
    localStorage.setItem(PIN_KEY, JSON.stringify(state.pins));
  }
  function pinKey(eventSlug, marketId) {
    return `${eventSlug}::${marketId}`;
  }
  function isPinned(eventSlug, marketId) {
    const k = pinKey(eventSlug, marketId);
    return state.pins.some((p) => p.key === k);
  }
  function togglePin(info) {
    const k = pinKey(info.eventSlug, info.marketId);
    const i = state.pins.findIndex((p) => p.key === k);
    if (i >= 0) state.pins.splice(i, 1);
    else state.pins.unshift({ ...info, key: k, pinnedAt: Date.now() });
    savePins();
    render();
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
  function asList(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === "string") {
      try { return JSON.parse(v); } catch { return []; }
    }
    return [];
  }
  function pct(price) {
    const n = Number(price);
    if (!Number.isFinite(n)) return null;
    return n <= 1 ? n * 100 : n;
  }
  function fmtPct(x) {
    if (x == null || Number.isNaN(x)) return "—";
    if (x < 1) return `${x.toFixed(1)}%`;
    if (x < 10) return `${Math.round(x * 10) / 10}%`;
    return `${Math.round(x)}%`;
  }
  function fmtVol(n) {
    n = Number(n) || 0;
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
    if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
    if (n <= 0) return "$0";
    return `$${Math.round(n)}`;
  }
  function parseIso(s) {
    if (!s) return NaN;
    return Date.parse(s);
  }
  function fmtEnd(iso) {
    const t = parseIso(iso);
    if (!Number.isFinite(t)) return "";
    const ms = t - Date.now();
    if (ms <= 0) return "Ended";
    if (ms < 60 * 60 * 1000) {
      const m = Math.max(1, Math.round(ms / 60000));
      return `Ends in ${m}m`;
    }
    if (ms < 6 * 60 * 60 * 1000) {
      const h = Math.floor(ms / 3600000);
      const m = Math.round((ms % 3600000) / 60000);
      return `Ends in ${h}h ${m}m`;
    }
    const d = new Date(t);
    const text = d.toLocaleString("en-US", {
      timeZone: TZ,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    return `Ends ${text} CT`;
  }
  function fmtClock(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleString("en-US", {
      timeZone: TZ,
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    }) + " CT";
  }
  function rangeMinutes(title) {
    const m = String(title || "").match(
      /(\d{1,2}):(\d{2})\s*(AM|PM)\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i
    );
    if (!m) return null;
    const mins = (h, mi, ap) => (Number(h) % 12 + (ap.toUpperCase() === "PM" ? 12 : 0)) * 60 + Number(mi);
    const dur = (mins(m[4], m[5], m[6]) - mins(m[1], m[2], m[3]) + 24 * 60) % (24 * 60);
    return dur || 24 * 60;
  }
  function classify(ev) {
    const title = ev.title || "";
    const t = title.toLowerCase();
    const slug = (ev.slug || "").toLowerCase();
    if (t.includes("up or down") || t.includes("up/down") || slug.includes("updown") || slug.includes("btc-updown")) {
      const dur = rangeMinutes(title);
      if (dur != null) {
        if (dur <= 5) return "updown-5m";
        if (dur <= 15) return "updown-15m";
        if (dur <= 60) return "updown-hourly";
        if (dur < 24 * 60) return "updown-window";
        return "updown-daily";
      }
      if (/up or down on /i.test(title)) return "updown-daily";
      return "updown-other";
    }
    if (["above", "below", " hit", "reach", "price will", "bitcoin price on", "price of bitcoin"].some((s) => t.includes(s.trim()) || t.includes(s))) {
      return "price-target";
    }
    return "other";
  }
  function groupLabel(kind) {
    return {
      "updown-5m": "5-minute up or down",
      "updown-15m": "15-minute up or down",
      "updown-hourly": "Hourly up or down",
      "updown-window": "Multi-hour up or down",
      "updown-daily": "Daily up or down",
      "updown-other": "Up or down",
      "price-target": "Price targets",
      other: "Other Bitcoin markets",
    }[kind] || kind;
  }
  function isUpDown(kind) {
    return String(kind).startsWith("updown");
  }
  function isShort(kind) {
    return kind === "updown-5m" || kind === "updown-15m";
  }
  function marketOdds(m) {
    const outcomes = asList(m.outcomes);
    const prices = asList(m.outcomePrices);
    return outcomes.map((name, i) => ({ name, pct: pct(prices[i]) }));
  }
  function yesPct(m) {
    const odds = marketOdds(m);
    const yes = odds.find((o) => /^yes$/i.test(o.name));
    return yes ? yes.pct : (odds[0] ? odds[0].pct : null);
  }
  function slimEvent(ev) {
    const markets = (ev.markets || [])
      .filter((m) => !m.closed)
      .map((m) => ({
        id: String(m.id),
        question: m.question || ev.title,
        slug: m.slug,
        groupItemTitle: m.groupItemTitle || "",
        outcomes: asList(m.outcomes),
        outcomePrices: asList(m.outcomePrices).map(Number),
        volume24hr: Number(m.volume24hr) || 0,
        endDate: m.endDate || ev.endDate,
        active: m.active,
      }));
    return {
      id: String(ev.id),
      title: ev.title || ev.slug,
      slug: ev.slug,
      endDate: ev.endDate,
      startDate: ev.startDate,
      volume24hr: Number(ev.volume24hr) || 0,
      volume: Number(ev.volume) || 0,
      kind: null,
      markets,
    };
  }

  async function fetchPage(cursor) {
    const qs = new URLSearchParams({
      tag_id: String(TAG_BITCOIN),
      closed: "false",
      limit: "100",
      order: "volume24hr",
      ascending: "false",
      end_date_min: new Date().toISOString(),
    });
    if (cursor) qs.set("after_cursor", cursor);
    const res = await fetch(`${API}?${qs}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Gamma API ${res.status}`);
    return res.json();
  }

  async function fetchAllEvents() {
    const all = [];
    const seen = new Set();
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const data = await fetchPage(cursor);
      const evs = data.events || [];
      let added = 0;
      for (const ev of evs) {
        const id = String(ev.id);
        if (seen.has(id)) continue;
        seen.add(id);
        if (ev.closed) continue;
        const end = parseIso(ev.endDate);
        if (Number.isFinite(end) && end < Date.now() - 60_000) continue;
        const slim = slimEvent(ev);
        slim.kind = classify(slim);
        if (!slim.markets.length) continue;
        all.push(slim);
        added++;
      }
      const next = data.next_cursor;
      if (!evs.length || !next) break;
      cursor = next;
    }
    all.sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0));
    return all;
  }

  function cacheSnap(events, updatedAt) {
    try {
      localStorage.setItem(SNAP_KEY, JSON.stringify({ updatedAt, events }));
    } catch { /* quota */ }
  }
  function loadSnap() {
    try {
      const raw = JSON.parse(localStorage.getItem(SNAP_KEY) || "null");
      if (raw && Array.isArray(raw.events)) return raw;
    } catch { /* ignore */ }
    return null;
  }

  async function refresh({ quiet } = {}) {
    if (state.refreshing) return;
    state.refreshing = true;
    if (!quiet) {
      state.loading = state.events.length === 0;
      state.error = null;
      render();
    }
    try {
      const events = await fetchAllEvents();
      state.events = events;
      state.updatedAt = Date.now();
      state.stale = false;
      state.error = null;
      cacheSnap(events, state.updatedAt);
    } catch (err) {
      state.error = err.message || String(err);
      if (!state.events.length) {
        const snap = loadSnap();
        if (snap) {
          state.events = snap.events;
          state.updatedAt = snap.updatedAt;
          state.stale = true;
        }
      } else {
        state.stale = true;
      }
    } finally {
      state.loading = false;
      state.refreshing = false;
      render();
    }
  }

  function liveOrSoon(ev, soonMs) {
    const end = parseIso(ev.endDate);
    const start = parseIso(ev.startDate);
    const now = Date.now();
    if (Number.isFinite(end) && end <= now) return false;
    if (Number.isFinite(start)) return start <= now + soonMs;
    const durMin = rangeMinutes(ev.title);
    if (durMin && Number.isFinite(end)) {
      const inferred = end - durMin * 60_000;
      return inferred <= now + soonMs;
    }
    return true;
  }

  function matchesQuery(ev, m, q) {
    if (!q) return true;
    const hay = `${ev.title} ${ev.slug} ${m.question || ""} ${m.groupItemTitle || ""}`.toLowerCase();
    return hay.includes(q);
  }

  function pinRecords() {
    const byKey = new Map();
    for (const ev of state.events) {
      for (const m of ev.markets) {
        byKey.set(pinKey(ev.slug, m.id), { ev, m });
      }
    }
    return state.pins.map((p) => {
      const live = byKey.get(p.key);
      if (live) return { ...p, ev: live.ev, m: live.m, missing: false };
      return {
        ...p,
        ev: { title: p.eventTitle, slug: p.eventSlug, endDate: p.endDate, volume24hr: 0, kind: p.kind || "other", markets: [] },
        m: { id: p.marketId, question: p.question, groupItemTitle: p.groupItemTitle || "", outcomes: ["Yes", "No"], outcomePrices: [], volume24hr: 0, endDate: p.endDate },
        missing: true,
      };
    });
  }

  const ICONS = {
    star: (on) => on
      ? `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.6 14.9 9l6.9.6-5.2 4.6 1.6 6.7L12 17.8 5.8 20.9 7.4 14.2 2.2 9.6 9.1 9z"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3.2 14.7 9l6.3.5-4.8 4.2 1.5 6.2L12 16.7 6.3 19.9 7.8 13.7 3 9.5 9.3 9z"/></svg>`,
    refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.2-5.5"/><path d="M20 4v6h-6"/></svg>`,
    search: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3-3"/></svg>`,
    ext: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M14 5h5v5"/><path d="M20 4 10 14"/><path d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5"/></svg>`,
  };

  function starBtn(ev, m) {
    const on = isPinned(ev.slug, m.id);
    const payload = esc(JSON.stringify({
      eventSlug: ev.slug,
      marketId: m.id,
      eventTitle: ev.title,
      question: m.question || ev.title,
      groupItemTitle: m.groupItemTitle || "",
      endDate: m.endDate || ev.endDate,
      kind: ev.kind,
    }));
    return `<button class="star" type="button" data-pin='${payload}' aria-pressed="${on}" aria-label="${on ? "Unpin" : "Pin"} market">${ICONS.star(on)}</button>`;
  }

  function renderBinaryOdds(m) {
    const odds = marketOdds(m);
    if (!odds.length) return "";
    if (odds.length <= 2) {
      return `<div class="odds-row">${odds.map((o) => {
        const cls = /^yes$/i.test(o.name) ? "yes" : (/^no$/i.test(o.name) ? "no" : "yes");
        return `<div class="odd ${cls}"><span class="lab">${esc(o.name)}</span><span class="val">${fmtPct(o.pct)}</span></div>`;
      }).join("")}</div>`;
    }
    return renderStrikes({ markets: odds.map((o, i) => ({ ...m, id: `${m.id}-${i}`, question: o.name, groupItemTitle: o.name, outcomes: [o.name], outcomePrices: [o.pct != null ? o.pct / 100 : null] })) }, false);
  }

  function renderStrikes(ev, allowPin = true) {
    const markets = ev.markets.slice();
    markets.sort((a, b) => {
      const pa = yesPct(a);
      const pb = yesPct(b);
      const da = pa == null ? 999 : Math.abs(50 - pa);
      const db = pb == null ? 999 : Math.abs(50 - pb);
      return da - db;
    });
    const key = ev.slug;
    const expanded = state.expanding.has(key);
    const limit = 8;
    const shown = expanded || markets.length <= limit ? markets : markets.slice(0, limit);
    const rows = shown.map((m) => {
      const yp = yesPct(m);
      const label = m.groupItemTitle || m.question || "Yes";
      return `<div class="strike">
        <div class="q" title="${esc(m.question || label)}">${esc(label)}</div>
        <div class="bar" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, yp || 0))}%"></span></div>
        <div style="display:flex;align-items:center;gap:2px">
          <div class="ypct">${fmtPct(yp)}</div>
          ${allowPin ? starBtn(ev, m) : ""}
        </div>
      </div>`;
    }).join("");
    const more = markets.length > limit
      ? `<div class="section-h" style="margin:6px 0 0"><button class="linkish" data-expand="${esc(key)}" type="button">${expanded ? "Show less" : `Show all ${markets.length} outcomes`}</button></div>`
      : "";
    return `<div class="strikes">${rows}</div>${more}`;
  }

  function renderEventCard(ev, opts = {}) {
    const single = ev.markets.length === 1;
    const m0 = ev.markets[0];
    const link = EVENT_URL(ev.slug);
    const starTarget = single ? m0 : null;
    return `<article class="card">
      <div class="card-top">
        <div style="flex:1;min-width:0">
          <h3 class="card-title"><a href="${esc(link)}" target="_blank" rel="noopener">${esc(ev.title)}</a></h3>
          <div class="card-meta">
            <span>${fmtVol(ev.volume24hr)} 24h</span>
            <span>${esc(fmtEnd(ev.endDate))}</span>
          </div>
        </div>
        ${starTarget ? starBtn(ev, starTarget) : ""}
        <a class="open-link" href="${esc(link)}" target="_blank" rel="noopener" aria-label="Open on Polymarket">${ICONS.ext}</a>
      </div>
      ${single ? renderBinaryOdds(m0) : renderStrikes(ev, true)}
    </article>`;
  }

  function renderPinnedCard(rec) {
    const ev = rec.ev;
    const m = rec.m;
    const link = EVENT_URL(ev.slug);
    const label = m.groupItemTitle && ev.title && !ev.title.includes(m.groupItemTitle)
      ? `${ev.title} — ${m.groupItemTitle}`
      : (m.question || ev.title);
    return `<article class="card">
      <div class="card-top">
        <div style="flex:1;min-width:0">
          <h3 class="card-title"><a href="${esc(link)}" target="_blank" rel="noopener">${esc(label)}</a></h3>
          <div class="card-meta">
            <span>${fmtVol(m.volume24hr || ev.volume24hr)} 24h</span>
            <span>${esc(fmtEnd(m.endDate || ev.endDate))}</span>
            ${rec.missing ? "<span>Last saved — reopen the full list to refresh this pin</span>" : ""}
          </div>
        </div>
        ${starBtn(ev, m)}
        <a class="open-link" href="${esc(link)}" target="_blank" rel="noopener" aria-label="Open on Polymarket">${ICONS.ext}</a>
      </div>
      ${renderBinaryOdds(m)}
    </article>`;
  }

  function applyFilters(list) {
    const q = state.query.trim().toLowerCase();
    const f = state.filter;
    return list.filter((ev) => {
      if (q && !ev.markets.some((m) => matchesQuery(ev, m, q)) && !matchesQuery(ev, {}, q)) return false;
      if (f === "all") return true;
      if (f === "pinned") return ev.markets.some((m) => isPinned(ev.slug, m.id)) || isPinned(ev.slug, ev.markets[0]?.id);
      if (f === "price") return ev.kind === "price-target";
      if (f === "updown") return isUpDown(ev.kind) && !isShort(ev.kind);
      if (f === "short") return isShort(ev.kind);
      if (f === "other") return ev.kind === "other";
      return true;
    });
  }

  function renderMain() {
    const hint = localStorage.getItem(HINT_KEY) !== "1";
    const filters = [
      ["all", "All"],
      ["pinned", "Pinned"],
      ["price", "Price"],
      ["updown", "Up/Down"],
      ["short", "5m / 15m"],
      ["other", "Other"],
    ];
    const status = state.error
      ? `Couldn’t refresh${state.stale && state.updatedAt ? ` — showing ${fmtClock(state.updatedAt)}` : ""}. ${esc(state.error)}`
      : state.loading
        ? "Loading Bitcoin markets…"
        : `${state.events.length} open markets · Updated ${fmtClock(state.updatedAt)}${state.stale ? " (cached)" : ""}`;

    let body = "";
    if (state.loading && !state.events.length) {
      body = `<div class="skeleton">${"<div class='card'></div>".repeat(4)}</div>`;
    } else if (!state.events.length && state.error) {
      body = `<div class="error-box"><p>${esc(state.error)}</p><button class="primary-btn" data-refresh type="button">Try again</button></div>`;
    } else {
      const q = state.query.trim().toLowerCase();
      const pins = pinRecords().filter((r) => {
        if (!q) return true;
        return matchesQuery(r.ev, r.m, q);
      });
      const filtered = applyFilters(state.events);

      const showPins = state.filter === "all" || state.filter === "pinned";
      if (showPins && pins.length && state.filter !== "short") {
        body += `<div class="section-h"><h2>Pinned</h2><span class="meta">${pins.length}</span></div>`;
        body += pins.map(renderPinnedCard).join("");
      } else if (state.filter === "pinned" && !pins.length) {
        body += `<div class="empty">Star a market to pin it here. Pins stay on this phone.</div>`;
      }

      if (state.filter !== "pinned") {
        const groups = [
          { kinds: ["price-target"], show: state.filter === "all" || state.filter === "price" },
          { kinds: ["updown-daily", "updown-window", "updown-hourly", "updown-other"], show: state.filter === "all" || state.filter === "updown" },
          { kinds: ["other"], show: state.filter === "all" || state.filter === "other" },
        ];
        for (const g of groups) {
          if (!g.show) continue;
          const items = filtered.filter((ev) => g.kinds.includes(ev.kind));
          if (!items.length) continue;
          body += `<div class="section-h"><h2>${esc(groupLabel(g.kinds[0]))}</h2><span class="meta">${items.length}</span></div>`;
          body += items.map((ev) => renderEventCard(ev)).join("");
        }

        const shortItems = (state.filter === "short" ? filtered : state.filter === "all" ? applyFilters(state.events) : [])
          .filter((ev) => isShort(ev.kind));
        if ((state.filter === "all" || state.filter === "short") && shortItems.length) {
          const soon = 45 * 60 * 1000;
          const live = shortItems.filter((ev) => liveOrSoon(ev, 0)).sort((a, b) => parseIso(a.endDate) - parseIso(b.endDate));
          const upcoming = shortItems.filter((ev) => !liveOrSoon(ev, 0) && liveOrSoon(ev, soon)).sort((a, b) => parseIso(a.endDate) - parseIso(b.endDate));
          let shown;
          if (state.filter === "short" || state.showAllShort || q) {
            shown = shortItems.slice().sort((a, b) => parseIso(a.endDate) - parseIso(b.endDate));
          } else {
            shown = [...live, ...upcoming.slice(0, 4)];
          }
          const hidden = shortItems.length - shown.length;
          body += `<div class="section-h"><h2>Short-interval up or down</h2><span class="meta">${shortItems.length}</span>
            ${hidden > 0 ? `<button class="linkish" data-all-short type="button">Show all</button>` : (state.showAllShort && state.filter === "all" ? `<button class="linkish" data-all-short type="button">Show less</button>` : "")}
          </div>`;
          if (!shown.length) body += `<div class="empty">No 5- or 15-minute markets ending soon. Open “5m / 15m” to see the full pre-listed set.</div>`;
          else body += shown.map((ev) => renderEventCard(ev)).join("");
        }
        if (!body) body = `<div class="empty">No markets match that filter.</div>`;
      }
    }

    document.body.classList.remove("widget");
    document.getElementById("app").innerHTML = `
      <div class="ptr" id="ptr">Release to refresh</div>
      <header class="header">
        <div class="header-row">
          <div class="brand">
            <img src="apple-touch-icon.png" alt="">
            <div>
              <h1>Polymarket BTC</h1>
              <div class="sub">Read-only live odds</div>
            </div>
          </div>
          <button class="icon-btn ${state.refreshing ? "spinning" : ""}" type="button" data-refresh aria-label="Refresh">${ICONS.refresh}</button>
        </div>
        <div class="status ${state.error ? "error" : ""}">${status}</div>
        <div class="search-wrap">
          <span class="search-icon">${ICONS.search}</span>
          <input id="search" type="search" placeholder="Search Bitcoin markets" value="${esc(state.query)}" autocomplete="off" enterkeyhint="search">
          ${state.query ? `<button class="search-clear" type="button" data-clear aria-label="Clear">&times;</button>` : ""}
        </div>
        <div class="chips">
          ${filters.map(([id, lab]) => `<button class="chip ${state.filter === id ? "active" : ""}" data-filter="${id}" type="button">${lab}</button>`).join("")}
        </div>
      </header>
      <main class="main">
        ${hint ? `<div class="banner" id="hint">
          <div>Add this page to your home screen for a one-tap shortcut. iPhone: Share → Add to Home Screen. Android: menu → Add to Home screen / Install app. A true OS widget isn’t possible from a web app; use <a href="?view=widget">widget view</a> for pinned odds in large type.</div>
          <button type="button" data-dismiss-hint aria-label="Dismiss">×</button>
        </div>` : ""}
        ${body}
      </main>
    `;
    bindMain();
  }

  function bindMain() {
    const search = document.getElementById("search");
    if (search) {
      search.addEventListener("input", (e) => {
        state.query = e.target.value;
        render();
        const again = document.getElementById("search");
        if (again) {
          again.focus();
          const len = again.value.length;
          again.setSelectionRange(len, len);
        }
      });
    }
    setupPullToRefresh();
  }

  function pinsFromUrl() {
    const raw = params.get("pins");
    if (!raw) return null;
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }

  function renderWidget() {
    document.body.classList.add("widget");
    const urlPins = pinsFromUrl();
    let recs = pinRecords();
    if (urlPins && urlPins.length) {
      const wanted = new Set(urlPins);
      recs = recs.filter((r) => wanted.has(r.ev.slug) || wanted.has(r.key) || wanted.has(r.marketId));
      if (!recs.length) {
        recs = state.events
          .filter((ev) => wanted.has(ev.slug))
          .map((ev) => ({ ev, m: ev.markets[0], missing: false, key: pinKey(ev.slug, ev.markets[0].id) }));
        // also allow eventSlug::marketId
        for (const ev of state.events) {
          for (const m of ev.markets) {
            const k = pinKey(ev.slug, m.id);
            if (wanted.has(k) && !recs.some((r) => r.key === k)) recs.push({ ev, m, missing: false, key: k });
          }
        }
      }
    }
    const body = recs.length
      ? recs.map((r) => {
          const odds = marketOdds(r.m);
          const yes = odds.find((o) => /^yes$/i.test(o.name)) || odds[0];
          const no = odds.find((o) => /^no$/i.test(o.name)) || odds[1];
          const label = r.m.groupItemTitle && r.ev.title ? `${r.ev.title} — ${r.m.groupItemTitle}` : (r.m.question || r.ev.title);
          const link = EVENT_URL(r.ev.slug);
          return `<div class="widget-item">
            <p class="q"><a href="${esc(link)}" target="_blank" rel="noopener">${esc(label)}</a></p>
            <div class="big">${fmtPct(yes ? yes.pct : null)}</div>
            <div class="side">${yes ? esc(yes.name) : "Yes"}${no ? ` · ${esc(no.name)} ${fmtPct(no.pct)}` : ""} · ${esc(fmtEnd(r.m.endDate || r.ev.endDate))}</div>
          </div>`;
        }).join("")
      : `<div class="widget-empty">No pinned markets yet. Open the <a href="./">full tracker</a>, star the bets you care about, then come back here. Pins are saved on this device.</div>`;

    document.getElementById("app").innerHTML = `
      <div class="widget-wrap">
        <div class="hdr"><span>Pinned BTC</span><span>${state.refreshing ? "Updating…" : (state.updatedAt ? fmtClock(state.updatedAt) : "")}</span></div>
        ${state.error ? `<div class="status error">${esc(state.error)}</div>` : ""}
        ${body}
      </div>
    `;
  }

  function render() {
    if (isWidget) renderWidget();
    else renderMain();
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-refresh]");
    if (btn) { refresh(); return; }
    const chip = e.target.closest("[data-filter]");
    if (chip) {
      state.filter = chip.getAttribute("data-filter");
      localStorage.setItem(FILTER_KEY, state.filter);
      render();
      return;
    }
    const clear = e.target.closest("[data-clear]");
    if (clear) { state.query = ""; render(); return; }
    const dismiss = e.target.closest("[data-dismiss-hint]");
    if (dismiss) { localStorage.setItem(HINT_KEY, "1"); render(); return; }
    const exp = e.target.closest("[data-expand]");
    if (exp) {
      const key = exp.getAttribute("data-expand");
      if (state.expanding.has(key)) state.expanding.delete(key);
      else state.expanding.add(key);
      render();
      return;
    }
    const allShort = e.target.closest("[data-all-short]");
    if (allShort) { state.showAllShort = !state.showAllShort; render(); return; }
    const star = e.target.closest("[data-pin]");
    if (star) {
      try { togglePin(JSON.parse(star.getAttribute("data-pin"))); } catch { /* ignore */ }
    }
  });

  function setupPullToRefresh() {
    let startY = 0;
    let pulling = false;
    const ptr = document.getElementById("ptr");
    window.addEventListener("touchstart", (e) => {
      if (window.scrollY <= 0 && e.touches[0]) {
        startY = e.touches[0].clientY;
        pulling = true;
      }
    }, { passive: true });
    window.addEventListener("touchmove", (e) => {
      if (!pulling || !e.touches[0]) return;
      const dy = e.touches[0].clientY - startY;
      if (ptr && window.scrollY <= 0 && dy > 24) ptr.classList.add("show");
    }, { passive: true });
    window.addEventListener("touchend", (e) => {
      if (!pulling) return;
      pulling = false;
      const dy = (e.changedTouches[0]?.clientY || 0) - startY;
      if (ptr) ptr.classList.remove("show");
      if (window.scrollY <= 0 && dy > 64) refresh({ quiet: true });
    }, { passive: true });
  }

  if ("serviceWorker" in navigator && !isWidget) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh({ quiet: true });
  });

  const snap = loadSnap();
  if (snap && snap.events?.length) {
    state.events = snap.events;
    state.updatedAt = snap.updatedAt;
    state.stale = true;
    state.loading = false;
  }
  render();
  refresh({ quiet: !!snap });
  setInterval(() => {
    if (document.visibilityState === "hidden") return;
    refresh({ quiet: true });
  }, REFRESH_MS);
})();
