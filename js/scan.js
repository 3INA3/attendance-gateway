(() => {
  const $ = (sel) => document.querySelector(sel);
  const params = new URLSearchParams(location.search);
  const token = params.get('token');
  // #a=<backend addresses>&did=<device id from gateway>
  const hashParams = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  const F = window.AttFailover;

  // When this page is on GitHub Pages (or any static host), location.origin has NO /api.
  // Only use hosts from the hash (the real tunnel / LAN backends).
  const alternates = F ? F.decodeHosts(hashParams.get('a') || '') : [];
  const isExternalFront =
    alternates.length > 0 &&
    !/localhost|127\.0\.0\.1/.test(location.hostname);

  const client = F
    ? F.createClient({
        // On GitHub Pages: do not use location.origin as API base
        origin: isExternalFront ? null : location.origin,
        alternates,
        pageProtocol: location.protocol
      })
    : null;

  // If external and we got a sticky from gateway, prefer first alternate
  if (client && isExternalFront && alternates.length) {
    try {
      client.learn(alternates);
    } catch (e) {}
  }

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

  function getOrCreateDeviceId() {
    try {
      const carried = hashParams.get('did');
      if (carried && /^dev_[0-9a-f]{48}$/.test(carried)) {
        localStorage.setItem(DEVICE_KEY, carried);
        return carried;
      }
      let id = localStorage.getItem(DEVICE_KEY);
      if (id && id.length >= 16) return id;
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      id = 'dev_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(DEVICE_KEY, id);
      return id;
    } catch (e) {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      return 'tmp_' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    }
  }

  function hardwareBits() {
    const parts = [
      navigator.userAgent || '',
      navigator.language || '',
      navigator.platform || '',
      String(screen.width) + 'x' + String(screen.height),
      String(screen.colorDepth || ''),
      String(window.devicePixelRatio || 1),
      Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      String(navigator.hardwareConcurrency || ''),
      String(navigator.maxTouchPoints || '')
    ];
    return parts.join('|');
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

  async function getDeviceFingerprint() {
    const deviceId = getOrCreateDeviceId();
    const hw = hardwareBits();
    return await hashString(deviceId + '::' + hw);
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

    if (isExternalFront && !alternates.length) {
      showError('آدرس سرور در لینک نیست. از QR جدید اسکن کنید (استاد باید تونل را روشن کرده باشد).');
      return;
    }

    getOrCreateDeviceId();
    const deviceFingerprint = await getDeviceFingerprint();

    try {
      const data = await api(
        `/public/session/${encodeURIComponent(token)}?fp=${encodeURIComponent(deviceFingerprint)}`
      );

      $('#scanClassName').textContent = data.className;
      if (client) client.refresh();

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
