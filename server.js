/**
 * Minimal Hospital Patients Sheets server
 * Strukturasi:
 *  patient/server.js
 *  patient/public/index.html
 *  patient/public/template.xlsx
 *  patient/data/    <-- avtomatik yaratiladi
 *    patients.json  <-- bemorlar ro'yxati
 *    patients/      <-- bemor xlsx fayllari shu yerda
 *
 * Ishga tushirish:
 *   cd patient
 *   npm init -y
 *   npm i express exceljs
 *   node server.js
 *   -> http://localhost:3000
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const app = express();
app.use(express.json({ limit: '20mb' }));

// Yo'llar
const ROOT = __dirname;

// PUBLIC_DIR ni avtomatik tanlash: avval ROOT/public mavjudmi, bo'lsa o'sha;
// bo'lmasa, ROOT (server.js yonidagi papka) ishlatiladi.
function pickPublicDir() {
  const pub = path.join(ROOT, 'public');
  try {
    if (fs.existsSync(pub) && fs.statSync(pub).isDirectory()) return pub;
  } catch (_) {}
  return ROOT;
}
const PUBLIC_DIR = pickPublicDir();

const DATA_DIR = path.join(ROOT, 'data');
const PATIENTS_JSON = path.join(DATA_DIR, 'patients.json');
const PATIENT_FILES_DIR = path.join(DATA_DIR, 'patients');

// Public (yoki ROOT) ichidagi fayllarni topish uchun yordamchi
function resolvePublicFile(...segments) {
  const first = path.join(PUBLIC_DIR, ...segments);
  try { fs.accessSync(first); return first; } catch (_) {}
  const fallback = path.join(ROOT, ...segments);
  try { fs.accessSync(fallback); return fallback; } catch (_) {}
  return null;
}

// template.xlsx, converter.json, alltmp.xlsx uchun avtomatik rezolving
function getTemplatePath() {
  return resolvePublicFile('template.xlsx');
}
function getConverterPath() {
  return resolvePublicFile('converter.json');
}
function getAllTmpPath() {
  return resolvePublicFile('alltmp.xlsx');
}


// Paths for admin/password management and activity logging.  These live in
// the data directory alongside patients.json.  They are created on demand
// by the helper functions below.
const PSWRDS_JSON = path.join(DATA_DIR, 'pswrds.json');
const ACTIONS_JSON = path.join(DATA_DIR, 'actions.json');

// In-memory session store.  Keys are randomly generated session IDs and
// values are objects containing the user id, login, name and role.  This
// simple implementation is sufficient for this project and does not persist
// across server restarts.
const SESSIONS = {};

// Return an ISO timestamp corresponding to the current time in the
// Asia/Tashkent time zone.  JavaScript's Date object uses the local
// timezone by default; we instead format the date using the target
// timezone and then re-parse it as a Date.  The returned ISO string
// represents that local time as if it were UTC (the Z suffix).  This
// function is used when creating or updating records so that the stored
// timestamps reflect Uzbekistan/Tashkent time.
function nowTashkentISO() {
  // Use the Swedish locale to get a predictable YYYY-MM-DD HH:mm:ss format
  const localStr = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tashkent' });
  // Convert to an ISO-like string (sv-SE returns "YYYY-MM-DD HH:mm:ss")
  const isoLike = localStr.replace(' ', 'T');
  return isoLike + '.000Z';
}

// F.I.O dan xavfsiz fayl nomi yasash
function toSafeFileNameFromName(name, id) {
  const base = String(name || `Patient_${id}`)
    .trim()
    .replace(/\s+/g, '_')                // bo'shliqlarni _
    .replace(/[^A-Za-z0-9_\-\.]/g, '');  // faqat xavfsiz belgilarga ruxsat
  return `${base}.xlsx`;
}

// Statik fayllar
app.use('/', express.static(PUBLIC_DIR));
app.use('/files', express.static(PATIENT_FILES_DIR)); // bemor xlsx fayllari ko'rsatiladi

// -------------------------------------------------------------------------
// Authentication middleware for API routes.  All /api calls except for
// /api/login, /api/session and /api/logout require a valid session.  Upon
// receiving a request we extract the sessionId cookie and look it up in
// the in-memory SESSIONS store.  If not found, we reject with 401
// Unauthorized.  For convenience, req.user is populated with the user
// information (id, login, name, role).  This middleware also ensures
// pswrds.json exists before continuing.
app.use('/api', async (req, res, next) => {
  // Allow unauthenticated login and session-check endpoints
  const openPaths = ['/login', '/session', '/logout'];
  if (openPaths.includes(req.path)) return next();
  // Ensure users file exists
  try { await ensureUsers(); } catch (_) {}
  const sid = getSessionIdFromReq(req);
  if (!sid || !SESSIONS[sid]) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Attach user info to request
  req.user = SESSIONS[sid];
  return next();
});

// ---------- Yordamchi funksiyalar ----------
async function ensureLayout() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(PATIENT_FILES_DIR, { recursive: true });

const tpl = getTemplatePath();
if (!tpl) {
  throw new Error(
    'template.xlsx topilmadi. Iltimos, quyidagi yo‘llardan biriga qo‘ying:\n' +
    ` - ${path.join(PUBLIC_DIR, 'template.xlsx')}\n` +
    ` - ${path.join(ROOT, 'template.xlsx')}`
  );
}


  try { await fsp.access(PATIENTS_JSON); }
  catch {
    const initial = { lastId: 0, patients: [] };
    await fsp.writeFile(PATIENTS_JSON, JSON.stringify(initial, null, 2), 'utf8');
  }
}

// Ensure that the users file exists.  If it doesn't, create a default
// super administrator account.  The file structure mirrors that of
// patients.json: it stores a monotonically increasing lastId counter and a
// list of user records.  Each record contains id, name, login, password
// (stored in plain text for simplicity) and role ("super" or "simple").
async function ensureUsers() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    await fsp.access(PSWRDS_JSON);
  } catch {
    const defaultAdmin = {
      id: 1,
      name: 'Super Admin',
      login: 'admin',
      password: 'admin',
      role: 'super'
    };
    const initial = { lastId: 1, users: [defaultAdmin] };
    await fsp.writeFile(PSWRDS_JSON, JSON.stringify(initial, null, 2), 'utf8');
  }
}

// Read and write helpers for users and actions.  These helpers parse and
// stringify JSON files on disk.  You should always call ensureUsers() or
// ensureActions() prior to reading/writing.
async function readUsers() {
  const buf = await fsp.readFile(PSWRDS_JSON, 'utf8');
  return JSON.parse(buf);
}
async function writeUsers(db) {
  await fsp.writeFile(PSWRDS_JSON, JSON.stringify(db, null, 2), 'utf8');
}
async function ensureActions() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    await fsp.access(ACTIONS_JSON);
  } catch {
    const initial = [];
    await fsp.writeFile(ACTIONS_JSON, JSON.stringify(initial, null, 2), 'utf8');
  }
}
async function readActions() {
  const buf = await fsp.readFile(ACTIONS_JSON, 'utf8');
  return JSON.parse(buf);
}
async function writeActions(actions) {
  await fsp.writeFile(ACTIONS_JSON, JSON.stringify(actions, null, 2), 'utf8');
}

// Generate a cryptographically secure random session ID.  The returned
// string is 32 hexadecimal characters long.
function generateSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

// Extract the sessionId cookie from an incoming request.  If the header
// is missing or the cookie is not present, null is returned.  Cookies are
// separated by semicolons and may include whitespace around the equals sign.
function getSessionIdFromReq(req) {
  const cookieHeader = req.headers?.cookie || '';
  const parts = cookieHeader.split(/;\s*/);
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 'sessionId') return decodeURIComponent(value || '');
  }
  return null;
}

