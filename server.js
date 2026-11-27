const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { init, getDb } = require('./db');

const PORT = process.env.PORT || 3000;
const SESSION_COOKIE = 'session';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days
const SECRET = process.env.SESSION_SECRET || 'vymena-produkce-secret-1273812';

// Simple signed cookie session (HMAC). No external store needed.
const sessions = new Map(); // token -> { userId, expires }

function sign(value) {
  return value + '.' + crypto.createHmac('sha256', SECRET).update(value).digest('hex');
}

function verifySigned(value) {
  if (!value) return null;
  const idx = value.lastIndexOf('.');
  if (idx === -1) return null;
  const payload = value.slice(0, idx);
  const mac = value.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  const a = Buffer.from(String(mac));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? payload : null;
}

function createSession(db, user) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { userId: user.id, expires });
  return sign(token);
}

function cleanupSessions() {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (s.expires < now) sessions.delete(token);
  }
}

function currentUser(req) {
  const cookie = req.cookies[SESSION_COOKIE];
  if (!cookie) return null;
  cleanupSessions();
  const payload = verifySigned(cookie);
  if (!payload) return null;
  const session = sessions.get(payload);
  if (!session || session.expires < Date.now()) return null;
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(session.userId) || null;
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Neautorizováno' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Přístup zamítnut' });
  next();
}

function initApp() {
  init();
  const db = getDb();

  const app = express();
  app.use(express.json());
  app.use(require('cookie-parser')());
  app.use(express.static(path.join(__dirname, 'public')));

  // ---- Auth ----
  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Chybí přihlašovací údaje' });

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Neplatné uživatelské jméno nebo heslo' });
    }
    const token = createSession(db, user);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS,
    });
    res.json({ username: user.username, role: user.role, name: user.name });
  });

  app.post('/api/logout', requireAuth, (req, res) => {
    const cookie = req.cookies[SESSION_COOKIE];
    const payload = verifySigned(cookie);
    if (payload) sessions.delete(payload);
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  });

  app.get('/api/me', requireAuth, (req, res) => {
    res.json({ username: req.user.username, role: req.user.role, name: req.user.name });
  });

  // ---- Reports ----
  app.get('/api/reports', requireAuth, (req, res) => {
    let rows;
    if (req.user.role === 'admin') {
      rows = db
        .prepare(
          `SELECT r.*, u.username, u.name AS user_name, u.role AS user_role
           FROM reports r JOIN users u ON u.id = r.user_id
           ORDER BY r.date DESC, r.id DESC`
        )
        .all();
    } else {
      rows = db
        .prepare(
          `SELECT r.* FROM reports r WHERE r.user_id = ? ORDER BY r.date DESC, r.id DESC`
        )
        .all(req.user.id);
    }
    res.json(rows);
  });

  app.get('/api/reports/mine', requireAuth, (req, res) => {
    const rows = db
      .prepare('SELECT * FROM reports WHERE user_id = ? ORDER BY date DESC, id DESC')
      .all(req.user.id);
    res.json(rows);
  });

  app.post('/api/reports', requireAuth, (req, res) => {
    const { date, hours, description } = req.body || {};
    if (!date || hours == null || !description) {
      return res.status(400).json({ error: 'Datum, hodiny a popis jsou povinné' });
    }
    const h = Number(hours);
    if (Number.isNaN(h) || h <= 0 || h > 24) {
      return res.status(400).json({ error: 'Hodiny musí být číslo v rozmezí 0–24' });
    }
    const result = db
      .prepare(
        'INSERT INTO reports (user_id, date, hours, description, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(req.user.id, date, h, String(description), new Date().toISOString());
    const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(row);
  });

  app.put('/api/reports/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
    if (!report) return res.status(404).json({ error: 'Záznam nenalezen' });
    if (report.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Nemáte oprávnění upravit tento záznam' });
    }
    const { date, hours, description } = req.body || {};
    if (!date || hours == null || !description) {
      return res.status(400).json({ error: 'Datum, hodiny a popis jsou povinné' });
    }
    const h = Number(hours);
    if (Number.isNaN(h) || h <= 0 || h > 24) {
      return res.status(400).json({ error: 'Hodiny musí být číslo v rozmezí 0–24' });
    }
    db.prepare('UPDATE reports SET date = ?, hours = ?, description = ? WHERE id = ?').run(
      date,
      h,
      String(description),
      id
    );
    res.json(db.prepare('SELECT * FROM reports WHERE id = ?').get(id));
  });

  app.delete('/api/reports/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
    if (!report) return res.status(404).json({ error: 'Záznam nenalezen' });
    if (report.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Nemáte oprávnění smazat tento záznam' });
    }
    db.prepare('DELETE FROM reports WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  // ---- Summaries (admin only) ----
  app.get('/api/summary/day', requireAuth, requireAdmin, (req, res) => {
    const start = new Date();
    start.setDate(start.getDate() - 13);
    start.setHours(0, 0, 0, 0);
    const startDate = start.toISOString().slice(0, 10);

    const rows = db
      .prepare(
        `SELECT date, SUM(hours) AS hours FROM reports
         WHERE date >= ? GROUP BY date ORDER BY date`
      )
      .all(startDate);

    const byDate = {};
    for (const r of rows) byDate[r.date] = r.hours;

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
    res.json({ labels, data });
  });

  app.get('/api/summary/week', requireAuth, requireAdmin, (req, res) => {
    // Group by ISO week (Monday start).
    const rows = db
      .prepare(
        `SELECT date, hours FROM reports ORDER BY date ASC`
      )
      .all();

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
    for (const r of rows) {
      const { label } = weekInfo(r.date);
      byWeek.set(label, (byWeek.get(label) || 0) + r.hours);
    }

    // Build last 8 weeks (including current, possibly partial).
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
    res.json({ labels, data });
  });

  app.listen(PORT, () => {
    console.log(`Aplikace běží na http://localhost:${PORT}`);
  });
}

initApp();
