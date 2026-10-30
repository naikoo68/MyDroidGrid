let CFG = null, TOKEN = localStorage.getItem('mdg_token') || null;

async function api(path, method = 'GET', body = null) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) }, body: body ? JSON.stringify(body) : null });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function el(id) { return document.getElementById(id); }

async function init() {
  CFG = await api('/api/config');
  fillSelect('fVersion', CFG.androidVersions, '12');
  fillSelect('fRam', CFG.ramOptionsGB, '2');
  fillSelect('fCores', CFG.coreOptions, '2');
  fillSelect('fStorage', CFG.storageOptionsGB, '32');
  fillSelect('fRes', CFG.resolutions, '720x1280');
  ['fVersion','fRam','fCores','fStorage'].forEach(id => el(id).addEventListener('change', createHint));
  el('fVersion').addEventListener('change', gappsHint);
  gappsHint();
  if (TOKEN) showDashboard().catch(() => { TOKEN = null; localStorage.removeItem('mdg_token'); });
}
function gappsHint() {
  const ok = ['12', '13'].includes(el('fVersion').value);
  el('fGapps').disabled = !ok;
  if (!ok) el('fGapps').checked = false;
}
function fillSelect(id, values, selected) {
  el(id).innerHTML = values.map(v => `<option value="${v}" ${String(v) === String(selected) ? 'selected' : ''}>${v}</option>`).join('');
}

function openAuth() {
  el('authModal').classList.remove('hidden');
  const setup = CFG.needsSetup;
  el('authTitle').textContent = setup ? 'Create your admin account' : 'Login';
  el('authHint').textContent = setup ? 'This is a one-time setup. You choose the username and password — they are stored only on this PC.' : (CFG.publicSignup ? '' : 'Public signup is off. Only the admin account can log in.');
  el('authError').textContent = '';
}
function closeAuth() { el('authModal').classList.add('hidden'); }
async function submitAuth() {
  try {
    const path = CFG.needsSetup ? '/api/setup' : '/api/auth/login';
    const data = await api(path, 'POST', { username: el('authUser').value.trim(), password: el('authPass').value });
    TOKEN = data.token; localStorage.setItem('mdg_token', TOKEN);
    closeAuth(); showDashboard();
  } catch (e) { el('authError').textContent = e.message; }
}
function logout() { TOKEN = null; localStorage.removeItem('mdg_token'); location.reload(); }

async function showDashboard() {
  const { phones, pool } = await api('/api/phones');
  el('landing').classList.add('hidden');
  el('dashboard').classList.remove('hidden');
  el('navAuthBtn').textContent = 'My Phones';
  renderPool(pool); renderPhones(phones, pool); syncStartingPoll(phones); renderServers();
}

