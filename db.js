const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'data.db');

let db = null;

function init() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'reporter')),
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      hours REAL NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // Seed only when the users table is empty (first start).
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count === 0) {
    seed();
  }
}

function hash(password) {
  return bcrypt.hashSync(password, 10);
}

function seed() {
  const adminId = db
    .prepare('INSERT INTO users (username, password_hash, role, name) VALUES (?, ?, ?, ?)')
    .run('admin', hash('admin123'), 'admin', 'Správce').lastInsertRowid;
  const reporterId = db
    .prepare('INSERT INTO users (username, password_hash, role, name) VALUES (?, ?, ?, ?)')
    .run('reporter', hash('reporter123'), 'reporter', 'Reportér').lastInsertRowid;

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

  const insert = db.prepare(
    'INSERT INTO reports (user_id, date, hours, description, created_at) VALUES (?, ?, ?, ?, ?)'
  );

  // ~20 random reports over the last 3 weeks from both users.
  const now = new Date();
  const rowCount = 20 + Math.floor(Math.random() * 5); // 20-24
  for (let i = 0; i < rowCount; i++) {
    const userId = Math.random() > 0.4 ? reporterId : adminId;
    const daysAgo = Math.floor(Math.random() * 21); // 0-20 days back
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    const dateStr = d.toISOString().slice(0, 10);
    const hours = Math.round((1 + Math.random() * 7) * 4) / 4; // 1-8 hours in 0.25 steps
    const description = descriptions[Math.floor(Math.random() * descriptions.length)];
    const created = new Date(d.getTime() + Math.floor(Math.random() * 8 * 3600 * 1000));
    insert.run(userId, dateStr, hours, description, created.toISOString());
  }
}

function getDb() {
  if (!db) init();
  return db;
}

module.exports = { init, getDb };
