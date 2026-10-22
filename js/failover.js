// failover.js — student-side multi-address client. Works in the browser (window.AttFailover)
// and in Node (require) so it can be unit-tested.
//
// The QR/gateway tells the phone ALL live addresses of the attendance server. The phone itself
// decides which one works for ITS network: the first address is tried at once, the next one
// 2.5 s later (or immediately if the first fails fast), and so on — the first good answer wins.
// A POST (register) is sent to one address at a time and moves on when an address does not
// answer. Registering twice is harmless: the server answers ALREADY_REGISTERED / DEVICE_ALREADY_USED.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AttFailover = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_HOSTS = 8;
  const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$|^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?$/i;

  // ['https://a.b.com', 'http://1.2.3.4:8080'] -> 'a.b.com,!1.2.3.4:8080'   ("!" = plain http)
  function encodeHosts(urls) {
    const out = [];
    (urls || []).forEach((u) => {
      try {
        const x = new URL(u);
        if (x.protocol !== 'https:' && x.protocol !== 'http:') return;
        const h = (x.protocol === 'http:' ? '!' : '') + x.host;
        if (!out.includes(h)) out.push(h);
      } catch (e) {}
    });
    return out.join(',');
  }

  // inverse of encodeHosts; ignores anything that does not look like a host name / IP
  function decodeHosts(str) {
    const out = [];
    String(str || '')
      .split(',')
      .slice(0, MAX_HOSTS)
      .forEach((raw) => {
        const plain = raw.startsWith('!');
        const host = (plain ? raw.slice(1) : raw).trim();
        if (!host || host.length > 120 || !HOST_RE.test(host)) return;
        const url = (plain ? 'http://' : 'https://') + host.toLowerCase();
        if (!out.includes(url)) out.push(url);
      });
    return out;
  }

  function endpointError(msg) {
    const e = new Error(msg);
    e.endpointFailure = true;
    return e;
  }

  // opts: { origin, alternates, fetch, pageProtocol, timeoutMs, postTimeoutMs, staggerMs }
  function createClient(opts) {
    const o = opts || {};
    const f = o.fetch || ((...a) => globalThis.fetch(...a));
    const origin = o.origin;
    const timeoutMs = o.timeoutMs || 8000;
    const postTimeoutMs = o.postTimeoutMs || 14000;
    const staggerMs = o.staggerMs == null ? 1800 : o.staggerMs;
    const pageProtocol = o.pageProtocol || '';
    let bases = [];
    let sticky = origin;

    function learn(list) {
      (list || []).forEach((u) => {
        const clean = String(u || '').replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(clean) || bases.includes(clean)) return;
        // an https page cannot talk to a plain-http address (mixed content) — do not waste time
        if (pageProtocol === 'https:' && /^http:/i.test(clean)) return;
        bases.push(clean);
      });
    }
    if (origin && /^https?:\/\//i.test(String(origin))) learn([origin]);
    learn(o.alternates);
    if (!sticky && bases.length) sticky = bases[0];

    function ordered() {
      return [sticky, ...bases.filter((b) => b !== sticky)];
    }

    async function attempt(base, path, init, ms) {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(() => ctrl && ctrl.abort(), ms);
      try {
        const url = (origin && base === origin ? '' : base) + '/api' + path;
        const res = await f(url, {
          method: init.method || 'GET',
          headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
          body: init.body ? JSON.stringify(init.body) : undefined,
          signal: ctrl ? ctrl.signal : undefined,
          cache: 'no-store'
        });
        const text = await res.text();
        let data = null;
        try {
          data = JSON.parse(text);
        } catch (e) {}
        // tunnel error pages (502/530, "tunnel unavailable"…) are HTML, never our JSON
        if (res.status >= 500 || data === null || typeof data !== 'object') {
          throw endpointError('bad answer from ' + base + ' (HTTP ' + res.status + ')');
        }
        return { status: res.status, ok: res.status >= 200 && res.status < 300, data, base };
      } catch (e) {
        if (e && e.endpointFailure) throw e;
        throw endpointError('no answer from ' + base);
      } finally {
        clearTimeout(timer);
      }
    }

    function netError(errs) {
      const e = new Error('no address answered');
      e.code = 'NETWORK';
      e.tried = errs.length;
      return e;
    }

    // idempotent GET: staggered race, first good answer wins
    function get(path) {
      const list = ordered();
      return new Promise((resolve, reject) => {
        let next = 0;
        let running = 0;
        let finished = false;
        let timer = null;
        const errs = [];
        function schedule() {
          clearTimeout(timer);
          if (!finished && next < list.length) timer = setTimeout(launch, staggerMs);
        }
        function launch() {
          if (finished || next >= list.length) return;
          const b = list[next++];
          running++;
          attempt(b, path, { method: 'GET' }, timeoutMs).then(
            (r) => {
              if (finished) return;
              finished = true;
              clearTimeout(timer);
              sticky = b;
              resolve(r);
            },
            (e) => {
              errs.push(e);
              running--;
              if (finished) return;
              if (next < list.length) launch();
              else if (running === 0) {
                finished = true;
                clearTimeout(timer);
                reject(netError(errs));
              }
            }
          );
          schedule();
        }
        launch();
      });
    }

    // POST: one address at a time, two rounds
    async function post(path, body) {
      const errs = [];
      for (let round = 0; round < 2; round++) {
        for (const b of ordered()) {
          try {
            const r = await attempt(b, path, { method: 'POST', body }, postTimeoutMs);
            sticky = b;
            return r;
          } catch (e) {
            errs.push(e);
          }
        }
      }
      throw netError(errs);
    }

    // ask the address that works for the rest of the live addresses
    async function refresh() {
      try {
        const r = await attempt(sticky, '/endpoints', { method: 'GET' }, 6000);
        if (r.data && Array.isArray(r.data.endpoints)) learn(r.data.endpoints);
      } catch (e) {}
    }

    return { get, post, refresh, learn, bases: () => bases.slice(), current: () => sticky };
  }

  return { encodeHosts, decodeHosts, createClient };
});