async function renderServers() {
  if (!el('servers')) return;
  try {
    const { servers } = await api('/api/servers');
    el('serverCount').textContent = servers.length + ' servers';
    el('servers').innerHTML = servers.length ? servers.map(s => `
    <div class="card">
      <h3>${escapeHtml(s.name)} <span class="status ${s.online ? 'online' : 'offline'}">${s.online ? 'ONLINE' : 'OFFLINE'}</span></h3>
      <p>${escapeHtml(s.host)}:${s.port}<br>${s.online
        ? `Dashboard: ${escapeHtml(s.siteName || 'MyDroidGrid')} · Max phones: ${s.maxPhones ?? '?'}${s.hostInfo ? ` · ${s.hostInfo.ramGB} GB RAM / ${s.hostInfo.cores} cores` : ''}`
        : 'Server jawab nahi de raha — band hai, ya us par port khula nahi hai.'}</p>
      <div class="phone-actions">
        <button onclick="window.open('http://${s.host}:${s.port}', '_blank')">Open Dashboard</button>
        <button class="del" onclick="delServer('${s.id}')">Remove</button>
      </div>
    </div>`).join('') : '<div class="card"><h3>No other servers yet</h3><p>“Add Server” dabao, doosre server ka IP aur port do — phir wo yahin nazar ayega.</p></div>';
  } catch (e) { /* servers list optional hai */ }
}
function openAddServer() { el('serverModal').classList.remove('hidden'); el('serverError').textContent = ''; }
function closeAddServer() { el('serverModal').classList.add('hidden'); }
async function submitServer() {
  try {
    await api('/api/servers', 'POST', { name: el('sName').value.trim(), host: el('sHost').value.trim(), port: Number(el('sPort').value || 4000) });
    closeAddServer(); renderServers();
  } catch (e) { el('serverError').textContent = e.message; }
}
async function delServer(id) {
  if (!confirm('Is server ko list se hata dun? Server khud band nahi hoga — sirf yahan se us ka link hat jayega.')) return;
  await api(`/api/servers/${id}`, 'DELETE'); renderServers();
}
function bar(label, used, total, unit) {
  const pct = total ? Math.min(100, Math.round(used / total * 100)) : 0;
  return `<div class="bar"><label><span>${label}</span><span>${used} / ${total} ${unit} used — ${total - used} free</span></label><div class="track"><div class="fill" style="width:${pct}%"></div></div></div>`;
}
function renderPool(pool) {
  el('phoneCount').textContent = pool.phoneCount + ' / ' + pool.maxPhones + ' phones';
  el('pool').innerHTML = bar('RAM', pool.used.ramGB, pool.total.ramGB, 'GB') + bar('CPU cores', pool.used.cores, pool.total.cores, '') + bar('Storage', pool.used.storageGB, pool.total.storageGB, 'GB');
}
function phoneActions(ph) {
  if (ph.status === 'starting') return '<span class="starting-note">Starting...</span>';
  const main = ph.status === 'running'
    ? `<button class="open-btn" onclick="openPhone('${ph.id}')">Open Phone</button><button onclick="act('${ph.id}','stop')">Stop</button><button onclick="act('${ph.id}','restart')">Restart</button>`
    : `<button onclick="act('${ph.id}','start')">Start</button><button onclick="editRes('${ph.id}',${ph.ramGB},${ph.cores})">RAM / Cores</button>`;
  return main + `<button onclick="openProxy('${ph.id}')">Proxy</button><button class="del" onclick="delPhone('${ph.id}')">Delete</button>`;
}
let startingPoll = null;
function syncStartingPoll(phones) {
  const anyStarting = (phones || []).some(ph => ph.status === 'starting');
  if (anyStarting && !startingPoll) {
    startingPoll = setInterval(async () => {
      try {
        const d = await api('/api/phones');
        renderPool(d.pool); renderPhones(d.phones, d.pool); syncStartingPoll(d.phones);
      } catch (e) { /* agle tick par phir try hoga */ }
    }, 3000);
  } else if (!anyStarting && startingPoll) {
    clearInterval(startingPoll); startingPoll = null;
  }
}
function renderPhones(phones, pool) {
  window._pool = pool;
  window._phones = phones;
  el('phones').innerHTML = phones.length ? phones.map(ph => `
    <div class="card">
      <h3>${escapeHtml(ph.name)} <span class="status ${ph.status}">${ph.status.toUpperCase()}</span></h3>
      <p>Android ${ph.androidVersion}${ph.gapps ? ' · Play Store' : ''} · ${ph.ramGB} GB RAM · ${ph.cores} cores · ${ph.storageGB} GB<br>
      Screen ${ph.resolution} · Runtime ${ph.runtimeMinutes} min<br>
      Proxy: ${ph.proxy ? escapeHtml(ph.proxy.host) + ':' + ph.proxy.port + ' (' + String(ph.proxy.type || 'http').toUpperCase() + ')' : 'Not set — server ki IP'}${ph.status === 'error' && ph.lastError ? `<br><span class="phone-error">⚠ ${escapeHtml(ph.lastError)}</span>` : ''}</p>
      <div class="phone-actions">
        ${phoneActions(ph)}
      </div>
    </div>`).join('') : '<div class="card"><h3>No phones yet</h3><p>Press “Create Phone” — choose the version, RAM, cores and storage yourself.</p></div>';
}

// ---------- Live screen: screencap frames + touch ----------
// Screen asal Android se bar bar screenshot le kar dikhayi jati hai;
// generation counter band/purani window ki purani requests ko rokta hai.
const screenStream = { phoneId: null, gen: 0, timer: null, counter: 0, errors: 0 };

