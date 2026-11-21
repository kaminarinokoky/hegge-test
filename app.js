/* ==========================================================================
 *  Hegeh Fast Food — online ordering SPA
 *  Alpine.js component + pure helpers. No build step, no backend.
 *
 *  Flow: load menu.json → restore cart → poll POS health → customize/add →
 *        checkout → POST to POS bridge → printable 80 mm receipt.
 *
 *  Sections
 *    1. Constants & storage          5. Receipt (80 mm thermal) builder
 *    2. Generic helpers              6. Alpine component
 *    3. Menu / cart pricing helpers
 *    4. POS health + Baransys payload
 * ========================================================================== */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ 1 --- */
  const LS = {
    cart: 'hg.cart.v1',
    customer: 'hg.customer.v1',
    config: 'hg.config.v1',
    seq: 'hg.seq.v1',
    last: 'hg.lastOrder.v1',
  };

  // Used only if menu.json fails to load or omits meta.pos
  const FALLBACK_POS = {
    baseUrl: 'http://localhost:8080',
    healthPath: '/health',
    orderPath: '/api/orders',
    timeoutMs: 4000,
    pollMs: 30000,
  };

  const CLOSED_MESSAGE = 'سفارش آنلاین فعلاً بسته است';

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (_) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; }
      catch (_) { return false; }
    },
    remove(key) { try { localStorage.removeItem(key); } catch (_) { /* ignore */ } },
  };

  /* ------------------------------------------------------------------ 2 --- */
  const pad = (n) => String(n).padStart(2, '0');
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

  /** Persian (۰-۹) and Arabic-Indic (٠-٩) digits → ASCII digits. */
  const toAsciiDigits = (s) => String(s == null ? '' : s)
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));

  /** Search key: ASCII digits, Persian ی/ک instead of Arabic ي/ك, zero-width marks → space. */
  const normFa = (s) => toAsciiDigits(s)
    .replace(/\u064A/g, '\u06CC').replace(/\u0643/g, '\u06A9')
    .replace(/[\u200C\u200E\u200F]/g, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();

  const normalizePhone = (s) => toAsciiDigits(s).replace(/[\s\-().]/g, '');
  const isValidPhone = (s) => /^\+?\d{8,15}$/.test(s);

  function formatMoney(value, cur) {
    const c = cur || {};
    const n = Math.round(Number(value) || 0);
    return `${n.toLocaleString(c.locale || 'en-US')} ${c.symbol || ''}`.trim();
  }

  /** ISO-8601 timestamp in the *local* zone, e.g. 2026-11-19T00:41:55+03:30 */
  function localISO(d) {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
      `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  }

  /* ---- URL helpers --------------------------------------------------------- */
  function isLoopbackHost(h) {
    return h === 'localhost' || h === '[::1]' || h === '::1' || /\.localhost$/i.test(h) ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
  }

  function isPrivateHost(h) {
    if (isLoopbackHost(h)) return true;
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) ||
        (a === 169 && b === 254);
    }
    return /\.local$/i.test(h);
  }

  /** "192.168.1.20:9000" | "http://pos.lan:8080/x" → "http://host:port/x" (no trailing slash) */
  function normalizeBaseUrl(raw, port) {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    try {
      const u = new URL(s);
      if (port && !u.port) u.port = String(port).replace(/\D/g, '');
      return u.origin + u.pathname.replace(/\/+$/, '');
    } catch (_) { return null; }
  }

  const normPath = (p, dflt) => {
    const s = String(p || '').trim() || dflt;
    return s.startsWith('/') ? s : '/' + s;
  };

  const joinUrl = (base, path) => base.replace(/\/+$/, '') + '/' + String(path || '').replace(/^\/+/, '');

  /** An https:// page may not call plain http:// — except loopback, which browsers exempt. */
  function mixedContentBlocked(url) {
    try {
      const u = new URL(url);
      return location.protocol === 'https:' && u.protocol === 'http:' && !isLoopbackHost(u.hostname);
    } catch (_) { return false; }
  }

  /* ------------------------------------------------------------------ 3 --- */
  function indexMenu(raw) {
    if (!raw || !Array.isArray(raw.items) || !Array.isArray(raw.categories)) {
      throw new Error('menu.json is missing "items" or "categories"');
    }
    raw.optionGroups = raw.optionGroups || {};
    raw.meta = raw.meta || {};
    raw.itemsById = Object.fromEntries(raw.items.map((i) => [i.id, i]));
    return raw;
  }

  function defaultSelections(menu, item) {
    const sel = {};
    for (const gid of item.options || []) {
      const g = menu.optionGroups[gid];
      if (!g) continue;
      if (g.type === 'multi') {
        sel[gid] = g.choices.filter((c) => c.default).map((c) => c.id);
      } else {
        const d = g.choices.find((c) => c.default) || g.choices[0];
        sel[gid] = d ? [d.id] : [];
      }
    }
    return sel;
  }

  /** Drop unknown groups/choices, enforce max — used when restoring a saved cart. */
  function sanitizeSelections(menu, item, sel) {
    const out = defaultSelections(menu, item);
    for (const gid of item.options || []) {
      const g = menu.optionGroups[gid];
      if (!g || !sel || !Array.isArray(sel[gid])) continue;
      const valid = sel[gid].filter((cid) => g.choices.some((c) => c.id === cid));
      if (g.type === 'multi') out[gid] = valid.slice(0, g.max || valid.length);
      else if (valid.length) out[gid] = [valid[0]];
    }
    return out;
  }

  const lineKey = (itemId, sel, note) =>
    itemId + '|' +
    Object.keys(sel || {}).sort().map((g) => g + '=' + [...sel[g]].sort().join(',')).join(';') +
    '|' + (note || '');

  /** Turns a stored cart line into a priced, display-ready line (prices always come from the menu). */
  function resolveLine(menu, line) {
    const item = menu.itemsById[line.itemId];
    if (!item) return null;
    let unit = Number(item.price) || 0;
    const mods = [];
    for (const gid of item.options || []) {
      const g = menu.optionGroups[gid];
      if (!g) continue;
      for (const cid of (line.selections && line.selections[gid]) || []) {
        const c = g.choices.find((x) => x.id === cid);
        if (!c) continue;
        unit += Number(c.price) || 0;
        if (!c.none) mods.push({ group: g.label, label: c.label, price: Number(c.price) || 0 });
      }
    }
    const qty = line.qty || 1;
    return { key: line.key, item, qty, unit, mods, note: line.note || '', lineTotal: unit * qty };
  }

  /* ------------------------------------------------------------------ 4 --- */
  async function timedFetch(url, init, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = performance.now();
    try {
      const res = await fetch(url, { cache: 'no-store', credentials: 'omit', ...init, signal: ctrl.signal });
      const text = init.mode === 'no-cors' ? '' : await res.text();
      return { res, text, ms: Math.round(performance.now() - t0) };
    } finally { clearTimeout(timer); }
  }

  /**
   * Pings the POS bridge. Expected contract (anything that answers HTTP 200 counts as online):
   *   GET {baseUrl}{healthPath}  →  200  (optional JSON: {"status":"ok","open":true})
   * The bridge can close online ordering remotely by answering {"open":false} or {"status":"closed"}.
   * The bridge must send CORS headers (Access-Control-Allow-Origin) for this page's origin.
   */
  async function probeHealth(cfg, diagnose) {
    if (cfg.simulate === 'offline') return { online: false, reason: 'حالت آفلاین شبیه‌سازی شده (تنظیمات پرسنل)' };
    if (cfg.simulate === 'online') return { online: true, latency: 0, simulated: true };

    const base = normalizeBaseUrl(cfg.baseUrl);
    if (!base) return { online: false, reason: 'آدرس POS تنظیم نشده یا نامعتبر است' };
    const url = joinUrl(base, cfg.healthPath);

    if (mixedContentBlocked(url)) {
      return {
        online: false,
        reason: 'مرورگر مسدود کرد: صفحه https نمی‌تواند به آدرس http ساده وصل شود ' +
          '(فقط localhost مستثناست). پل POS را با آدرس https در دسترس بگذار.',
      };
    }

    try {
      const r = await timedFetch(url, { method: 'GET', mode: 'cors' }, cfg.timeoutMs);
      if (!r.res.ok) return { online: false, reason: `POS با کد HTTP ${r.res.status} پاسخ داد` };
      let body = null;
      try { body = JSON.parse(r.text); } catch (_) { /* plain "OK" is fine */ }
      if (body && (body.open === false || String(body.status).toLowerCase() === 'closed')) {
        return { online: false, reason: 'POS اعلام کرده سفارش آنلاین بسته است' };
      }
      return { online: true, latency: r.ms, body };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return { online: false, reason: `تا ${cfg.timeoutMs} میلی‌ثانیه پاسخی نیامد` };
      }
      if (diagnose) {
        try {
          await timedFetch(url, { method: 'GET', mode: 'no-cors' }, cfg.timeoutMs);
          return { online: false, reason: 'سرور در دسترس است ولی این صفحه را مسدود می‌کند (هدرهای CORS تنظیم نشده).' };
        } catch (_) { /* fall through */ }
      }
      return { online: false, reason: 'در دسترس نیست (خاموش، آدرس اشتباه، CORS یا درخواست مسدود)' };
    }
  }

  /**
   * Maps our order to the JSON sent to the local POS gateway.
   * NOTE: the exact Baransys schema is not public — field names below are a sensible,
   * documented default. Adjust ONLY this function to match the real bridge contract.
   */
  function buildBaransysPayload(o) {
    const isDelivery = o.fulfillment === 'delivery';
    return {
      schema: 'baransys.digital-menu.order/1',
      source: 'web-digital-menu',
      orderNumber: o.orderId,
      reference: o.reference, // unique, timestamp-based — dedupe on this
      createdAt: o.createdAt,
      orderType: isDelivery ? 'DELIVERY' : 'TAKEAWAY',
      payment: {
        method: 'CASH',
        status: 'UNPAID',
        note: isDelivery ? 'On Delivery' : 'Pay at Counter',
      },
      customer: {
        name: o.customer.name,
        phone: o.customer.phone,
        address: isDelivery ? o.customer.address : null,
      },
      deliveryNotes: isDelivery ? o.customer.deliveryNotes || null : null,
      pickupTimeNote: isDelivery ? null : o.customer.pickupTime || null,
      items: o.items.map((l) => ({
        code: l.sku,
        name: l.name,
        nameFa: l.nameFa || null,
        quantity: l.qty,
        unitPrice: l.unit,
        total: l.lineTotal,
        modifiers: l.mods.map((m) => ({ group: m.group, name: m.label, price: m.price })),
        comment: l.note || null,
      })),
      totals: {
        itemCount: o.totals.itemCount,
        subtotal: o.totals.subtotal,
        deliveryFee: o.totals.deliveryFee,
        total: o.totals.total,
        currency: o.totals.currency,
      },
    };
  }

  /* ------------------------------------------------------------------ 5 --- */
  /**
   * 80 mm thermal receipt: customer copy + cut line + kitchen copy + cut line.
   * Styling lives in index.html (.receipt, .r-*). Every dynamic string goes through esc().
   */
  function buildReceiptHTML(o, meta) {
    const r = meta.restaurant || {};
    const money = (v) => esc(formatMoney(v, meta.currency));
    const d = new Date(o.createdAt);
    const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}  ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const isDelivery = o.fulfillment === 'delivery';
    const typeLabel = isDelivery ? 'DELIVERY' : 'PICKUP / COUNTER';

    const itemRows = (kitchen) => o.items.map((l) => `
      <div class="r-item">
        <div class="r-row">
          <span class="r-qty">${l.qty}&times;</span>
          <span class="r-name" dir="auto">${esc(l.name)}</span>
          ${kitchen ? '' : `<span class="r-amt">${money(l.lineTotal)}</span>`}
        </div>
        ${l.mods.map((m) => `<div class="r-mod" dir="auto">+ ${esc(m.group)}: ${esc(m.label)}</div>`).join('')}
        ${l.note ? `<div class="r-mod r-note" dir="auto">NOTE: ${esc(l.note)}</div>` : ''}
      </div>`).join('');

    const field = (label, value) => value
      ? `<div class="r-lbl">${esc(label)}</div><div class="r-val">${esc(value)}</div>` : '';

    const cut = '<div class="r-cut"><span>&#9986; CUT HERE</span></div>';

    return `
<div class="receipt" dir="ltr">
  <div class="r-center">
    <div class="r-brand">${esc(r.name)}</div>
    <div class="r-fa" lang="fa" dir="rtl">${esc(r.nameFa)}</div>
    <div class="r-small">${esc(r.address)}</div>
    <div class="r-small">Tel: ${esc(r.phone)}</div>
  </div>
  <div class="r-rule"></div>
  <div class="r-center">
    <div class="r-small">ORDER</div>
    <div class="r-big">#${esc(o.orderId)}</div>
    <div class="r-tag">${typeLabel}</div>
    <div class="r-small">${esc(when)}</div>
  </div>
  <div class="r-rule"></div>
  ${field('Name', o.customer.name)}
  ${field('Phone', o.customer.phone)}
  ${isDelivery ? field('Address', o.customer.address) + field('Delivery notes', o.customer.deliveryNotes)
               : field('Pickup time', o.customer.pickupTime)}
  <div class="r-rule"></div>
  <div class="r-row r-head"><span>QTY&nbsp; ITEM</span><span>AMOUNT</span></div>
  ${itemRows(false)}
  <div class="r-rule"></div>
  <div class="r-row"><b>TOTAL ITEMS</b><b class="r-count">${o.totals.itemCount}</b></div>
  <div class="r-row"><span>Subtotal</span><span>${money(o.totals.subtotal)}</span></div>
  ${o.totals.deliveryFee ? `<div class="r-row"><span>Delivery fee</span><span>${money(o.totals.deliveryFee)}</span></div>` : ''}
  <div class="r-row r-total"><span>TOTAL</span><span>${money(o.totals.total)}</span></div>
  <div class="r-rule solid"></div>
  <div class="r-center r-pay">${isDelivery ? 'PAY ON DELIVERY' : 'PAY AT COUNTER'}</div>
  <div class="r-center r-small">Thank you for your order!</div>
  <div class="r-center r-tiny">Ref ${esc(o.reference)}</div>
  ${o.simulated ? '<div class="r-center r-demo">*** DEMO ORDER - NOT SENT TO POS ***</div>' : ''}

  ${cut}

  <div class="r-kitchen">
    <div class="r-center">
      <div class="r-inv">KITCHEN COPY</div>
      <div class="r-big">#${esc(o.orderId)}</div>
      <div class="r-tag">${typeLabel}</div>
      <div class="r-small">${esc(when)}</div>
    </div>
    <div class="r-rule"></div>
    ${itemRows(true)}
    <div class="r-rule"></div>
    <div class="r-row"><b>TOTAL ITEMS</b><b class="r-count">${o.totals.itemCount}</b></div>
    ${isDelivery ? field('Delivery notes', o.customer.deliveryNotes) : field('Pickup time', o.customer.pickupTime)}
    ${field('Customer', o.customer.name)}
  </div>

  ${cut}
  <div class="r-feed"></div>
</div>`;
  }

  /* ------------------------------------------------------------------ 6 --- */
  function app() {
    // Non-reactive internals
    let pollTimer = null;
    let inflight = null;   // in-flight health check promise
    let pending = null;    // order identity kept across retries of the same cart
    let toastTimer = null;

    function nextSeq() {
      const s = store.get(LS.seq, null);
      // First order on a device is seeded from the clock so different devices rarely start equal.
      let n = s && Number.isFinite(s.n) ? s.n + 1 : 1000 + (Math.floor(Date.now() / 60000) % 8000);
      if (!store.set(LS.seq, { n })) n = 1000 + (Math.floor(Date.now() / 1000) % 9000); // storage blocked
      return n;
    }

    return {
      /* ------------------------------ state ------------------------------ */
      menu: null,
      loading: true,
      loadError: '',
      activeCategory: 'all',
      search: '',

      cart: [],
      drawerOpen: false,
      drawerView: 'cart', // 'cart' | 'checkout'

      cz: { open: false, item: null, selections: {}, qty: 1, note: '' },

      fulfillment: 'delivery',
      form: { name: '', phone: '', address: '', deliveryNotes: '', pickupTime: '', remember: true },
      pickupPresets: ['در اولین فرصت', '۱۵ دقیقه دیگه', '۳۰ دقیقه دیگه', '۱ ساعت دیگه'],
      errors: {},
      submitting: false,
      submitError: '',

      pos: { status: 'checking', reason: '', latency: null, lastChecked: null, failStreak: 0, spinning: false, simulated: false },
      saved: {},
      urlOverride: '',
      devVisible: false,
      openConfigOnLoad: false,
      configOpen: false,
      draft: {},
      testResult: null,
      testing: false,

      receiptOpen: false,
      lastOrder: null,
      hasLast: false,
      toastMsg: '',
      logoFailed: false,

      /* ----------------------------- lifecycle --------------------------- */
      async init() {
        this.parseUrlParams();
        this.saved = store.get(LS.config, {}) || {};
        this.hasLast = !!store.get(LS.last, null);
        await this.loadMenu();
        this.restoreCustomer();
        this.startPOS();

        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') this.checkPOS();
        });
        window.addEventListener('online', () => this.checkPOS());
        window.addEventListener('offline', () => this.checkPOS());

        if (this.openConfigOnLoad) this.openConfig();
      },

      async loadMenu() {
        this.loading = true;
        this.loadError = '';
        try {
          const res = await fetch('menu.json', { cache: 'no-cache' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          this.menu = indexMenu(await res.json());
          this.restoreCart();
        } catch (err) {
          console.error('[menu] load failed', err);
          this.loadError = location.protocol === 'file:'
            ? 'وقتی صفحه از روی دیسک باز می‌شود، menu.json لود نمی‌شود. پوشه را روی یک سرور اجرا کن (مثلاً python -m http.server) یا روی GitHub Pages بگذار.'
            : 'اتصال اینترنتت را چک کن و دوباره امتحان کن.';
        } finally {
          this.loading = false;
        }
      },

      parseUrlParams() {
        const p = new URLSearchParams(location.search);
        this.devVisible = p.get('dev') === '1' || p.has('pos_ip');
        this.openConfigOnLoad = p.get('dev') === '1';
        if (!p.has('pos_ip')) return;

        const base = normalizeBaseUrl(p.get('pos_ip'), p.get('pos_port'));
        if (!base) {
          this.toast('pos_ip معتبر نیست و نادیده گرفته شد');
        } else if (!isPrivateHost(new URL(base).hostname)) {
          // Safety: a crafted link must not be able to redirect customers' orders to a public server.
          this.toast('pos_ip فقط آدرس localhost و شبکه داخلی را می‌پذیرد. برای آدرس عمومی از تنظیمات پرسنل استفاده کن.', 6000);
        } else {
          this.urlOverride = base; // session only — never written to localStorage
        }
      },

      /* ------------------------------ getters ---------------------------- */
      get restaurant() {
        return (this.menu && this.menu.meta && this.menu.meta.restaurant) ||
          { name: 'HEGGE', nameFa: 'هگه', phone: '', address: '', hours: '' };
      },
      get categories() { return this.menu ? this.menu.categories : []; },
      get maxQty() { return (this.menu && this.menu.meta.limits && this.menu.meta.limits.maxQtyPerLine) || 20; },

      get baseConfig() {
        const fromMenu = (this.menu && this.menu.meta && this.menu.meta.pos) || {};
        return { simulate: 'auto', ...FALLBACK_POS, ...fromMenu, ...this.saved };
      },
      get effectiveConfig() {
        const c = this.baseConfig;
        return this.urlOverride ? { ...c, baseUrl: this.urlOverride } : c;
      },
      get sim() { return this.baseConfig.simulate && this.baseConfig.simulate !== 'auto'; },

      get statusUi() {
        switch (this.pos.status) {
          case 'online':
            return { label: 'باز برای سفارش', short: 'باز', pill: '', dot: 'bg-emerald-500' };
          case 'offline':
            return { label: 'بسته', short: 'بسته', pill: '', dot: 'bg-red-500' };
          default:
            return { label: 'در حال بررسی…', short: '…', pill: '', dot: 'bg-amber-400' };
        }
      },

      get visibleGroups() {
        if (!this.menu) return [];
        const q = normFa(this.search);
        const match = (i) => !q ||
          normFa([i.name, i.nameFa, i.description].filter(Boolean).join(' ')).includes(q);
        return this.menu.categories
          .filter((c) => this.activeCategory === 'all' || c.id === this.activeCategory)
          .map((c) => ({ category: c, items: this.menu.items.filter((i) => i.category === c.id && match(i)) }))
          .filter((g) => g.items.length);
      },

      get cartLines() {
        if (!this.menu) return [];
        return this.cart.map((l) => resolveLine(this.menu, l)).filter(Boolean);
      },
      get cartCount() { return this.cart.reduce((s, l) => s + l.qty, 0); },
      get subtotal() { return this.cartLines.reduce((s, l) => s + l.lineTotal, 0); },
      get deliveryFee() {
        const fee = Number(this.menu && this.menu.meta.fees && this.menu.meta.fees.delivery) || 0;
        return this.fulfillment === 'delivery' && this.cartCount > 0 ? fee : 0;
      },
      get total() { return this.subtotal + this.deliveryFee; },
      get canCheckout() { return this.pos.status === 'online' && this.cartCount > 0; },
      get closedMessage() { return CLOSED_MESSAGE; },

      get czGroups() {
        if (!this.menu || !this.cz.item) return [];
        return (this.cz.item.options || [])
          .filter((id) => this.menu.optionGroups[id])
          .map((id) => ({ id, ...this.menu.optionGroups[id] }));
      },
      get czUnit() {
        if (!this.menu || !this.cz.item) return 0;
        const l = resolveLine(this.menu, { itemId: this.cz.item.id, selections: this.cz.selections, qty: 1 });
        return l ? l.unit : 0;
      },
      get czTotal() { return this.czUnit * this.cz.qty; },

      get lockScroll() { return this.drawerOpen || this.cz.open || this.receiptOpen || this.configOpen; },
      get receiptHtml() {
        return this.lastOrder && this.menu ? buildReceiptHTML(this.lastOrder, this.menu.meta) : '';
      },

      /* ------------------------------ helpers ---------------------------- */
      money(v) { return formatMoney(v, this.menu && this.menu.meta.currency); },
      moneyNum(v) {
        const c = (this.menu && this.menu.meta.currency) || {};
        return Math.round(Number(v) || 0).toLocaleString(c.locale || 'en-US');
      },
      get cur() { return (this.menu && this.menu.meta.currency && this.menu.meta.currency.symbol) || ''; },
      hasOptions(item) { return (item.options || []).length > 0; },
      /** Opens the customizer: option groups and/or the free-text request field. */
      customizable(item) { return this.hasOptions(item) || !!item.allowNote; },
      itemLabel(item) { return (item && (item.nameFa || item.name)) || ''; },
      /** srcset for SnappFood-style URLs, where one file exists at two sizes. Empty when meta.images is absent. */
      imgSet(item) {
        const c = this.menu && this.menu.meta.images;
        if (!c || !item.image || item.imgSmallOnly || !item.image.includes(c.small)) return '';
        return `${item.image} ${c.smallW}w, ${item.image.replace(c.small, c.large)} ${c.largeW}w`;
      },
      /** Large file failed: retry with the small one. The small one failed too: show the placeholder. */
      imgError(item) {
        if (this.imgSet(item)) item.imgSmallOnly = true;
        else item.imgFailed = true;
      },
      qtyInCart(itemId) { return this.cart.filter((l) => l.itemId === itemId).reduce((s, l) => s + l.qty, 0); },
      simpleKey(item) { return lineKey(item.id, {}, ''); },
      fromPrice(item) { return this.hasOptions(item) && (item.options || []).some((g) => g === 'pizzaSize'); },
      setCategory(id) { this.activeCategory = id; },

      toast(msg, ms = 2600) {
        this.toastMsg = msg;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { this.toastMsg = ''; }, ms);
      },

      focusRef(name) { this.$nextTick(() => { const el = this.$refs[name]; if (el) el.focus(); }); },

      closeTop() {
        if (this.configOpen) this.configOpen = false;
        else if (this.receiptOpen) this.closeReceipt();
        else if (this.cz.open) this.cz.open = false;
        else if (this.drawerOpen) this.closeCart();
      },

      /* --------------------------- customizer ---------------------------- */
      openItem(item) {
        if (!item || item.soldOut) return;
        if (!this.customizable(item)) {
          this.addLine(item, {}, 1, '');
          this.toast(`«${this.itemLabel(item)}» به سبد اضافه شد`);
          return;
        }
        this.cz = { open: true, item, selections: defaultSelections(this.menu, item), qty: 1, note: '' };
        this.focusRef('czClose');
      },
      pick(g, c) {
        const cur = this.cz.selections[g.id] || [];
        if (g.type === 'multi') {
          if (cur.includes(c.id)) this.cz.selections[g.id] = cur.filter((x) => x !== c.id);
          else if (g.max && cur.length >= g.max) this.toast(`برای «${g.label}» حداکثر ${g.max} مورد می‌تونی انتخاب کنی`);
          else this.cz.selections[g.id] = [...cur, c.id];
        } else {
          this.cz.selections[g.id] = [c.id];
        }
      },
      isPicked(g, c) { return (this.cz.selections[g.id] || []).includes(c.id); },
      czStep(delta) { this.cz.qty = clamp(this.cz.qty + delta, 1, this.maxQty); },
      confirmCz() {
        const item = this.cz.item;
        if (!item) return;
        this.addLine(item, this.cz.selections, this.cz.qty, this.cz.note.trim().slice(0, 80));
        this.cz.open = false;
        this.toast(`«${this.itemLabel(item)}» به سبد اضافه شد`);
      },

      /* ------------------------------- cart ------------------------------ */
      addLine(item, selections, qty, note) {
        const sel = JSON.parse(JSON.stringify(selections || {}));
        const key = lineKey(item.id, sel, note);
        const existing = this.cart.find((l) => l.key === key);
        if (existing) existing.qty = Math.min(this.maxQty, existing.qty + qty);
        else this.cart.push({ key, itemId: item.id, qty: Math.min(this.maxQty, qty), selections: sel, note: note || '' });
        this.commitCart();
      },
      changeQty(key, delta) {
        const line = this.cart.find((l) => l.key === key);
        if (!line) return;
        const q = line.qty + delta;
        if (q <= 0) this.cart = this.cart.filter((l) => l.key !== key);
        else line.qty = Math.min(this.maxQty, q);
        this.commitCart();
      },
      removeLine(key) {
        this.cart = this.cart.filter((l) => l.key !== key);
        this.commitCart();
      },
      clearCart() {
        this.cart = [];
        this.commitCart();
      },
      commitCart() {
        store.set(LS.cart, this.cart.map(({ key, itemId, qty, selections, note }) => ({ key, itemId, qty, selections, note })));
        pending = null; // a changed cart is a new order
        if (!this.cart.length) this.drawerView = 'cart';
      },
      restoreCart() {
        const saved = store.get(LS.cart, []);
        const out = [];
        let dropped = 0;
        for (const l of Array.isArray(saved) ? saved : []) {
          const item = l && this.menu.itemsById[l.itemId];
          if (!item || item.soldOut) { dropped++; continue; }
          const selections = sanitizeSelections(this.menu, item, l.selections);
          const note = String(l.note || '').slice(0, 80);
          const key = lineKey(item.id, selections, note);
          const qty = clamp(parseInt(l.qty, 10) || 1, 1, this.maxQty);
          const ex = out.find((x) => x.key === key);
          if (ex) ex.qty = Math.min(this.maxQty, ex.qty + qty);
          else out.push({ key, itemId: item.id, qty, selections, note });
        }
        this.cart = out;
        store.set(LS.cart, out);
        if (dropped) this.toast('بعضی از آیتم‌های سبد قبلی‌ات دیگه توی منو نیستن.', 4000);
      },

      /* ------------------------------ drawer ----------------------------- */
      openCart() { this.toastMsg = ''; this.drawerView = 'cart'; this.drawerOpen = true; this.focusRef('drawerClose'); },
      closeCart() { this.drawerOpen = false; },
      goCheckout() {
        if (!this.canCheckout) return;
        this.drawerView = 'checkout';
        this.submitError = '';
        this.$nextTick(() => { const b = this.$refs.drawerBody; if (b) b.scrollTop = 0; });
      },
      backToCart() { this.drawerView = 'cart'; this.submitError = ''; },
      setFulfillment(kind) { this.fulfillment = kind; this.errors = {}; this.submitError = ''; },

      /* ----------------------------- customer ---------------------------- */
      restoreCustomer() {
        const c = store.get(LS.customer, null);
        if (!c || typeof c !== 'object') return;
        this.form.name = String(c.name || '');
        this.form.phone = String(c.phone || '');
        this.form.address = String(c.address || '');
      },
      validateForm() {
        const f = this.form;
        const e = {};
        if (f.name.trim().length < 2) e.name = 'اسمت رو بنویس';
        if (!isValidPhone(normalizePhone(f.phone))) e.phone = 'یه شماره تماس معتبر بنویس (فقط عدد)';
        if (this.fulfillment === 'delivery') {
          if (f.address.trim().length < 8) e.address = 'آدرس کامل تحویل رو بنویس';
        } else if (!f.pickupTime.trim()) {
          e.pickupTime = 'بنویس کی میای تحویل بگیری';
        }
        this.errors = e;
        return Object.keys(e).length === 0;
      },

      /* ------------------------------ ordering --------------------------- */
      buildOrder() {
        const lines = this.cartLines;
        const sig = this.cart.map((l) => l.key + 'x' + l.qty).join('|') + '#' + this.fulfillment;
        if (!pending || pending.sig !== sig) {
          const now = new Date();
          const prefix = this.restaurant.orderPrefix || 'HG';
          const seq = nextSeq();
          pending = {
            sig,
            orderId: `${prefix}-${seq}`,
            reference: `${prefix}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
              `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${seq}`,
            createdAt: localISO(now),
          };
        }
        const f = this.form;
        const isDelivery = this.fulfillment === 'delivery';
        const itemCount = lines.reduce((s, l) => s + l.qty, 0);
        const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
        const deliveryFee = isDelivery ? Number(this.menu.meta.fees && this.menu.meta.fees.delivery) || 0 : 0;
        return {
          orderId: pending.orderId,
          reference: pending.reference,
          createdAt: pending.createdAt,
          fulfillment: this.fulfillment,
          customer: {
            name: f.name.trim(),
            phone: normalizePhone(f.phone),
            address: isDelivery ? f.address.trim() : '',
            deliveryNotes: isDelivery ? f.deliveryNotes.trim() : '',
            pickupTime: isDelivery ? '' : f.pickupTime.trim(),
          },
          items: lines.map((l) => ({
            sku: l.item.sku || l.item.id,
            name: l.item.name,
            nameFa: l.item.nameFa || '',
            qty: l.qty,
            unit: l.unit,
            lineTotal: l.lineTotal,
            mods: l.mods.map((m) => ({ ...m })),
            note: l.note,
          })),
          totals: {
            itemCount,
            subtotal,
            deliveryFee,
            total: subtotal + deliveryFee,
            currency: (this.menu.meta.currency && this.menu.meta.currency.symbol) || '',
          },
          payment: 'cash',
          simulated: false,
        };
      },

      async sendToPOS(payload) {
        const cfg = this.effectiveConfig;
        if (cfg.simulate === 'online') { await sleep(600); return { simulated: true }; }

        const base = normalizeBaseUrl(cfg.baseUrl);
        if (!base) throw new Error('No POS address configured');
        const url = joinUrl(base, cfg.orderPath);
        if (mixedContentBlocked(url)) throw new Error('Blocked: https page cannot call plain http POS address');

        const r = await timedFetch(url, {
          method: 'POST',
          mode: 'cors',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }, Math.max(Number(cfg.timeoutMs) || 4000, 10000));

        if (!r.res.ok) throw new Error(`POS answered HTTP ${r.res.status}`);
        let data = null;
        try { data = JSON.parse(r.text); } catch (_) { /* empty body is fine */ }
        if (data && (data.ok === false || data.accepted === false)) {
          throw new Error(data.message || 'The POS rejected the order');
        }
        return { data };
      },

      async placeOrder() {
        if (this.submitting) return;
        this.submitError = '';
        if (!this.canCheckout) { this.submitError = CLOSED_MESSAGE + '.'; return; }
        if (!this.validateForm()) {
          this.$nextTick(() => {
            const el = document.querySelector('[data-invalid="true"]');
            if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.focus({ preventScroll: true }); }
          });
          return;
        }

        this.submitting = true;
        try {
          const order = this.buildOrder();
          const res = await this.sendToPOS(buildBaransysPayload(order));
          order.simulated = !!res.simulated;
          this.finishOrder(order);
        } catch (err) {
          console.error('[order] failed', err);
          const phone = this.restaurant.phone ? ` یا با ${this.restaurant.phone} تماس بگیر` : '';
          this.submitError = 'سفارشت به رستوران نرسید. چیزی ثبت نشده و سبدت سر جاشه؛ ' +
            `چند لحظه دیگه دوباره امتحان کن${phone}.`;
          this.checkPOS(); // re-evaluate open/closed right away
        } finally {
          this.submitting = false;
        }
      },

      finishOrder(order) {
        this.lastOrder = order;
        this.toastMsg = '';
        this.hasLast = store.set(LS.last, order);

        if (this.form.remember) {
          store.set(LS.customer, { name: this.form.name.trim(), phone: normalizePhone(this.form.phone), address: this.form.address.trim() });
        } else {
          store.remove(LS.customer);
        }
        this.form.deliveryNotes = '';
        this.form.pickupTime = '';
        this.errors = {};

        this.cart = [];
        store.set(LS.cart, []);
        pending = null;

        this.drawerOpen = false;
        this.drawerView = 'cart';
        this.receiptOpen = true;
        this.focusRef('receiptDone');
      },

      closeReceipt() { this.receiptOpen = false; },

      printReceipt() {
        const prev = document.title;
        if (this.lastOrder) document.title = 'Receipt ' + this.lastOrder.orderId;
        window.print();
        document.title = prev;
      },

      reprintLast() {
        const o = store.get(LS.last, null);
        if (!o) return;
        this.lastOrder = o;
        this.configOpen = false;
        this.receiptOpen = true;
      },

      /* ----------------------------- POS health -------------------------- */
      startPOS() {
        this.checkPOS();
        const loop = () => {
          clearTimeout(pollTimer);
          const every = Math.max(5000, Number(this.effectiveConfig.pollMs) || 30000);
          pollTimer = setTimeout(async () => { await this.checkPOS(); loop(); }, every);
        };
        loop();
      },

      checkPOS(manual = false) {
        if (inflight) return inflight;
        if (manual === true) this.pos.spinning = true;
        inflight = (async () => {
          const r = await probeHealth(this.effectiveConfig, false);
          const p = this.pos;
          p.lastChecked = Date.now();
          if (r.online) {
            p.status = 'online';
            p.failStreak = 0;
            p.reason = '';
            p.latency = r.latency;
            p.simulated = !!r.simulated;
          } else {
            p.failStreak += 1;
            p.reason = r.reason;
            p.latency = null;
            // Flip to "closed" immediately if we were not online yet; otherwise require two misses
            // in a row so a single dropped packet does not lock customers out.
            if (p.status !== 'online' || p.failStreak >= 2) p.status = 'offline';
            else setTimeout(() => this.checkPOS(), 4000);
          }
        })().finally(() => { inflight = null; this.pos.spinning = false; });
        return inflight;
      },

      /* --------------------------- staff settings ------------------------ */
      openConfig() {
        const c = this.baseConfig;
        this.draft = {
          baseUrl: c.baseUrl || '',
          healthPath: c.healthPath,
          orderPath: c.orderPath,
          timeoutMs: c.timeoutMs,
          pollSec: Math.round((Number(c.pollMs) || 30000) / 1000),
          simulate: c.simulate || 'auto',
        };
        this.testResult = null;
        this.configOpen = true;
        this.focusRef('cfgClose');
      },

      async testConnection() {
        const d = this.draft;
        this.testing = true;
        this.testResult = null;
        const cfg = {
          simulate: 'auto',
          baseUrl: d.baseUrl,
          healthPath: normPath(d.healthPath, '/health'),
          timeoutMs: clamp(Number(d.timeoutMs) || 4000, 1000, 20000),
        };
        const r = await probeHealth(cfg, true);
        this.testResult = r.online
          ? { ok: true, msg: `آنلاین · پاسخ در ${r.latency} میلی‌ثانیه` }
          : { ok: false, msg: r.reason };
        this.testing = false;
      },

      saveConfig() {
        const d = this.draft;
        const base = normalizeBaseUrl(d.baseUrl);
        if (d.simulate === 'auto' && !base) {
          this.testResult = { ok: false, msg: 'یک آدرس معتبر برای POS بنویس، مثلاً 192.168.1.20:8080 یا https://pos.example.com' };
          return;
        }
        this.saved = {
          baseUrl: base || '',
          healthPath: normPath(d.healthPath, '/health'),
          orderPath: normPath(d.orderPath, '/api/orders'),
          timeoutMs: clamp(Number(d.timeoutMs) || 4000, 1000, 20000),
          pollMs: clamp((Number(d.pollSec) || 30) * 1000, 5000, 300000),
          simulate: d.simulate,
        };
        store.set(LS.config, this.saved);
        this.configOpen = false;
        this.pos.status = 'checking';
        clearTimeout(pollTimer);
        this.startPOS();
        this.toast('تنظیمات ذخیره شد');
      },

      resetConfig() {
        this.saved = {};
        store.remove(LS.config);
        this.configOpen = false;
        this.pos.status = 'checking';
        clearTimeout(pollTimer);
        this.startPOS();
        this.toast('تنظیمات به حالت پیش‌فرض برگشت');
      },
    };
  }

  document.addEventListener('alpine:init', () => { window.Alpine.data('app', app); });
})();
