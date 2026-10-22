(() => {
  const state = {
    teacher: null,
    isRegisterMode: false,
    currentClassId: null,
    currentSessionId: null,
    socket: null,
    qrExpiresAt: null,
    currentToken: null,
    tunnel: null,
    tunnelPoll: null,
    countdownTimer: null,
    qrPoll: null,
    overview: null,
    qrSize: 'lg', // sm | md | lg | xl | full
    searchQ: ''
  };

  const $ = (sel) => document.querySelector(sel);
  const views = ['auth', 'dashboard', 'class', 'session', 'summary'];

  function showView(name) {
    views.forEach((v) => {
      const el = $(`#view-${v}`);
      if (el) el.classList.toggle('hidden', v !== name);
    });
    if (name !== 'session') hideQr();
  }

  async function api(path, options = {}) {
    const res = await fetch(`/api${path}`, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'خطا');
      err.data = data;
      throw err;
    }
    return data;
  }

  // ---------- Theme ----------
  function initTheme() {
    const saved = localStorage.getItem('att-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved === 'light' ? 'light' : '');
    updateThemeBtn();
  }
  function updateThemeBtn() {
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    $('#themeToggle').textContent = light ? '🌙 شب' : '☀️ روز';
  }
  $('#themeToggle').addEventListener('click', () => {
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    document.documentElement.setAttribute('data-theme', light ? '' : 'light');
    localStorage.setItem('att-theme', light ? 'dark' : 'light');
    updateThemeBtn();
  });

  // ---------- AUTH ----------
  async function initAuth() {
    const status = await api('/auth/status');
    if (status.loggedIn) {
      const me = await api('/auth/me');
      onLoggedIn(me.teacher);
      return;
    }
    state.isRegisterMode = !status.hasTeacher;
    renderAuthMode();
    showView('auth');
  }

  function renderAuthMode() {
    $('#authTitle').textContent = state.isRegisterMode ? 'ساخت حساب استاد (فقط یک‌بار)' : 'ورود استاد';
    $('#fullNameField').classList.toggle('hidden', !state.isRegisterMode);
    const hint = $('#passwordHint');
    if (hint) hint.classList.toggle('hidden', !state.isRegisterMode);
    $('#authSwitchWrap').classList.add('hidden');
  }

  function clientPasswordOk(password) {
    if (!password || password.length < 8) return 'رمز عبور باید حداقل ۸ کاراکتر باشد';
    if (!/[a-zA-Z\u0600-\u06FF]/.test(password)) return 'رمز عبور باید حداقل یک حرف داشته باشد';
    if (!/[0-9]/.test(password)) return 'رمز عبور باید حداقل یک عدد داشته باشد';
    if (!/[^a-zA-Z0-9\u0600-\u06FF]/.test(password)) {
      return 'رمز عبور باید حداقل یک کاراکتر خاص داشته باشد (مثل ! @ # $ %)';
    }
    return null;
  }

  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#authError').classList.add('hidden');
    const username = $('#authUsername').value.trim();
    const password = $('#authPassword').value;
    const fullName = $('#authFullName').value.trim();
    try {
      if (state.isRegisterMode) {
        const pe = clientPasswordOk(password);
        if (pe) throw new Error(pe);
        await api('/auth/register', { method: 'POST', body: { username, password, fullName } });
      } else {
        await api('/auth/login', { method: 'POST', body: { username, password } });
      }
      const me = await api('/auth/me');
      onLoggedIn(me.teacher);
    } catch (err) {
      $('#authError').textContent = err.message;
      $('#authError').classList.remove('hidden');
    }
  });

  function onLoggedIn(teacher) {
    state.teacher = teacher;
    $('#userBox').classList.remove('hidden');
    $('#teacherName').textContent = teacher.full_name || teacher.username;
    loadDashboard();
  }

  $('#logoutBtn').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' });
    state.teacher = null;
    location.reload();
  });

  // ---------- Dashboard ----------
  async function loadDashboard() {
    showView('dashboard');
    const data = await api('/classes');
    const list = $('#classList');
    list.innerHTML = '';
    if (!data.classes || !data.classes.length) {
      list.innerHTML = '<p class="muted">هنوز کلاسی ندارید. یک کلاس جدید بسازید.</p>';
      return;
    }
    data.classes.forEach((c) => {
      const div = document.createElement('div');
      div.className = 'class-card';
      div.innerHTML = `
        <h3>${esc(c.name)}</h3>
        <div class="meta">${esc(c.description || '')}</div>
        <div class="class-card-actions">
          <button type="button" class="btn small danger class-del-btn">حذف کلاس</button>
        </div>`;
      div.querySelector('h3').onclick = () => openClass(c.id);
      div.querySelector('.meta').onclick = () => openClass(c.id);
      div.querySelector('.class-del-btn').onclick = async (e) => {
        e.stopPropagation();
        if (!confirm('کلاس «' + c.name + '» و همه دانشجویان و جلسات آن پاک شود؟')) return;
        try {
          await api('/classes/' + c.id, { method: 'DELETE' });
          loadDashboard();
        } catch (err) {
          alert(err.message);
        }
      };
      list.appendChild(div);
    });
  }

  
  const factoryBtn = $('#factoryResetBtn');
  if (factoryBtn) {
    factoryBtn.addEventListener('click', async () => {
      if (!confirm('هشدار: همه کلاس‌ها، دانشجویان، جلسات و نمرات پاک می‌شود.\nفقط حساب استاد می‌ماند.')) return;
      if (!confirm('تأیید نهایی پاک‌سازی؟')) return;
      try {
        const pw = prompt('برای تأیید، رمز عبور خود را وارد کنید:');
        if (!pw) return;
        const r = await api('/auth/reset-data', { method: 'POST', body: { password: pw } });
        alert(r.message || 'پاک شد');
        loadDashboard();
      } catch (e) {
        alert(e.message);
      }
    });
  }

  $('#newClassBtn').addEventListener('click', () => {
    openModal('کلاس جدید', `
      <label>نام کلاس <input id="mClassName" required /></label>
      <label>توضیح (اختیاری) <input id="mClassDesc" /></label>
    `, [
      { label: 'انصراف', action: closeModal },
      {
        label: 'ایجاد', primary: true, action: async () => {
          const name = $('#mClassName').value.trim();
          if (!name) return;
          await api('/classes', { method: 'POST', body: { name, description: $('#mClassDesc').value.trim() } });
          closeModal();
          loadDashboard();
        }
      }
    ]);
  });

  $('#backToDash').addEventListener('click', () => {
    state.currentClassId = null;
    loadDashboard();
  });

  // ---------- Class overview ----------
  async function openClass(classId) {
    state.currentClassId = classId;
    showView('class');
    const cls = await api('/classes/' + classId);
    $('#classTitle').textContent = cls.class.name;
    await loadOverview();
  }

  async function loadOverview() {
    const data = await api('/attendance/overview/' + state.currentClassId);
    state.overview = data;
    renderOverview();
  }

  function renderOverview() {
    const data = state.overview;
    if (!data) return;
    const q = (state.searchQ || '').trim().toLowerCase();
    let students = data.students || [];
    if (q) {
      students = students.filter(
        (s) =>
          (s.fullName || '').toLowerCase().includes(q) ||
          (s.studentNumber || '').toLowerCase().includes(q)
      );
    }

    const head = $('#overviewHead');
    const body = $('#overviewBody');
    const empty = $('#overviewEmpty');

    if (!students.length && !(data.students || []).length) {
      head.innerHTML = '';
      body.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    // Header
    let hr = '<tr><th class="sticky-name">دانشجو</th><th>شماره</th>';
    (data.sessions || []).forEach((sess, i) => {
      const d = formatDate(sess.startedAt);
      const day = formatDay(sess.startedAt);
      const st = sess.status === 'active' ? '🟢' : '⚪';
      const title = sess.title ? esc(sess.title) : ('جلسه ' + (i + 1));
      hr += `<th class="session-col session-sep" data-session-id="${sess.id}">
        <div class="sess-title">${st} ${title}</div>
        <div class="small muted">${day} · ${d}</div>
        <button type="button" class="btn tiny danger sess-del-btn" data-sid="${sess.id}" title="حذف این روز/جلسه">حذف جلسه</button>
      </th>`;
    });
    hr += '<th>پایان‌ترم</th><th>مثبت‌ها</th><th>نمرات جلسه</th><th>جمع کل</th><th>حضور%</th></tr>';
    head.innerHTML = hr;

    body.innerHTML = '';
    students.forEach((st, idx) => {
      const tr = document.createElement('tr');
      tr.className = 'tier-' + (st.colorTier || 'black');

      // name cell
      const anyScanned = Object.values(st.sessions || {}).some(
        (x) => x.status === 'present' || x.status === 'late'
      );
      const nameClass = anyScanned ? 'name-bold' : 'name-dim';
      const cross = st.deviceMismatch ? ' <span class="device-x" title="ورود با گوشی متفاوت">✖</span>' : '';
      let html = `<td class="sticky-name ${nameClass}">
        <div class="name-row">
          <span>${esc(st.fullName)}${cross}</span>
          <button type="button" class="btn tiny danger stu-del-btn" data-stid="${st.id}" title="حذف دانشجو">حذف</button>
        </div>
      </td>`;
      html += `<td>${esc(st.studentNumber || '—')}</td>`;

      (data.sessions || []).forEach((sess) => {
        const rec = (st.sessions && st.sessions[sess.id]) || {
          status: 'absent',
          positives: 0,
          sessionGrade: null
        };
        html += `<td class="session-col" data-sid="${sess.id}" data-stid="${st.id}">
          <div class="cell-edit">
            <select class="status-sel" data-field="status">
              <option value="present" ${rec.status === 'present' ? 'selected' : ''}>حاضر</option>
              <option value="late" ${rec.status === 'late' ? 'selected' : ''}>تأخیر</option>
              <option value="absent" ${rec.status === 'absent' ? 'selected' : ''}>غایب</option>
            </select>
            <div style="display:flex;gap:4px;align-items:center">
              <input class="num pos-inp" type="number" min="0" max="20" value="${rec.positives || 0}" title="مثبت" data-field="positives" />
              <input class="num grade-inp" type="number" step="0.25" min="0" max="20" value="${rec.sessionGrade != null ? rec.sessionGrade : ''}" placeholder="نمره" title="نمره جلسه" data-field="sessionGrade" />
            </div>
          </div>
        </td>`;
      });

      html += `<td><input class="final-input" type="number" step="0.25" min="0" max="20" value="${st.finalExam != null ? st.finalExam : ''}" data-student="${st.id}" /></td>`;
      html += `<td>${st.positivesSum || 0} <span class="muted small">(${st.positivesScore})</span></td>`;
      html += `<td>${st.gradesSum || 0}</td>`;
      html += `<td class="total-cell">${st.totalScore != null ? st.totalScore : '—'}</td>`;
      html += `<td>${st.attendanceRate != null ? st.attendanceRate + '%' : '—'}</td>`;

      tr.innerHTML = html;
      body.appendChild(tr);
    });

    // Bind edits
    body.querySelectorAll('.session-col').forEach((td) => {
      const sid = td.dataset.sid;
      const stid = td.dataset.stid;
      const save = debounce(async () => {
        const status = td.querySelector('.status-sel').value;
        const positives = td.querySelector('.pos-inp').value;
        const sessionGrade = td.querySelector('.grade-inp').value;
        try {
          await api(`/attendance/${sid}/student/${stid}`, {
            method: 'PATCH',
            body: { status, positives, sessionGrade: sessionGrade === '' ? null : sessionGrade }
          });
          await loadOverview();
        } catch (e) {
          alert(e.message);
        }
      }, 400);
      td.querySelectorAll('select, input').forEach((el) => {
        el.addEventListener('change', save);
        el.addEventListener('blur', save);
      });
    });

    head.querySelectorAll('.sess-del-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const sid = btn.dataset.sid;
        if (!confirm('این جلسه/روز و تمام حضور و نمرات آن پاک شود؟')) return;
        try {
          await api('/attendance/session/' + sid, { method: 'DELETE' });
          await loadOverview();
        } catch (err) {
          alert(err.message);
        }
      });
    });

    body.querySelectorAll('.stu-del-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.stid;
        if (!confirm('این دانشجو از کلاس حذف شود؟ (حضورهای قبلی‌اش هم پاک می‌شود)')) return;
        try {
          await api('/students/' + id, { method: 'DELETE' });
          await loadOverview();
        } catch (err) {
          alert(err.message);
        }
      });
    });

    body.querySelectorAll('.final-input').forEach((inp) => {
      const save = debounce(async () => {
        try {
          await api('/students/' + inp.dataset.student, {
            method: 'PATCH',
            body: { finalExam: inp.value === '' ? null : inp.value }
          });
          await loadOverview();
        } catch (e) {
          alert(e.message);
        }
      }, 400);
      inp.addEventListener('change', save);
      inp.addEventListener('blur', save);
    });
  }

  $('#studentSearch').addEventListener('input', (e) => {
    state.searchQ = e.target.value;
    renderOverview();
  });

  // ---------- Start session ----------
  $('#startSessionBtn').addEventListener('click', () => {
    const today = new Date();
    const ymd = today.toISOString().slice(0, 10);
    openModal('شروع جلسه جدید', `
      <label>تاریخ جلسه
        <input type="date" id="mSessionDate" value="${ymd}" required />
      </label>
      <label>سکشن / عنوان جلسه
        <input type="text" id="mSessionSection" placeholder="مثلاً جلسه ۳ — فصل مشتق" />
      </label>
      <p class="muted small">هر سکشن جدا از قبلی ذخیره می‌شود و در جدول با فاصله نمایش داده می‌شود.</p>
    `, [
      { label: 'انصراف', action: closeModal },
      {
        label: 'شروع حضور و غیاب', primary: true, action: async () => {
          const sessionDate = $('#mSessionDate').value;
          const section = $('#mSessionSection').value.trim();
          if (!sessionDate) { alert('تاریخ را وارد کنید'); return; }
          try {
            const res = await api('/attendance/start', {
              method: 'POST',
              body: { classId: state.currentClassId, sessionDate, section, title: section }
            });
            closeModal();
            state.currentSessionId = res.sessionId;
            enterSession(res);
          } catch (e) {
            alert(e.message);
          }
        }
      }
    ]);
  });

  $('#backToClass').addEventListener('click', async () => {
    leaveSessionSocket();
    hideQr();
    await openClass(state.currentClassId);
  });

  $('#summaryBackBtn').addEventListener('click', () => openClass(state.currentClassId));

  // ---------- Live session ----------
  function enterSession(res) {
    showView('session');
    connectSocket(res.sessionId);
    showQr();
    updateQrFromToken(res.token, res.expiresAt);
    pollTunnel();
    refreshLive();
  }

  function connectSocket(sessionId) {
    leaveSessionSocket();
    state.socket = io({ transports: ['websocket', 'polling'] });
    state.socket.emit('join-session', sessionId);
    state.socket.on('qr-update', (msg) => {
      if (String(msg.sessionId) === String(sessionId)) {
        updateQrFromToken(msg.token, msg.expiresAt || msg.expires_at);
      }
    });
    // Backup: refresh QR image every 10s if socket event is missed
    if (state.qrPoll) clearInterval(state.qrPoll);
    state.qrPoll = setInterval(() => {
      if (state.currentSessionId) refreshQrImage();
    }, 10000);
    state.socket.on('attendance-update', (summary) => {
      if (summary && String(summary.sessionId) === String(sessionId)) {
        renderLive(summary);
      }
    });
    state.socket.on('tunnel-update', (t) => {
      state.tunnel = t;
      renderTunnelBadge();
      if (state.currentToken) refreshQrImage();
    });
  }

  function leaveSessionSocket() {
    if (state.socket) {
      state.socket.disconnect();
      state.socket = null;
    }
    if (state.qrPoll) {
      clearInterval(state.qrPoll);
      state.qrPoll = null;
    }
    if (state.tunnelPoll) {
      clearInterval(state.tunnelPoll);
      state.tunnelPoll = null;
    }
    if (state.countdownTimer) {
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
    }
  }

  async function refreshLive() {
    if (!state.currentSessionId) return;
    try {
      const summary = await api('/attendance/' + state.currentSessionId + '/live');
      renderLive(summary);
    } catch (e) {}
  }

  function renderLive(summary) {
    if (!summary) return;
    $('#statPresent').textContent = summary.present || 0;
    $('#statLate').textContent = summary.late || 0;
    $('#statAbsent').textContent = summary.absent || 0;
    $('#statPercent').textContent = (summary.percent || 0) + '%';

    const body = $('#liveBody');
    body.innerHTML = '';
    (summary.students || []).forEach((s, i) => {
      const tr = document.createElement('tr');
      tr.className =
        s.status === 'present' ? '' : s.status === 'late' ? '' : 'tier-red';
      const pill =
        s.status === 'present'
          ? '<span class="status-pill status-present">حاضر</span>'
          : s.status === 'late'
            ? '<span class="status-pill status-late">تأخیر</span>'
            : '<span class="status-pill status-absent">غایب</span>';
      const nameClass = s.scanned || s.status !== 'absent' ? 'name-bold' : 'name-dim';
      const cross = s.deviceMismatch ? ' <span class="device-x" title="ورود با گوشی متفاوت از قبل">✖</span>' : '';
      const dev = s.deviceSummary ? `<div class="muted small">${esc(s.deviceSummary)}</div>` : '';
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td class="${nameClass}">${esc(s.fullName)}${cross}${dev}</td>
        <td>${esc(s.studentNumber || '')}</td>
        <td>
          <select data-stid="${s.id}" class="live-status" style="width:auto;padding:4px 6px;margin:0;font-size:0.8rem">
            <option value="present" ${s.status === 'present' ? 'selected' : ''}>حاضر</option>
            <option value="late" ${s.status === 'late' ? 'selected' : ''}>تأخیر</option>
            <option value="absent" ${s.status === 'absent' ? 'selected' : ''}>غایب</option>
          </select>
        </td>
        <td><input type="number" min="0" max="20" value="${s.positives || 0}" data-stid="${s.id}" class="live-pos" style="width:52px;padding:4px;margin:0;font-size:0.8rem" /></td>
        <td><input type="number" step="0.25" value="${s.sessionGrade != null ? s.sessionGrade : ''}" data-stid="${s.id}" class="live-grade" placeholder="—" style="width:56px;padding:4px;margin:0;font-size:0.8rem" /></td>
        <td class="muted small">${s.registeredAt ? formatTime(s.registeredAt) : '—'}</td>
      `;
      body.appendChild(tr);
    });

    body.querySelectorAll('.live-status, .live-pos, .live-grade').forEach((el) => {
      el.addEventListener('change', async () => {
        const stid = el.dataset.stid;
        const row = el.closest('tr');
        const status = row.querySelector('.live-status').value;
        const positives = row.querySelector('.live-pos').value;
        const sessionGrade = row.querySelector('.live-grade').value;
        try {
          await api(`/attendance/${state.currentSessionId}/student/${stid}`, {
            method: 'PATCH',
            body: {
              status,
              positives,
              sessionGrade: sessionGrade === '' ? null : sessionGrade
            }
          });
        } catch (e) {
          alert(e.message);
        }
      });
    });
  }

  $('#endSessionBtn').addEventListener('click', async () => {
    if (!confirm('پایان حضور و غیاب این جلسه؟')) return;
    try {
      const res = await api('/attendance/' + state.currentSessionId + '/end', { method: 'POST' });
      leaveSessionSocket();
      hideQr();
      showView('summary');
      const s = res.summary || {};
      $('#summaryContent').innerHTML = `
        <div class="stat-row" style="margin-bottom:16px">
          <div class="stat"><span class="stat-n">${s.present || 0}</span><span class="stat-l">حاضر</span></div>
          <div class="stat"><span class="stat-n">${s.late || 0}</span><span class="stat-l">تأخیر</span></div>
          <div class="stat"><span class="stat-n">${s.absent || 0}</span><span class="stat-l">غایب</span></div>
          <div class="stat"><span class="stat-n">${s.percent || 0}%</span><span class="stat-l">حضور</span></div>
        </div>
        <p class="muted">می‌توانید از صفحه کلاس وضعیت‌ها، مثبت‌ها و نمرات را ویرایش کنید.</p>
      `;
    } catch (e) {
      alert(e.message);
    }
  });

  // ---------- Tunnel ----------
  async function pollTunnel() {
    try {
      const t = await api('/attendance/tunnel/status');
      state.tunnel = t;
      renderTunnelBadge();
      if (t.kind && t.kind !== 'none') refreshQrImage();
    } catch (e) {}
    if (state.tunnelPoll) clearInterval(state.tunnelPoll);
    state.tunnelPoll = setInterval(async () => {
      try {
        const t = await api('/attendance/tunnel/status');
        state.tunnel = t;
        renderTunnelBadge();
      } catch (e) {}
    }, 8000);
  }

  function renderTunnelBadge() {
    const el = $('#tunnelBadge');
    if (!el) return;
    const t = state.tunnel || {};
    const lanIp = t.lan && t.lan.ip;
    const eps = t.endpoints || [];
    if (t.kind === 'public') {
      el.className = 'badge ok';
      el.textContent = eps.length > 1
        ? '🌐 ' + eps.length + ' مسیر فعال · ' + eps.map((e) => e.name).join(' + ')
        : '🌐 اینترنت · ' + (t.provider || '');
    } else if (t.kind === 'lan') {
      el.className = 'badge warn';
      el.textContent = '📶 شبکه محلی · ' + (lanIp || '');
    } else if (t.status === 'connecting') {
      el.className = 'badge warn';
      el.textContent = 'در حال اتصال...';
    } else {
      el.className = 'badge err';
      el.textContent = 'بدون آدرس · Wi-Fi یا هات‌اسپات را روشن کنید';
    }

    const sel = $('#qrModeSel');
    if (sel && t.mode && document.activeElement !== sel) sel.value = t.mode;

    const lanSel = $('#lanIpSel');
    if (lanSel) {
      const addrs = (t.lan && t.lan.addresses) || [];
      if (addrs.length > 1) {
        const sig = addrs.map((a) => a.address).join(',') + '|' + (lanIp || '');
        if (lanSel.dataset.sig !== sig) {
          lanSel.dataset.sig = sig;
          lanSel.innerHTML = '';
          addrs.forEach((a) => {
            const o = document.createElement('option');
            o.value = a.address;
            o.textContent = a.address + ' (' + a.name + ')';
            if (a.address === lanIp) o.selected = true;
            lanSel.appendChild(o);
          });
        }
        lanSel.classList.remove('hidden');
      } else {
        lanSel.classList.add('hidden');
      }
    }

    const warn = $('#lanWarn');
    if (warn) warn.classList.toggle('hidden', t.kind !== 'lan');
    const logBox = $('#tunnelLogBox');
    if (logBox) {
      const lines = (t.log || []).slice();
      if (t.status === 'failed' && t.error) lines.push('', 'خلاصه: ' + t.error);
      if (t.intl === false) lines.push('', 'اینترنت بین‌الملل از این کامپیوتر در دسترس نیست.');
      logBox.textContent = lines.join('\n') || 'هنوز پیامی نیست...';
    }

    const info = $('#qrNetInfo');
    const help = $('#qrNetHelp');
    if (info) info.textContent = (t.baseUrl || '') + (eps.length > 1 ? '  (+' + (eps.length - 1) + ' مسیر پشتیبان)' : '');
    if (help) {
      if (t.kind === 'lan') {
        help.textContent = '⚠️ فقط گوشی‌های روی همین Wi-Fi / هات‌اسپات (با اینترنت موبایل باز نمی‌شود)';
      } else if (t.kind === 'public') {
        help.textContent = eps.length > 1
          ? 'با اینترنت گوشی هم کار می‌کند · اگر یک مسیر روی شبکه‌ی دانشجو باز نشود، گوشی خودکار مسیر بعدی را امتحان می‌کند'
          : 'با اینترنت گوشی هم کار می‌کند';
      } else {
        help.textContent = 'Wi-Fi یا «Mobile hotspot» ویندوز را روشن کنید';
      }
    }
  }

  async function setQrMode(body) {
    try {
      const r = await api('/attendance/tunnel/mode', { method: 'POST', body });
      state.tunnel = Object.assign({}, state.tunnel || {}, r);
      renderTunnelBadge();
      refreshQrImage();
    } catch (e) {
      alert(e.message);
    }
  }
  $('#qrModeSel').addEventListener('change', (e) => setQrMode({ mode: e.target.value }));
  $('#lanIpSel').addEventListener('change', (e) => setQrMode({ lanIp: e.target.value }));

  $('#retryTunnelBtn').addEventListener('click', async () => {
    await api('/attendance/tunnel/retry', { method: 'POST' });
    pollTunnel();
  });

  // ---------- QR float ----------
  function showQr() {
    $('#qrFloat').classList.remove('hidden');
  }
  function hideQr() {
    $('#qrFloat').classList.add('hidden');
  }

  function updateQrFromToken(token, expiresAt) {
    state.currentToken = token;
    state.qrExpiresAt = expiresAt ? new Date(expiresAt).getTime() : null;
    refreshQrImage();
    startCountdown();
  }

  function refreshQrImage() {
    if (!state.currentSessionId) return;
    const img = $('#qrImage');
    const qw = state.qrSize === 'full' || state.qrSize === 'xl' ? 1000 : 640;
    img.src = `/api/attendance/${state.currentSessionId}/qr.png?w=${qw}&t=${Date.now()}`;
    img.onload = () => {
      $('#qrHint').textContent = 'کد هر چند ثانیه تازه می‌شود';
    };
    img.onerror = () => {
      $('#qrHint').textContent = 'هیچ آدرسی برای QR نیست — Wi-Fi یا هات‌اسپات را روشن کنید';
    };
  }

  function startCountdown() {
    if (state.countdownTimer) clearInterval(state.countdownTimer);
    state.countdownTimer = setInterval(() => {
      const el = $('#qrCountdown');
      if (!state.qrExpiresAt) {
        el.textContent = '—';
        return;
      }
      const left = Math.max(0, Math.ceil((state.qrExpiresAt - Date.now()) / 1000));
      el.textContent = left + 'ث';
    }, 250);
  }

  $('#qrSizeBtn').addEventListener('click', () => {
    const order = ['sm', 'md', 'lg', 'xl', 'full'];
    const i = order.indexOf(state.qrSize);
    state.qrSize = order[(i + 1) % order.length];
    const el = $('#qrFloat');
    el.classList.remove('size-sm', 'size-lg', 'size-xl', 'size-full');
    if (state.qrSize === 'sm') el.classList.add('size-sm');
    if (state.qrSize === 'lg') el.classList.add('size-lg');
    if (state.qrSize === 'xl') el.classList.add('size-xl');
    if (state.qrSize === 'full') el.classList.add('size-full');
    const labels = { sm: '⬛', md: '⬛', lg: '⬛', xl: '⬛⬛', full: '⛶' };
    $('#qrSizeBtn').textContent = state.qrSize === 'full' ? '⛶' : '⬛';
    $('#qrSizeBtn').title = 'اندازه: ' + state.qrSize;
  });


  const qrShowBtn = $('#qrShowBtn');
  if (qrShowBtn) {
    qrShowBtn.addEventListener('click', () => {
      showQr();
      state.qrSize = 'lg';
      const el = $('#qrFloat');
      el.classList.remove('size-sm', 'size-lg', 'size-xl', 'size-full');
      el.classList.add('size-lg');
    });
  }
  const qrHugeBtn = $('#qrHugeBtn');
  if (qrHugeBtn) {
    qrHugeBtn.addEventListener('click', () => {
      showQr();
      state.qrSize = 'full';
      const el = $('#qrFloat');
      el.classList.remove('size-sm', 'size-lg', 'size-xl', 'size-full');
      el.classList.add('size-full');
      refreshQrImage();
    });
  }

  $('#qrCloseBtn').addEventListener('click', hideQr);

  // drag QR
  (function makeDraggable() {
    const el = $('#qrFloat');
    const handle = $('#qrDragHandle');
    let ox = 0, oy = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      const r = el.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.left = e.clientX - ox + 'px';
      el.style.top = e.clientY - oy + 'px';
      el.style.bottom = 'auto';
      el.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  })();

  // ---------- Students import / add ----------
  $('#addStudentBtn').addEventListener('click', () => {
    openModal('افزودن دانشجو', `
      <label>نام و نام خانوادگی <input id="mStName" required /></label>
      <label>شماره دانشجویی <input id="mStNum" /></label>
    `, [
      { label: 'انصراف', action: closeModal },
      {
        label: 'افزودن', primary: true, action: async () => {
          await api('/students/class/' + state.currentClassId, {
            method: 'POST',
            body: { fullName: $('#mStName').value.trim(), studentNumber: $('#mStNum').value.trim() }
          });
          closeModal();
          loadOverview();
        }
      }
    ]);
  });

  $('#importStudentsBtn').addEventListener('click', () => {
    openModal('وارد کردن اسامی', `
      <p class="muted small" style="margin-bottom:10px">هر خط: نام و شماره دانشجویی (با ویرگول یا فاصله). مثال:<br>
      علی رضایی، ۴۰۰۱۲۳۴۵۶<br>
      سارا محمدی	۴۰۰۹۸۷۶۵۴</p>
      <textarea id="mImportText" class="import-area" placeholder="نام، شماره&#10;..."></textarea>
    `, [
      { label: 'انصراف', action: closeModal },
      {
        label: 'وارد کردن', primary: true, action: async () => {
          const text = $('#mImportText').value;
          const res = await api('/students/class/' + state.currentClassId + '/import', {
            method: 'POST',
            body: { text }
          });
          closeModal();
          alert(`${res.added} نفر اضافه شد` + (res.skipped ? `، ${res.skipped} رد شد` : ''));
          loadOverview();
        }
      }
    ]);
  });

  // ---------- Modal helpers ----------
  function openModal(title, bodyHtml, actions) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = bodyHtml;
    const act = $('#modalActions');
    act.innerHTML = '';
    (actions || []).forEach((a) => {
      const b = document.createElement('button');
      b.className = 'btn' + (a.primary ? ' primary' : '');
      b.textContent = a.label;
      b.onclick = a.action;
      act.appendChild(b);
    });
    $('#modalOverlay').classList.remove('hidden');
  }
  function closeModal() {
    $('#modalOverlay').classList.add('hidden');
  }
  $('#modalOverlay').addEventListener('click', (e) => {
    if (e.target === $('#modalOverlay')) closeModal();
  });


  $('#exportPdfBtn').addEventListener('click', () => {
    if (!state.currentClassId) return;
    window.open('/api/report/class/' + state.currentClassId + '/html', '_blank');
  });

  // ---------- Utils ----------
  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function formatDate(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('fa-IR');
    } catch (e) {
      return iso.slice(0, 10);
    }
  }
  function formatDay(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString('fa-IR', { weekday: 'short' });
    } catch (e) {
      return '';
    }
  }
  function formatTime(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  }
  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // ---------- Boot ----------
  initTheme();
  initAuth().catch((e) => {
    console.error(e);
    showView('auth');
  });
})();