// Set a session cookie on the response.  When remember is truthy, a
// persistent cookie is written with a 30 day max-age; otherwise a session
// cookie is created (expires when the browser closes).  All cookies are
// HttpOnly for security.  Note: In a production deployment you may want
// to set the Secure flag and SameSite attributes.
function setSessionCookie(res, sid, remember) {
  const attrs = [];
  attrs.push(`sessionId=${encodeURIComponent(sid)}`);
  attrs.push('Path=/');
  attrs.push('HttpOnly');
  if (remember) {
    // 30 days in seconds
    attrs.push(`Max-Age=${30 * 24 * 60 * 60}`);
  }
  res.setHeader('Set-Cookie', attrs.join('; '));
}

// Record an action performed by a user.  Each entry contains a
// timestamp (ISO), user id, login, name, the action string and an
// optional details object.  The log is appended to actions.json.  No
// trimming is performed here; filtering for the last 7 days is done when
// serving the log to clients.
async function logAction(user, action, details = {}) {
  if (!user) return;
  await ensureActions();
  const actions = await readActions();
  actions.push({
    time: new Date().toISOString(),
    userId: user.userId || user.id || null,
    login: user.login || '',
    name: user.name || '',
    action,
    details
  });
  await writeActions(actions);
}

async function readPatients() {
  const buf = await fsp.readFile(PATIENTS_JSON, 'utf8');
  return JSON.parse(buf);
}
async function writePatients(db) {
  await fsp.writeFile(PATIENTS_JSON, JSON.stringify(db, null, 2), 'utf8');
}
async function ensurePatientFile(id) {
  await ensureLayout();
  const dst = path.join(PATIENT_FILES_DIR, `${id}.xlsx`);
  try { await fsp.access(dst); } catch {
    // agar topilmasa — template'dan nusxa
    const tpl = getTemplatePath();
    if (!tpl) throw new Error('template.xlsx topilmadi (ensurePatientFile).');
    await fsp.copyFile(tpl, dst);
  }
  return dst;
}

