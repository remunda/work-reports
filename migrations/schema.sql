-- D1 schema pro aplikaci work-reports.
-- Hesla jsou ukládána v novém formátu: sha256(`${salt}:${password}`) hex.
-- Hashe níže jsou předpočítané (viz scripts/hash-password.js):
--   admin    salt=admin-salt-3f8a    heslo=admin123
--   reporter salt=reporter-salt-9c2d heslo=reporter123

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
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

-- Seed uživatelů (pouze pokud je tabulka prázdná — d1 execute běží jen jednou).
INSERT INTO users (username, password_hash, salt, role, name) VALUES
  ('admin',    '1db079ce031e29a8c113c0f3dff3195afb8d50c859ab8962cc39f4293aca250f', 'admin-salt-3f8a',    'admin',    'Správce'),
  ('reporter', '931151b9102e26c94e654f685543872e2cae2b1552b7fa5083168d455e11d3d2', 'reporter-salt-9c2d', 'reporter', 'Reportér');

-- Seed pár reportů (admin: 1, reporter: 2) pro demonstraci.
INSERT INTO reports (user_id, date, hours, description, created_at) VALUES
  (1, date('now', '-1 day'),  8.0, 'Implementace nové funkce',  datetime('now', '-1 day')),
  (2, date('now', '-2 days'), 6.5, 'Revize kódu',               datetime('now', '-2 days')),
  (2, date('now', '-3 days'), 4.0, 'Psaní dokumentace',         datetime('now', '-3 days'));

-- D1 nemá standardní IF NOT EXISTS guard na sekvence; id jsou AUTOINCREMENT,
-- takže po opakovaném seedu by vznikly duplicity. Pro jednorázové spuštění je to OK.
