// ==UserScript==
// @name         BookBeam Niche Finder -> CSV
// @namespace    bookbeam-niche-finder-csv-export
// @version      1.0.0
// @description  Export BookBeam Niche Finder results to CSV (same columns as the table), in search order.
// @homepageURL  https://github.com/angelo18181818/bookbeam-niche-finder-csv-export
// @supportURL   https://github.com/angelo18181818/bookbeam-niche-finder-csv-export/issues
// @downloadURL  https://raw.githubusercontent.com/angelo18181818/bookbeam-niche-finder-csv-export/main/bookbeam-niche-finder-csv.user.js
// @updateURL    https://raw.githubusercontent.com/angelo18181818/bookbeam-niche-finder-csv-export/main/bookbeam-niche-finder-csv.user.js
// @license      MIT
// @match        https://app.bookbeam.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
  USAGE
  1. Set your filters and click "Find Books" once (uses 1 search, as usual).
  2. A green bubble appears in the bottom-right corner and drifts toward your mouse.
  3. Hover it: choose "From page" and "To page" (1 = first page, both inclusive),
     the number of threads (parallel requests, 1-5), then click "Start".
  Changing page does not use searches (checked on 2026-11-23).
  Your session token stays in the page: the script never stores it or sends it anywhere else.
  Sales and royalty figures are BookBeam ESTIMATES, not Amazon data.
*/