// ---------- API ----------

// ============ Authentication & User Management API ============

// Login: verify credentials and set a session cookie
app.post('/api/login', async (req, res) => {
  try {
    const { login, password, remember } = req.body || {};
    if (!login || !password) {
      return res.status(400).json({ error: 'Login va parol talab qilinadi' });
    }
    await ensureUsers();
    const db = await readUsers();
    const user = db.users.find(u => u.login === login && u.password === password);
    if (!user) {
      return res.status(401).json({ error: 'Login yoki parol noto‘g‘ri' });
    }
    const sid = generateSessionId();
    SESSIONS[sid] = { userId: user.id, login: user.login, name: user.name, role: user.role };
    setSessionCookie(res, sid, !!remember);
    await logAction({ userId: user.id, login: user.login, name: user.name }, 'login');
    return res.json({ ok: true, id: user.id, login: user.login, name: user.name, role: user.role });
  } catch (e) {
    console.error('Login error:', e);
    return res.status(500).json({ error: 'Xatolik yuz berdi' });
  }
});

// Logout: clear session and cookie
app.post('/api/logout', (req, res) => {
  const sid = getSessionIdFromReq(req);
  if (sid && SESSIONS[sid]) {
    const user = SESSIONS[sid];
    delete SESSIONS[sid];
    // Overwrite the cookie to expire immediately
    res.setHeader('Set-Cookie', 'sessionId=; Path=/; Max-Age=0; HttpOnly');
    logAction(user, 'logout').catch(() => {});
  } else {
    // Delete cookie anyway
    res.setHeader('Set-Cookie', 'sessionId=; Path=/; Max-Age=0; HttpOnly');
  }
  return res.json({ ok: true });
});

// Session check: return current user info if logged in
app.get('/api/session', async (req, res) => {
  try {
    await ensureUsers();
    const sid = getSessionIdFromReq(req);
    if (!sid || !SESSIONS[sid]) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const user = SESSIONS[sid];
    return res.json({ id: user.userId, login: user.login, name: user.name, role: user.role });
  } catch (e) {
    return res.status(500).json({ error: 'Xatolik' });
  }
});

// Profile: get current user profile (no password/role)
app.get('/api/profile', (req, res) => {
  const user = req.user;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  return res.json({ id: user.userId, login: user.login, name: user.name });
});