function startScreenStream(id) {
  screenStream.phoneId = id;
  screenStream.errors = 0;
  loadScreenFrame(++screenStream.gen);
}
function stopScreenStream() {
  screenStream.gen++;
  screenStream.phoneId = null;
  if (screenStream.timer) { clearTimeout(screenStream.timer); screenStream.timer = null; }
}
function loadScreenFrame(gen) {
  if (gen !== screenStream.gen || !screenStream.phoneId) return;
  el('screenImg').src = `/api/phones/${screenStream.phoneId}/screen.png?t=${encodeURIComponent(TOKEN)}&v=${++screenStream.counter}`;
}
function scheduleScreenFrame(gen, delay) {
  if (gen !== screenStream.gen) return;
  if (screenStream.timer) clearTimeout(screenStream.timer);
  screenStream.timer = setTimeout(() => loadScreenFrame(gen), delay);
}
function refreshScreenNow() {
  if (!screenStream.phoneId) return;
  if (screenStream.timer) { clearTimeout(screenStream.timer); screenStream.timer = null; }
  loadScreenFrame(screenStream.gen);
}

function openPhone(id) {
  const ph = (window._phones || []).find(x => x.id === id); if (!ph) return;
  stopScreenStream();
  el('screenTitle').textContent = ph.name + ' — Android ' + ph.androidVersion;
  el('screenNote').textContent = `Screen ${ph.resolution} · ${ph.ramGB} GB RAM · ${ph.cores} cores · Proxy: ${ph.proxy ? ph.proxy.host + ':' + ph.proxy.port : 'server IP'}`;
  const img = el('screenImg');
  img.classList.add('hidden'); img.removeAttribute('src');
  el('screenFallback').classList.remove('hidden');
  if (ph.status === 'running') {
    el('screenMsg').textContent = 'Screen aa rahi hai...';
    el('screenControls').classList.remove('hidden');
    el('screenModal').classList.remove('hidden');
    startScreenStream(id);
  } else {
    el('screenMsg').textContent = 'Ye phone abhi band hai. Pehle card se Start dabao — phir iski screen yahan khulegi.';
    el('screenControls').classList.add('hidden');
    el('screenModal').classList.remove('hidden');
  }
}
function closeScreen() {
  stopScreenStream();
  const img = el('screenImg');
  img.removeAttribute('src'); img.classList.add('hidden');
  el('screenModal').classList.add('hidden');
}

async function screenKey(code) {
  if (!screenStream.phoneId) return;
  try {
    await api(`/api/phones/${screenStream.phoneId}/input`, 'POST', { type: 'key', code });
    refreshScreenNow();
  } catch (e) { /* khamoshi — agli refresh asal halat dikha degi */ }
}

// Screen par ungli/mouse: halki harakat = tap, lambi harakat = swipe.
let touchStart = null;
const screenImgEl = el('screenImg');
screenImgEl.addEventListener('load', () => {
  if (!screenStream.phoneId) return;
  screenStream.errors = 0;
  el('screenFallback').classList.add('hidden');
  screenImgEl.classList.remove('hidden');
  scheduleScreenFrame(screenStream.gen, 600);
});
screenImgEl.addEventListener('error', () => {
  if (!screenStream.phoneId) return;
  screenStream.errors++;
  screenImgEl.classList.add('hidden');
  el('screenFallback').classList.remove('hidden');
  el('screenMsg').textContent = 'Screen nahi aa rahi — phone band to nahi ho gaya?';
  if (screenStream.errors <= 5) scheduleScreenFrame(screenStream.gen, 2000);
});
screenImgEl.addEventListener('pointerdown', e => {
  const r = screenImgEl.getBoundingClientRect();
  if (!r.width || !r.height) return;
  touchStart = { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height, at: Date.now() };
  e.preventDefault();
});
screenImgEl.addEventListener('pointercancel', () => { touchStart = null; });
screenImgEl.addEventListener('pointerup', async e => {
  if (!touchStart || !screenStream.phoneId) { touchStart = null; return; }
  const r = screenImgEl.getBoundingClientRect();
  const start = touchStart; touchStart = null;
  if (!r.width || !r.height) return;
  const fx2 = (e.clientX - r.left) / r.width, fy2 = (e.clientY - r.top) / r.height;
  const clampF = v => Math.min(1, Math.max(0, v));
  try {
    if (Math.hypot(fx2 - start.fx, fy2 - start.fy) < 0.02) {
      await api(`/api/phones/${screenStream.phoneId}/input`, 'POST', { type: 'tap', fx: clampF(start.fx), fy: clampF(start.fy) });
    } else {
      const ms = Math.min(1000, Math.max(80, Date.now() - start.at));
      await api(`/api/phones/${screenStream.phoneId}/input`, 'POST', { type: 'swipe', fx1: clampF(start.fx), fy1: clampF(start.fy), fx2: clampF(fx2), fy2: clampF(fy2), ms });
    }
    refreshScreenNow();
  } catch (err) { /* khamoshi — agli refresh asal halat dikha degi */ }
});

