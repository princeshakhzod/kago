const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');
const { IncomingForm } = require('formidable');

/*
 * Simple training platform server with phone-based login and premium/plus membership
 * management. All lesson and user data is stored in JSON files. The server
 * exposes a few JSON API endpoints used by the front‑end (index.html) and
 * the admin panel (admin.html). Phone verification codes are delivered via
 * a Telegram bot – when a user requests a code the server will spawn the
 * Python bot script with the user's phone number and the generated code.
 */

const PORT = process.env.PORT || 3001;
const BASE_DIR = __dirname;
const LESSONS_FILE = path.join(BASE_DIR, 'data.json');
const USERS_FILE = path.join(BASE_DIR, 'rusbot.json');
const UPLOAD_DIR = path.join(BASE_DIR, 'uploads');

// Ensure uploads directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ==== Admin login storage & helpers ====
const PASSWORDS_FILE = path.join(BASE_DIR, 'passwords.json');
const ADMIN_TOKENS = new Set();

function readPasswords() {
  try {
    const raw = fs.readFileSync(PASSWORDS_FILE, 'utf8');
    const data = JSON.parse(raw || '{"accounts":[]}');
    return Array.isArray(data.accounts) ? data.accounts : [];
  } catch {
    return [];
  }
}
function makeToken() {
  return 'adm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
function requireAdmin(req) {
  const token = req.headers['x-admin-token'];
  return token && ADMIN_TOKENS.has(String(token));
}

/* Lesson helpers */
function readLessons() {
  if (!fs.existsSync(LESSONS_FILE)) return { lessons: [] };
  try {
    const raw = fs.readFileSync(LESSONS_FILE, 'utf8');
    const data = JSON.parse(raw || '{"lessons": []}');
    if (!Array.isArray(data.lessons)) data.lessons = [];
    return data;
  } catch (e) {
    return { lessons: [] };
  }
}

function writeLessons(data) {
  fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/* User helpers */
function readUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    const data = JSON.parse(raw || '[]');
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

/* Utility to generate unique IDs for lessons */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

/* Utility to save base64 DataURIs to a file in the uploads folder */
function saveDataUriToFile(dataUri, prefix) {
  if (!dataUri || typeof dataUri !== 'string') return null;
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const mime = match[1];
  const ext = (mime.split('/')[1] || '').toLowerCase();
  const buffer = Buffer.from(match[2], 'base64');
  const filename = `${prefix}.${ext}`;
  const dest = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(dest, buffer);
  return `/uploads/${filename}`;
}

/* Spawn the Python Telegram bot to deliver codes or membership notifications.
 * The Python script expects at least two arguments: phone and info. If info
 * consists of six digits it will be treated as a one‑time login code. If
 * info equals "premium" it sends a premium membership notice; if info starts
 * with "plus:" the part after the colon should be the lesson ID and a plus
 * membership notice is sent. This helper never waits for the child process
 * to finish. */
function sendTelegram(phone, info) {
  try {
    const script = path.join(BASE_DIR, 'rusbot.py');
    const child = spawn(process.platform === "win32" ? "python" : "python3", [script, phone, info], {
        detached: true,
        stdio: 'ignore'
    });

    child.unref();
  } catch (e) {
    console.error('Failed to spawn Python bot:', e.message);
  }
}

/* Convenience to send JSON responses with CORS headers */
function sendJSON(res, status, obj) {
  const json = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(json);
}

/* Serve static files (HTML, JS, CSS, uploads) */
function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

/* Main HTTP server */
const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  // Serve uploaded files
  if (req.method === 'GET' && pathname.startsWith('/uploads/')) {
    const filePath = path.join(UPLOAD_DIR, pathname.replace('/uploads/', ''));
    const ext = path.extname(filePath).substring(1).toLowerCase();
    const mimeMap = {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc: 'application/msword',
      pdf: 'application/pdf'
    };
    const mime = mimeMap[ext] || 'application/octet-stream';
    return serveFile(res, filePath, mime);
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // Serve index and admin pages
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return serveFile(res, path.join(BASE_DIR, 'index.html'), 'text/html');
  }
  if (req.method === 'GET' && (pathname === '/admin' || pathname === '/admin.html')) {
    return serveFile(res, path.join(BASE_DIR, 'admin.html'), 'text/html');
  }

  // Serve static JS/CSS files
  if (req.method === 'GET' && (pathname.endsWith('.js') || pathname.endsWith('.css'))) {
    const filePath = path.join(BASE_DIR, pathname);
    const ext = path.extname(filePath).substring(1).toLowerCase();
    const mime = ext === 'css' ? 'text/css' : 'application/javascript';
    return serveFile(res, filePath, mime);
  }

// Request a verification code
if (pathname === '/api/request-code' && req.method === 'POST') {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const { phone } = JSON.parse(body || '{}');
      if (!phone) return sendJSON(res, 400, { error: 'Telefon raqam kiritilmadi' });

      const users = readUsers();
      let user = users.find(u => u.phone === phone);
      if (!user) {
        user = { phone, premium: false, plus: [] };
        users.push(user);
      }

      // 6 xonali kod yaratamiz
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      user.code = code;
      user.codeExpires = Date.now() + 60 * 1000; // 1 daqiqa amal qiladi
      writeUsers(users);

      // Kodni Telegram botga yuborish
      sendTelegram(phone, code);

      return sendJSON(res, 200, { success: true });
    } catch (e) {
      return sendJSON(res, 400, { error: 'Noto‘g‘ri so‘rov' });
    }
  });
  return;
}


  // API endpoints
  // Request a verification code – must include phone in request body
  if (pathname === '/api/lessons' && req.method === 'POST') {
    const form = new IncomingForm({
      multiples: false,
      uploadDir: UPLOAD_DIR,
      keepExtensions: true,
      maxFileSize: 200 * 1024 * 1024
    });


    form.parse(req, (err, fields, files) => {
      if (err) {
        return sendJSON(res, 400, { error: 'Faylni yuklashda xatolik' });
      }

      const { title, content, free } = fields;
      if (!title || !files.doc) {
        return sendJSON(res, 400, { error: 'Sarlavha va doc fayl majburiy' });
      }

      const id = generateId();
      const audioPath = files.audio ? `/uploads/${path.basename(files.audio[0].filepath)}` : null;
      const docPath = files.doc ? `/uploads/${path.basename(files.doc[0].filepath)}` : null;

      const data = readLessons();
      const lesson = {
        id,
        title: String(title),
        content: String(content || ''),
        audio: audioPath,
        doc: docPath,
        free: (String(free).toLowerCase() === 'true')
      };

      data.lessons.push(lesson);
      writeLessons(data);

      return sendJSON(res, 200, { success: true, id });
    });
    return;
  }

  // Verify the code and return membership status
  if (pathname === '/api/verify-code' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) req.connection.destroy();
    });
    req.on('end', () => {
      try {
        const { phone, code } = JSON.parse(body || '{}');
        if (!phone || !code) return sendJSON(res, 400, { error: 'Telefon va kod kiritilishi kerak' });
        const users = readUsers();
        const user = users.find(u => u.phone === phone);
        if (!user || !user.code || !user.codeExpires) {
          return sendJSON(res, 401, { error: 'Avval kod so‘rang' });
        }
        if (user.code !== code || Date.now() > user.codeExpires) {
          return sendJSON(res, 401, { error: 'Kod noto‘g‘ri yoki eskirgan' });
        }
        // Successful verification
        user.code = null;
        user.codeExpires = null;
        user.loggedIn = true;
        writeUsers(users);
        return sendJSON(res, 200, {
          success: true,
          phone: user.phone,
          premium: user.premium || false,
          plus: user.plus || []
        });
      } catch (e) {
        return sendJSON(res, 400, { error: 'Noto‘g‘ri so‘rov' });
      }
    });
    return;
  }

  // Admin: login -> returns token
  if (pathname === '/api/admin/login' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { username, password } = JSON.parse(body || '{}');
        if (!username || !password) {
          return sendJSON(res, 400, { error: 'Login va parol kerak' });
        }
        const accounts = readPasswords();
        const ok = accounts.find(a => a.username === username && a.password === password);
        if (!ok) return sendJSON(res, 401, { error: 'Noto‘g‘ri login yoki parol' });

        const token = makeToken();
        ADMIN_TOKENS.add(token);
        return sendJSON(res, 200, { success: true, token });
      } catch {
        return sendJSON(res, 400, { error: 'Noto‘g‘ri so‘rov' });
      }
    });
    return;
  }

  // Admin: grant premium membership
  if (pathname === '/api/admin/premium' && req.method === 'POST') {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'Ruxsat yo‘q (login qiling)' });
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) req.connection.destroy();
    });
    req.on('end', () => {
      try {
        const { phone } = JSON.parse(body || '{}');
        if (!phone) return sendJSON(res, 400, { error: 'Telefon raqam kiritilmadi' });
        const users = readUsers();
        const user = users.find(u => u.phone === phone);
        if (!user) {
          return sendJSON(res, 404, { error: 'Foydalanuvchi topilmadi' });
        }
        user.premium = true;
        user.plus = [];
        writeUsers(users);
        sendTelegram(phone, 'premium');
        return sendJSON(res, 200, { success: true });
      } catch (e) {
        return sendJSON(res, 400, { error: 'Noto‘g‘ri so‘rov' });
      }
    });
    return;
  }

  // Admin: grant plus membership for a single lesson
  if (pathname === '/api/admin/plus' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) req.connection.destroy();
    });
    req.on('end', () => {
      try {
        const { phone, lessonId } = JSON.parse(body || '{}');
        if (!phone || !lessonId) return sendJSON(res, 400, { error: 'Telefon raqam va dars ID kerak' });
        const users = readUsers();
        const user = users.find(u => u.phone === phone);
        if (!user) {
          return sendJSON(res, 404, { error: 'Foydalanuvchi topilmadi' });
        }
        user.premium = user.premium || false;
        user.plus = user.plus || [];
        if (!user.plus.includes(lessonId)) user.plus.push(lessonId);
        writeUsers(users);
        sendTelegram(phone, `plus:${lessonId}`);
        return sendJSON(res, 200, { success: true });
      } catch (e) {
        return sendJSON(res, 400, { error: 'Noto‘g‘ri so‘rov' });
      }
    });
    return;
  }

  // User status (obuna yangilash)
  if (pathname === '/api/user-status' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { phone } = JSON.parse(body || '{}');
        const users = readUsers();
        const user = users.find(u => u.phone === phone);
        if (!user) return sendJSON(res, 404, { error: 'Foydalanuvchi topilmadi' });
        return sendJSON(res, 200, {
          phone: user.phone,
          premium: user.premium || false,
          plus: user.plus || []
        });
      } catch (e) {
        return sendJSON(res, 400, { error: 'Noto‘g‘ri so‘rov' });
      }
    });
    return;
  }

  // Get list of lessons (id, title, free)
  if (pathname === '/api/lessons' && req.method === 'GET') {
    const data = readLessons();
    const summary = data.lessons.map(({ id, title, free }) => ({ id, title, free: !!free }));
    return sendJSON(res, 200, summary);
  }

  // Get a specific lesson by id
  if (pathname.startsWith('/api/lessons/') && req.method === 'GET') {
    const parts = pathname.split('/');
    const id = parts[3];
    const data = readLessons();
    const lesson = data.lessons.find(l => l.id === id);
    if (!lesson) {
      return sendJSON(res, 404, { error: 'Dars topilmadi' });
    }
    return sendJSON(res, 200, lesson);
  }
  
    form.parse(req, (err, fields, files) => {
      if (err) {
        return sendJSON(res, 400, { error: 'Faylni yuklashda xatolik' });
      }

      const { title, content, free } = fields;
      if (!title || !files.doc) {
        return sendJSON(res, 400, { error: 'Sarlavha va doc fayl majburiy' });
      }

      const id = generateId();
      const audioPath = files.audio ? `/uploads/${path.basename(files.audio[0].filepath)}` : null;
      const docPath = files.doc ? `/uploads/${path.basename(files.doc[0].filepath)}` : null;

      const data = readLessons();
      const lesson = {
        id,
        title: String(title),
        content: String(content || ''),
        audio: audioPath,
        doc: docPath,
        free: (String(free).toLowerCase() === 'true')
      };

      data.lessons.push(lesson);
      writeLessons(data);

      return sendJSON(res, 200, { success: true, id });
    });
    return;
  }


  // Default 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`🚀 Server ishga tushdi: http://localhost:${PORT}`);
});