// Update profile: update name/login/password for current user
app.put('/api/profile', async (req, res) => {
  try {
    const { name, login, password } = req.body || {};
    const userSession = req.user;
    if (!userSession) return res.status(401).json({ error: 'Unauthorized' });
    await ensureUsers();
    const db = await readUsers();
    const idx = db.users.findIndex(u => u.id === userSession.userId);
    if (idx < 0) return res.status(404).json({ error: 'User not found' });
    // Check if login is taken by another user
    if (login && login !== db.users[idx].login) {
      if (db.users.some(u => u.login === login)) {
        return res.status(409).json({ error: 'Bu login band' });
      }
      db.users[idx].login = login;
      userSession.login = login;
    }
    if (name) {
      db.users[idx].name = name;
      userSession.name = name;
    }
    if (password) {
      db.users[idx].password = password;
    }
    await writeUsers(db);
    await logAction(userSession, 'update_profile', { fields: { name: !!name, login: !!login, password: !!password } });
    return res.json({ ok: true, id: db.users[idx].id, login: db.users[idx].login, name: db.users[idx].name });
  } catch (e) {
    console.error('Profile update error:', e);
    return res.status(500).json({ error: 'Xatolik yuz berdi' });
  }
});

// Get list of all users (super admin only)
app.get('/api/users', async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'super') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await ensureUsers();
    const db = await readUsers();
    // Do not return passwords
    const list = db.users.map(u => ({ id: u.id, name: u.name, login: u.login, role: u.role }));
    return res.json(list);
  } catch (e) {
    console.error('Get users error:', e);
    return res.status(500).json({ error: 'Xatolik' });
  }
});

// Create a new user (super admin only)
app.post('/api/users', async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'super') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { name, login, password, role } = req.body || {};
    if (!name || !login || !password || !role) {
      return res.status(400).json({ error: 'Barcha maydonlar to‘ldirilishi shart' });
    }
    await ensureUsers();
    const db = await readUsers();
    if (db.users.some(u => u.login === login)) {
      return res.status(409).json({ error: 'Bu login mavjud' });
    }
    const id = db.lastId + 1;
    const newUser = { id, name, login, password, role };
    db.users.push(newUser);
    db.lastId = id;
    await writeUsers(db);
    await logAction(req.user, 'create_user', { newUserId: id, login, role });
    return res.json({ id, name, login, role });
  } catch (e) {
    console.error('Create user error:', e);
    return res.status(500).json({ error: 'Xatolik yuz berdi' });
  }
});

// Update a user (super admin only)
app.put('/api/users/:id', async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'super') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const userId = parseInt(req.params.id, 10);
    if (Number.isNaN(userId)) return res.status(400).json({ error: 'Invalid id' });
    const { name, login, password, role } = req.body || {};
    await ensureUsers();
    const db = await readUsers();
    const idx = db.users.findIndex(u => u.id === userId);
    if (idx < 0) return res.status(404).json({ error: 'User not found' });
    // Prevent duplicate logins
    if (login && login !== db.users[idx].login) {
      if (db.users.some(u => u.login === login)) {
        return res.status(409).json({ error: 'Bu login mavjud' });
      }
      db.users[idx].login = login;
    }
    if (name) db.users[idx].name = name;
    if (password) db.users[idx].password = password;
    if (role) db.users[idx].role = role;
    await writeUsers(db);
    await logAction(req.user, 'update_user', { userId, role });
    return res.json({ ok: true });
  } catch (e) {
    console.error('Update user error:', e);
    return res.status(500).json({ error: 'Xatolik yuz berdi' });
  }
});