let proxyPhoneId = null;
function openProxy(id) {
  const ph = (window._phones || []).find(x => x.id === id); if (!ph) return;
  proxyPhoneId = id;
  el('proxyTitle').textContent = ph.name + ' — Proxy';
  el('pProxyType').value = ph.proxy ? ph.proxy.type : 'http';
  el('pProxyHost').value = ph.proxy ? ph.proxy.host : '';
  el('pProxyPort').value = ph.proxy ? ph.proxy.port : '';
  el('pProxyUser').value = ph.proxy ? (ph.proxy.username || '') : '';
  el('pProxyPass').value = ph.proxy ? (ph.proxy.password || '') : '';
  el('proxyError').textContent = '';
  el('proxyModal').classList.remove('hidden');
}
function closeProxy() { el('proxyModal').classList.add('hidden'); }
async function submitProxy() {
  try {
    await api(`/api/phones/${proxyPhoneId}/proxy`, 'PATCH', { type: el('pProxyType').value, host: el('pProxyHost').value.trim(), port: Number(el('pProxyPort').value || 0), username: el('pProxyUser').value.trim(), password: el('pProxyPass').value });
    closeProxy(); showDashboard();
  } catch (e) { el('proxyError').textContent = e.message; }
}
async function clearProxy() {
  try { await api(`/api/phones/${proxyPhoneId}/proxy`, 'PATCH', { clear: true }); closeProxy(); showDashboard(); }
  catch (e) { el('proxyError').textContent = e.message; }
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function act(id, action) { const { phones, pool } = await api(`/api/phones/${id}/${action}`, 'POST'); renderPool(pool); const d = await api('/api/phones'); renderPool(d.pool); renderPhones(d.phones, d.pool); syncStartingPoll(d.phones); }
async function delPhone(id) { if (!confirm('Delete this phone? Its apps and accounts inside it will be gone.')) return; await api(`/api/phones/${id}`, 'DELETE'); showDashboard(); }
async function editRes(id, ram, cores) {
  const r = prompt('RAM (GB) — options: ' + CFG.ramOptionsGB.join(', '), ram); if (r === null) return;
  const c = prompt('CPU cores — options: ' + CFG.coreOptions.join(', '), cores); if (c === null) return;
  try { await api(`/api/phones/${id}/resources`, 'PATCH', { ramGB: Number(r), cores: Number(c) }); showDashboard(); }
  catch (e) { alert(e.message); }
}

function openCreate() { el('createModal').classList.remove('hidden'); el('createError').textContent = ''; createHint(); }
function closeCreate() { el('createModal').classList.add('hidden'); }
function createHint() {
  if (!window._pool) return;
  const f = window._pool.free;
  el('createHint').textContent = `Free right now: ${f.ramGB} GB RAM · ${f.cores} cores · ${f.storageGB} GB storage. You are choosing: ${el('fRam').value} GB RAM · ${el('fCores').value} cores · ${el('fStorage').value} GB, Android ${el('fVersion').value}.`;
}
async function submitCreate() {
  try {
    const proxyHost = el('fProxyHost').value.trim();
    const proxy = proxyHost ? { type: el('fProxyType').value, host: proxyHost, port: Number(el('fProxyPort').value || 0), username: el('fProxyUser').value.trim(), password: el('fProxyPass').value } : null;
    await api('/api/phones', 'POST', { name: el('fName').value.trim() || 'My Phone', androidVersion: el('fVersion').value, gapps: el('fGapps').checked, ramGB: Number(el('fRam').value), cores: Number(el('fCores').value), storageGB: Number(el('fStorage').value), resolution: el('fRes').value, proxy });
    closeCreate(); showDashboard();
  } catch (e) { el('createError').textContent = e.message; }
}
el('navAuthBtn').addEventListener('click', () => TOKEN ? showDashboard() : openAuth());
init();
