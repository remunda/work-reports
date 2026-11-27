import { Hono } from 'hono';

// Cloudflare Workers verze reportingové aplikace.
// Používá D1 (env.DB) místo better-sqlite3 a Web Crypto API (crypto.subtle)
// místo node crypto. Statické assety servíruje ASSETS binding z public/.

const SESSION_COOKIE = 'session';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days
const SECRET_FALLBACK = 'vymena-produkce-secret-1273812'; // jen pro dev; produkce = SESSION_SECRET

// ---------------------------------------------------------------
// Hash helpers (Web Crypto API)
// ---------------------------------------------------------------

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Nový formát hesel: sha256(`${salt}:${password}`)
async function hashPassword(salt, password) {
  return sha256Hex(`${salt}:${password}`);
}

// ---------------------------------------------------------------
// HMAC signed cookie (session)
// ---------------------------------------------------------------

function getSecret(env) {
  return env.SESSION_SECRET || SECRET_FALLBACK;
}

async function hmacValue(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function signValue(secret, value) {
  return value + '.' + (await hmacValue(secret, value));
}

// Vrací payload, pokud je cookie platná, jinak null.
async function verifySigned(secret, value) {
  if (!value) return null;
  const idx = value.lastIndexOf('.');
  if (idx === -1) return null;
  const payload = value.slice(0, idx);
  const mac = value.slice(idx + 1);
  const expected = await hmacValue(secret, payload);
  // Konstantní-čas srovnání (Web Crypto nemá timingSafeEqual).
  if (mac.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < mac.length; i++) diff |= mac.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? payload : null;
}

function currentUserCookie(env, request) {
  const header = request.headers.get('Cookie') || '';
  const cookies = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies[SESSION_COOKIE] || null;
}

async function currentUser(env, request) {
  try {
    const signed = currentUserCookie(env, request);
    if (!signed) return null;
    const payload = await verifySigned(getSecret(env), signed);
    if (!payload) return null;
    const idx = payload.indexOf(':');
    if (idx === -1) return null;
    const userId = Number(payload.slice(0, idx));
    const expires = Number(payload.slice(idx + 1));
    if (!userId || !expires || expires < Date.now()) return null;
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(userId)
      .first();
    return user || null;
  } catch {
    return null;
  }
}

// Ukládá do session cookie user.id + expiraci (signováno) — stateless, vhodné pro Workers.
async function setSessionCookie(response, env, user) {
  const payload = `${user.id}:${Date.now() + SESSION_TTL_MS}`;
  const token = await signValue(getSecret(env), payload);
  response.headers.set(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}; Path=/`
  );
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Vytvoří tabulky, pokud ještě neexistují (stejně jako CREATE TABLE IF NOT EXISTS v db.js).
async function ensureSchema(env) {
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'reporter')),
        name TEXT NOT NULL
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        hours REAL NOT NULL,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`
    ),
  ]);
}