// Delete a user (super admin only)
app.delete('/api/users/:id', async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'super') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const userId = parseInt(req.params.id, 10);
    if (Number.isNaN(userId)) return res.status(400).json({ error: 'Invalid id' });
    await ensureUsers();
    const db = await readUsers();
    const idx = db.users.findIndex(u => u.id === userId);
    if (idx < 0) return res.status(404).json({ error: 'User not found' });
    // Prevent deleting yourself
    if (req.user.userId === userId) {
      return res.status(400).json({ error: 'O‘zingizni o‘chira olmaysiz' });
    }
    const removed = db.users.splice(idx, 1)[0];
    await writeUsers(db);
    await logAction(req.user, 'delete_user', { userId: removed.id, login: removed.login });
    return res.json({ ok: true });
  } catch (e) {
    console.error('Delete user error:', e);
    return res.status(500).json({ error: 'Xatolik yuz berdi' });
  }
});

// Get recent actions (super admin only).  Returns activities from the last 7
// days in reverse chronological order.
app.get('/api/actions', async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'super') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await ensureActions();
    const actions = await readActions();
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const filtered = actions.filter(act => {
      const t = new Date(act.time).getTime();
      return !Number.isNaN(t) && t >= sevenDaysAgo;
    });
    // Sort descending by time
    filtered.sort((a, b) => new Date(b.time) - new Date(a.time));
    return res.json(filtered);
  } catch (e) {
    console.error('Get actions error:', e);
    return res.status(500).json({ error: 'Xatolik yuz berdi' });
  }
});

// Bemorlar ro'yxati
app.get('/api/patients', async (req, res) => {
  try {
    await ensureLayout();
    const db = await readPatients();
    res.json(db.patients);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Cannot read patients' });
  }
});

