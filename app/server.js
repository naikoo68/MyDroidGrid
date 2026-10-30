// MyDroidGrid — server (zero external dependencies, Node built-ins only)
// API: first-run admin setup, login (HMAC token), phones CRUD + start/stop/restart,
// per-phone RAM/CPU/storage allocation checked against the host pool in config.json.
// Phase 2: start/stop/restart/delete drive REAL Redroid containers via Docker
// (engine layer below) — the API contract is unchanged.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
fs.mkdirSync(DATA, { recursive: true });

const SECRET_FILE = path.join(DATA, 'secret.txt');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'));
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();

function loadJson(name, fallback) {
  const f = path.join(DATA, name);
  if (!fs.existsSync(f)) return fallback;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
}
function saveJson(name, value) { fs.writeFileSync(path.join(DATA, name), JSON.stringify(value, null, 2)); }

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function send(res, code, obj, type = 'application/json') {
  const body = type === 'application/json' ? JSON.stringify(obj) : obj;
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}
function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}
function authUserToken(token) {
  const payload = verifyToken(token);
  if (!payload) return null;
  const users = loadJson('users.json', []);
  return users.find(u => u.id === payload.uid) || null;
}
function authUser(req) {
  const header = req.headers.authorization || '';
  return authUserToken(header.replace('Bearer ', ''));
}

function resourcePool(phones, excludeId = null) {
  const usableRam = CONFIG.host.ramGB - CONFIG.host.reservedRamGB;
  const usableCores = CONFIG.host.cores - CONFIG.host.reservedCores;
  const usableStorage = CONFIG.host.storageGB;
  const list = phones.filter(p => p.id !== excludeId);
  const used = list.reduce((a, p) => ({ ramGB: a.ramGB + p.ramGB, cores: a.cores + p.cores, storageGB: a.storageGB + p.storageGB }), { ramGB: 0, cores: 0, storageGB: 0 });
  return {
    host: CONFIG.host,
    total: { ramGB: usableRam, cores: usableCores, storageGB: usableStorage },
    used,
    free: { ramGB: usableRam - used.ramGB, cores: usableCores - used.cores, storageGB: usableStorage - used.storageGB },
    maxPhones: CONFIG.maxPhones, phoneCount: list.length
  };
}
function cleanProxy(b) {
  if (!b || typeof b !== 'object') return null;
  const host = String(b.host || '').trim();
  if (!host) return null;
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) return 'INVALID';
  const port = Number(b.port || 0);
  if (!(port >= 1 && port <= 65535)) return 'INVALID';
  return {
    type: String(b.type || 'http') === 'socks5' ? 'socks5' : 'http',
    host, port,
    username: String(b.username || '').slice(0, 60),
    password: String(b.password || '').slice(0, 120)
  };
}

function validateAllocation(phones, candidate, excludeId = null) {
  const pool = resourcePool(phones, excludeId);
  if (!excludeId && pool.phoneCount >= CONFIG.maxPhones) return `Phone limit poora ho gaya hai (${CONFIG.maxPhones}). Pehle ek phone delete karo.`;
  if (candidate.ramGB > pool.free.ramGB) return `RAM kam hai: ${candidate.ramGB} GB chahiye, free sirf ${pool.free.ramGB} GB hai.`;
  if (candidate.cores > pool.free.cores) return `CPU cores kam hain: ${candidate.cores} chahiye, free sirf ${pool.free.cores} hain.`;
  if (candidate.storageGB > pool.free.storageGB) return `Storage kam hai: ${candidate.storageGB} GB chahiye, free sirf ${pool.free.storageGB} GB hai.`;
  return null;
}

// ---------- Phase 2 engine: asal Redroid containers (Docker) ----------
// Har phone ka ek container: naam mdg-<phoneId>, data us ke apne folder me.
// Docker ki koi ghalti request ko crash nahi karti — error phone.lastError me jati hai.
const PHONE_DATA = path.join(DATA, 'phone-data');
const startingSet = new Set();

