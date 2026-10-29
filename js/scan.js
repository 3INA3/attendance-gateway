(() => {
  const $ = (sel) => document.querySelector(sel);
  const params = new URLSearchParams(location.search);
  const token = params.get('token');
  const hashParams = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  const F = window.AttFailover;
  const client = F
    ? F.createClient({
        origin: location.origin,
        alternates: F.decodeHosts(hashParams.get('a') || ''),
        pageProtocol: location.protocol
      })
    : null;

  const REG_PREFIX = 'att_reg_session_';
  const FP_COOKIE = 'att_hw_fp';

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

  function setFpCookie(fp) {
    try {
      const maxAge = 60 * 60 * 24 * 400;
      document.cookie =
        FP_COOKIE +
        '=' +
        encodeURIComponent(fp) +
        '; Max-Age=' +
        maxAge +
        '; Path=/; SameSite=Lax; Secure';
    } catch (e) {}
  }

  function readFpCookie() {
    try {
      const m = document.cookie.match(new RegExp('(?:^|; )' + FP_COOKIE + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) {
      return '';
    }
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

  function webglStable() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return 'nowebgl';
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const vendor = dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '') : '';
      const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '';
      return vendor + '~' + renderer;
    } catch (e) {
      return 'webgl_err';
    }
  }

  async function clientHints() {
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        const v = await navigator.userAgentData.getHighEntropyValues([
          'architecture',
          'bitness',
          'model',
          'platformVersion',
          'fullVersionList',
          'uaFullVersion'
        ]);
        return [
          v.architecture || '',
          v.bitness || '',
          v.model || '',
          v.platformVersion || '',
          v.uaFullVersion || '',
          (v.fullVersionList || []).map((x) => x.brand + ':' + x.version).join(',')
        ].join('|');
      }
    } catch (e) {}
    return '';
  }

  /**
   * Fingerprint ONLY from stable hardware signals.
   * Does NOT use random localStorage ids — so normal Chrome and Incognito
   * on the SAME phone produce the same value.
   */
  async function getDeviceFingerprint() {
    const hints = await clientHints();
    const parts = [
      'v3',
      navigator.platform || '',
      String(screen.width),
      String(screen.height),
      String(screen.availWidth),
      String(screen.availHeight),
      String(screen.colorDepth || ''),
      String(window.devicePixelRatio || 1),
      String(navigator.hardwareConcurrency || ''),
      String(navigator.maxTouchPoints || ''),
      String(navigator.deviceMemory || ''),
      Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      (navigator.languages || []).join(','),
      navigator.language || '',
      webglStable(),
      hints,
      // coarse UA family only (not full UA which can differ slightly)
      /Android/i.test(navigator.userAgent || '')
        ? 'android'
        : /iPhone|iPad|iPod/i.test(navigator.userAgent || '')
          ? 'ios'
          : /Windows/i.test(navigator.userAgent || '')
            ? 'win'
            : /Mac/i.test(navigator.userAgent || '')
              ? 'mac'
              : 'other'
    ];
    const fp = await hashString(parts.join('||'));
    // Prefer cookie if we already set one earlier on this profile (extra glue)
    const cookieFp = readFpCookie();
    if (cookieFp && cookieFp.length >= 32) {
      // If cookie differs from HW, still use HW for server uniqueness across Incognito.
      // Cookie only helps same-profile fast path.
    }
    return fp;
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

    const deviceFingerprint = await getDeviceFingerprint();

    try {
      const data = await api(
        `/public/session/${encodeURIComponent(token)}?fp=${encodeURIComponent(deviceFingerprint)}`
      );

      $('#scanClassName').textContent = data.className;
      if (client) client.refresh();

      if (data.deviceAlreadyUsed || isRegisteredLocally(data.sessionId)) {
        markRegisteredLocally(data.sessionId);
        setFpCookie(deviceFingerprint);
        showSuccess(
          'این گوشی قبلاً برای این جلسه حضور ثبت کرده است. هر گوشی فقط یک‌بار می‌تواند ثبت کند.'
        );
        return;
      }

      $('#scanLoading').classList.add('hidden');
      $('#scanForm').classList.remove('hidden');
      window.__attSessionId = data.sessionId;
      window.__attFp = deviceFingerprint;
    } catch (err) {
      showError(err.message || 'خطا در بارگذاری جلسه');
    }
  }

  const form = $('#scanForm');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#registerBtn');
      const firstName = ($('#firstName') && $('#firstName').value) || '';
      const lastName = ($('#lastName') && $('#lastName').value) || '';
      const studentNumber = ($('#studentNumber') && $('#studentNumber').value) || '';
      const website = ($('#website') && $('#website').value) || '';

      if (btn) btn.disabled = true;
      try {
        const deviceFingerprint = window.__attFp || (await getDeviceFingerprint());
        const deviceInfo = getDeviceInfo();
        const body = {
          token,
          fullName: [firstName.trim(), lastName.trim()].filter(Boolean).join(' '),
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          studentNumber: studentNumber.trim(),
          deviceFingerprint,
          deviceInfo,
          honeypot: '',
          website
        };

        const data = await api('/public/register', { method: 'POST', body });
        if (window.__attSessionId) markRegisteredLocally(window.__attSessionId);
        setFpCookie(deviceFingerprint);
        showSuccess(
          (data.studentName ? data.studentName + ' — ' : '') +
            'حضور شما ثبت شد.' +
            (data.status === 'late' ? ' (تأخیر)' : '')
        );
      } catch (err) {
        if (err.code === 'ALREADY_REGISTERED' || err.code === 'DEVICE_ALREADY_USED') {
          if (window.__attSessionId) markRegisteredLocally(window.__attSessionId);
          showSuccess(err.message || 'این گوشی یا این شماره قبلاً ثبت شده است.');
        } else {
          showError(err.message || 'خطا در ثبت');
          if (btn) btn.disabled = false;
        }
      }
    });
  }

  init();
})();
