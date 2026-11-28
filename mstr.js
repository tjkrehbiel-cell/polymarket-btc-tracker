/* MSTR mNAV tab: live-ish mNAV estimate, three-wheel odometer, price grid.
   Read-only. Public data only: Coinbase BTC ticker (live), MSTR snapshot (delayed, via GitHub Action),
   Strategy-published constants (mstr-config.json). */
(() => {
  const A = window.PMApp;
  if (!A || A.isWidget) return;
  const { esc, TZ } = A;
  const root = document.getElementById("mstr-root");

  const REPO = "tjkrehbiel-cell/polymarket-btc-tracker";
  const SNAP_URL = `https://raw.githubusercontent.com/${REPO}/data/data/mstr.json`;
  const SEED_URL = "mstr-seed.json";
  const CFG_URL = "mstr-config.json";
  const CB_URL = "https://api.exchange.coinbase.com/products/BTC-USD/ticker";
  const DEF_KEY = "pm-btc-mnav-def";

  const MN_MIN = 0.5, MN_MAX = 3.0, MN_STEP = 0.1;
  const BTC_STEP = 2500, BTC_SPAN = 20000;
  const ITEM = 40, THETA = 24;

  const DEFS = {
    official: {
      label: "Strategy mNAV",
      short: "Strategy",
      shares: "diluted",
      calc: "MSTR price ÷ Net BTC per share, where Net BTC per share = (BTC held × BTC price + USD assets − debt − preferred) ÷ diluted shares. This is Strategy’s published definition (since Jul 23, 2026).",
      inv: "MSTR price = mNAV × (BTC held × BTC price + USD assets − debt − preferred) ÷ diluted shares",
    },
    ev: {
      label: "EV ÷ BTC NAV",
      short: "EV ÷ BTC",
      shares: "basic",
      calc: "(market cap + debt + preferred − USD assets) ÷ (BTC held × BTC price), with market cap on basic shares. The classic enterprise-value version.",
      inv: "MSTR price = (mNAV × BTC held × BTC price − debt − preferred + USD assets) ÷ basic shares",
    },
    simple: {
      label: "Mkt cap ÷ BTC NAV",
      short: "Mkt cap ÷ BTC",
      shares: "basic",
      calc: "(MSTR price × basic shares) ÷ (BTC held × BTC price). Ignores debt, preferred and cash.",
      inv: "MSTR price = mNAV × BTC held × BTC price ÷ basic shares",
    },
  };

  const S = {
    cfg: null, snap: null, snapSource: "", snapErr: null,
    btcLive: null, btcLiveAt: null,
    def: localStorage.getItem(DEF_KEY) in DEFS ? localStorage.getItem(DEF_KEY) : "official",
    range: "1d", poly: [], polyErr: null, polyAt: 0,
    touched: false, anchor: null,
    built: false, active: false, tick: 0, timer: null, loading: false,
  };

  /* ---------- math ---------- */
  const sharesFor = (def) => (DEFS[def].shares === "diluted" ? S.cfg.dilutedShares : S.cfg.basicShares);
  const netUsd = (btc) => S.cfg.btcHoldings * btc + S.cfg.usdAssets - S.cfg.debtNotional - S.cfg.preferredNotional;
  function mnavOf(def, price, btc) {
    const c = S.cfg, nav = c.btcHoldings * btc;
    if (def === "official") return price / (netUsd(btc) / c.dilutedShares);
    if (def === "ev") return (price * c.basicShares + c.debtNotional + c.preferredNotional - c.usdAssets) / nav;
    return (price * c.basicShares) / nav;
  }
  function impliedOf(def, m, btc) {
    const c = S.cfg, nav = c.btcHoldings * btc;
    let v;
    if (def === "official") v = m * netUsd(btc) / c.dilutedShares;
    else if (def === "ev") v = (m * nav - c.debtNotional - c.preferredNotional + c.usdAssets) / c.basicShares;
    else v = m * nav / c.basicShares;
    return Math.max(0, v);
  }

  /* ---------- formatting ---------- */
  const n0 = (n) => Math.round(n).toLocaleString("en-US");
  const usd0 = (n) => `$${n0(n)}`;
  const usd2 = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const bil = (n) => `$${(n / 1e9).toFixed(2)}B`;
  const mx = (m) => `${m.toFixed(2)}x`;
  const dateNice = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
  function ts(ms, withDate) {
    const d = new Date(ms);
    const time = d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
    if (!withDate) return `${time} CT`;
    return `${d.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" })}, ${time} CT`;
  }
  const ago = (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 90) return `${s}s ago`;
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    return `${(s / 3600).toFixed(1)} h ago`;
  };
  const gridPct = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;

  /* ---------- derived state ---------- */
  const quote = () => (S.snap ? S.snap.mstr.price : null);
  const btcAtQuote = () => (S.snap ? (S.snap.mstr.btcAtQuote ?? S.snap.btc.price) : null);
  const btcNow = () => S.btcLive ?? (S.snap ? S.snap.btc.price : null);
  const liveMnav = (def = S.def) => (S.snap ? mnavOf(def, quote(), btcAtQuote()) : null);

  function btcAxis() {
    const mid = Math.round((btcNow() || 60000) / BTC_STEP) * BTC_STEP;
    const out = [];
    for (let v = mid - BTC_SPAN; v <= mid + BTC_SPAN; v += BTC_STEP) if (v > 0) out.push(v);
    return out;
  }
  function mnavAxis() {
    const out = [];
    for (let i = 0; Math.round((MN_MIN + i * MN_STEP) * 10) <= MN_MAX * 10; i++) out.push(Math.round((MN_MIN + i * MN_STEP) * 10) / 10);
    return out;
  }
  const nearestIdx = (arr, v) => arr.reduce((b, x, i) => (Math.abs(x - v) < Math.abs(arr[b] - v) ? i : b), 0);

  /* ---------- wheel ---------- */
  function makeWheel(host, label, fmt, onChange) {
    host.innerHTML = `<div class="wheel-vp" tabindex="0" role="slider" aria-orientation="vertical" aria-label="${esc(label)}"><div class="wheel-barrel"></div><div class="wheel-band"></div></div>`;
    const vp = host.firstElementChild;
    const barrel = vp.querySelector(".wheel-barrel");
    const R = (ITEM / 2) / Math.tan((THETA / 2) * Math.PI / 180);
    let values = [], els = [], pos = 0, lastIdx = -1, raf = 0;
    let drag = null;

    function build(vals) {
      values = vals;
      barrel.innerHTML = vals.map((v) => `<div class="wheel-item">${esc(fmt(v))}</div>`).join("");
      els = [...barrel.children];
      lastIdx = -1;
      pos = Math.min(Math.max(pos, 0), values.length - 1);
      layout(true);
    }
    function layout(silent) {
      for (let i = 0; i < els.length; i++) {
        const off = i - pos, a = Math.abs(off);
        const el = els[i];
        if (a > 3.3) { el.style.visibility = "hidden"; el.classList.remove("sel"); continue; }
        el.style.visibility = "visible";
        el.style.transform = `rotateX(${(-off * THETA).toFixed(2)}deg) translateZ(${R.toFixed(1)}px)`;
        el.style.opacity = String(Math.max(0.08, 1 - a * 0.3).toFixed(2));
        el.classList.toggle("sel", a < 0.5);
      }
      const idx = Math.round(pos);
      vp.setAttribute("aria-valuenow", values[idx] ?? "");
      vp.setAttribute("aria-valuetext", fmt(values[idx]));
      if (idx !== lastIdx) {
        lastIdx = idx;
        if (!silent) onChange(idx, values[idx], false);
      }
    }
    function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
    function animateTo(target, dur = 220, user = true) {
      stop();
      target = Math.min(Math.max(target, 0), values.length - 1);
      const from = pos, t0 = performance.now();
      if (from === target) { settle(user); return; }
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - k, 3);
        pos = from + (target - from) * e;
        layout();
        if (k < 1) raf = requestAnimationFrame(step);
        else { raf = 0; pos = target; layout(); settle(user); }
      };
      raf = requestAnimationFrame(step);
    }
    function settle(user) { onChange(Math.round(pos), values[Math.round(pos)], true, user); }

    vp.style.touchAction = "none";
    vp.addEventListener("pointerdown", (e) => {
      stop();
      vp.setPointerCapture(e.pointerId);
      drag = { y: e.clientY, startY: e.clientY, pos0: pos, samples: [[performance.now(), e.clientY]], moved: false };
      vp.classList.add("grab");
    });
    vp.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.startY;
      if (Math.abs(dy) > 4) drag.moved = true;
      pos = Math.min(Math.max(drag.pos0 - dy / ITEM, -0.35), values.length - 0.65);
      drag.samples.push([performance.now(), e.clientY]);
      if (drag.samples.length > 8) drag.samples.shift();
      layout();
      e.preventDefault();
    });
    const end = (e) => {
      if (!drag) return;
      const d = drag; drag = null;
      vp.classList.remove("grab");
      if (!d.moved) {
        const r = vp.getBoundingClientRect();
        const off = Math.round((e.clientY - (r.top + r.height / 2)) / ITEM);
        animateTo(Math.round(pos) + off, 200, true);
        return;
      }
      const s = d.samples, a = s[0], b = s[s.length - 1];
      const dt = Math.max(1, b[0] - a[0]);
      let v = -(b[1] - a[1]) / ITEM / dt; // items per ms (drag up => higher index)
      if (performance.now() - b[0] > 120) v = 0;
      const K = 0.004;
      const target = Math.round(pos + v / K);
      const dist = Math.abs(target - pos);
      animateTo(target, Math.min(1200, 200 + dist * 55), true);
    };
    vp.addEventListener("pointerup", end);
    vp.addEventListener("pointercancel", end);
    let wheelTarget = null;
    vp.addEventListener("wheel", (e) => {
      e.preventDefault();
      const base = wheelTarget ?? Math.round(pos);
      wheelTarget = base + (e.deltaY > 0 ? 1 : -1);
      wheelTarget = Math.min(Math.max(wheelTarget, 0), values.length - 1);
      animateTo(wheelTarget, 160, true);
      setTimeout(() => { wheelTarget = null; }, 220);
    }, { passive: false });
    vp.addEventListener("keydown", (e) => {
      const i = Math.round(pos);
      const map = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 };
      if (e.key in map) { e.preventDefault(); animateTo(i + map[e.key], 160, true); }
      else if (e.key === "Home") { e.preventDefault(); animateTo(0, 200, true); }
      else if (e.key === "End") { e.preventDefault(); animateTo(values.length - 1, 200, true); }
    });

    return {
      build,
      get index() { return Math.round(pos); },
      get value() { return values[Math.round(pos)]; },
      get values() { return values; },
      set(i, animated = true) { if (drag) return; if (animated) animateTo(i, 420, false); else { stop(); pos = i; layout(true); lastIdx = Math.round(pos); } },
    };
  }

  /* ---------- odometer (read-only) ---------- */
  function makeOdometer(host) {
    host.innerHTML = `<div class="odo-frame" role="img" aria-live="polite"><div class="odo"></div><div class="wheel-band"></div></div>`;
    const frame = host.firstElementChild;
    const odo = frame.querySelector(".odo");
    let sig = "", cells = [];
    const OH = 44;
    function structure(str) {
      odo.innerHTML = [...str].map((ch) => {
        if (/\d/.test(ch)) {
          const strip = Array.from({ length: 30 }, (_, i) => `<span>${i % 10}</span>`).join("");
          return `<span class="od"><span class="od-strip">${strip}</span></span>`;
        }
        return `<span class="oc">${esc(ch)}</span>`;
      }).join("");
      cells = [...odo.querySelectorAll(".od")].map((el) => ({ el, strip: el.firstElementChild, pos: 10 }));
      cells.forEach((c) => {
        c.strip.style.transition = "none";
        c.strip.style.transform = "translateY(0px)";
      });
      cells.forEach((c) => c.strip.addEventListener("transitionend", () => norm(c)));
    }
    function norm(c) {
      if (c.pos >= 10 && c.pos < 20) return;
      c.pos = 10 + (((c.pos % 10) + 10) % 10);
      c.strip.style.transition = "none";
      c.strip.style.transform = `translateY(${-c.pos * OH}px)`;
      void c.strip.offsetHeight;
      c.strip.style.transition = "";
    }
    function set(value) {
      const str = usd2(value);
      const shape = str.replace(/\d/g, "9");
      if (shape !== sig) {
        sig = shape;
        structure(str);
        cells.forEach((c, i) => {
          const d = Number([...str].filter((ch) => /\d/.test(ch))[i]);
          c.pos = 10 + d;
          c.strip.style.transform = `translateY(${-c.pos * OH}px)`;
        });
        frame.setAttribute("aria-label", `Implied MSTR price ${str}`);
        return;
      }
      const digits = [...str].filter((ch) => /\d/.test(ch)).map(Number);
      const n = cells.length;
      cells.forEach((c, i) => {
        const cur = ((c.pos % 10) + 10) % 10;
        let delta = (digits[i] - cur + 10) % 10;
        if (delta > 5) delta -= 10;
        if (!delta) return;
        c.pos += delta;
        c.strip.style.transition = `transform ${520 + (n - i) * 25}ms cubic-bezier(.2,.85,.25,1)`;
        c.strip.style.transform = `translateY(${-c.pos * OH}px)`;
      });
      frame.setAttribute("aria-label", `Implied MSTR price ${str}`);
    }
    return { set };
  }

  /* ---------- DOM ---------- */
  let wMn, wBtc, odo, defbarSig = "";

  function build() {
    root.innerHTML = `
      <header class="header">
        <div class="header-row">
          <div class="brand">
            <img src="apple-touch-icon.png" alt="">
            <div><h1>MSTR mNAV</h1><div class="sub">Estimate · read-only</div></div>
          </div>
          <button class="icon-btn" type="button" id="m-refresh" aria-label="Refresh">${A.ICONS.refresh}</button>
        </div>
        <div class="status" id="m-status">Loading…</div>
      </header>
      <main class="main">
        <section class="card mcard" id="m-panel"></section>
        <section class="card" id="m-feed"></section>
        <section class="card" id="m-wheelcard">
          <div class="section-h" style="margin:0 0 6px"><h2>Price wheels</h2><span class="meta">mNAV × BTC → MSTR</span></div>
          <div class="defbar" id="m-defbar"></div>
          <div class="wheels">
            <div class="wcol"><div class="wlab">mNAV</div><div id="w-mn"></div><div class="wcap">0.5x – 3.0x</div></div>
            <div class="wcol"><div class="wlab">BTC price</div><div id="w-btc"></div><div class="wcap">±$20,000 · $2,500 steps</div></div>
            <div class="wcol wout"><div class="wlab">MSTR (implied)</div><div id="w-out"></div><div class="wcap">calculated</div></div>
          </div>
          <div class="wread" id="m-read"></div>
          <div class="wbtns"><button type="button" class="chip" id="m-reset">Reset to live</button></div>
          <div class="grid-h"><h3>Price grid</h3><span class="meta">every mNAV × every BTC step</span></div>
          <div class="heat-wrap" id="m-heat"></div>
          <p class="fine" id="m-formula"></p>
        </section>
        <section id="m-poly"></section>
        <p class="fine disclaimer">Estimates only, not investment advice. mNAV here is computed from a delayed MSTR quote, live BTC, and Strategy’s published holdings and claims (dated above). Strategy’s own dashboard may differ. Read-only: no trading, no wallet.</p>
      </main>`;
    wMn = makeWheel(root.querySelector("#w-mn"), "mNAV", (v) => `${v.toFixed(1)}x`, onWheel);
    wBtc = makeWheel(root.querySelector("#w-btc"), "BTC price", (v) => usd0(v), onWheel);
    odo = makeOdometer(root.querySelector("#w-out"));
    S.built = true;
  }

  function onWheel(_i, _v, settled, user) {
    if (user) S.touched = true;
    paintOut();
    if (settled) { paintHeatSel(true); }
    else paintHeatSel(false);
  }

  function status(msg, err) {
    const el = root.querySelector("#m-status");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("error", !!err);
  }

  function sessionText() {
    const m = S.snap.mstr;
    return ({
      regular: "Market open (quote delayed)",
      pre: "Pre-market",
      post: "After-hours",
      closed: "Market closed · last trade",
      unknown: "Last trade (delayed)",
    })[m.session] || "Last trade";
  }

  function paintStatus() {
    if (!S.snap) { status(S.snapErr ? `MSTR quote unavailable: ${S.snapErr}` : "Loading…", !!S.snapErr); return; }
    const gen = Date.parse(S.snap.generatedAt);
    const bits = [`MSTR quote ${ts(S.snap.mstr.priceTime * 1000)}`, `snapshot ${ago(gen)}`];
    if (S.btcLiveAt) bits.push(`BTC live ${ago(S.btcLiveAt)}`);
    const stale = Date.now() - gen > (S.snap.mstr.session === "closed" ? 3.5 : 0.5) * 3600e3;
    if (S.snapSource === "seed") status(`Using bundled snapshot (live feed unavailable) · ${bits[0]}`, true);
    else if (stale) status(`Snapshot is ${ago(gen)} old, so MSTR may be behind · ${bits[0]}`, true);
    else status(bits.join(" · "), false);
  }

  function paintPanel() {
    const el = root.querySelector("#m-panel");
    if (!el) return;
    if (!S.snap || !S.cfg) { el.innerHTML = `<div class="empty">${S.snapErr ? esc(S.snapErr) : "Loading MSTR data…"}</div>`; return; }
    const c = S.cfg, snap = S.snap, price = quote(), bq = btcAtQuote(), bl = btcNow();
    const vals = Object.fromEntries(Object.keys(DEFS).map((d) => [d, mnavOf(d, price, bq)]));
    const m = vals[S.def];
    const moved = bl && bq ? (bl / bq - 1) * 100 : 0;
    const pub = c.strategyPublishedMnav;
    const chg = snap.mstr.prevClose ? (price / snap.mstr.prevClose - 1) * 100 : null;
    el.innerHTML = `
      <div class="m-kicker">Likely current mNAV · estimate</div>
      <div class="m-bigrow">
        <div class="m-big">${mx(m)}</div>
        <div class="m-pct">${Math.round(m * 100)}%</div>
        <button class="m-poly" type="button" data-m-poly aria-label="MSTR odds on Polymarket">${A.ICONS.chart}<span>Polymarket</span></button>
      </div>
      <div class="m-sub">${esc(DEFS[S.def].label)} · ${esc(sessionText())}</div>
      <div class="m-defs" role="tablist">
        ${Object.keys(DEFS).map((d) => `<button type="button" class="mdef ${d === S.def ? "on" : ""}" data-def="${d}"><b>${mx(vals[d])}</b><span>${esc(DEFS[d].short)}</span></button>`).join("")}
      </div>
      <div class="m-stats">
        <div><span>MSTR price</span><b>${usd2(price)}</b><i>${chg != null ? gridPct(chg) + " vs prev close · " : ""}${ts(snap.mstr.priceTime * 1000)}</i></div>
        <div><span>BTC (Coinbase)</span><b>${usd0(bl)}</b><i>live · ${gridPct(moved)} since quote</i></div>
        <div><span>BTC held</span><b>${n0(c.btcHoldings)}</b><i>as of ${dateNice(c.btcHoldingsAsOf)}</i></div>
        <div><span>Shares used</span><b>${(sharesFor(S.def) / 1e6).toFixed(1)}M</b><i>${esc(DEFS[S.def].shares)} · as of ${dateNice(c.sharesAsOf)}</i></div>
        <div><span>Debt (notional)</span><b>${bil(c.debtNotional)}</b><i>as of ${dateNice(c.claimsAsOf)}</i></div>
        <div><span>Preferred (notional)</span><b>${bil(c.preferredNotional)}</b><i>as of ${dateNice(c.claimsAsOf)}</i></div>
        <div><span>USD assets</span><b>${bil(c.usdAssets)}</b><i>reserve + cash · ${dateNice(c.usdAssetsAsOf)}</i></div>
        <div><span>Strategy published</span><b>${pub.value.toFixed(2)}x</b><i>${dateNice(pub.asOf)} · MSTR $${pub.mstrPrice} · BTC ${usd0(pub.btcPrice)}</i></div>
      </div>
      <p class="fine"><b>Formula (${esc(DEFS[S.def].label)}):</b> ${esc(DEFS[S.def].calc)} mNAV uses the MSTR quote paired with BTC at the same moment (${usd0(bq)}). MSTR is a delayed Yahoo Finance quote refreshed about every 5 min; BTC is live from Coinbase. Constants are from Strategy’s <a href="${esc(c.briefingUrl)}" target="_blank" rel="noopener">Investor Briefing</a> and <a href="${esc(c.sourceUrl)}" target="_blank" rel="noopener">Form 8-K</a>.</p>`;
  }

  function series() {
    if (!S.snap || !S.cfg) return [];
    const h = S.snap.history || [];
    const slice = S.range === "1d" ? h.slice(-192) : h;
    return slice.map(([t, p, b]) => ({ t: t * 1000, p, b, m: mnavOf(S.def, p, b) }));
  }

  function spark(pts) {
    if (pts.length < 2) return "";
    const W = 340, H = 96, L = 4, R = 4, T = 8, B = 8;
    const ms = pts.map((p) => p.m);
    let lo = Math.min(...ms), hi = Math.max(...ms);
    const pad = Math.max(0.01, (hi - lo) * 0.1); lo -= pad; hi += pad;
    const x = (i) => L + (i / (pts.length - 1)) * (W - L - R);
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.m).toFixed(1)}`).join("");
    const last = pts[pts.length - 1];
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="mNAV over time"><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/><circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last.m).toFixed(1)}" r="3.5" fill="var(--accent)"/></svg>
      <div class="spark-lab"><span>low ${mx(Math.min(...ms))}</span><span>high ${mx(Math.max(...ms))}</span></div>`;
  }

  function paintFeed() {
    const el = root.querySelector("#m-feed");
    if (!el) return;
    if (!S.snap || !S.cfg) { el.innerHTML = ""; return; }
    const pts = series();
    const rows = pts.slice(-36).reverse();
    el.innerHTML = `
      <div class="section-h" style="margin:0 0 8px"><h2>mNAV feed</h2>
        <span class="chips" style="margin:0;gap:6px"><button class="chip ${S.range === "1d" ? "active" : ""}" data-range="1d" type="button">1 day</button><button class="chip ${S.range === "5d" ? "active" : ""}" data-range="5d" type="button">5 days</button></span>
      </div>
      ${spark(pts)}
      <div class="feed" role="table" aria-label="Recent mNAV readings">
        <div class="frow fhead" role="row"><span>Time (CT)</span><span>MSTR</span><span>BTC</span><span>mNAV</span></div>
        <div class="frow now" role="row"><span>Live BTC</span><span>—</span><span>${usd0(btcNow())}</span><span>${mx(liveMnav())}</span></div>
        ${rows.map((r) => `<div class="frow" role="row"><span>${ts(r.t, true).replace(" CT", "")}</span><span>${usd2(r.p)}</span><span>${usd0(r.b)}</span><span><b>${mx(r.m)}</b></span></div>`).join("")}
      </div>
      <p class="fine">5-minute bars including pre-market and after-hours. New readings arrive about every 5 min; the page re-checks every minute and BTC every 30 seconds.</p>`;
  }

  function paintDefbar() {
    const el = root.querySelector("#m-defbar");
    if (!el || !S.cfg) return;
    const sig = S.def;
    el.innerHTML = Object.keys(DEFS).map((d) => `<button type="button" class="chip ${d === S.def ? "active" : ""}" data-def="${d}">${esc(DEFS[d].label)}</button>`).join("");
    defbarSig = sig;
    const f = root.querySelector("#m-formula");
    if (f) f.innerHTML = `<b>Definition in effect: ${esc(DEFS[S.def].label)}.</b> ${esc(DEFS[S.def].inv)}. Uses BTC held ${n0(S.cfg.btcHoldings)} (${dateNice(S.cfg.btcHoldingsAsOf)}), USD assets ${bil(S.cfg.usdAssets)}, debt ${bil(S.cfg.debtNotional)}, preferred ${bil(S.cfg.preferredNotional)}, ${(sharesFor(S.def) / 1e6).toFixed(1)}M ${esc(DEFS[S.def].shares)} shares.`;
  }

  function currentPrice() {
    return impliedOf(S.def, wMn.value, wBtc.value);
  }

  function paintOut() {
    if (!S.cfg || !wMn || !wMn.values.length || !wBtc.values.length) return;
    const p = currentPrice();
    odo.set(p);
    const q = quote();
    const rd = root.querySelector("#m-read");
    if (!rd) return;
    const vs = q ? (p / q - 1) * 100 : null;
    const lm = S.snap ? liveMnav() : null;
    rd.innerHTML = `<div><b>${wMn.value.toFixed(1)}x</b> mNAV at <b>${usd0(wBtc.value)}</b> BTC → <b class="g">${usd2(p)}</b> MSTR${vs != null ? ` <span class="${vs >= 0 ? "up" : "down"}">${gridPct(vs)} vs last quote</span>` : ""}</div>
      ${S.snap ? `<div class="fine">Live: ${mx(lm)} at ${usd0(btcAtQuote())} → ${usd2(q)} exact (${esc(DEFS[S.def].short)} definition).</div>` : ""}`;
  }

  function heatColor(price, q) {
    if (!q || price <= 0) return "transparent";
    const r = Math.log(price / q);
    const a = Math.min(0.62, Math.abs(r) / Math.log(2.6) * 0.62);
    return r >= 0 ? `rgba(61,214,140,${a.toFixed(3)})` : `rgba(255,107,122,${a.toFixed(3)})`;
  }

  function paintHeat() {
    const el = root.querySelector("#m-heat");
    if (!el || !S.cfg) return;
    const mns = mnavAxis(), btcs = wBtc.values.length ? wBtc.values : btcAxis();
    const q = quote();
    const lm = S.snap ? liveMnav() : null;
    const liveRow = lm != null ? nearestIdx(mns, lm) : -1;
    const liveCol = btcNow() ? nearestIdx(btcs, btcNow()) : -1;
    let html = `<table class="heat"><thead><tr><th class="corner">mNAV ↓ / BTC →</th>${btcs.map((b, j) => `<th data-c="${j}" class="${j === liveCol ? "livec" : ""}">${(b / 1000).toFixed(1)}k</th>`).join("")}</tr></thead><tbody>`;
    mns.forEach((m, i) => {
      html += `<tr data-r="${i}"><th class="${i === liveRow ? "liver" : ""}">${m.toFixed(1)}x</th>`;
      btcs.forEach((b, j) => {
        const p = impliedOf(S.def, m, b);
        html += `<td data-r="${i}" data-c="${j}" style="background:${heatColor(p, q)}" class="${i === liveRow && j === liveCol ? "live" : ""}">${p >= 100 ? n0(p) : p.toFixed(1)}</td>`;
      });
      html += "</tr>";
    });
    html += `</tbody></table>`;
    el.innerHTML = html;
    paintHeatSel(true);
  }

  function paintHeatSel(scroll) {
    const el = root.querySelector("#m-heat");
    if (!el || !wMn || !wMn.values.length) return;
    const r = wMn.index, c = wBtc.index;
    el.querySelectorAll("td.sel,th.sel").forEach((n) => n.classList.remove("sel"));
    const td = el.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
    if (td) td.classList.add("sel");
    el.querySelector(`tbody tr[data-r="${r}"] th`)?.classList.add("sel");
    el.querySelector(`thead th[data-c="${c}"]`)?.classList.add("sel");
    if (scroll && td) {
      el.scrollTo({ left: Math.max(0, td.offsetLeft - el.clientWidth / 2 + td.offsetWidth / 2), top: Math.max(0, td.offsetTop - el.clientHeight / 2), behavior: "smooth" });
    }
  }

  function syncWheels(forceLive) {
    if (!S.cfg || !S.built) return;
    const btcs = btcAxis();
    const mns = mnavAxis();
    const mnLive = S.snap ? nearestIdx(mns, liveMnav()) : nearestIdx(mns, 1.0);
    const anchor = btcs[Math.floor(btcs.length / 2)];
    const first = !wMn.values.length;
    if (first || forceLive || (!S.touched && anchor !== S.anchor)) {
      S.anchor = anchor;
      wMn.build(mns); wBtc.build(btcs);
      wMn.set(mnLive, !first); wBtc.set(nearestIdx(btcs, btcNow() || anchor), !first);
      paintHeat();
    } else if (!S.touched) {
      wMn.set(mnLive, true);
    }
    paintDefbar();
    paintOut();
  }

  function paintPoly() {
    const el = root.querySelector("#m-poly");
    if (!el) return;
    const list = S.poly;
    let body;
    if (S.polyErr && !list.length) body = `<div class="empty">Couldn’t load Polymarket MSTR markets (${esc(S.polyErr)}).</div>`;
    else if (!list.length) body = `<div class="empty">Loading MSTR markets…</div>`;
    else body = list.map((ev) => A.renderEventCard(ev)).join("");
    el.innerHTML = `<div class="section-h" id="m-poly-h"><h2>MSTR on Polymarket</h2><span class="meta">tap a % for the odds chart</span></div>${body}`;
  }

  /* ---------- data ---------- */
  async function loadConfig() {
    if (S.cfg) return;
    const res = await fetch(CFG_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error(`config ${res.status}`);
    S.cfg = await res.json();
  }

  async function loadSnap() {
    const sources = [
      () => fetch(`${SNAP_URL}?t=${Math.floor(Date.now() / 60000)}`, { cache: "no-store" }),
      // second CDN for the same file (purged by the Action after every push)
      () => fetch(`https://cdn.jsdelivr.net/gh/${REPO}@data/data/mstr.json`),
      // last live fallback (GitHub API, rate-limited, used rarely)
      () => fetch(`https://api.github.com/repos/${REPO}/contents/data/mstr.json?ref=data`, { headers: { Accept: "application/vnd.github.raw+json" } }),
    ];
    let lastErr = null;
    for (const get of sources) {
      try {
        const res = await get();
        if (!res.ok) throw new Error(`snapshot ${res.status}`);
        const j = await res.json();
        if (!j || !j.mstr) throw new Error("bad snapshot");
        S.snap = j; S.snapSource = "live"; S.snapErr = null;
        return;
      } catch (err) { lastErr = err; }
    }
    if (!S.snap) {
      try {
        const r2 = await fetch(SEED_URL, { cache: "no-cache" });
        S.snap = await r2.json();
        S.snapSource = "seed"; S.snapErr = null;
      } catch (e2) { S.snapErr = lastErr ? lastErr.message : "no snapshot"; }
    }
  }

  async function loadBtc() {
    try {
      const res = await fetch(CB_URL, { cache: "no-store" });
      const j = await res.json();
      const p = Number(j.price);
      if (Number.isFinite(p)) { S.btcLive = p; S.btcLiveAt = Date.now(); }
    } catch { /* keep last */ }
  }

  async function loadPoly() {
    try {
      const qs = ["MSTR", "MicroStrategy"];
      const res = await Promise.all(qs.map((q) => fetch(`https://gamma-api.polymarket.com/public-search?q=${q}&events_status=active&limit_per_type=12`).then((r) => r.json())));
      const seen = new Map();
      for (const r of res) for (const ev of (r.events || [])) {
        if (ev.closed || !ev.slug || seen.has(ev.slug)) continue;
        if (Date.parse(ev.endDate) < Date.now()) continue;
        if (!/mstr|microstrategy|strategy|saylor/i.test(ev.title || "")) continue;
        const slim = A.slimEvent(ev);
        slim.kind = "other";
        if (slim.markets.length) seen.set(ev.slug, slim);
      }
      S.poly = [...seen.values()].sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0) || Date.parse(a.endDate) - Date.parse(b.endDate)).slice(0, 8);
      S.polyErr = null; S.polyAt = Date.now();
    } catch (err) { S.polyErr = err.message; }
  }

  async function refreshAll(opts = {}) {
    if (S.loading) return;
    S.loading = true;
    const btn = root.querySelector("#m-refresh");
    btn?.classList.add("spinning");
    try {
      await loadConfig();
      await Promise.all([loadBtc(), opts.btcOnly ? null : loadSnap(), (!opts.btcOnly && Date.now() - S.polyAt > 4 * 60e3) ? loadPoly() : null]);
    } catch (err) {
      S.snapErr = err.message;
    } finally {
      S.loading = false;
      btn?.classList.remove("spinning");
    }
    paintAll();
  }

  function paintAll() {
    if (!S.built) return;
    paintStatus(); paintPanel(); paintFeed(); syncWheels(false); paintPoly();
  }

  /* ---------- lifecycle ---------- */
  function start() {
    if (!S.built) build();
    if (!S.timer) {
      S.timer = setInterval(() => {
        if (!S.active || document.visibilityState === "hidden") return;
        S.tick++;
        refreshAll({ btcOnly: S.tick % 2 !== 0 });
      }, 30_000);
    }
    refreshAll();
  }
  function stopTimers() { if (S.timer) { clearInterval(S.timer); S.timer = null; } }

  // app.js may already have switched to this tab before this script ran
  if (!root.hidden) { S.active = true; setTimeout(start, 0); }

  window.addEventListener("pm-tab", (e) => {
    S.active = e.detail === "mstr";
    if (S.active) start(); else stopTimers();
  });
  document.addEventListener("visibilitychange", () => {
    if (S.active && document.visibilityState === "visible") refreshAll();
  });
  window.addEventListener("pm-render", () => { if (S.built && S.poly.length) paintPoly(); });

  document.addEventListener("click", (e) => {
    if (root.hidden) return;
    const d = e.target.closest("#mstr-root [data-def]");
    if (d) {
      S.def = d.getAttribute("data-def");
      localStorage.setItem(DEF_KEY, S.def);
      paintPanel(); paintFeed(); paintDefbar(); paintHeat(); paintOut();
      if (!S.touched && S.snap) wMn.set(nearestIdx(mnavAxis(), liveMnav()), true);
      return;
    }
    const r = e.target.closest("#mstr-root [data-range]");
    if (r) { S.range = r.getAttribute("data-range"); paintFeed(); return; }
    if (e.target.closest("#m-refresh")) { refreshAll(); return; }
    if (e.target.closest("#m-reset")) { S.touched = false; syncWheels(true); return; }
    if (e.target.closest("[data-m-poly]")) { document.getElementById("m-poly-h")?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    const td = e.target.closest("#m-heat td");
    if (td) {
      S.touched = true;
      wMn.set(Number(td.dataset.r), true);
      wBtc.set(Number(td.dataset.c), true);
    }
  });
})();