async function runDocker(args, timeout = 30000) {
  const r = await execFileP('docker', args, { timeout, maxBuffer: 16 * 1024 * 1024 });
  return String(r.stdout || '');
}
// Binary output ke liye (screencap PNG) — stdout Buffer ki surat me wapas aata hai.
async function runDockerBuffer(args, timeout = 30000) {
  const r = await execFileP('docker', args, { timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' });
  return r.stdout;
}
function shortErr(e) {
  const raw = (e && (e.stderr || e.message)) || e || 'unknown error';
  return String(raw).trim().replace(/\s+/g, ' ').slice(0, 300);
}
function containerName(phone) { return 'mdg-' + phone.id; }
function phoneDataDir(phone) { return path.join(PHONE_DATA, phone.id); }
// ---------- Live frame engine ----------
// Har running phone ke liye peeche ek halki loop chalti hai jo screen ki
// sab se taza tasveer hamesha tayyar rakhti hai — browser ki request par
// docker ka intezar nahi karna parta, is liye screen tez chalti hai aur
// sust lamhon me pichli tasveer nazar aati rehti hai (khali screen nahi).
const frameLoops = new Map(); // phoneId -> { buf, type, timer, busy, fails }
let FFMPEG = false;
execFileP('ffmpeg', ['-version']).then(() => { FFMPEG = true; }).catch(() => { FFMPEG = false; });

async function captureFrame(phone) {
  const png = await runDockerBuffer(['exec', containerName(phone), '/system/bin/screencap', '-p'], 15000);
  if (!png || !png.length) return null;
  if (!FFMPEG) return { buf: png, type: 'image/png' };
  try {
    const r = await execFileP('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-q:v', '7', '-f', 'image2', 'pipe:1'], { timeout: 10000, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer', input: png });
    if (r.stdout && r.stdout.length > 100) return { buf: r.stdout, type: 'image/jpeg' };
  } catch { /* ffmpeg fail ho to PNG hi sahi */ }
  return { buf: png, type: 'image/png' };
}
function startFrameLoop(phone) {
  if (frameLoops.has(phone.id)) return;
  const st = { buf: null, type: 'image/png', timer: null, busy: false, fails: 0 };
  frameLoops.set(phone.id, st);
  const tick = async () => {
    if (!frameLoops.has(phone.id)) return;
    if (!st.busy) {
      st.busy = true;
      try {
        const f = await captureFrame(phone);
        if (f) { st.buf = f.buf; st.type = f.type; st.fails = 0; }
      } catch { st.fails++; }
      st.busy = false;
    }
    if (frameLoops.has(phone.id)) st.timer = setTimeout(tick, st.fails >= 3 ? 3000 : 500);
  };
  tick();
}
function stopFrameLoop(id) {
  const st = frameLoops.get(id);
  if (st) { if (st.timer) clearTimeout(st.timer); frameLoops.delete(id); }
}

// Phone ki proxy asal me lagana. Android ka system proxy sirf HTTP ko
// system-wide support karta hai; SOCKS5 apps ke andar lagta hai.
async function applyProxy(phone) {
  try {
    if (phone.proxy && phone.proxy.type === 'http') {
      await runDocker(['exec', containerName(phone), '/system/bin/settings', 'put', 'global', 'http_proxy', phone.proxy.host + ':' + phone.proxy.port], 10000);
    } else {
      await runDocker(['exec', containerName(phone), '/system/bin/settings', 'put', 'global', 'http_proxy', ':0'], 10000);
    }
  } catch { /* phone band ho to khamoshi se chor do — agle Start par lag jayegi */ }
}

function imageFor(version, gapps) { return gapps ? `redroid/redroid:${version}.0.0_mindthegapps` : `redroid/redroid:${version}.0.0-latest`; }
function resParts(resolution) {
  const parts = String(resolution || '720x1280').split('x').map(Number);
  const width = parts[0] || 720, height = parts[1] || 1280;
  return { width, height, dpi: width >= 1080 ? 320 : 240 };
}
function nextAdbPort(phones, excludeId = null) {
  const used = new Set(phones.filter(x => x.id !== excludeId).map(x => x.adbPort).filter(Boolean));
  let port = 5555;
  while (used.has(port)) port++;
  return port;
}
async function engineStatus() {
  let docker = false;
  try { await runDocker(['version', '--format', '{{.Server.Version}}']); docker = true; } catch { docker = false; }
  return { docker, binder: fs.existsSync('/dev/binderfs/binder') };
}
function mutatePhone(id, fn) {
  const list = loadJson('phones.json', []);
  const ph = list.find(x => x.id === id);
  if (!ph) return;
  fn(ph);
  saveJson('phones.json', list);
}

// Phone ko asal me chalane ki poori pipeline — background me chalti hai,
// POST /start sirf status 'starting' karke foran jawab de deta hai.
async function startPipeline(phoneId, mode) {
  if (startingSet.has(phoneId)) return;
  startingSet.add(phoneId);
  try {
    const snap = loadJson('phones.json', []).find(x => x.id === phoneId);
    if (!snap) return;
    const name = containerName(snap);
    // (a) engine tayyar hai?
    const eng = await engineStatus();
    if (!eng.docker) throw new Error('Docker is not running on this server — the phone engine cannot start.');
    if (!eng.binder) throw new Error('Android kernel support (binder) is not ready on this server — the phone cannot start.');
    // (b) Android image maujood hai? na ho to download karo
    // (Play Store wali image server par bani hui hoti hai — wo download nahi hoti)
    const image = imageFor(snap.androidVersion, snap.gapps);
    let haveImage = true;
    try { await runDocker(['image', 'inspect', image]); } catch { haveImage = false; }
    if (!haveImage) {
      if (snap.gapps) throw new Error('Google Apps (Play Store) image is server par bani hui nahi hai — Android ' + snap.androidVersion + ' ke liye pehle use banana hoga.');
      await runDocker(['pull', image], 600000);
    }
    // (c) container hai to start/restart, warna naya banao
    let exists = true;
    try { await runDocker(['inspect', name]); } catch { exists = false; }
    if (exists && mode === 'restart') {
      await runDocker(['restart', name], 60000);
    } else if (exists) {
      await runDocker(['start', name], 60000);
    } else {
      fs.mkdirSync(phoneDataDir(snap), { recursive: true });
      const { width, height, dpi } = resParts(snap.resolution);
      await runDocker(['run', '-d', '--privileged', '--name', name,
        '-v', '/dev/binderfs:/dev/binderfs',
        '-v', phoneDataDir(snap) + ':/data',
        '--memory=' + snap.ramGB + 'g', '--cpus=' + snap.cores,
        '-p', '127.0.0.1:' + snap.adbPort + ':5555',
        image,
        'androidboot.redroid_width=' + width,
        'androidboot.redroid_height=' + height,
        'androidboot.redroid_dpi=' + dpi], 60000);
    }
    // (d) Android ke poori tarah boot hone ka intezar (har 3s check;
    // Play Store wale phone ki pehli boot sust hoti hai, use zyada waqt do)
    const deadline = Date.now() + (snap.gapps ? 420000 : 360000);
    let booted = false, deadSince = null;
    while (Date.now() < deadline) {
      let alive = false;
      try { alive = (await runDocker(['inspect', '-f', '{{.State.Running}}', name])).trim() === 'true'; } catch { alive = false; }
      if (!alive) {
        if (!deadSince) deadSince = Date.now();
        if (Date.now() - deadSince > 9000) {
          let logs = '';
          try { logs = String(await runDocker(['logs', '--tail', '20', name]) || '').trim().replace(/\s+/g, ' '); } catch { }
          throw new Error('Phone container stopped while starting.' + (logs ? ' Logs: ' + logs.slice(0, 180) : ''));
        }
      } else {
        deadSince = null;
        try {
          if ((await runDocker(['exec', name, '/system/bin/getprop', 'sys.boot_completed'])).trim() === '1') { booted = true; break; }
        } catch { /* Android abhi uth raha hai */ }
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    if (!booted) throw new Error('boot timeout');
    await applyProxy(snap);
    mutatePhone(phoneId, ph => {
      if (ph.status !== 'starting') return; // beech me stop/delete ho gaya ho to hath na lagao
      ph.status = 'running'; ph.startedAt = Date.now(); ph.lastError = null;
    });
    const fresh = loadJson('phones.json', []).find(x => x.id === phoneId);
    if (fresh && fresh.status === 'running') startFrameLoop(fresh);
  } catch (e) {
    stopFrameLoop(phoneId);
    mutatePhone(phoneId, ph => {
      if (ph.status !== 'starting') return;
      ph.status = 'error'; ph.startedAt = null; ph.lastError = shortErr(e);
    });
  } finally {
    startingSet.delete(phoneId);
  }
}

// Doosre MyDroidGrid server ki halat check karna (uska public /api/config parh kar)
function checkServer(host, port) {
  return new Promise(resolve => {
    const req = http.get({ host, port, path: '/api/config', timeout: 3000 }, r => {
      let d = '';
      r.on('data', c => { d += c; });
      r.on('end', () => {
        try {
          const j = JSON.parse(d);
          resolve({ online: r.statusCode === 200, siteName: j.siteName || null, maxPhones: (j.maxPhones ?? null), hostInfo: j.host || null, needsSetup: !!j.needsSetup });
        } catch { resolve({ online: false }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ online: false }); });
    req.on('error', () => resolve({ online: false }));
  });
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/api/config') {
    const users = loadJson('users.json', []);
    return send(res, 200, { siteName: CONFIG.siteName, publicSignup: CONFIG.publicSignup, needsSetup: users.length === 0, androidVersions: CONFIG.androidVersions, ramOptionsGB: CONFIG.ramOptionsGB, coreOptions: CONFIG.coreOptions, storageOptionsGB: CONFIG.storageOptionsGB, resolutions: CONFIG.resolutions, host: CONFIG.host, maxPhones: CONFIG.maxPhones });
  }
  if (p === '/api/setup' && req.method === 'POST') {
    const users = loadJson('users.json', []);
    if (users.length) return send(res, 400, { error: 'Setup pehle hi ho chuka hai. Login karo.' });
    const { username, password } = await readBody(req);
    if (!username || !password || password.length < 6) return send(res, 400, { error: 'Username aur kam se kam 6 characters ka password chahiye.' });
    const { salt, hash } = hashPassword(password);
    const user = { id: crypto.randomUUID(), username, salt, hash, role: 'admin', createdAt: Date.now() };
    users.push(user); saveJson('users.json', users);
    return send(res, 200, { token: signToken({ uid: user.id, exp: Date.now() + 7 * 24 * 3600 * 1000 }), username });
  }
  if (p === '/api/auth/login' && req.method === 'POST') {
    const { username, password } = await readBody(req);
    const users = loadJson('users.json', []);
    const user = users.find(u => u.username === username);
    if (!user) return send(res, 401, { error: 'Username ya password ghalat hai.' });
    const check = hashPassword(password, user.salt);
    if (check.hash !== user.hash) return send(res, 401, { error: 'Username ya password ghalat hai.' });
    return send(res, 200, { token: signToken({ uid: user.id, exp: Date.now() + 7 * 24 * 3600 * 1000 }), username });
  }

  if (p === '/api/servers' || p.startsWith('/api/servers/')) {
    const user = authUser(req);
    if (!user) return send(res, 401, { error: 'Login required.' });
    let servers = loadJson('servers.json', []);

    if (p === '/api/servers' && req.method === 'GET') {
      const checked = await Promise.all(servers.map(async s => ({ ...s, ...(await checkServer(s.host, s.port)) })));
      return send(res, 200, { servers: checked });
    }
    if (p === '/api/servers' && req.method === 'POST') {
      const b = await readBody(req);
      const host = String(b.host || '').trim();
      const port = Number(b.port || 4000);
      if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) || host.includes('..')) return send(res, 400, { error: 'Server ka IP/hostname sahi likho (masalan 129.150.10.25).' });
      if (!Number.isInteger(port) || port < 1 || port > 65535) return send(res, 400, { error: 'Port 1-65535 ke darmiyan hona chahiye.' });
      if (servers.some(s => s.host === host && s.port === port)) return send(res, 400, { error: 'Ye server pehle se add hai.' });
      const server = { id: crypto.randomUUID(), name: String(b.name || host).slice(0, 40), host, port, createdAt: Date.now() };
      servers.push(server); saveJson('servers.json', servers);
      return send(res, 200, { server });
    }
    const sm = p.match(/^\/api\/servers\/([^/]+)$/);
    if (sm && req.method === 'DELETE') {
      servers = servers.filter(s => s.id !== sm[1]); saveJson('servers.json', servers);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Route nahi mila.' });
  }

  if (p.startsWith('/api/phones') || p === '/api/resources') {
    // screen.png <img> tag se load hoti hai — wahan Authorization header nahi ja
    // sakta, is liye SIRF us ek GET route par token query param (?t=) se bhi chalega.
    // Baqi tamam routes sirf header wali auth par rahenge.
    const user = (req.method === 'GET' && /\/screen\.png$/.test(p))
      ? authUserToken(url.searchParams.get('t'))
      : authUser(req);
    if (!user) return send(res, 401, { error: 'Login required.' });
    let phones = loadJson('phones.json', []);

    if (p === '/api/resources' && req.method === 'GET') return send(res, 200, resourcePool(phones));

    if (p === '/api/phones' && req.method === 'GET') {
      const engine = await engineStatus();
      let changed = false;
      for (const ph of phones) {
        if (ph.status !== 'running') continue;
        // Container maujood hi nahi (engine se pehle ke zamane ka nakli 'running'
        // record) -> runtime jode baghair stopped karo. Asal runtime sirf tab
        // jodo jab container asal me bana tha aur ab band hai.
        let exists = true;
        try { await runDocker(['inspect', containerName(ph)]); } catch { exists = false; }
        if (!exists) {
          ph.status = 'stopped'; ph.startedAt = null; changed = true;
          continue;
        }
        let alive = false;
        try { alive = (await runDocker(['inspect', '-f', '{{.State.Running}}', containerName(ph)])).trim() === 'true'; } catch { alive = false; }
        if (alive && !frameLoops.has(ph.id)) startFrameLoop(ph);
        if (!alive) {
          if (ph.startedAt) ph.runtimeMinutes += Math.round((Date.now() - ph.startedAt) / 60000);
          ph.status = 'stopped'; ph.startedAt = null; changed = true;
        }
      }
      // Error/starting me atka phone jo asal me boot ho chuka ho (masalan
      // service restart ke darmiyan pipeline ruk gayi ho) — khud pehchano,
      // taake user ko bila wajah dobara Start na dabana pare.
      for (const ph of phones) {
        if ((ph.status !== 'error' && ph.status !== 'starting') || startingSet.has(ph.id)) continue;
        let alive = false;
        try { alive = (await runDocker(['inspect', '-f', '{{.State.Running}}', containerName(ph)])).trim() === 'true'; } catch { alive = false; }
        if (!alive) {
          if (ph.status === 'starting') { ph.status = 'stopped'; ph.startedAt = null; changed = true; }
          continue;
        }
        let booted = false;
        try { booted = (await runDocker(['exec', containerName(ph), '/system/bin/getprop', 'sys.boot_completed'])).trim() === '1'; } catch { booted = false; }
        if (booted) {
          ph.status = 'running'; if (!ph.startedAt) ph.startedAt = Date.now(); ph.lastError = null; changed = true;
          startFrameLoop(ph);
        }
      }
      if (changed) saveJson('phones.json', phones);
      return send(res, 200, { phones, pool: resourcePool(phones), engine });
    }

    if (p === '/api/phones' && req.method === 'POST') {
      const b = await readBody(req);
      const candidate = {
        ramGB: Number(b.ramGB || 2), cores: Number(b.cores || 2), storageGB: Number(b.storageGB || 16)
      };
      const err = validateAllocation(phones, candidate);
      if (err) return send(res, 400, { error: err });
      const proxy = cleanProxy(b.proxy);
      if (proxy === 'INVALID') return send(res, 400, { error: 'Proxy ka IP/hostname ya port sahi nahi hai.' });
      const adbPort = nextAdbPort(phones);
      const phone = {
        id: crypto.randomUUID(),
        ownerId: user.id,
        name: String(b.name || 'My Phone').slice(0, 40),
        androidVersion: CONFIG.androidVersions.includes(String(b.androidVersion)) ? String(b.androidVersion) : '12',
        gapps: b.gapps === true,
        ...candidate,
        proxy,
        resolution: CONFIG.resolutions.includes(b.resolution) ? b.resolution : '720x1280',
        adbPort,
        lastError: null,
        status: 'stopped',
        runtimeMinutes: 0,
        startedAt: null,
        createdAt: Date.now()
      };
      phones.push(phone); saveJson('phones.json', phones);
      return send(res, 200, { phone, pool: resourcePool(phones) });
    }

    const m = p.match(/^\/api\/phones\/([^/]+)(?:\/(start|stop|restart|resources|proxy|input|screen\.png))?$/);
    if (m) {
      const phone = phones.find(x => x.id === m[1]);
      if (!phone) return send(res, 404, { error: 'Phone nahi mila.' });
      const action = m[2];
      if (req.method === 'DELETE' && !action) {
        stopFrameLoop(phone.id);
        try { await runDocker(['rm', '-f', containerName(phone)]); } catch { /* container na ho to bhi aage barho */ }
        try { fs.rmSync(phoneDataDir(phone), { recursive: true, force: true }); } catch { }
        phones = phones.filter(x => x.id !== phone.id); saveJson('phones.json', phones);
        return send(res, 200, { ok: true, pool: resourcePool(phones) });
      }
      if (req.method === 'GET' && action === 'screen.png') {
        // Asal screen ka ek frame — frontend isay bar bar load karke live screen banata hai.
        if (phone.status !== 'running') { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('Phone is not running.'); }
        // Frame engine ki tayyar tasveer ho to foran wahi do (tez tareeqa)
        const fst = frameLoops.get(phone.id);
        if (fst && fst.buf) {
          res.writeHead(200, { 'Content-Type': fst.type, 'Cache-Control': 'no-store' });
          return res.end(fst.buf);
        }
        try {
          const buf = await runDockerBuffer(['exec', containerName(phone), '/system/bin/screencap', '-p'], 15000);
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
          return res.end(buf);
        } catch (e) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          return res.end('Screen capture failed.');
        }
      }
      if (req.method === 'POST' && action === 'input') {
        // Touch / key asal Android ko bhejna. Jagah fractions (0..1) me aati hai,
        // phone ki apni resolution ke pixels me badal kar input ko di jati hai.
        if (phone.status !== 'running') return send(res, 400, { error: 'Phone chal nahi raha — pehle Start karo.' });
        const b = await readBody(req);
        const { width, height } = resParts(phone.resolution);
        const isFrac = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
        const toX = f => String(Math.round(f * (width - 1)));
        const toY = f => String(Math.round(f * (height - 1)));
        let args = null;
        if (b.type === 'tap') {
          if (!isFrac(b.fx) || !isFrac(b.fy)) return send(res, 400, { error: 'Tap ki jagah sahi nahi hai.' });
          args = ['exec', containerName(phone), '/system/bin/input', 'tap', toX(b.fx), toY(b.fy)];
        } else if (b.type === 'swipe') {
          if (![b.fx1, b.fy1, b.fx2, b.fy2].every(isFrac)) return send(res, 400, { error: 'Swipe ki jagah sahi nahi hai.' });
          const ms = Number.isFinite(b.ms) ? Math.min(1000, Math.max(50, Math.round(b.ms))) : 250;
          args = ['exec', containerName(phone), '/system/bin/input', 'swipe', toX(b.fx1), toY(b.fy1), toX(b.fx2), toY(b.fy2), String(ms)];
        } else if (b.type === 'key') {
          const code = Number(b.code);
          if (![3, 4, 19, 20, 21, 22, 26, 61, 62, 66, 67, 111, 112, 187].includes(code)) return send(res, 400, { error: 'Ye key allowed nahi hai.' });
          args = ['exec', containerName(phone), '/system/bin/input', 'keyevent', String(code)];
        } else if (b.type === 'text') {
          // Keyboard se likhai: Android ka 'input text' space ke liye %s leta hai
          // aur asal % ke liye \\% — nayi line ko space bana do (Enter alag key hai).
          const raw = String(b.text || '');
          if (!raw || raw.length > 500) return send(res, 400, { error: 'Text khali hai ya bohat lamba hai (500 characters tak).' });
          const prepared = raw.replace(/%/g, '\\%').replace(/ /g, '%s').replace(/[\r\n]+/g, ' ');
          args = ['exec', containerName(phone), '/system/bin/input', 'text', prepared];
        } else {
          return send(res, 400, { error: 'Input type samajh nahi aya.' });
        }
        try { await runDocker(args, 15000); }
        catch (e) { return send(res, 502, { error: shortErr(e) }); }
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && action === 'start') {
        if (phone.status !== 'running' && phone.status !== 'starting' && !startingSet.has(phone.id)) {
          if (!phone.adbPort) phone.adbPort = nextAdbPort(phones, phone.id);
          phone.status = 'starting'; phone.lastError = null;
          saveJson('phones.json', phones);
          startPipeline(phone.id, 'start'); // background — jawab foran jata hai
        }
        return send(res, 200, { phone, pool: resourcePool(phones) });
      }
      if (req.method === 'POST' && action === 'stop') {
        stopFrameLoop(phone.id);
        try { await runDocker(['stop', '-t', '5', containerName(phone)]); } catch { /* pehle se band ho to bhi theek */ }
        if (phone.startedAt) phone.runtimeMinutes += Math.round((Date.now() - phone.startedAt) / 60000);
        phone.startedAt = null; phone.status = 'stopped'; phone.lastError = null;
        saveJson('phones.json', phones);
        return send(res, 200, { phone, pool: resourcePool(phones) });
      }
      if (req.method === 'POST' && action === 'restart') {
        stopFrameLoop(phone.id);
        if (phone.status !== 'starting' && !startingSet.has(phone.id)) {
          if (phone.startedAt) phone.runtimeMinutes += Math.round((Date.now() - phone.startedAt) / 60000);
          phone.startedAt = null;
          if (!phone.adbPort) phone.adbPort = nextAdbPort(phones, phone.id);
          phone.status = 'starting'; phone.lastError = null;
          saveJson('phones.json', phones);
          startPipeline(phone.id, 'restart'); // background
        }
        return send(res, 200, { phone, pool: resourcePool(phones) });
      }
      if (req.method === 'PATCH' && action === 'resources') {
        if (phone.status === 'running') return send(res, 400, { error: 'Pehle phone STOP karo, phir RAM/Cores badlo.' });
        const b = await readBody(req);
        const candidate = { ramGB: Number(b.ramGB || phone.ramGB), cores: Number(b.cores || phone.cores), storageGB: phone.storageGB };
        const err = validateAllocation(phones, candidate, phone.id);
        if (err) return send(res, 400, { error: err });
        phone.ramGB = candidate.ramGB; phone.cores = candidate.cores;
      }
      if (req.method === 'PATCH' && action === 'proxy') {
        const b = await readBody(req);
        if (b && b.clear) phone.proxy = null;
        else {
          const proxy = cleanProxy(b);
          if (!proxy || proxy === 'INVALID') return send(res, 400, { error: 'Proxy ka IP/hostname aur sahi port likho — ya proxy hatane ke liye "Proxy Hatao" dabao.' });
          phone.proxy = proxy;
        }
        if (phone.status === 'running') applyProxy(phone); // chal rahe phone par foran lagao
      }
      saveJson('phones.json', phones);
      return send(res, 200, { phone, pool: resourcePool(phones) });
    }
    return send(res, 404, { error: 'Route nahi mila.' });
  }

  // static files
  let file = p === '/' ? '/index.html' : p;
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full)) return send(res, 404, 'Not found', 'text/plain');
  return send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'text/plain');
});

server.listen(CONFIG.port, () => console.log(`MyDroidGrid running at http://localhost:${CONFIG.port}`));
