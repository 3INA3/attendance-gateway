(() => {
  const $ = (sel) => document.querySelector(sel);
  const params = new URLSearchParams(location.search);
  const token = params.get('token');
  // #a=<other live addresses>&did=<device id carried over from the gateway / another address>
  const hashParams = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  const F = window.AttFailover;
  const client = F
    ? F.createClient({
        origin: location.origin,
        alternates: F.decodeHosts(hashParams.get('a') || ''),
        pageProtocol: location.protocol
      })
    : null;

  const DEVICE_KEY = 'att_device_id_v2';
  const REG_PREFIX = 'att_reg_session_';

  async function api(path, options = {}) {
    let r;
    try {
      if (client) {
        r = options.body ? await client.post(path, options.body) : await client.get(path);
      } else {
        const res = await fetch(`/api${path}`, {
          method: options.method || 'GET',
          headers: { 'Content-Type': 'application/json' },
          body: options.body ? JSON.stringify(options.body) : undefined
        });
        r = { ok: res.ok, data: await res.json().catch(() => ({})) };
      }
    } catch (networkErr) {
      const err = new Error(
        'اتصال به سرور برقرار نشد (همه‌ی مسیرها امتحان شد). اینترنت گوشی را بررسی کنید، چند ثانیه صبر کنید و دوباره QR را اسکن کنید.'
      );
      err.code = 'NETWORK';
      throw err;
    }
    const data = r.data || {};
    if (!r.ok) {
      const err = new Error(data.error || 'خطا');
      err.code = data.code;
      throw err;
    }
    return data;
  }

  function showError(msg) {
    $('#scanLoading').classList.add('hidden');
    $('#scanForm').classList.add('hidden');
    $('#scanSuccess').classList.add('hidden');
    $('#scanError').textContent = msg;
    $('#scanError').classList.remove('hidden');
  }

  function showSuccess(msg) {
    $('#scanLoading').classList.add('hidden');
    $('#scanForm').classList.add('hidden');
    $('#scanError').classList.add('hidden');
    $('#scanSuccessMsg').textContent = msg;
    $('#scanSuccess').classList.remove('hidden');
  }

  // Persistent unique device ID stored in localStorage (survives reloads & new QR scans)
  function getOrCreateDeviceId() {
    try {
      // The device id belongs to the PHONE, not to one address: when the phone arrives from the
      // gateway page (or another address) it brings its id along so the "one phone, one
      // registration" rule keeps working whichever address answers.
      const carried = hashParams.get('did');
      if (carried && /^dev_[0-9a-f]{48}$/.test(carried)) {
        localStorage.setItem(DEVICE_KEY, carried);
        return carried;
      }
      let id = localStorage.getItem(DEVICE_KEY);
      if (id && id.length >= 16) return id;
      // Cryptographically random id
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      id = 'dev_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(DEVICE_KEY, id);
      return id;
    } catch (e) {
      // localStorage blocked (rare) — fall back to session-only random (weaker)
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      return 'tmp_' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    }
  }

  // Hardware signals that survive Incognito (no localStorage dependency).
  // Canvas + WebGL make two identical phone models less likely to collide than UA alone.
  function canvasFingerprint() {
    try {
      const c = document.createElement('canvas');
      c.width = 240;
      c.height = 60;
      const ctx = c.getContext('2d');
      if (!ctx) return 'nocanvas';
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(0, 0, 240, 60);
      ctx.fillStyle = '#069';
      ctx.fillText('att-fp-fa-حضور', 4, 8);
      ctx.fillStyle = 'rgba(0,128,255,0.7)';
      ctx.fillText('att-fp-fa-حضور', 8, 28);
      return c.toDataURL().slice(-120);
    } catch (e) {
      return 'canvas_err';
    }
  }

  function webglFingerprint() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return 'nowebgl';
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      return [vendor, renderer, gl.getParameter(gl.VERSION)].join('|');
    } catch (e) {
      return 'webgl_err';
    }
  }

  function hardwareBits() {
    const parts = [
      navigator.userAgent || '',
      navigator.language || '',
      (navigator.languages || []).join(','),
      navigator.platform || '',
      String(screen.width) + 'x' + String(screen.height) + 'x' + String(screen.availWidth),
      String(screen.colorDepth || ''),
      String(window.devicePixelRatio || 1),
      Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      String(navigator.hardwareConcurrency || ''),
      String(navigator.maxTouchPoints || ''),
      String(navigator.deviceMemory || ''),
      canvasFingerprint(),
      webglFingerprint()
    ];
    return parts.join('||');
  }

  async function hashString(str) {
    if (window.crypto && window.crypto.subtle) {
      try {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
        return Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
      } catch (e) {}
    }
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = (Math.imul(33, h) ^ str.charCodeAt(i)) >>> 0;
    }
    return 'h' + h.toString(16) + '_' + str.length;
  }

  // Server-side uniqueness key: HARDWARE ONLY (works across normal + Incognito on same phone).
  // localStorage id is only for UX (show "already registered" faster in normal browser).
  async function getDeviceFingerprint() {
    const hw = hardwareBits();
    return await hashString('hw::' + hw);
  }

  function markRegisteredLocally(sessionId) {
    try {
      localStorage.setItem(REG_PREFIX + sessionId, '1');
    } catch (e) {}
  }

  function isRegisteredLocally(sessionId) {
    try {
      return localStorage.getItem(REG_PREFIX + sessionId) === '1';
    } catch (e) {
      return false;
    }
  }

  function getDeviceInfo() {
    const ua = navigator.userAgent || '';
    let model = '';
    let browser = '';
    if (/iPhone/.test(ua)) model = 'iPhone';
    else if (/iPad/.test(ua)) model = 'iPad';
    else if (/Android/.test(ua)) {
      const m = ua.match(/Android.*?;\s*([^)]+)\)/);
      model = m ? m[1].trim().split(';')[0] : 'Android';
    } else if (/Windows/.test(ua)) model = 'Windows';
    else if (/Mac OS/.test(ua)) model = 'Mac';
    else if (/Linux/.test(ua)) model = 'Linux';
    else model = navigator.platform || 'Unknown';

    if (/Edg\//.test(ua)) browser = 'Edge';
    else if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) browser = 'Chrome';
    else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = 'Safari';
    else if (/Firefox\//.test(ua)) browser = 'Firefox';
    else browser = 'Browser';

    return {
      model,
      browser,
      platform: navigator.platform || '',
      language: navigator.language || '',
      screen: `${screen.width}x${screen.height}`,
      pixelRatio: window.devicePixelRatio || 1,
      userAgent: ua.slice(0, 300),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    };
  }

  async function init() {
    if (!token) {
      showError('کد QR نامعتبر است. لطفاً دوباره اسکن کنید.');
      return;
    }

    // Ensure device id exists before anything else
    getOrCreateDeviceId();
    const deviceFingerprint = await getDeviceFingerprint();

    try {
      const data = await api(
        `/public/session/${encodeURIComponent(token)}?fp=${encodeURIComponent(deviceFingerprint)}`
      );

      $('#scanClassName').textContent = data.className;
      if (client) client.refresh(); // learn the other live addresses in the background

      // Already registered on this device (server or local)
      if (data.deviceAlreadyUsed || isRegisteredLocally(data.sessionId)) {
        markRegisteredLocally(data.sessionId);
        showSuccess('این گوشی قبلاً برای این جلسه حضور ثبت کرده است. هر گوشی فقط یک‌بار می‌تواند ثبت کند.');
        return;
      }

      $('#scanLoading').classList.add('hidden');
      $('#scanForm').classList.remove('hidden');
    } catch (err) {
      showError(err.message);
    }
  }

  $('#scanForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const firstName = $('#firstName').value.trim();
    const lastName = $('#lastName').value.trim();
    const studentNumber = $('#studentNumber').value.trim();

    if (!firstName || !lastName || !studentNumber) {
      alert('لطفاً همه فیلدها را پر کنید');
      return;
    }

    const btn = $('#registerBtn');
    btn.disabled = true;
    btn.textContent = 'در حال ثبت...';

    try {
      const deviceFingerprint = await getDeviceFingerprint();
      const deviceInfo = getDeviceInfo();
      const websiteEl = document.getElementById('website');
      const body = {
        token,
        firstName,
        lastName,
        studentNumber,
        deviceFingerprint,
        deviceInfo,
        website: websiteEl ? websiteEl.value : ''
      };

      const data = await api('/public/register', { method: 'POST', body });
      if (data.sessionId) markRegisteredLocally(data.sessionId);
      showSuccess(`${data.studentName} عزیز، حضور شما با موفقیت ثبت شد.`);
    } catch (err) {
      if (err.code === 'ALREADY_REGISTERED' || err.code === 'DEVICE_ALREADY_USED') {
        showSuccess(err.message);
      } else {
        showError(err.message || 'خطا در ثبت');
        btn.disabled = false;
        btn.textContent = 'ثبت حضور';
      }
    }
  });

  init();
})();
