# Nasazení na Cloudflare Workers

Tato složka obsahuje Cloudflare Workers variantu reportingové aplikace. Worker
servíruje statické assety z `public/` (binding `ASSETS`) a používá D1 databázi
(binding `DB`). Původní Node/Express běh (`server.js` + `db.js`) zůstává
nedotčený a dál funguje lokálně přes `npm start`.

## Architektura

- `wrangler.jsonc` — konfigurace Workeru `work-reports` (assets + D1 binding).
- `worker/index.js` — entry point Workeru: `fetch` handler, který routuje `/api/*`
  na Hono handler a ostatní cesty posílá do `env.ASSETS.fetch()`.
- `migrations/schema.sql` — schema D1 (tabulky `users`, `reports`) + seed uživatelů
  s předpočítanými hashi.
- `scripts/hash-password.js` — offline generátor hesel ve formátu `sha256(salt:heslo)`.

### Rozdíly oproti Node verzi

- **Databáze**: better-sqlite3 → D1 (`env.DB.prepare(...).bind(...).all()/run()`).
- **Hesla**: bcrypt → `sha256(`${salt}:${password}`)` hex (Web Crypto API).
  Tabulka `users` má navíc sloupec `salt`. Login posílá jen `username`/`password`;
  worker ověří sám novým formátem. (Node běh dál používá bcrypt na svém lokálním
  `data.db` — sloupec `salt` se lokálně nevytvoří.)
- **Sessions**: HMAC signed cookie přes `crypto.subtle`. Secret se čte z env
  proměnné `SESSION_SECRET`.

## Lokální vývoj (Wrangler, bez deploye)

```bash
npm install
cp .dev.vars.example .dev.vars            # nastaví SESSION_SECRET pro lokální dev
npx wrangler dev --port 3180
```

D1 se lokálně vytvoří automaticky a uloží do `.wrangler/state`. Worker při prvním
požadavku, pokud je DB prázdná, dosadí admin/reporter uživatele a pár reportů.
Lokálně se dá DB taky naplnit seedem:

```bash
npx wrangler d1 execute work-reports --local --file=./migrations/schema.sql
```

> `better-sqlite3`, `esbuild` a `workerd` mají postinstall skripty. Pokud je npm
> zablokoval, spusť `npm approve-scripts` (nebo `npm rebuild esbuild workerd`),
> jinak `npx wrangler dev` nemusí fungovat.

## Nasazení na produkci

1. **Login do Cloudflare**
   ```bash
   npx wrangler login
   ```

2. **Vytvoř D1 databázi**
   ```bash
   npx wrangler d1 create work-reports
   ```
   Z výstupu si opiš vygenerované `database_id` (UUID) a doplň ho do
   `wrangler.jsonc` → `d1_databases[0].database_id` (aktuálně je tam `TODO`).

3. **Aplikuj schema + seed (remote D1)**
   ```bash
   npx wrangler d1 execute work-reports --remote --file=./migrations/schema.sql
   ```
   Toto vytvoří tabulky a vloží uživatele `admin`/`admin123` a `reporter`/`reporter123`
   (s předpočítanými hashi z `migrations/schema.sql`). Pokud bys chtěl jiná hesla,
   zregeneruj hashe: `node scripts/hash-password.js <salt> <heslo>`.

4. **Nastav session secret**
   ```bash
   npx wrangler secret put SESSION_SECRET
   ```
   (Zadej dlouhý náhodný řetězec — produkce ho nepoužívá z `.dev.vars`.)

5. **Deploy**
   ```bash
   npx wrangler deploy
   ```
   Nebo přes npm skript: `npm run deploy`.

Po deployi aplikace běží na `https://work-reports.<tvůj-subdomén>.workers.dev`.
Při prvním requestu, pokud by D1 byla prázdná (např. schema nebyly nahrány), worker
automaticky dosadí seed — nicméně standardním postupem je aplikovat schema v kroku 3.

## Shrnutí příkazů

```bash
npm install
npx wrangler login
npx wrangler d1 create work-reports          # → doplnit database_id do wrangler.jsonc
npx wrangler d1 execute work-reports --remote --file=./migrations/schema.sql
npx wrangler secret put SESSION_SECRET
npx wrangler deploy
```

### Lokální vývoj

```bash
npx wrangler dev --port 3180
```
