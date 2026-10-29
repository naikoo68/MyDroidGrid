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
  if (TOKEN) showDashboard().catch(() => { TOKEN = null; localStorage.removeItem('mdg_token'); });
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
  renderPool(pool); renderPhones(phones, pool);
}
function bar(label, used, total, unit) {
  const pct = total ? Math.min(100, Math.round(used / total * 100)) : 0;
  return `<div class="bar"><label><span>${label}</span><span>${used} / ${total} ${unit} used — ${total - used} free</span></label><div class="track"><div class="fill" style="width:${pct}%"></div></div></div>`;
}
function renderPool(pool) {
  el('phoneCount').textContent = pool.phoneCount + ' / ' + pool.maxPhones + ' phones';
  el('pool').innerHTML = bar('RAM', pool.used.ramGB, pool.total.ramGB, 'GB') + bar('CPU cores', pool.used.cores, pool.total.cores, '') + bar('Storage', pool.used.storageGB, pool.total.storageGB, 'GB');
}
function renderPhones(phones, pool) {
  window._pool = pool;
  el('phones').innerHTML = phones.length ? phones.map(ph => `
    <div class="card">
      <h3>${escapeHtml(ph.name)} <span class="status ${ph.status}">${ph.status.toUpperCase()}</span></h3>
      <p>Android ${ph.androidVersion} · ${ph.ramGB} GB RAM · ${ph.cores} cores · ${ph.storageGB} GB<br>
      Screen ${ph.resolution} · Runtime ${ph.runtimeMinutes} min</p>
      <div class="phone-actions">
        ${ph.status === 'running'
          ? `<button onclick="act('${ph.id}','stop')">Stop</button><button onclick="act('${ph.id}','restart')">Restart</button>`
          : `<button onclick="act('${ph.id}','start')">Start</button><button onclick="editRes('${ph.id}',${ph.ramGB},${ph.cores})">RAM / Cores</button>`}
        <button class="del" onclick="delPhone('${ph.id}')">Delete</button>
      </div>
    </div>`).join('') : '<div class="card"><h3>No phones yet</h3><p>Press “Create Phone” — choose the version, RAM, cores and storage yourself.</p></div>';
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function act(id, action) { const { phones, pool } = await api(`/api/phones/${id}/${action}`, 'POST'); renderPool(pool); const d = await api('/api/phones'); renderPool(d.pool); renderPhones(d.phones, d.pool); }
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
    await api('/api/phones', 'POST', { name: el('fName').value.trim() || 'My Phone', androidVersion: el('fVersion').value, ramGB: Number(el('fRam').value), cores: Number(el('fCores').value), storageGB: Number(el('fStorage').value), resolution: el('fRes').value });
    closeCreate(); showDashboard();
  } catch (e) { el('createError').textContent = e.message; }
}
el('navAuthBtn').addEventListener('click', () => TOKEN ? showDashboard() : openAuth());
init();