(function () {
  'use strict';

  const CONFIG = {
    DEFAULT_FROM: 1,    // initial "From page" (1 = first BookBeam page)
    DEFAULT_TO: 5,      // initial "To page" (inclusive): 1-5 = 75 books
    PARALLEL: 2,        // initial threads (pick 1-5 in the bubble); drops to 1 on the first HTTP 429
    MAX_PARALLEL: 5,
    DELAY_MS: 400,      // initial pause between pages
    MAX_DELAY_MS: 8000, // after each 429 the pause doubles (up to this) for the rest of the run
    RETRIES: 4,         // retries after a 429 (with growing waits)
    BACKOFF_MS: 5000,   // first wait after a 429; doubles on each retry
    EUROPEAN_CSV: false, // true: ";" separator and decimal comma (Excel in IT/DE/FR/ES locales)
  };

  const ENDPOINT = '/book-tracker-service/api/v1/niche-finder';
  let last = null;      // last search sent by the app: { url, headers, body }
  let totalResults = null;

  // ---------- Capture the request sent by the app ----------
  const XO = XMLHttpRequest.prototype.open;
  const XH = XMLHttpRequest.prototype.setRequestHeader;
  const XS = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__bb = { method, url: String(url), headers: {} };
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__bb) this.__bb.headers[k] = v;
    return XH.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const c = this.__bb;
    if (c && c.method === 'POST' && c.url.split('?')[0].endsWith(ENDPOINT) && !this.__bbOwn) {
      last = { url: c.url, headers: { ...c.headers }, body: String(body) };
      this.addEventListener('load', () => {
        try { totalResults = JSON.parse(this.responseText).totalResults ?? totalResults; } catch (e) {}
        updateMax();
      });
      showBubble();
    }
    return XS.apply(this, arguments);
  };

  // ---------- Fetch one page ----------
  function fetchPage(pageNr) {
    return new Promise((resolve, reject) => {
      const payload = JSON.parse(last.body);
      payload.pageNr = pageNr;
      const x = new XMLHttpRequest();
      x.__bbOwn = true;
      x.open('POST', last.url);
      for (const [k, v] of Object.entries(last.headers)) x.setRequestHeader(k, v);
      x.onload = () => {
        if (x.status !== 200) {
          const err = new Error('HTTP ' + x.status + ' on page ' + (pageNr + 1));
          err.status = x.status;
          err.retryAfter = parseFloat(x.getResponseHeader('Retry-After')) * 1000 || 0;
          return reject(err);
        }
        try { resolve({ pageNr, pageSize: payload.pageSize || 15, payload, books: JSON.parse(x.responseText).books || [] }); }
        catch (e) { reject(e); }
      };
      x.onerror = () => reject(new Error('Network error on page ' + (pageNr + 1)));
      x.send(JSON.stringify(payload));
    });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Retry only on 429 (Too Many Requests), waiting longer each time
  async function fetchPageRetry(pageNr) {
    for (let attempt = 0; ; attempt++) {
      try { return await fetchPage(pageNr); }
      catch (e) {
        if (e.status !== 429 || attempt >= CONFIG.RETRIES) throw e;
        // adaptive: first drop to one thread, then lengthen the pause
        if (parallel > 1) parallel = 1;
        else delay = Math.min(delay * 2, CONFIG.MAX_DELAY_MS);
        const wait = Math.max(e.retryAfter, CONFIG.BACKOFF_MS * 2 ** attempt);
        for (let s = Math.ceil(wait / 1000); s > 0; s--) {
          setStatus('rate limited, retrying page ' + (pageNr + 1) + ' in ' + s + 's');
          await sleep(1000);
        }
      }
    }
  }

  // ---------- Age as shown in the table: 20d / 5m / 1y 4m ----------
  function age(iso) {
    if (!iso) return '';
    const d = new Date(iso), now = new Date();
    if (isNaN(d)) return '';
    let months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
    if (now.getDate() < d.getDate()) months--;
    if (months < 1) return Math.max(0, Math.floor((now - d) / 86400000)) + 'd';
    const y = Math.floor(months / 12), m = months % 12;
    if (y === 0) return m + 'm';
    return m ? y + 'y ' + m + 'm' : y + 'y';
  }

  // ---------- CSV: only the table columns ----------
  // Book Information -> Title, Author, Pages, Age, Market, Link
  // Reviews -> Rating, Reviews | BSR | Sales (Mo) | Royalty (Mo) | Price | Publisher
  const COLS = [
    ['#', (b) => b._rank],
    ['Title', (b) => b.title],
    ['Author', (b) => b.author],
    ['Pages', (b) => b.numberOfPages ?? b.numOfPages],
    ['Age', (b) => age(b.publicationDate)],
    ['Market', (b) => b._market],
    ['Link', (b) => b.asin ? 'https://www.amazon.com/dp/' + b.asin : ''],
    ['Rating', (b) => b.rating],
    ['Reviews', (b) => b.reviewsQuantity],
    ['BSR', (b) => b.bestsellerRank],
    ['Sales (Mo)', (b) => b.salesPerMonth],
    ['Royalty (Mo)', (b) => b.income],
    ['Price', (b) => b.price],
    ['Publisher', (b) => b.publisher],
  ];

  function toCsv(rows) {
    const sep = CONFIG.EUROPEAN_CSV ? ';' : ',';
    const cell = (v) => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'number' && CONFIG.EUROPEAN_CSV) v = String(v).replace('.', ',');
      v = String(v);
      return /["\n\r;,]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    return '﻿' + [COLS.map((c) => c[0]).join(sep),
      ...rows.map((b) => COLS.map((c) => cell(c[1](b))).join(sep))].join('\r\n');
  }

  function download(text, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------- Export ----------
  let running = false;
  let delay = CONFIG.DELAY_MS;
  let parallel = CONFIG.PARALLEL;
  // from/to: page numbers as in BookBeam (1 = first), both inclusive
  async function run(fromPage, toPage, threads) {
    const from = fromPage - 1, to = toPage - 1; // the API counts from 0
    const pages = to - from + 1;
    if (!last) return alert('Click "Find Books" once first.');
    if (running) return;
    running = true;
    delay = CONFIG.DELAY_MS; // every export starts fast again
    parallel = threads;
    const rows = [];
    let done = 0, payload = null, error = null;
    const queue = Array.from({ length: pages }, (_, i) => from + i);
    setStatus('0/' + pages);
    try {
      while (queue.length) {
        const batch = queue.splice(0, parallel);
        const results = await Promise.all(batch.map(fetchPageRetry));
        let empty = false;
        for (const r of results) {
          payload = r.payload;
          r.books.forEach((b, j) => rows.push({
            ...b, _rank: r.pageNr * r.pageSize + j + 1, _market: r.payload.marketplace || '',
          }));
          if (!r.books.length) empty = true;
        }
        done += batch.length;
        setStatus(done + '/' + pages);
        if (empty) break;
        if (queue.length) await sleep(delay);
      }
    } catch (e) { error = e; }

    // Search order, first to last.
    // With no column sort selected, BookBeam sorts by ascending BSR: we apply it explicitly
    // so the order does not depend on the order in which pages arrive.
    const custom = payload && payload.sortDetails;
    const bsr = (b) => (typeof b.bestsellerRank === 'number' ? b.bestsellerRank : Infinity);
    rows.sort(custom ? (a, b) => a._rank - b._rank
                     : (a, b) => bsr(a) - bsr(b) || a._rank - b._rank);
    // drop duplicates (same ASIN on two pages)
    const seen = new Set();
    const unique = rows.filter((r) => !r.asin || (!seen.has(r.asin) && seen.add(r.asin)));
    rows.length = 0;
    rows.push(...unique);
    // numbering starts at the real position in the search (e.g. from page 3 -> #31)
    const pageSize = (payload && payload.pageSize) || 15;
    rows.forEach((r, i) => { r._rank = from * pageSize + i + 1; });
    if (rows.length) {
      const date = new Date().toISOString().slice(0, 10);
      const market = (payload && payload.marketplace) || 'NA';
      download(toCsv(rows), 'bookbeam_niche_' + market + '_' + date + '_p' + fromPage + '-' + toPage + '.csv');
    }
    if (error) alert('Stopped: ' + error.message + '\nDownloaded the rows collected so far (' + rows.length + ').');
    setStatus(rows.length ? rows.length + ' books ✓' : 'no data');
    running = false;
  }

  // ---------- Magnetic bubble ----------
  let bubble, inFrom, inTo, inThreads, hintEl, statusEl, maxPage = null;

  function pageSize() { try { return JSON.parse(last.body).pageSize || 15; } catch (e) { return 15; } }
  function updateMax() {
    if (!inTo || !totalResults || !last) return;
    maxPage = Math.ceil(totalResults / pageSize()); // last page, counting from 1
    inFrom.max = inTo.max = maxPage;
    updateHint();
  }
  function updateHint() {
    if (!hintEl) return;
    const f = parseInt(inFrom.value, 10), t = parseInt(inTo.value, 10), s = pageSize();
    if (isNaN(f) || isNaN(t) || t < f) { hintEl.textContent = 'invalid range'; return; }
    hintEl.textContent = (t - f + 1) + ' pages · ' + (t - f + 1) * s + ' books' +
      (maxPage !== null ? ' · last page ' + maxPage : '');
  }
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }

  function showBubble() {
    if (document.getElementById('bb-bubble')) return;
    if (!document.body) return document.addEventListener('DOMContentLoaded', showBubble, { once: true });

    const css = document.createElement('style');
    css.textContent = `
      #bb-bubble{position:fixed;right:28px;bottom:28px;z-index:99999;width:64px;height:64px;
        border-radius:32px;overflow:hidden;cursor:pointer;color:#fff;font:600 13px system-ui,sans-serif;
        background:radial-gradient(circle at 30% 28%,#7ef0b9 0%,#22b573 45%,#12804f 100%);
        box-shadow:0 8px 24px rgba(18,128,79,.45),inset 0 -6px 12px rgba(0,0,0,.15),inset 0 6px 10px rgba(255,255,255,.35);
        transition:width .25s ease,height .25s ease,border-radius .25s ease,transform .12s ease-out;
        display:flex;align-items:center;justify-content:center;will-change:transform}
      #bb-bubble .bb-icon{font-size:26px;line-height:1;pointer-events:none}
      #bb-bubble .bb-panel{display:none;flex-direction:column;gap:8px;padding:14px;width:100%;box-sizing:border-box}
      #bb-bubble.open{width:260px;height:178px;border-radius:22px;cursor:default}
      #bb-bubble .bb-row{display:flex;gap:8px}
      #bb-bubble .bb-row > div{flex:1;display:flex;flex-direction:column;gap:3px}
      #bb-bubble .bb-hint{font-size:11px;opacity:.9}
      #bb-bubble.open .bb-icon{display:none}
      #bb-bubble.open .bb-panel{display:flex}
      #bb-bubble label{font-size:12px;opacity:.95}
      #bb-bubble input{width:100%;box-sizing:border-box;padding:6px 8px;border:none;border-radius:8px;
        font:600 15px system-ui,sans-serif;color:#0f5c39}
      #bb-bubble button{padding:8px;border:none;border-radius:10px;background:#fff;color:#12804f;
        font:700 14px system-ui,sans-serif;cursor:pointer}
      #bb-bubble button:hover{background:#eafff4}
      #bb-bubble .bb-status{font-size:11px;opacity:.9;min-height:13px}`;
    document.head.appendChild(css);

    bubble = document.createElement('div');
    bubble.id = 'bb-bubble';
    bubble.innerHTML = `<span class="bb-icon">⤓</span>
      <div class="bb-panel">
        <div class="bb-row">
          <div><label>From page</label><input class="bb-from" type="number" min="1" value="${CONFIG.DEFAULT_FROM}"></div>
          <div><label>To page</label><input class="bb-to" type="number" min="1" value="${CONFIG.DEFAULT_TO}"></div>
          <div><label>Threads</label><input class="bb-threads" type="number" min="1" max="${CONFIG.MAX_PARALLEL}" value="${CONFIG.PARALLEL}"></div>
        </div>
        <div class="bb-hint"></div>
        <button type="button">Start</button>
        <div class="bb-status"></div>
      </div>`;
    document.body.appendChild(bubble);
    inFrom = bubble.querySelector('.bb-from');
    inTo = bubble.querySelector('.bb-to');
    inThreads = bubble.querySelector('.bb-threads');
    hintEl = bubble.querySelector('.bb-hint');
    statusEl = bubble.querySelector('.bb-status');
    inFrom.addEventListener('input', updateHint);
    inTo.addEventListener('input', updateHint);
    updateMax();
    updateHint();

    bubble.querySelector('button').onclick = () => {
      let f = Math.max(1, parseInt(inFrom.value, 10) || 1);
      let t = Math.max(1, parseInt(inTo.value, 10) || 1);
      if (maxPage !== null) { f = Math.min(f, maxPage); t = Math.min(t, maxPage); }
      if (t < f) [f, t] = [t, f];
      const th = Math.min(CONFIG.MAX_PARALLEL, Math.max(1, parseInt(inThreads.value, 10) || 1));
      inFrom.value = f; inTo.value = t; inThreads.value = th; updateHint();
      run(f, t, th);
    };

    let closeTimer;
    bubble.addEventListener('mouseenter', () => { clearTimeout(closeTimer); bubble.classList.add('open'); });
    bubble.addEventListener('mouseleave', () => {
      closeTimer = setTimeout(() => {
        if (!running && !bubble.contains(document.activeElement)) bubble.classList.remove('open');
      }, 500);
    });
    for (const el of [inFrom, inTo, inThreads]) el.addEventListener('blur', () => setTimeout(() => {
      if (!bubble.matches(':hover') && !running && !bubble.contains(document.activeElement)) bubble.classList.remove('open');
    }, 0));

    // Magnet effect: the closer the mouse, the more the bubble moves toward it
    const RADIUS = 220, PULL = 0.45, MAX_SHIFT = 70;
    document.addEventListener('mousemove', (e) => {
      if (bubble.classList.contains('open')) { bubble.style.transform = 'translate(0,0) scale(1)'; return; }
      const r = bubble.getBoundingClientRect();
      const cx = r.left + r.width / 2 - (bubble.__tx || 0), cy = r.top + r.height / 2 - (bubble.__ty || 0);
      const dx = e.clientX - cx, dy = e.clientY - cy, dist = Math.hypot(dx, dy);
      if (dist < RADIUS) {
        const f = (1 - dist / RADIUS) * PULL;
        let tx = dx * f, ty = dy * f;
        const len = Math.hypot(tx, ty);
        if (len > MAX_SHIFT) { tx *= MAX_SHIFT / len; ty *= MAX_SHIFT / len; }
        bubble.__tx = tx; bubble.__ty = ty;
        bubble.style.transform = `translate(${tx}px,${ty}px) scale(${1 + (1 - dist / RADIUS) * 0.25})`;
      } else if (bubble.__tx || bubble.__ty) {
        bubble.__tx = bubble.__ty = 0;
        bubble.style.transform = 'translate(0,0) scale(1)';
      }
    }, { passive: true });
  }
})();