// Seed, pokud je DB prázdná (první request po čistém nasazení).
async function ensureSeeded(env) {
  await ensureSchema(env);
  const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first();
  if (row && row.c > 0) return;

  // Stejné soli jako v migrations/schema.sql — hashe se shodují.
  const seedUsers = [
    {
      username: 'admin',
      password: 'admin123',
      salt: 'admin-salt-3f8a',
      role: 'admin',
      name: 'Správce',
    },
    {
      username: 'reporter',
      password: 'reporter123',
      salt: 'reporter-salt-9c2d',
      role: 'reporter',
      name: 'Reportér',
    },
  ];

  const descriptions = [
    'Implementace nové funkce',
    'Údržba a oprava chyb',
    'Schůzka s týmem',
    'Revize kódu',
    'Psaní dokumentace',
    'Testování aplikace',
    'Analýza požadavků',
    'Nasazení na produkci',
    'Podpora zákazníků',
    'Optimalizace výkonu',
  ];

  const userIds = {};
  for (const u of seedUsers) {
    const hash = await hashPassword(u.salt, u.password);
    const res = await env.DB.prepare(
      'INSERT INTO users (username, password_hash, salt, role, name) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(u.username, hash, u.salt, u.role, u.name)
      .run();
    userIds[u.username] = res.meta.last_row_id;
  }

  // ~20 náhodných reportů za poslední 3 týdny (jako db.js).
  const now = Date.now();
  const rowCount = 20 + Math.floor(Math.random() * 5); // 20-24
  const insert = env.DB.prepare(
    'INSERT INTO reports (user_id, date, hours, description, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  for (let i = 0; i < rowCount; i++) {
    const isReporter = Math.random() > 0.4;
    const userId = isReporter ? userIds['reporter'] : userIds['admin'];
    const daysAgo = Math.floor(Math.random() * 21);
    const d = new Date(now - daysAgo * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    const hours = Math.round((1 + Math.random() * 7) * 4) / 4;
    const description = descriptions[Math.floor(Math.random() * descriptions.length)];
    const created = new Date(now - daysAgo * 86400000 + Math.floor(Math.random() * 8 * 3600 * 1000));
    await insert.bind(userId, dateStr, hours, description, created.toISOString()).run();
  }
}

// ---------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------

function createApp() {
  const app = new Hono();

  // ---- Auth ----
  app.post('/api/login', async (c) => {
    const env = c.env;
    const body = await c.req.json().catch(() => ({}));
    const { username, password } = body;
    if (!username || !password) return c.json({ error: 'Chybí přihlašovací údaje' }, 400);

    const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?')
      .bind(username)
      .first();
    if (!user || (await hashPassword(user.salt, password)) !== user.password_hash) {
      return c.json({ error: 'Neplatné uživatelské jméno nebo heslo' }, 401);
    }

    const res = json({ username: user.username, role: user.role, name: user.name });
    await setSessionCookie(res, env, user);
    return res;
  });

  app.post('/api/logout', async (c) => {
    const res = json({ ok: true });
    res.headers.set(
      'Set-Cookie',
      `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`
    );
    return res;
  });

  app.get('/api/me', async (c) => {
    const user = await currentUser(c.env, c.req.raw);
    if (!user) return c.json({ error: 'Neautorizováno' }, 401);
    return c.json({ username: user.username, role: user.role, name: user.name });
  });

  // ---- Reports ----
  app.get('/api/reports/mine', async (c) => {
    const user = await currentUser(c.env, c.req.raw);
    if (!user) return c.json({ error: 'Neautorizováno' }, 401);
    const rows = await c.env.DB.prepare(
      'SELECT * FROM reports WHERE user_id = ? ORDER BY date DESC, id DESC'
    )
      .bind(user.id)
      .all();
    return c.json(rows.results);
  });

  app.get('/api/reports', async (c) => {
    const user = await currentUser(c.env, c.req.raw);
    if (!user) return c.json({ error: 'Neautorizováno' }, 401);
    let rows;
    if (user.role === 'admin') {
      rows = await c.env.DB.prepare(
        `SELECT r.*, u.username, u.name AS user_name, u.role AS user_role
         FROM reports r JOIN users u ON u.id = r.user_id
         ORDER BY r.date DESC, r.id DESC`
      ).all();
    } else {
      rows = await c.env.DB.prepare(
        'SELECT r.* FROM reports r WHERE r.user_id = ? ORDER BY r.date DESC, r.id DESC'
      )
        .bind(user.id)
        .all();
    }
    return c.json(rows.results);
  });

  app.post('/api/reports', async (c) => {
    const user = await currentUser(c.env, c.req.raw);
    if (!user) return c.json({ error: 'Neautorizováno' }, 401);
    const body = await c.req.json().catch(() => ({}));
    const { date, hours, description } = body;
    if (!date || hours == null || !description) {
      return c.json({ error: 'Datum, hodiny a popis jsou povinné' }, 400);
    }
    const h = Number(hours);
    if (Number.isNaN(h) || h <= 0 || h > 24) {
      return c.json({ error: 'Hodiny musí být číslo v rozmezí 0–24' }, 400);
    }
    const res = await c.env.DB.prepare(
      'INSERT INTO reports (user_id, date, hours, description, created_at) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(user.id, date, h, String(description), new Date().toISOString())
      .run();
    const row = await c.env.DB.prepare('SELECT * FROM reports WHERE id = ?')
      .bind(res.meta.last_row_id)
      .first();
    return c.json(row, 201);
  });

  app.put('/api/reports/:id', async (c) => {
    const user = await currentUser(c.env, c.req.raw);
    if (!user) return c.json({ error: 'Neautorizováno' }, 401);
    const id = Number(c.req.param('id'));
    const report = await c.env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(id).first();
    if (!report) return c.json({ error: 'Záznam nenalezen' }, 404);
    if (report.user_id !== user.id && user.role !== 'admin') {
      return c.json({ error: 'Nemáte oprávnění upravit tento záznam' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const { date, hours, description } = body;
    if (!date || hours == null || !description) {
      return c.json({ error: 'Datum, hodiny a popis jsou povinné' }, 400);
    }
    const h = Number(hours);
    if (Number.isNaN(h) || h <= 0 || h > 24) {
      return c.json({ error: 'Hodiny musí být číslo v rozmezí 0–24' }, 400);
    }
    await c.env.DB.prepare('UPDATE reports SET date = ?, hours = ?, description = ? WHERE id = ?')
      .bind(date, h, String(description), id)
      .run();
    const updated = await c.env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(id).first();
    return c.json(updated);
  });

  app.delete('/api/reports/:id', async (c) => {
    const user = await currentUser(c.env, c.req.raw);
    if (!user) return c.json({ error: 'Neautorizováno' }, 401);
    const id = Number(c.req.param('id'));
    const report = await c.env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(id).first();
    if (!report) return c.json({ error: 'Záznam nenalezen' }, 404);
    if (report.user_id !== user.id && user.role !== 'admin') {
      return c.json({ error: 'Nemáte oprávnění smazat tento záznam' }, 403);
    }
    await c.env.DB.prepare('DELETE FROM reports WHERE id = ?').bind(id).run();
    return c.json({ ok: true });
  });

  // ---- Summaries (admin only) ----
  app.get('/api/summary/day', async (c) => {
    const user = await currentUser(c.env, c.req.raw);
    if (!user) return c.json({ error: 'Neautorizováno' }, 401);
    if (user.role !== 'admin') return c.json({ error: 'Přístup zamítnut' }, 403);

    const start = new Date();
    start.setDate(start.getDate() - 13);
    start.setHours(0, 0, 0, 0);
    const startDate = start.toISOString().slice(0, 10);

    const rows = await c.env.DB.prepare(
      `SELECT date, SUM(hours) AS hours FROM reports
       WHERE date >= ? GROUP BY date ORDER BY date`
    )
      .bind(startDate)
      .all();

    const byDate = {};
    for (const r of rows.results) byDate[r.date] = r.hours;

    const labels = [];
    const data = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const key = d.toISOString().slice(0, 10);
      labels.push(key);
      data.push(Math.round((byDate[key] || 0) * 100) / 100);
    }
    return c.json({ labels, data });
  });

  app.get('/api/summary/week', async (c) => {
    const user = await currentUser(c.env, c.req.raw);
    if (!user) return c.json({ error: 'Neautorizováno' }, 401);
    if (user.role !== 'admin') return c.json({ error: 'Přístup zamítnut' }, 403);

    const rows = await c.env.DB.prepare('SELECT date, hours FROM reports ORDER BY date ASC').all();

    const weekInfo = (dateStr) => {
      const d = new Date(dateStr + 'T00:00:00Z');
      const day = (d.getUTCDay() + 6) % 7; // Monday=0
      const monday = new Date(d);
      monday.setUTCDate(d.getUTCDate() - day);
      const y = monday.getUTCFullYear();
      const jan1 = new Date(Date.UTC(y, 0, 1));
      const days = Math.floor((monday - jan1) / 86400000);
      const week = 1 + Math.floor((days - monday.getUTCDay() + 7) / 7);
      return { label: `${y}-W${week}`, monday };
    };

    const byWeek = new Map();
    for (const r of rows.results) {
      const { label } = weekInfo(r.date);
      byWeek.set(label, (byWeek.get(label) || 0) + r.hours);
    }

    const labels = [];
    const data = [];
    const today = new Date();
    for (let w = 7; w >= 0; w--) {
      const monday = new Date(today);
      const day = (monday.getUTCDay() + 6) % 7;
      monday.setUTCDate(monday.getUTCDate() - day - w * 7);
      const y = monday.getUTCFullYear();
      const jan1 = new Date(Date.UTC(y, 0, 1));
      const days = Math.floor((monday - jan1) / 86400000);
      const week = 1 + Math.floor((days - monday.getUTCDay() + 7) / 7);
      const label = `${y}-W${week}`;
      labels.push(label);
      data.push(Math.round((byWeek.get(label) || 0) * 100) / 100);
    }
    return c.json({ labels, data });
  });

  return app;
}

// ---------------------------------------------------------------
// Fetch handler
// ---------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // API routy
    if (path === '/api' || path.startsWith('/api/')) {
      // Ujistit se, že DB je nasazená (první request).
      try {
        await ensureSeeded(env);
      } catch {
        // Necháme routy vrátit přirozenou chybu (např. pokud DB neexistuje).
      }
      const app = createApp();
      return app.fetch(request, env);
    }

    // Statické assety z binding ASSETS (public/).
    return env.ASSETS.fetch(request);
  },
};
