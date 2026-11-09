// Storage layer. With DATABASE_URL set, state lives in PostgreSQL (one JSONB row).
// Without it, falls back to data/db.json so local development needs no database.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'db.json');
const fresh = () => ({ sessions: [], blacklist: [], buyers: {}, nextOrderId: 1 });

let pool = null;
let timer = null;
let latest = null;
let dirty = false;
let chain = Promise.resolve();

async function init(opts = {}) {
  if (opts.pool || process.env.DATABASE_URL) {
    if (opts.pool) {
      pool = opts.pool;
    } else {
      const { Pool } = require('pg');
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        // Render's *internal* URL needs no SSL. For the *external* URL set PGSSL=true.
        ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
      });
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS app_state (
      id INT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const r = await pool.query('SELECT data FROM app_state WHERE id = 1');
    console.log('[store] PostgreSQL ' + (r.rows.length ? 'state loaded' : 'ready (empty)'));
    return Object.assign(fresh(), r.rows[0] ? r.rows[0].data : {});
  }
  try {
    const d = Object.assign(fresh(), JSON.parse(fs.readFileSync(FILE, 'utf8')));
    console.log('[store] using local file data/db.json');
    return d;
  } catch (_) {
    console.log('[store] using local file data/db.json (new)');
    return fresh();
  }
}

function write(snapshot) {
  chain = chain
    .then(async () => {
      if (pool) {
        await pool.query(
          `INSERT INTO app_state (id, data, updated_at) VALUES (1, $1::jsonb, now())
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [snapshot]
        );
      } else {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(FILE, snapshot);
      }
    })
    .catch((e) => console.error('[store] save failed:', e.message));
  return chain;
}

// Debounced: many chat comments in a second become one write.
function save(db) {
  latest = db;
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(() => { dirty = false; write(JSON.stringify(latest)); }, 200);
}

// Write right now (used when the server is shutting down).
async function flush() {
  clearTimeout(timer);
  if (dirty && latest) { dirty = false; write(JSON.stringify(latest)); }
  await chain;
}

module.exports = { init, save, flush };