// Yangi bemor yaratish: name, phone -> id avtomatik
// Yangi bemor yaratish: endi name/phone majburiy emas.
// Faqat ID auto-increment bo'ladi va template.xlsx dan nusxa tayyorlanadi.
// Name/phone keyin /save vaqtida D3 va AC3 dan yangilanadi.
app.post('/api/patients', async (req, res) => {
  try {
    await ensureLayout();
    const db = await readPatients();
    const id = db.lastId + 1;
    const now = nowTashkentISO();

    // Dastlab "bo'sh" qiymatlar; /save paytida D3/AC3 bilan yangilanadi
    const name = '';
    const phone = '';

    db.patients.push({ id, name, phone, createdAt: now, updatedAt: now });
    db.lastId = id;
    await writePatients(db);

    // Log creation if user context is available (requires authentication)
    try {
      if (req.user) await logAction(req.user, 'create_patient', { patientId: id });
    } catch (_) {}

    // Bemor uchun xlsx faylni tayyorlab qo'yamiz (template'dan nusxa)
    await ensurePatientFile(id);

    res.json({ id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Cannot create patient' });
  }
});

// Mavjud bemorning xlsx URL'ini qaytarish (Luckysheet yuklash uchun)
app.get('/api/patients/:id/sheet', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    await ensurePatientFile(id);
    const url = `/files/${id}.xlsx`;
    res.json({ url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Cannot get sheet url' });
  }
});

// Tanlangan patientlarni Excel faylga export qilish
app.post('/api/patients/export', async (req, res) => {
  try {
    const { patientIds } = req.body || {};
    if (!Array.isArray(patientIds) || patientIds.length === 0) {
      return res.status(400).json({ error: 'Hech qanday bemor tanlanmagan' });
    }

    const ExcelJS = require('exceljs');

    // --- 1) converter.json'ni topish (public/ yoki ROOT yonidan) ---
    const convCandidates = [
      path.join(PUBLIC_DIR, 'converter.json'),
      path.join(ROOT, 'converter.json')
    ];
    let converterList = null;
    for (const p of convCandidates) {
      try {
        if (fs.existsSync(p)) {
          const raw = await fsp.readFile(p, 'utf8');
          if (raw && raw.trim()) {
            const conf = JSON.parse(raw);
            if (Array.isArray(conf)) {
              converterList = conf;
            } else if (Array.isArray(conf.mappings)) {
              converterList = conf.mappings;
            } else if (typeof conf.mappings === 'string') {
              converterList = conf.mappings.split(/\s*;\s*/).filter(Boolean);
            } else if (typeof conf === 'string') {
              converterList = conf.split(/\s*;\s*/).filter(Boolean);
            }
          }
          break; // topildi, boshqa yo'llarni tekshirmaymiz
        }
      } catch (_) {}
    }

    // --- 2) CONVERTER BOR bo'lsa: bitta varaqga jamlab chiqamiz ---
    if (converterList && converterList.length > 0) {
      // alltmp.xlsx shablonini o‘qish (bo'lsa)
      const alltmpCandidates = [
        path.join(PUBLIC_DIR, 'alltmp.xlsx'),
        path.join(ROOT, 'alltmp.xlsx')
      ];
      const destWb = new ExcelJS.Workbook();
      let destWs = null;
      for (const p of alltmpCandidates) {
        try {
          if (fs.existsSync(p)) {
            await destWb.xlsx.readFile(p);
            destWs = destWb.worksheets[0] || destWb.addWorksheet('Sheet1');
            break;
          }
        } catch (_) {}
      }
      if (!destWs) destWs = destWb.addWorksheet('Sheet1');

      // Har bir bemor bo'yicha yozish
      for (let idx = 0; idx < patientIds.length; idx++) {
        const id = patientIds[idx];
        const filePath = await ensurePatientFile(id);

        const srcWb = new ExcelJS.Workbook();
        await srcWb.xlsx.readFile(filePath);
        const src = srcWb.worksheets[0];
        if (!src) continue;

        for (const raw of converterList) {
          if (typeof raw !== 'string') continue;
          const parts = raw.split('-');
          if (parts.length < 2) continue;
          const srcAddr = parts[0].trim();
          const dstAddr = parts[1].trim();

          // Masalan "C4" → ["C","4"]
          const m = dstAddr.match(/^([A-Za-z]+)(\d+)$/);
          if (!m) continue;
          const destCol = m[1];
          const baseRow = parseInt(m[2], 10);
          if (!baseRow) continue;

          const destRow = baseRow + idx;
          const targetA1 = `${destCol}${destRow}`;

          const val = src.getCell(srcAddr).value;

          // Shablondagi (bazaviy) dst katakdan style nusxalashga urinamiz
          try {
            const baseCell = destWs.getCell(dstAddr);
            const tCell = destWs.getCell(targetA1);
            if (baseCell && baseCell.style) tCell.style = baseCell.style;
            tCell.value = val;
          } catch {
            destWs.getCell(targetA1).value = val;
          }
        }
      }

      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition','attachment; filename="alltmp.xlsx"');
      await destWb.xlsx.write(res);
      return res.end();
    }

    // --- 3) CONVERTER YO'Q bo'lsa: ko'p varaqli fallback ---
    const wb = new ExcelJS.Workbook();

    for (const id of patientIds) {
      const filePath = await ensurePatientFile(id);

      // Manba faylni ALohida o'qiymiz (rename to'qnashuvlardan qochish uchun)
      const srcWb = new ExcelJS.Workbook();
      await srcWb.xlsx.readFile(filePath);
      const sourceWorksheet = srcWb.worksheets[0];
      if (!sourceWorksheet) continue;

      const db = await readPatients();
      const p = db.patients.find(x => x.id === id);
      const baseName = p ? `${p.id}_${p.name}` : `Patient_${id}`;

      // Excel varaq nomi cheklovlari
      const safeBase = String(baseName).replace(/[\\/*?:[\]]/g, '_').slice(0, 31);
      let sheetName = safeBase;
      let counter = 1;
      while (wb.getWorksheet(sheetName)) {
        sheetName = `${safeBase.slice(0, 28)}_${counter++}`;
      }

      const newWs = wb.addWorksheet(sheetName);

      // Ustun kengliklari
      sourceWorksheet.columns.forEach((col, i) => {
        if (col && col.width) newWs.getColumn(i + 1).width = col.width;
      });

      // Qator balandliklari
      sourceWorksheet.eachRow({ includeEmpty: true }, (_row, r) => {
        const h = sourceWorksheet.getRow(r).height;
        if (h) newWs.getRow(r).height = h;
      });

      // Qiymatlar
      newWs.addRows(sourceWorksheet.getSheetValues());
    }

    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="patients_export_${Date.now()}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('Export error:', e);
    res.status(500).json({ error: 'Export failed: ' + e.message });
  }
});

// Luckysheet JSON'ini qabul qilib, ExcelJS orqali xlsx faylga yozish (soddalashtirilgan)
app.post('/api/patients/:id/save', async (req, res) => {
  try {
    // ---- Luckysheet JSON ichidan A1 manzil bo'yicha ko'rinadigan matnni olish yordamchilari ----
    function a1ToRC(a1) {
      if (!a1 || typeof a1 !== 'string') return null;
      const m = a1.trim().match(/^([A-Za-z]+)(\d+)$/);
      if (!m) return null;
      const colLetters = m[1].toUpperCase();
      const rowNum = parseInt(m[2], 10);
      if (!rowNum || rowNum < 1) return null;
      let colNum = 0;
      for (let i = 0; i < colLetters.length; i++) {
        colNum = colNum * 26 + (colLetters.charCodeAt(i) - 64);
      }
      return { r: rowNum - 1, c: colNum - 1 };
    }

    function getDisplayFromSheetObj(sheet, r, c) {
      // 1) data[][] dagidan o'qish
      if (Array.isArray(sheet.data) && sheet.data[r] && sheet.data[r][c]) {
        const cell = sheet.data[r][c];
        const v = (cell && typeof cell === 'object' && 'v' in cell) ? cell.v : cell;
        if (v == null) return '';
        if (typeof v === 'object') {
          if (v.m != null) return String(v.m);
          if (v.v != null) return String(v.v);
          return '';
        }
        return String(v);
      }
      // 2) celldata dan o'qish
      if (Array.isArray(sheet.celldata)) {
        const found = sheet.celldata.find(item => item.r === r && item.c === c);
        if (found && found.v) {
          const v = found.v;
          if (v.m != null) return String(v.m);
          if (v.v != null) return String(v.v);
        }
      }
      return '';
    }

    function getCellDisplayFromSheets(sheets, a1) {
      if (!Array.isArray(sheets) || sheets.length === 0) return '';
      const rc = a1ToRC(a1);
      if (!rc) return '';
      // Aktiv (status===1) bo'lsa shuni, bo'lmasa birinchi sheetni olamiz
      const active = sheets.find(s => s && s.status === 1) || sheets[0];
      return getDisplayFromSheetObj(active, rc.r, rc.c).trim();
    }
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const { sheets } = req.body || {};
    if (!Array.isArray(sheets) || sheets.length === 0) {
      return res.status(400).json({ error: 'sheets bo\'sh' });
    }

    const ExcelJS = require('exceljs');
    const filePath = await ensurePatientFile(id);

    // Mavjud faylni o'qiymiz (formatlar/merge/column width saqlansin)
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);

    // Luckysheetdagi "display" ni olish (matn ko'rinishi)
    const getDisplay = (v) => {
      if (v == null) return null;
      if (typeof v === 'object') {
        if (v.m != null) return String(v.m);
        if (v.v != null) return String(v.v);
        return null;
      }
      // v oddiy string/number bo'lsa
      if (v === '') return null;        // bo'sh stringni SKIP qilamiz!
      return String(v);
    };

    for (const s of sheets) {
      // Worksheetni nom bo'yicha izlaymiz; bo'lmasa indeks; yana bo'lmasa birinchisi
      let ws = null;
      if (s.name) ws = wb.getWorksheet(s.name);
      if (!ws && Number.isInteger(s.index)) ws = wb.worksheets[s.index];
      if (!ws) ws = wb.worksheets[0];
      if (!ws) return res.status(500).json({ error: 'Worksheet not found' });

      // 1) Sparse format bo'lsa — faqat mavjud kataklarni yozamiz
      if (Array.isArray(s.celldata) && s.celldata.length) {
        for (const cell of s.celldata) {
          const r = (cell.r ?? 0) + 1;
          const c = (cell.c ?? 0) + 1;
          const display = getDisplay(cell.v);
          if (display != null) ws.getCell(r, c).value = display; // faqat qiymat boriga yozamiz
          // display null/bo'sh bo'lsa — SKIP, template matni/formatini saqlab qolamiz
        }
        continue;
      }

      // 2) To'liq matritsa bo'lsa (s.data) — bo'shlarini SKIP qilamiz
      if (Array.isArray(s.data) && s.data.length) {
        for (let r = 0; r < s.data.length; r++) {
          const row = s.data[r];
          if (!Array.isArray(row)) continue;
          for (let c = 0; c < row.length; c++) {
            const cell = row[c];
            // ba'zan cell o'zi qiymat bo'ladi, ba'zan { v: {...} }
            const raw = (cell && typeof cell === 'object' && 'v' in cell) ? cell.v : cell;
            const display = getDisplay(raw);
            if (display != null) ws.getCell(r + 1, c + 1).value = display; // faqat borini yozamiz
          }
        }
      }
      // Eslatma: merges/width/font/fill GA TEGMAYMIZ.
    }

  await wb.xlsx.writeFile(filePath);

  // DB ni D3 (ism-familiya) va AC3 (telefon) bilan yangilaymiz
  const db = await readPatients();
  const idx = db.patients.findIndex(p => p.id === id);
  if (idx >= 0) {
    // Luckysheet'dan yuborilgan "sheets" JSON ichidan qiymatlarni olamiz
    const fullNameFromD3 = getCellDisplayFromSheets(sheets, 'D3');   // Ism Familiya
    const phoneFromAC3   = getCellDisplayFromSheets(sheets, 'AC3');  // Telefon

    if (fullNameFromD3) db.patients[idx].name  = fullNameFromD3;
    if (phoneFromAC3)   db.patients[idx].phone = phoneFromAC3;

    // update timestamp using Tashkent time
    db.patients[idx].updatedAt = nowTashkentISO();
    await writePatients(db);
    // Log patient update
    try {
      if (req.user) await logAction(req.user, 'update_patient', { patientId: id });
    } catch (_) {}
  }

  res.json({ ok: true, file: `/files/${id}.xlsx` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Save failed' });
  }
});

// Bemorga tegishli xlsx faylni yuklab berish
app.get('/api/patients/:id/download', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const filePath = await ensurePatientFile(id);
    const filename = `patient_${id}.xlsx`;
    res.download(filePath, filename);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Download failed' });
  }
});

// Tanlangan bemor(lar)ni butunlay o'chirish (JSON va xlsx)
app.post('/api/patients/bulk-delete', async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Hech qanday id berilmadi' });
    }

    await ensureLayout();
    const idSet = new Set(ids.map(x => parseInt(x, 10)).filter(x => !Number.isNaN(x)));

    const db = await readPatients();
    const deletedIds = [];
    db.patients = db.patients.filter(p => {
      if (idSet.has(p.id)) {
        deletedIds.push(p.id);
        return false; // o'chiramiz
      }
      return true;    // qoldiramiz
    });

    if (deletedIds.length === 0) {
      return res.status(404).json({ error: 'Bemor(lar) topilmadi' });
    }

    await writePatients(db);

    // Har bir bemorning xlsx faylini ham o'chiramiz
    await Promise.all(deletedIds.map(async (id) => {
      const filePath = path.join(PATIENT_FILES_DIR, `${id}.xlsx`);
      try {
        await fsp.unlink(filePath);
      } catch (e) {
        if (e.code !== 'ENOENT') {
          console.error('unlink error:', id, e.message);
        }
      }
    }));

    // Log deletion event
    try {
      if (req.user) await logAction(req.user, 'delete_patients', { ids: deletedIds });
    } catch (_) {}
    res.json({ ok: true, deletedIds, deletedCount: deletedIds.length });
  } catch (e) {
    console.error('Bulk delete error:', e);
    res.status(500).json({ error: 'Bulk delete failed' });
  }
});

// Serverni ishga tushirish
const PORT = process.env.PORT || 3000;
Promise.all([ensureLayout(), ensureUsers(), ensureActions()])
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server: http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error('Initial error:', e.message);
    process.exit(1);
  });