// ==UserScript==
// @name         BookBeam Niche Finder -> CSV
// @namespace    bookbeam-niche-finder-csv-export
// @version      4.2.0
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
  HOW TO USE
  1. Set your filters and click "Find Books" once (uses 1 search, as usual).
  2. Hover the green bubble in the bottom-right corner (click it to keep the panel open).
     The bubble is shown only on the Niche Finder page (#/niche-finder); an export keeps running
     if you move to another page, and the bubble shows it again when you come back.
  3. "Max" (on by default) exports from page 1 to the last page. Untick it to choose a range.
  4. Click "Start export". The CSV downloads at the end, with a report in the panel.

  Notes
  - Changing page does not use searches (checked on 23/11/2026).
  - BookBeam's result count is an estimate, usually too high: past the real last page it answers
    HTTP 404 (observed on 25/11/2026). The export ends there, after two empty pages in a row.
  - BookBeam itself repeats some books on different pages: duplicates are removed by ASIN when the
    file is built, after all pages have been downloaded.
  - A page that fails is retried, never dropped: if it still fails it is listed as missing and
    "Recover missing pages" downloads only those, then saves the whole list again.
  - Your session token stays in the page: the script never stores it or sends it anywhere else.
  - Sales and royalty are BookBeam ESTIMATES, not Amazon data.
*/

(function () {
  'use strict';

  const VERSION = '4.2';
  const CONFIG = {
    DEFAULT_FROM: 1,       // range restored when "Max" is unticked
    DEFAULT_TO: 5,
    MAX_DEFAULT: true,     // "Max" ticked when the panel opens
    PARALLEL: 1,           // parallel requests (1-5)
    MAX_PARALLEL: 5,
    DELAY_S: 0.8,          // delay between requests, in seconds, for each parallel request
    DELAY_STEP_S: 0.1,     // with Antithrottled on, the delay grows by this much at each server warning
    DELAY_MIN_S: 0.1,
    DELAY_MAX_S: 10,       // Antithrottled stops here; a higher value typed by hand is kept
    ANTITHROTTLED: true,
    BACKOFF_MS: 5000,      // pause after a server error; +2 s for each further error in a row
    BACKOFF_STEP_MS: 2000,
    MAX_BACKOFF_MS: 60000,
    TIMEOUT_MS: 45000,     // a page with no answer after this long is retried
    PAGE_TRIES: 5,         // tries per page before leaving it to the final pass
    RECOVER_OK: 5,         // pages in a row without errors before adding a parallel request back
    MAX_RECOVER_OK: 40,
    MAX_FAILS: 30,         // errors in a row (no page at all) before stopping
    MAX_PAGES: 2000,       // safety limit for "Max"
    LOG_LINES: 300,
    EUROPEAN_CSV: false,   // true: ";" separator and decimal comma (Excel in IT/DE/FR/ES locales)
    MOTION: true,          // bubble physics (soft body, magnet, droplet); also off with the system's reduced motion
  };

  const ENDPOINT = '/book-tracker-service/api/v1/niche-finder';
  let last = null;         // last search sent by the app: { url, headers, body }
  let lastKey = null;      // its filters, without the page number
  let totalResults = null, totalPage = -1, realPageSize = null;
  let realEnd = null;      // real last page (1-based), found while downloading
  let maxPage = null;      // last page shown in the panel: the real one if known, otherwise BookBeam's estimate

  let running = false, stopAsked = false, pending = null, job = null, lastReport = null;

  function searchKey(body) {
    try { const o = JSON.parse(body); delete o.pageNr; return JSON.stringify(o); } catch (e) { return body; }
  }
  // BookBeam lowers its total while you move forward (4888 on page 1, 4551 on page 304): keep the furthest one
  function learn(j, pageNr) {
    const n = Number(j && j.totalResults);
    if (n > 0 && pageNr >= totalPage) { totalResults = n; totalPage = pageNr; }
    if (j && j.books && j.books.length && pageNr === 0) realPageSize = j.books.length;
  }

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
      const key = searchKey(last.body);
      if (key !== lastKey) { // a new search, not just another page
        lastKey = key; totalResults = null; totalPage = -1; realEnd = null; realPageSize = null; maxPage = null;
        if (!running && pending) { pending = null; log('New search detected: the previous recovery was discarded.', 'w'); }
      }
      this.addEventListener('load', () => {
        if (key !== lastKey || this.status !== 200) return; // late answer to an older search
        try {
          const j = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
          learn(j, JSON.parse(String(body)).pageNr);
        } catch (e) {}
        updateMax();
        setTimeout(updateMax, 1500); // the page counter is drawn after the answer
      });
      ensureUi();
    }
    return XS.apply(this, arguments);
  };

  // ---------- One page ----------
  // Only the fields used in the CSV are kept: the full answer (with sales and rank history) is dropped at once.
  const KEEP = ['asin', 'title', 'author', 'numberOfPages', 'numOfPages', 'publicationDate', 'rating',
    'reviewsQuantity', 'bestsellerRank', 'salesPerMonth', 'income', 'price', 'publisher'];
  function slim(b) {
    const o = {};
    for (const k of KEEP) if (b && b[k] !== undefined) o[k] = b[k];
    return o;
  }

  function fetchPage(body, pageNr) {
    return new Promise((resolve, reject) => {
      const payload = JSON.parse(body);
      payload.pageNr = pageNr;
      const x = new XMLHttpRequest();
      x.__bbOwn = true;
      x.open('POST', last.url);
      x.timeout = CONFIG.TIMEOUT_MS;
      for (const [k, v] of Object.entries(last.headers)) x.setRequestHeader(k, v); // always the latest token
      const fail = (msg, status) => {
        const err = new Error(msg);
        err.status = status || 0;
        err.page = pageNr;
        err.retryAfter = status ? parseFloat(x.getResponseHeader('Retry-After')) * 1000 || 0 : 0;
        reject(err);
      };
      x.onload = () => {
        if (x.status !== 200) return fail('HTTP ' + x.status, x.status);
        let j;
        try { j = JSON.parse(x.responseText); } catch (e) { return fail('unreadable answer'); }
        if (!j || !Array.isArray(j.books)) return fail('answer without books');
        resolve({ pageNr, pageSize: payload.pageSize || 15, market: payload.marketplace || '',
          books: j.books.map(slim), total: j.totalResults });
      };
      x.onerror = () => fail('network error');
      x.ontimeout = () => fail('no answer after ' + CONFIG.TIMEOUT_MS / 1000 + ' s');
      x.send(JSON.stringify(payload));
    });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Expired session, access denied or wrong request: retrying does not help
  const isFatal = (e) => e.status >= 400 && e.status < 500 && ![404, 408, 429].includes(e.status);

  // ---------- Formatting ----------
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    if (h) return h + 'h ' + String(m).padStart(2, '0') + 'm';
    if (m) return m + 'm ' + String(r).padStart(2, '0') + 's';
    return r + 's';
  }
  // 0-based page numbers -> "206–300, 305"
  function ranges(pages) {
    const p = [...new Set(pages)].sort((a, b) => a - b), out = [];
    for (let i = 0; i < p.length;) {
      let k = i;
      while (k + 1 < p.length && p[k + 1] === p[k] + 1) k++;
      out.push(p[i] === p[k] ? String(p[i] + 1) : (p[i] + 1) + '–' + (p[k] + 1));
      i = k + 1;
    }
    return out.join(', ');
  }
  const clock = () => new Date().toTimeString().slice(0, 8);
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  // ---------- Age as in the table: 20d / 5m / 1y 4m ----------
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

  const DOMAINS = { US: 'com', IT: 'it', UK: 'co.uk', GB: 'co.uk', DE: 'de', FR: 'fr', ES: 'es', CA: 'ca' };
  const domain = (m) => DOMAINS[String(m || 'US').toUpperCase()] || 'com';

  // ---------- CSV: the columns of the table ----------
  const COLS = [
    ['#', (b) => b._rank],
    ['Title', (b) => b.title],
    ['Author', (b) => b.author],
    ['Pages', (b) => b.numberOfPages ?? b.numOfPages],
    ['Age', (b) => age(b.publicationDate)],
    ['Market', (b) => b._market],
    ['Link', (b) => b.asin ? 'https://www.amazon.' + domain(b._market) + '/dp/' + b.asin : ''],
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

  // All downloaded pages -> rows in search order, without duplicates (same ASIN), numbered from the first page
  function buildRows(j) {
    const rows = [];
    for (const r of [...j.got.values()].sort((a, b) => a.pageNr - b.pageNr)) {
      r.books.forEach((b, i) => rows.push({ ...b, _rank: r.pageNr * r.pageSize + i + 1, _market: r.market }));
    }
    let body = {};
    try { body = JSON.parse(j.body); } catch (e) {}
    // Without a column sort BookBeam orders by ascending BSR: applied here too, so the order
    // does not depend on how the pages arrive.
    const bsr = (b) => (typeof b.bestsellerRank === 'number' ? b.bestsellerRank : Infinity);
    rows.sort(body.sortDetails ? (a, b) => a._rank - b._rank : (a, b) => bsr(a) - bsr(b) || a._rank - b._rank);
    const seen = new Set();
    const unique = rows.filter((r) => !r.asin || (!seen.has(r.asin) && seen.add(r.asin)));
    const size = body.pageSize || 15;
    unique.forEach((r, i) => { r._rank = j.from * size + i + 1; });
    return unique;
  }

  // ---------- Export ----------
  let wake = null;
  // wait up to ms, or less if a request finishes first (no busy polling)
  const nap = (ms) => new Promise((r) => {
    const t = setTimeout(() => { wake = null; r(); }, ms);
    wake = () => { clearTimeout(t); wake = null; r(); };
  });
  const poke = () => { if (wake) wake(); };

  function newJob(body, from, to, open) {
    return {
      body, from, to, open, // 0-based pages; to = null with "Max"
      got: new Map(), empty: new Set(), emptyTries: new Map(), end: undefined, inflight: new Set(),
      rows: 0, asins: new Set(), noAsin: 0, retries: 0, kinds: {}, times: [], elapsed: 0, runStart: 0,
      limit: 1, note: '', est: searchKey(body) === lastKey && maxPage ? maxPage - 1 : null, maxGot: -1,
    };
  }
  const uniqueCount = (j) => j.asins.size + j.noAsin;
  function recount(j) {
    j.rows = 0; j.asins = new Set(); j.noAsin = 0; j.maxGot = -1;
    for (const [p, r] of j.got) {
      j.rows += r.books.length; j.maxGot = Math.max(j.maxGot, p);
      for (const b of r.books) b.asin ? j.asins.add(b.asin) : j.noAsin++;
    }
  }
  // last page (0-based) this export is expected to reach
  function lastGuess(j) {
    if (j.end !== undefined) return j.to === null ? j.end : Math.min(j.to, j.end);
    if (j.to !== null) return j.to;
    return Math.max(j.est ?? j.from, j.maxGot);
  }

  function start() {
    if (running) {
      stopAsked = true;
      log('Stop requested: finishing the requests in progress…', 'w');
      render();
      return;
    }
    if (pending) return work(pending.job, pending.missing);
    if (!last) { showReport('err', ['Click “Find Books” first, so the script can read your filters.']); return; }
    const max = inMax.checked;
    let f = max ? 1 : int(inFrom.value, 1), t = max ? null : int(inTo.value, f);
    if (t !== null && t < f) [f, t] = [t, f];
    const j = newJob(last.body, f - 1, t === null ? null : t - 1, max);
    const upto = t === null ? (j.est ?? f - 1 + 19) : t - 1;
    const pages = [];
    for (let p = f - 1; p <= upto; p++) pages.push(p);
    if (logBox) logBox.textContent = '';
    showReport();
    return work(j, pages);
  }

  // Downloads the given pages. A failed page goes back to the queue (it is never dropped): after an error
  // only 1 request runs, then parallel requests come back one at a time after some pages without errors.
  async function work(j, pages) {
    running = true; stopAsked = false; pending = null; job = j;
    j.runStart = Date.now(); j.times = []; j.note = ''; j.emptyTries = new Map();
    for (const p of pages) j.empty.delete(p);
    let queue = [...new Set(pages)].sort((a, b) => a - b), lost = [], tries = new Map();
    let okNeeded = CONFIG.RECOVER_OK, okRow = 0, failRow = 0, slots = 0, lastKind = '';
    let pauseUntil = 0, epoch = 0, error = null, finalPass = false, probing = false;
    let nextOpen = (queue.length ? queue[queue.length - 1] : j.from - 1) + 1;
    j.limit = threads();
    const ticker = setInterval(render, 1000);
    if (j.got.size) log('Recovering ' + fmt(pages.length) + ' page(s): ' + ranges(pages) + '.', 'w');
    else log('Export started: pages ' + (j.from + 1) + '–' + (j.to === null ? (j.est !== null ? '~' + (j.est + 1) + ' (Max)' : 'Max') : j.to + 1) +
      ', ' + j.limit + ' parallel, delay ' + delayS() + ' s.');
    render();

    const isShort = (p) => j.got.has(p) && j.got.get(p).books.length < j.got.get(p).pageSize;
    // Page with no books, or HTTP 404 (BookBeam's answer past the last page). Each one is checked twice.
    // The results are over only when two pages in a row are empty and the page before them is known;
    // a single empty page is kept as missing, so nothing is lost if it was a server hiccup.
    function noBooks(p, why) {
      const n = (j.emptyTries.get(p) || 0) + 1;
      j.emptyTries.set(p, n);
      if (n < 2) { queue.unshift(p); log('Page ' + (p + 1) + ': ' + why + ', checking again.'); return; }
      j.empty.add(p);
      log('Page ' + (p + 1) + ': ' + why + ' again.');
      checkEnd();
    }
    function checkEnd() {
      for (const p of [...j.empty].sort((a, b) => a - b)) {
        const lastAsked = j.to !== null && p === j.to; // with a fixed range the next page is never asked
        if (!j.empty.has(p + 1) && !(lastAsked && isShort(p - 1))) continue;
        if (p > j.from && !j.got.has(p - 1)) continue; // the page before must be known
        const end = p - 1;
        j.end = end;
        queue = queue.filter((q) => q <= end);
        lost = lost.filter((q) => q <= end);
        let stale = 0;
        for (const q of [...j.got.keys()]) if (q > end) { j.got.delete(q); stale++; } // old pages past the end
        if (stale) { recount(j); log('Removed ' + stale + ' outdated page(s) past the end.', 'w'); }
        j.empty = new Set([...j.empty].filter((q) => q <= end));
        if (searchKey(j.body) === lastKey) { realEnd = end + 1; updateMax(); }
        log(end < j.from ? 'No results from page ' + (j.from + 1) + '.' :
          'Last page found: ' + (end + 1) + ' (' + j.got.get(end).books.length + ' books). Pages ' + (p + 1) + '–' + (p + 2) + ' have no results.', 'g');
        return;
      }
    }

    async function one(p) {
      const myEpoch = epoch;
      j.inflight.add(p);
      render();
      try {
        const r = await fetchPage(j.body, p);
        failRow = 0;
        if (j.end !== undefined && p > j.end) return; // past the end already found
        if (!r.books.length) { noBooks(p, 'no books'); return; }
        j.got.set(p, r);
        j.rows += r.books.length;
        j.maxGot = Math.max(j.maxGot, p);
        for (const b of r.books) b.asin ? j.asins.add(b.asin) : j.noAsin++;
        j.times.push(Date.now());
        if (j.times.length > 30) j.times.shift();
        if (searchKey(j.body) === lastKey) { learn({ totalResults: r.total, books: r.books }, p); updateMax(); }
        if (j.empty.size) checkEnd(); // a page arriving later can confirm the end
        if (myEpoch !== epoch) return; // sent before the last error: does not count to speed up again
        if (++okRow >= okNeeded) {
          okRow = 0;
          if (j.limit < threads()) {
            j.limit++; probing = true;
            log('Server stable: back to ' + j.limit + ' parallel requests.', 'g');
          } else if (probing) { probing = false; okNeeded = CONFIG.RECOVER_OK; }
        }
      } catch (e) {
        if (j.end !== undefined && p > j.end) return;
        if (e.status === 404) { noBooks(p, 'HTTP 404'); return; }
        const kind = e.status ? 'HTTP ' + e.status : e.message;
        j.kinds[kind] = (j.kinds[kind] || 0) + 1;
        lastKind = kind;
        if (isFatal(e)) { error = error || e; queue.unshift(p); log('Page ' + (p + 1) + ': ' + kind + '.', 'e'); return; }
        j.retries++;
        const n = (tries.get(p) || 0) + 1;
        tries.set(p, n);
        if (n >= CONFIG.PAGE_TRIES) lost.push(p);       // kept for the final pass
        else if (n === 1) queue.unshift(p);              // first error: retried first
        else queue.push(p);                              // then at the end, so the others go on
        failRow++; okRow = 0;
        if (failRow >= CONFIG.MAX_FAILS) {
          if (!error) { error = new Error('BookBeam did not answer ' + failRow + ' times in a row (last: ' + kind + ')'); error.status = 0; error.page = p; }
          return;
        }
        // errors of requests sent together count as one slowdown
        if (myEpoch === epoch) {
          epoch++;
          if (inAnti.checked) growDelay();
          if (probing) okNeeded = Math.min(okNeeded * 2, CONFIG.MAX_RECOVER_OK);
          probing = false;
          j.limit = 1;
        }
        const wait = Math.max(e.retryAfter, Math.min(CONFIG.BACKOFF_MS + CONFIG.BACKOFF_STEP_MS * (failRow - 1), CONFIG.MAX_BACKOFF_MS));
        pauseUntil = Math.max(pauseUntil, Date.now() + wait);
        log('Page ' + (p + 1) + ': ' + kind + (n >= CONFIG.PAGE_TRIES ? ', left for the final pass' : ', will retry') +
          '. Pause ' + Math.round(wait / 1000) + ' s · delay ' + delayS() + ' s · ' + j.limit + ' parallel.', 'w');
      } finally {
        j.inflight.delete(p);
        render();
      }
    }

    while (true) {
      if (error || stopAsked) { if (!slots) break; await nap(500); continue; }
      const now = Date.now();
      if (now < pauseUntil) {
        j.note = 'BookBeam busy (' + lastKind + '), next try in ' + Math.ceil((pauseUntil - now) / 1000) + ' s';
        render();
        await nap(Math.min(1000, pauseUntil - now));
        continue;
      }
      j.note = '';
      // "Max": keep going past BookBeam's estimate until the real end is found
      if (j.open && j.end === undefined && !finalPass) {
        while (queue.length < 3 && nextOpen - j.from < CONFIG.MAX_PAGES) {
          if (!j.got.has(nextOpen)) queue.push(nextOpen);
          nextOpen++;
        }
      }
      if (!queue.length && !slots) {
        if (lost.length && !finalPass) {
          finalPass = true;
          queue = lost.splice(0).sort((a, b) => a - b);
          tries = new Map(); j.limit = 1; epoch++; okRow = 0; failRow = 0;
          log('Final pass: retrying page(s) ' + ranges(queue) + '.', 'w');
          continue;
        }
        break;
      }
      if (queue.length && slots < Math.min(j.limit, threads())) {
        const p = queue.shift();
        if (j.got.has(p) || (j.end !== undefined && p > j.end)) continue; // each page is downloaded once
        slots++;
        one(p).then(() => sleep(delayS() * 1000)).finally(() => { slots--; poke(); }); // the delay is read live
        continue;
      }
      await nap(1000);
    }
    clearInterval(ticker);
    j.elapsed += Date.now() - j.runStart;
    j.runStart = 0;
    j.note = '';
    finish(j, error, [...lost, ...queue]);
  }

  function finish(j, error, leftover) {
    const upper = j.end !== undefined ? lastGuess(j) : Math.max(lastGuess(j), ...leftover);
    const missing = [];
    for (let p = j.from; p <= upper; p++) if (!j.got.has(p)) missing.push(p);
    const isolated = [...j.empty].filter((p) => p <= upper);
    const rows = buildRows(j);
    let file = null;
    if (rows.length) {
      let market = 'NA';
      try { market = JSON.parse(j.body).marketplace || 'NA'; } catch (e) {}
      file = 'bookbeam_niche_' + market + '_' + today() + '_p' + (j.from + 1) + '-' + (upper + 1) +
        (missing.length ? '_PARTIAL' : '') + '.csv';
      download(toCsv(rows), file);
    }
    running = false;
    pending = missing.length ? { job: j, missing } : null;

    const total = upper - j.from + 1, dups = j.rows - rows.length;
    const kinds = Object.entries(j.kinds).map(([k, n]) => k + ' ×' + n).join(', ');
    let cls, head;
    if (error) {
      cls = 'err';
      head = '✕ Interrupted: ' + (isFatal(error)
        ? error.message + ' at page ' + (error.page + 1) + (error.status === 401 || error.status === 403
          ? '. Your BookBeam session has expired: reload the page, click › once and start a new export (the pages kept in this tab are lost on reload).'
          : '.')
        : error.message + '. Try “Recover missing pages” later.');
    } else if (stopAsked) { cls = 'warn'; head = '■ Stopped by you.'; }
    else if (missing.length) { cls = 'warn'; head = '⚠ Finished with missing pages.'; }
    else if (j.end !== undefined && j.end < j.from) { cls = 'warn'; head = 'No results from page ' + (j.from + 1) + '.'; }
    else { cls = 'ok'; head = j.end !== undefined ? '✓ Finished: last page reached (' + (j.end + 1) + ').' : '✓ Finished.'; }

    const lines = [head];
    if (j.end !== undefined && j.end >= j.from)
      lines.push('Page ' + (j.end + 2) + ' returned no results: BookBeam has no more books for this search.');
    if (total > 0) lines.push('Pages: ' + fmt(j.got.size) + ' of ' + fmt(total) + (j.end === undefined && j.to === null ? ' (estimated)' : ''));
    lines.push('Books: ' + fmt(rows.length) + ' unique · ' + fmt(j.rows) + ' rows · ' + fmt(dups) + ' duplicates removed (repeated by BookBeam)');
    if (missing.length) lines.push('Missing pages: ' + ranges(missing) + '. Click “Recover missing pages” to download only those: the next file will contain the whole list.');
    if (isolated.length) lines.push('Pages with no books (checked twice, kept as missing): ' + ranges(isolated));
    lines.push('Errors: ' + (kinds ? kinds + ' · ' + fmt(j.retries) + ' page retries' : 'none'));
    lines.push('Time: ' + fmtDur(j.elapsed));
    lines.push(file ? 'File: ' + file : 'No file: no books downloaded.');
    showReport(cls, lines);
    log(head + (missing.length ? ' Missing: ' + ranges(missing) + '.' : '') + (file ? ' Saved ' + file + '.' : ''), cls === 'ok' ? 'g' : cls === 'err' ? 'e' : 'w');
    render();
  }

  // ---------- Panel ----------
  let root, panel, fab, inFrom, inTo, inMax, inPar, inDelay, inAnti, info, goBtn, newBtn;
  let progBox, bar, nowEl, sPages, sBooks, sDups, sErr, sEta, sEl, sSpeed, sPar, reportBox, logBox;
  let saved = { from: CONFIG.DEFAULT_FROM, to: CONFIG.DEFAULT_TO };

  const int = (v, d) => { const n = parseInt(v, 10); return isNaN(n) ? d : Math.max(1, n); };
  function pageSize() { try { return JSON.parse(last.body).pageSize || 15; } catch (e) { return 15; } }
  const threads = () => Math.min(CONFIG.MAX_PARALLEL, Math.max(1, parseInt(inPar && inPar.value, 10) || CONFIG.PARALLEL));
  function delayS() {
    const v = parseFloat(String(inDelay ? inDelay.value : CONFIG.DELAY_S).replace(',', '.'));
    return Math.max(CONFIG.DELAY_MIN_S, isFinite(v) ? v : CONFIG.DELAY_S);
  }
  const round = (v) => Math.round(v * 1000) / 1000;
  function growDelay() {
    const v = delayS();
    if (v >= CONFIG.DELAY_MAX_S) return;
    inDelay.value = String(round(Math.min(v + CONFIG.DELAY_STEP_S, CONFIG.DELAY_MAX_S)));
    log('Antithrottled: delay raised to ' + inDelay.value + ' s.', 'w');
  }

  // "1 – 15 of 4888" written in the page
  function domTotal() {
    const el = document.querySelector('.mat-paginator-range-label');
    const m = el && el.textContent.match(/of\s+([\d.,]+)/i);
    return m ? +m[1].replace(/[.,]/g, '') : 0;
  }
  function updateMax() {
    if (!last) return;
    const tot = totalResults || domTotal();
    maxPage = realEnd || (tot ? Math.ceil(tot / (realPageSize || pageSize())) : null);
    if (job && running && searchKey(job.body) === lastKey && job.end === undefined && maxPage) job.est = maxPage - 1;
    if (inMax && inMax.checked) inTo.value = maxPage || '';
    render();
  }

  function log(msg, kind) {
    if (!logBox) return;
    const d = document.createElement('div');
    if (kind) d.className = kind;
    d.textContent = clock() + '  ' + msg;
    logBox.appendChild(d);
    while (logBox.children.length > CONFIG.LOG_LINES) logBox.removeChild(logBox.firstElementChild);
    logBox.scrollTop = logBox.scrollHeight;
  }
  function showReport(cls, lines) {
    lastReport = cls ? { cls, lines } : null;
    if (!reportBox) return;
    reportBox.className = 'bbx-report' + (cls ? ' ' + cls : '');
    reportBox.textContent = '';
    for (const t of lines || []) { const d = document.createElement('div'); d.textContent = t; reportBox.appendChild(d); }
  }

  let drawQueued = false;
  function render() {
    if (drawQueued || !root) return;
    drawQueued = true;
    (window.requestAnimationFrame || setTimeout)(() => { drawQueued = false; draw(); }); // nothing is drawn while the tab is hidden
  }
  function draw() {
    goBtn.textContent = running ? 'Stop and save' : pending ? 'Recover missing pages (' + fmt(pending.missing.length) + ')' : 'Start export';
    goBtn.classList.toggle('bbx-stop', running);
    newBtn.style.display = !running && pending ? 'block' : 'none';
    inFrom.disabled = inTo.disabled = inMax.disabled = running;
    info.textContent = infoText();
    root.classList.toggle('running', running);
    const j = job;
    progBox.style.display = j ? 'block' : 'none';
    let pct = 0, warn = false;
    if (j) {
      const lastP = lastGuess(j), total = Math.max(1, lastP - j.from + 1), done = j.got.size;
      const approx = j.end === undefined && j.to === null ? '~' : '';
      pct = running || pending ? Math.min(100, Math.floor((done / total) * 100)) : 100;
      warn = !!j.note || (!running && !!pending);
      bar.style.width = pct + '%';
      bar.parentNode.classList.toggle('warn', warn);
      const uniq = uniqueCount(j);
      sPages.textContent = fmt(done) + ' / ' + approx + fmt(total);
      sBooks.textContent = fmt(uniq);
      sDups.textContent = fmt(j.rows - uniq);
      sErr.textContent = fmt(j.retries);
      const elapsed = j.elapsed + (j.runStart ? Date.now() - j.runStart : 0);
      sEl.textContent = fmtDur(elapsed);
      sEta.textContent = running ? eta(j, total) : '—';
      sSpeed.textContent = speed(j);
      sPar.textContent = running ? j.limit + ' / ' + threads() : String(threads());
      const now = [...j.inflight].sort((a, b) => a - b).map((p) => p + 1);
      nowEl.textContent = running
        ? (j.note || (now.length ? 'Downloading page ' + now.join(', ') : 'Waiting ' + delayS() + ' s before the next page')) +
          (stopAsked ? ' · stopping…' : '')
        : pending ? 'Paused: ' + fmt(pending.missing.length) + ' page(s) to recover.' : 'Done.';
      nowEl.classList.toggle('warn', warn);
    }
    root.classList.toggle('warn', warn);
    vis.pct = running ? pct : 0; vis.running = running; vis.warn = warn; vis.badge = !running && !!pending;
    wakeBubble();
  }
  function speed(j) {
    const t = j.times;
    if (t.length < 2) return '—';
    const ppm = (t.length - 1) / ((t[t.length - 1] - t[0]) / 60000);
    return ppm.toFixed(ppm < 10 ? 1 : 0);
  }
  function eta(j, total) {
    const t = j.times;
    if (t.length < 3) return '…';
    const rate = (t.length - 1) / (t[t.length - 1] - t[0]); // pages per ms, pauses included
    const left = Math.max(0, total - j.got.size);
    return (j.end === undefined && j.to === null ? '~' : '') + fmtDur(left / rate);
  }
  function infoText() {
    if (!last) return 'Click “Find Books” first, so the script can read your filters.';
    const lp = realEnd ? 'Last page: ' + realEnd + ' (confirmed).'
      : maxPage ? 'Last page: ~' + maxPage + ' (BookBeam’s estimate, often too high: the export stops at the real end).'
        : 'Last page: not known yet; the export stops at the real end.';
    if (running) return lp;
    const f = inMax.checked ? 1 : int(inFrom.value, 1), t = inMax.checked ? maxPage : int(inTo.value, f);
    const n = t ? Math.abs(t - f) + 1 : null;
    return (n ? fmt(n) + ' pages · up to ' + fmt(n * (realPageSize || pageSize())) + ' books. ' : '') + lp;
  }

  function applyMax() {
    if (inMax.checked) { inFrom.value = 1; inTo.value = maxPage || ''; inTo.placeholder = 'max'; }
    else { inFrom.value = saved.from; inTo.value = saved.to; inTo.placeholder = ''; }
  }
  function dropPending(why) {
    if (pending && !running) { pending = null; log(why + ': the recovery was discarded.', 'w'); }
  }

  // The bubble lives only on the Niche Finder page. BookBeam changes page through the address "#/...",
  // which @match cannot see, so the script follows it here.
  const onNicheFinder = () => /^#\/niche-finder(?:[/?]|$)/.test(location.hash || '');
  function syncRoute() {
    if (!root) return;
    const on = onNicheFinder();
    root.style.display = on ? '' : 'none';
    if (!on) root.classList.remove('open');
    else wakeBubble();
  }

  // ---------- Bubble ----------
  // Soft body: BB.N points on the rim, moved with Verlet integration and held together by XPBD-style
  // constraints (rim lengths + area, i.e. the air pressure inside). The centre follows a damped spring
  // (Hooke + damping) toward the cursor, scaled by a distance falloff: the magnet. Near the cursor a
  // metaball droplet grows out of the bubble and finally joins it. Light: Fresnel rim, thin-film
  // iridescent band, specular highlight that moves against the cursor.
  // Cost: 60 fps only while something moves, about 20 fps for the idle breathing, nothing while the
  // tab or the bubble is hidden; no layout is read while the mouse moves.
  const BB = { N: 28, R0: 27, SIZE: 320, C: 262, PULL: 170 };
  let cvs = null, g = null, dpr = 1, pts = [], loopOn = false, lastT = 0;
  const cen = { x: BB.C, y: BB.C, vx: 0, vy: 0, hx: 0, hy: 0 };
  const drop = { x: BB.C, y: BB.C, r: 0 }, mouse = { x: -1e5, y: -1e5 }, t0 = Date.now();
  const vis = { pct: 0, running: false, warn: false, badge: false };
  const motion = () => CONFIG.MOTION && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const nowMs = () => (window.performance ? performance.now() : Date.now());

  function bubbleInit() {
    cvs = root.querySelector('#bbx-canvas');
    g = cvs && cvs.getContext ? cvs.getContext('2d') : null;
    if (!g) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cvs.width = BB.SIZE * dpr; cvs.height = BB.SIZE * dpr;
    pts = [];
    for (let i = 0; i < BB.N; i++) {
      const a = (i / BB.N) * 2 * Math.PI, x = BB.C + Math.cos(a) * BB.R0, y = BB.C + Math.sin(a) * BB.R0;
      pts.push({ a, x, y, px: x, py: y });
    }
    document.addEventListener('mousemove', (e) => {
      mouse.x = e.clientX - (window.innerWidth - BB.SIZE);
      mouse.y = e.clientY - (window.innerHeight - BB.SIZE);
      if (Math.hypot(mouse.x - BB.C, mouse.y - BB.C) < BB.PULL + 60) wakeBubble();
    }, { passive: true });
    document.addEventListener('mouseleave', () => { mouse.x = mouse.y = -1e5; wakeBubble(); });
    document.addEventListener('visibilitychange', wakeBubble);
    window.addEventListener('resize', wakeBubble);
    wakeBubble();
  }
  // a push on the rim: a squash along an angle (hover) or a press inward (click)
  function jiggle(kind) {
    for (const p of pts) {
      const v = kind === 'press' ? -2.4 : 2.8 * Math.cos(2 * (p.a - kind));
      p.px -= Math.cos(p.a) * v; p.py -= Math.sin(p.a) * v;
    }
    wakeBubble();
  }

  function stepBubble(t) {
    const N = BB.N, open = root.classList.contains('open');
    const dxr = mouse.x - BB.C, dyr = mouse.y - BB.C, dr = Math.hypot(dxr, dyr);
    const near = !open && dr < BB.PULL;
    const fall = near ? 1 - dr / BB.PULL : 0; // distance falloff
    const breathe = Math.sin(t * 1.5);
    // magnet: damped spring toward a target that leans to the cursor
    const tx = BB.C + dxr * fall * 0.3, ty = BB.C + dyr * fall * 0.3 - breathe * 1.5;
    cen.vx = (cen.vx + (tx - cen.x) * 0.06) * 0.86;
    cen.vy = (cen.vy + (ty - cen.y) * 0.06) * 0.86;
    cen.x += cen.vx; cen.y += cen.vy;
    const dx = mouse.x - cen.x, dy = mouse.y - cen.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
    cen.hx += (-ux * fall * 4 - cen.hx) * 0.15; cen.hy += (-uy * fall * 4 - cen.hy) * 0.15;
    const r0 = BB.R0 * (1 + breathe * 0.012);
    // Verlet: inertia + pull toward the rest shape, stretched toward a near cursor
    for (const p of pts) {
      const ca = Math.cos(p.a), sa = Math.sin(p.a);
      const face = near ? Math.max(0, ca * ux + sa * uy) : 0;
      const st = face * face * face * fall * fall * 15;
      const rx = cen.x + ca * r0 + ux * st, ry = cen.y + sa * r0 + uy * st;
      const vx = (p.x - p.px) * 0.93, vy = (p.y - p.py) * 0.93;
      p.px = p.x; p.py = p.y;
      p.x += vx + (rx - p.x) * 0.12; p.y += vy + (ry - p.y) * 0.12;
    }
    // XPBD-style constraints: rim lengths and area (the air inside keeps the volume)
    const L0 = 2 * r0 * Math.sin(Math.PI / N), A0 = 0.5 * N * r0 * r0 * Math.sin((2 * Math.PI) / N);
    for (let it = 0; it < 2; it++) {
      for (let i = 0; i < N; i++) {
        const p = pts[i], q = pts[(i + 1) % N];
        const ex = q.x - p.x, ey = q.y - p.y, l = Math.hypot(ex, ey) || 1, k = ((l - L0) / l) * 0.25;
        p.x += ex * k; p.y += ey * k; q.x -= ex * k; q.y -= ey * k;
      }
      let A = 0;
      for (let i = 0; i < N; i++) { const p = pts[i], q = pts[(i + 1) % N]; A += p.x * q.y - q.x * p.y; }
      A *= 0.5;
      const gr = new Array(2 * N);
      let sum = 0;
      for (let i = 0; i < N; i++) {
        const n = pts[(i + 1) % N], b = pts[(i + N - 1) % N];
        gr[2 * i] = 0.5 * (n.y - b.y); gr[2 * i + 1] = 0.5 * (b.x - n.x);
        sum += gr[2 * i] * gr[2 * i] + gr[2 * i + 1] * gr[2 * i + 1];
      }
      const lam = sum ? ((A0 - A) / sum) * 0.5 : 0;
      for (let i = 0; i < N; i++) { pts[i].x += gr[2 * i] * lam; pts[i].y += gr[2 * i + 1] * lam; }
    }
    // metaball droplet: grows out toward a near cursor, then joins it
    const join = near && dr < r0 + 34;
    const reach = near ? Math.min(d, r0 * 0.55 + 55 * Math.pow(fall, 1.4)) : 0;
    const gx = join ? mouse.x : cen.x + ux * reach, gy = join ? mouse.y : cen.y + uy * reach;
    const rTarget = near ? 3 + 7.5 * Math.pow(fall, 0.8) : 0;
    drop.x += (gx - drop.x) * 0.2; drop.y += (gy - drop.y) * 0.2; drop.r += (rTarget - drop.r) * 0.15;
    if (drop.r < 0.3) { drop.x = cen.x; drop.y = cen.y; drop.r = 0; }
  }
  function restBubble() {
    cen.x = BB.C; cen.y = BB.C; cen.vx = cen.vy = cen.hx = cen.hy = 0; drop.r = 0;
    for (const p of pts) { p.x = p.px = BB.C + Math.cos(p.a) * BB.R0; p.y = p.py = BB.C + Math.sin(p.a) * BB.R0; }
  }
  function moving() {
    let e = Math.abs(cen.vx) + Math.abs(cen.vy) + drop.r;
    for (const p of pts) e += Math.abs(p.x - p.px) + Math.abs(p.y - p.py);
    return e > 0.4 || Math.hypot(mouse.x - BB.C, mouse.y - BB.C) < BB.PULL + 40;
  }

  function wakeBubble() {
    if (!g || loopOn) return;
    loopOn = true;
    lastT = nowMs();
    (window.requestAnimationFrame || setTimeout)(frame);
  }
  function frame() {
    if (!root || root.style.display === 'none' || document.hidden) { loopOn = false; return; }
    const now = nowMs(), live = motion();
    const n = Math.min(4, Math.max(1, Math.round((now - lastT) / 16.7)));
    lastT = now;
    if (live) { const t = (Date.now() - t0) / 1000; for (let i = 0; i < n; i++) stepBubble(t + i / 60); } else restBubble();
    paintBubble((Date.now() - t0) / 1000);
    if (!live) { loopOn = false; return; }
    if (moving()) requestAnimationFrame(frame);
    else setTimeout(() => requestAnimationFrame(frame), 50); // idle breathing, about 20 fps
  }

  // smooth closed outline through the rim points
  function bodyPath() {
    const N = BB.N, p = new Path2D();
    const mid = (i) => { const a = pts[i % N], b = pts[(i + 1) % N]; return [(a.x + b.x) / 2, (a.y + b.y) / 2]; };
    const s = mid(N - 1);
    p.moveTo(s[0], s[1]);
    for (let i = 0; i < N; i++) { const m = mid(i); p.quadraticCurveTo(pts[i].x, pts[i].y, m[0], m[1]); }
    p.closePath();
    return p;
  }
  // neck between two circles (metaball connector, same method as the Paper.js metaball example)
  function metaball(r1, r2, c1, c2) {
    const d = Math.hypot(c2.x - c1.x, c2.y - c1.y), v = 0.5, hs = 2.4;
    if (!r1 || !r2 || d > r1 + r2 * 2.5 || d <= Math.abs(r1 - r2)) return null;
    let u1 = 0, u2 = 0;
    if (d < r1 + r2) {
      u1 = Math.acos((r1 * r1 + d * d - r2 * r2) / (2 * r1 * d));
      u2 = Math.acos((r2 * r2 + d * d - r1 * r1) / (2 * r2 * d));
    }
    const ab = Math.atan2(c2.y - c1.y, c2.x - c1.x), spread = Math.acos((r1 - r2) / d);
    const a1 = ab + u1 + (spread - u1) * v, a2 = ab - u1 - (spread - u1) * v;
    const a3 = ab + Math.PI - u2 - (Math.PI - u2 - spread) * v, a4 = ab - Math.PI + u2 + (Math.PI - u2 - spread) * v;
    const at = (c, a, r) => ({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
    const p1 = at(c1, a1, r1), p2 = at(c1, a2, r1), p3 = at(c2, a3, r2), p4 = at(c2, a4, r2);
    const tot = r1 + r2, k = Math.min(v * hs, Math.hypot(p3.x - p1.x, p3.y - p1.y) / tot) * Math.min(1, (d * 2) / tot);
    const h1 = at(p1, a1 - Math.PI / 2, r1 * k), h2 = at(p2, a2 + Math.PI / 2, r1 * k);
    const h3 = at(p3, a3 + Math.PI / 2, r2 * k), h4 = at(p4, a4 - Math.PI / 2, r2 * k);
    const path = new Path2D();
    path.moveTo(p1.x, p1.y); path.bezierCurveTo(h1.x, h1.y, h3.x, h3.y, p3.x, p3.y);
    path.lineTo(p4.x, p4.y); path.bezierCurveTo(h4.x, h4.y, h2.x, h2.y, p2.x, p2.y);
    path.closePath();
    return path;
  }

  function paintBubble(t) {
    const c = g, S = BB.SIZE, r = BB.R0, x = cen.x, y = cen.y, TAU = 2 * Math.PI;
    fab.style.transform = 'translate(' + (x - BB.C).toFixed(1) + 'px,' + (y - BB.C).toFixed(1) + 'px)'; // click area follows the bubble
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, S, S);
    // soft shadow under the bubble
    c.save(); c.translate(x, y + r * 1.02); c.scale(1, 0.3);
    const sh = c.createRadialGradient(0, 0, 0, 0, 0, r);
    sh.addColorStop(0, 'rgba(10,90,55,.30)'); sh.addColorStop(1, 'rgba(10,90,55,0)');
    c.fillStyle = sh; c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill(); c.restore();
    // droplet and neck first, the body covers the joint
    if (drop.r > 0.6) {
      c.fillStyle = '#17ad6f';
      const neck = metaball(r, drop.r, cen, drop);
      if (neck) c.fill(neck);
      const dg = c.createRadialGradient(drop.x - drop.r * 0.4, drop.y - drop.r * 0.4, 0, drop.x, drop.y, drop.r * 1.2);
      dg.addColorStop(0, '#6ff5bb'); dg.addColorStop(0.6, '#1fc07e'); dg.addColorStop(1, '#0f8a56');
      c.fillStyle = dg; c.beginPath(); c.arc(drop.x, drop.y, drop.r, 0, TAU); c.fill();
    }
    const body = bodyPath();
    const fill = c.createRadialGradient(x - r * 0.32, y - r * 0.38, r * 0.05, x, y, r * 1.3);
    fill.addColorStop(0, '#6ff5bb'); fill.addColorStop(0.42, '#1fc07e'); fill.addColorStop(0.78, '#11935c'); fill.addColorStop(1, '#0a6b42');
    c.fillStyle = fill; c.fill(body);
    c.save(); c.clip(body);
    const shade = c.createRadialGradient(x, y - r * 0.5, r * 0.3, x, y, r * 1.25); // depth: darker at the bottom
    shade.addColorStop(0, 'rgba(3,58,34,0)'); shade.addColorStop(1, 'rgba(3,58,34,.42)');
    c.fillStyle = shade; c.fillRect(x - 2 * r, y - 2 * r, 4 * r, 4 * r);
    const fr = c.createRadialGradient(x, y, r * 0.7, x, y, r * 1.08); // Fresnel: the rim reflects more light
    fr.addColorStop(0, 'rgba(230,255,245,0)'); fr.addColorStop(1, 'rgba(230,255,245,.42)');
    c.fillStyle = fr; c.fillRect(x - 2 * r, y - 2 * r, 4 * r, 4 * r);
    c.restore();
    if (c.createConicGradient) { // thin film: a faint iridescent band that slowly turns
      const tf = c.createConicGradient(t * 0.35, x, y);
      const hues = ['#ff78c8', '#ffe678', '#78ffdc', '#82aaff', '#dc82ff', '#ff78c8'];
      hues.forEach((h, i) => tf.addColorStop(i / (hues.length - 1), h));
      c.save(); c.globalAlpha = 0.3; c.globalCompositeOperation = 'screen'; c.lineWidth = 3; c.strokeStyle = tf; c.stroke(body); c.restore();
    }
    // specular highlight, moving a little against the cursor
    c.save(); c.translate(x - r * 0.3 + cen.hx, y - r * 0.5 + cen.hy); c.rotate(-0.5); c.scale(1, 0.55);
    const hl = c.createRadialGradient(0, 0, 0, 0, 0, r * 0.56);
    hl.addColorStop(0, 'rgba(255,255,255,.98)'); hl.addColorStop(0.35, 'rgba(255,255,255,.75)'); hl.addColorStop(0.7, 'rgba(255,255,255,.18)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = hl; c.beginPath(); c.arc(0, 0, r * 0.56, 0, TAU); c.fill(); c.restore();
    c.fillStyle = 'rgba(210,255,235,.35)';
    c.beginPath(); c.ellipse(x + r * 0.42 - cen.hx * 0.5, y + r * 0.5 - cen.hy * 0.5, r * 0.16, r * 0.08, -0.6, 0, TAU); c.fill();
    if (drop.r > 2) { c.fillStyle = 'rgba(255,255,255,.7)'; c.beginPath(); c.arc(drop.x - drop.r * 0.35, drop.y - drop.r * 0.35, drop.r * 0.28, 0, TAU); c.fill(); }
    // progress ring while exporting
    if (vis.running) {
      c.lineWidth = 3.5; c.lineCap = 'round';
      c.strokeStyle = 'rgba(17,147,92,.18)'; c.beginPath(); c.arc(x, y, r + 7, 0, TAU); c.stroke();
      if (vis.pct > 0) {
        c.strokeStyle = vis.warn ? '#f59e0b' : '#14a86b';
        c.beginPath(); c.arc(x, y, r + 7, -Math.PI / 2, -Math.PI / 2 + (TAU * vis.pct) / 100); c.stroke();
      }
    }
    // label: % while exporting, otherwise a download arrow
    c.save(); c.shadowColor = 'rgba(0,0,0,.3)'; c.shadowBlur = 3; c.shadowOffsetY = 1; c.fillStyle = c.strokeStyle = '#fff';
    if (vis.running) {
      c.font = '700 14px system-ui,-apple-system,"Segoe UI",sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(vis.pct + '%', x, y + 1);
    } else {
      c.lineWidth = 2.4; c.lineCap = 'round'; c.lineJoin = 'round'; c.beginPath();
      c.moveTo(x, y - 9); c.lineTo(x, y + 3); c.moveTo(x - 5, y - 2); c.lineTo(x, y + 3); c.lineTo(x + 5, y - 2);
      c.moveTo(x - 7.5, y + 8.5); c.lineTo(x + 7.5, y + 8.5); c.stroke();
    }
    c.restore();
    if (vis.badge) {
      const bx = x + r * 0.74, by = y - r * 0.74;
      c.fillStyle = '#f59e0b'; c.beginPath(); c.arc(bx, by, 9, 0, TAU); c.fill();
      c.fillStyle = '#fff'; c.font = '700 12px system-ui,sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('!', bx, by + 0.5);
    }
  }


  function ensureUi() {
    if (root) return;
    if (!document.body) return document.addEventListener('DOMContentLoaded', ensureUi, { once: true });

    const css = document.createElement('style');
    css.textContent = `
      #bbx-root{--g1:#5ff0b0;--g2:#1fc07e;--g3:#11935c;--g4:#0a6b42;position:fixed;right:26px;bottom:26px;z-index:99999;
        font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2937}
      #bbx-canvas{position:absolute;right:-26px;bottom:-26px;width:320px;height:320px;pointer-events:none}
      #bbx-fab{position:relative;display:block;width:64px;height:64px;margin-left:auto;padding:0;border:0;border-radius:50%;
        background:transparent;cursor:pointer;outline:none;-webkit-tap-highlight-color:transparent}
      #bbx-fab:focus-visible{box-shadow:0 0 0 3px rgba(22,163,109,.45)}

      #bbx-panel{position:absolute;right:0;bottom:80px;width:356px;max-height:calc(100vh - 130px);overflow:auto;box-sizing:border-box;
        background:linear-gradient(180deg,#ffffff 0%,#f8fbf9 100%);border:1px solid rgba(17,24,39,.08);border-radius:22px;
        box-shadow:0 28px 64px rgba(17,24,39,.22),0 3px 10px rgba(17,24,39,.06),inset 0 1px 0 #fff;padding:16px 18px 14px;
        transform-origin:calc(100% - 32px) calc(100% + 48px);transform:translate(0,12px) scale(.18);opacity:0;visibility:hidden;
        transition:transform .32s cubic-bezier(.4,0,.6,1),opacity .2s ease .08s,visibility 0s linear .32s;scrollbar-width:thin}
      #bbx-root.open #bbx-panel{transform:none;opacity:1;visibility:visible;
        transition:transform .46s cubic-bezier(.2,1.28,.32,1),opacity .16s ease,visibility 0s}
      #bbx-root .bbx-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:2px}
      #bbx-root .bbx-title{font-weight:700;font-size:15px;color:#0f172a;letter-spacing:-.01em}
      #bbx-root .bbx-ver{font-size:11px;color:#94a3b8;background:#f1f5f4;border-radius:999px;padding:1px 8px}
      #bbx-root .bbx-sec{font:600 10.5px system-ui;letter-spacing:.07em;text-transform:uppercase;color:#64748b;margin:13px 0 6px}
      #bbx-root .bbx-row{display:flex;gap:10px;align-items:flex-end}
      #bbx-root .bbx-field{flex:1;display:flex;flex-direction:column;gap:4px;min-width:0}
      #bbx-root .bbx-field>span{font-size:12px;color:#475569;white-space:nowrap}
      #bbx-root input[type=number]{width:100%;box-sizing:border-box;margin:0;padding:7px 9px;border:1px solid #d7dee3;border-radius:10px;
        font:500 14px system-ui;color:#0f172a;background:#fff;transition:border-color .15s,box-shadow .15s}
      #bbx-root input[type=number]:focus{outline:none;border-color:#16a36d;box-shadow:0 0 0 3px rgba(22,163,109,.16)}
      #bbx-root input:disabled{background:#f1f5f4;color:#94a3b8}
      #bbx-root #bbx-delay::-webkit-inner-spin-button{opacity:1;height:26px;cursor:pointer}
      #bbx-root .bbx-check{display:flex;align-items:center;gap:7px;cursor:pointer;white-space:nowrap;font-size:13px;color:#0f172a;padding-bottom:8px}
      #bbx-root .bbx-check input{width:17px;height:17px;margin:0;accent-color:#16a36d;cursor:pointer}
      #bbx-root .bbx-note{font-size:11.5px;color:#64748b;margin:3px 0 0 24px}
      #bbx-root .bbx-info{font-size:12px;color:#334155;background:#f3f7f5;border-radius:12px;padding:8px 10px;margin:13px 0 11px}
      #bbx-root .bbx-btn{width:100%;padding:10px;border:none;border-radius:999px;font:600 14px system-ui;cursor:pointer;color:#fff;
        background:linear-gradient(180deg,#2bcf8a 0%,#14a067 100%);
        box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 6px 16px rgba(20,160,103,.32);transition:transform .15s,filter .15s,box-shadow .2s}
      #bbx-root .bbx-btn:hover{filter:brightness(1.05)}
      #bbx-root .bbx-btn:active{transform:scale(.97)}
      #bbx-root .bbx-btn.bbx-stop{background:linear-gradient(180deg,#f36b6b 0%,#d63434 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.3),0 6px 16px rgba(214,52,52,.3)}
      #bbx-root .bbx-link{display:none;width:100%;margin-top:6px;padding:4px;border:none;background:none;color:#64748b;font:12px system-ui;text-decoration:underline;cursor:pointer}
      #bbx-root .bbx-track{height:10px;background:#e6ece9;border-radius:999px;overflow:hidden;margin:2px 0 8px;box-shadow:inset 0 1px 2px rgba(0,0,0,.08)}
      #bbx-root .bbx-track i{display:block;height:100%;width:0;border-radius:999px;background:linear-gradient(90deg,#14a067,#46dc9c);
        transition:width .6s cubic-bezier(.2,.8,.2,1)}
      #bbx-root.running .bbx-track i{background:linear-gradient(110deg,rgba(255,255,255,0) 35%,rgba(255,255,255,.55) 50%,rgba(255,255,255,0) 65%) 0 0/220% 100%,
        linear-gradient(90deg,#14a067,#46dc9c);animation:bbx-shine 1.8s linear infinite}
      #bbx-root .bbx-track.warn i{background:linear-gradient(90deg,#f59e0b,#fbbf24)}
      @keyframes bbx-shine{from{background-position:130% 0,0 0}to{background-position:-90% 0,0 0}}
      #bbx-root .bbx-now{font-size:12px;color:#0f172a;margin-bottom:8px;min-height:17px}
      #bbx-root .bbx-now.warn{color:#b45309}
      #bbx-root .bbx-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
      #bbx-root .bbx-stats div{background:#f3f7f5;border-radius:10px;padding:6px 4px;text-align:center;min-width:0}
      #bbx-root .bbx-stats b{display:block;font:650 13px/1.25 system-ui;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #bbx-root .bbx-stats span{display:block;font-size:10px;color:#64748b;white-space:nowrap}
      #bbx-root .bbx-report{display:none;margin-top:11px;border-radius:12px;padding:9px 11px;font-size:12px}
      #bbx-root .bbx-report div+div{margin-top:3px}
      #bbx-root .bbx-report div:first-child{font-weight:650}
      #bbx-root .bbx-report.ok{display:block;background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0}
      #bbx-root .bbx-report.warn{display:block;background:#fffbeb;color:#92400e;border:1px solid #fde68a}
      #bbx-root .bbx-report.err{display:block;background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
      #bbx-root .bbx-log{height:132px;overflow:auto;background:#0f172a;color:#cbd5e1;border-radius:12px;padding:7px 9px;
        font:11px/1.5 ui-monospace,Consolas,monospace;scrollbar-width:thin}
      #bbx-root .bbx-log div{white-space:pre-wrap;word-break:break-word}
      #bbx-root .bbx-log .w{color:#fcd34d}#bbx-root .bbx-log .e{color:#fca5a5}#bbx-root .bbx-log .g{color:#86efac}`;
    document.head.appendChild(css);

    root = document.createElement('div');
    root.id = 'bbx-root';
    root.innerHTML = `
      <canvas id="bbx-canvas" aria-hidden="true"></canvas>
      <div id="bbx-panel">
        <div class="bbx-head"><span class="bbx-title">Niche Finder → CSV</span><span class="bbx-ver">v${VERSION}</span></div>
        <div class="bbx-sec">Pages</div>
        <div class="bbx-row">
          <label class="bbx-field"><span>From page</span><input id="bbx-from" type="number" min="1"></label>
          <label class="bbx-field"><span>To page</span><input id="bbx-to" type="number" min="1"></label>
          <label class="bbx-check" title="From page 1 to the last page"><input id="bbx-max" type="checkbox"> Max</label>
        </div>
        <div class="bbx-sec">Speed</div>
        <div class="bbx-row">
          <label class="bbx-field" style="flex:.8"><span>Parallel requests</span><input id="bbx-par" type="number" min="1" max="${CONFIG.MAX_PARALLEL}"></label>
          <label class="bbx-field" style="flex:1.2"><span>Delay between requests (s)</span><input id="bbx-delay" type="number" step="0.1" min="${CONFIG.DELAY_MIN_S}"></label>
        </div>
        <label class="bbx-check" style="margin-top:9px;padding:0"><input id="bbx-anti" type="checkbox"> Antithrottled</label>
        <div class="bbx-note">Adds ${CONFIG.DELAY_STEP_S} s to the delay each time BookBeam slows down or fails. Speed changes apply while running.</div>
        <div class="bbx-info" id="bbx-info"></div>
        <button type="button" class="bbx-btn" id="bbx-go">Start export</button>
        <button type="button" class="bbx-link" id="bbx-new">Discard the recovery and start a new export</button>
        <div id="bbx-prog" style="display:none">
          <div class="bbx-sec">Progress</div>
          <div class="bbx-track"><i id="bbx-bar"></i></div>
          <div class="bbx-now" id="bbx-now"></div>
          <div class="bbx-stats">
            <div><b id="bbx-s-pages"></b><span>pages</span></div>
            <div><b id="bbx-s-books"></b><span>books</span></div>
            <div><b id="bbx-s-dups"></b><span>duplicates</span></div>
            <div><b id="bbx-s-err"></b><span>retries</span></div>
            <div><b id="bbx-s-eta"></b><span>time left</span></div>
            <div><b id="bbx-s-el"></b><span>elapsed</span></div>
            <div><b id="bbx-s-speed"></b><span>pages/min</span></div>
            <div><b id="bbx-s-par"></b><span>parallel</span></div>
          </div>
        </div>
        <div class="bbx-report" id="bbx-report"></div>
        <div class="bbx-sec">Log</div>
        <div class="bbx-log" id="bbx-log"></div>
      </div>
      <button type="button" id="bbx-fab" aria-label="BookBeam export" title="BookBeam export (click to keep it open)"></button>`;
    document.body.appendChild(root);
    syncRoute();
    window.addEventListener('hashchange', syncRoute);
    window.addEventListener('popstate', syncRoute);
    const $ = (id) => root.querySelector('#' + id);
    panel = $('bbx-panel'); fab = $('bbx-fab');
    inFrom = $('bbx-from'); inTo = $('bbx-to'); inMax = $('bbx-max');
    inPar = $('bbx-par'); inDelay = $('bbx-delay'); inAnti = $('bbx-anti');
    info = $('bbx-info'); goBtn = $('bbx-go'); newBtn = $('bbx-new');
    progBox = $('bbx-prog'); bar = $('bbx-bar'); nowEl = $('bbx-now');
    sPages = $('bbx-s-pages'); sBooks = $('bbx-s-books'); sDups = $('bbx-s-dups'); sErr = $('bbx-s-err');
    sEta = $('bbx-s-eta'); sEl = $('bbx-s-el'); sSpeed = $('bbx-s-speed'); sPar = $('bbx-s-par');
    reportBox = $('bbx-report'); logBox = $('bbx-log');

    inPar.value = CONFIG.PARALLEL;
    inDelay.value = CONFIG.DELAY_S;
    inAnti.checked = CONFIG.ANTITHROTTLED;
    inMax.checked = CONFIG.MAX_DEFAULT;
    applyMax();

    inMax.addEventListener('change', () => {
      if (inMax.checked) saved = { from: inFrom.value || CONFIG.DEFAULT_FROM, to: inTo.value || CONFIG.DEFAULT_TO };
      applyMax();
      dropPending('Range changed');
      render();
    });
    for (const el of [inFrom, inTo]) el.addEventListener('input', () => {
      if (inMax.checked) { inMax.checked = false; inTo.placeholder = ''; } // typing a page switches to a custom range
      saved = { from: inFrom.value, to: inTo.value };
      dropPending('Range changed');
      render();
    });
    inDelay.addEventListener('change', () => {
      inDelay.value = String(round(delayS()));
      if (running) log('Delay set to ' + inDelay.value + ' s (applies from the next page).');
      render();
    });
    inPar.addEventListener('change', () => {
      inPar.value = threads();
      if (running) log('Parallel requests set to ' + inPar.value + '.');
      render();
    });
    inAnti.addEventListener('change', () => { if (running) log('Antithrottled ' + (inAnti.checked ? 'on' : 'off') + '.'); });
    goBtn.addEventListener('click', () => { start(); });
    newBtn.addEventListener('click', () => { pending = null; log('Recovery discarded.', 'w'); start(); });

    // Open on hover, click the bubble to keep it open; stays open while exporting
    let pinned = false, closeTimer;
    const open = () => { clearTimeout(closeTimer); if (!root.classList.contains('open')) { updateMax(); root.classList.add('open'); } };
    fab.addEventListener('mouseenter', (e) => {
      jiggle(Math.atan2(e.clientY - (window.innerHeight - BB.SIZE) - cen.y, e.clientX - (window.innerWidth - BB.SIZE) - cen.x));
      open();
    });
    fab.addEventListener('mousedown', () => jiggle('press'));
    panel.addEventListener('mouseenter', () => { if (root.classList.contains('open')) clearTimeout(closeTimer); });
    fab.addEventListener('click', () => {
      pinned = !pinned;
      fab.title = pinned ? 'Click to let the panel close' : 'BookBeam export (click to keep it open)';
      if (pinned) open(); else root.classList.remove('open');
    });
    root.addEventListener('mouseleave', () => {
      closeTimer = setTimeout(() => {
        if (!pinned && !running && !root.contains(document.activeElement)) root.classList.remove('open');
      }, 600);
    });

    bubbleInit();
    updateMax();
    render();
  }
})();
