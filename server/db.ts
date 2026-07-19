import pg from "pg";
import bcrypt from "bcryptjs";

const pool = new pg.Pool({
  host: process.env.PGHOST || "51.68.225.233",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "ttransit",
  user: process.env.PGUSER || "admin",
  password: process.env.PGPASSWORD || "",
  ssl: false,
  max: 10,
  connectionTimeoutMillis: 10000,
  // The remote server drops idle sockets; recycle ours before it kills them
  // and keep the TCP connection alive.
  idleTimeoutMillis: 30000,
  keepAlive: true,
});

// A dropped idle connection emits 'error' on the pool. Without this handler
// Node would treat it as unhandled and crash the whole process. pg already
// removes the broken client from the pool, so we just log and continue.
pool.on("error", (err) => {
  console.warn("[db] idle client error (recovered):", err.message);
});

const RETRYABLE = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "57P01", // admin_shutdown / terminating connection due to administrator command
  "08006", // connection_failure
  "08003", // connection_does_not_exist
]);

function isRetryable(e: unknown): boolean {
  const err = e as { code?: string };
  return !!err?.code && RETRYABLE.has(err.code);
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
) {
  try {
    return await pool.query<T>(text, params as never[]);
  } catch (e) {
    if (!isRetryable(e)) throw e;
    console.warn("[db] retrying query after connection drop:", (e as Error).message);
    return await pool.query<T>(text, params as never[]);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_users (
  id           SERIAL PRIMARY KEY,
  email        TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name         TEXT,
  role         TEXT NOT NULL DEFAULT 'admin',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS issued_wallets (
  id                 UUID PRIMARY KEY,
  wallet_id          BIGINT,
  address            TEXT NOT NULL,
  network            TEXT NOT NULL,
  network_label      TEXT,
  usdt_net           TEXT,
  native             TEXT,
  label              TEXT,
  project            TEXT,
  issued_by          INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  transit_created_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_issued_wallets_created_at ON issued_wallets (created_at);
CREATE INDEX IF NOT EXISTS idx_issued_wallets_project    ON issued_wallets (project);

-- Operations ledger: an audit trail of every action performed in the panel.
CREATE TABLE IF NOT EXISTS ledger (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  type        TEXT NOT NULL,           -- issue | topup | transfer | rename
  status      TEXT NOT NULL,           -- success | error
  wallet_id   UUID,
  address     TEXT,
  network     TEXT,
  direction   TEXT,                    -- in | out | null
  coin        INTEGER,
  coin_symbol TEXT,
  amount      NUMERIC,
  to_address  TEXT,
  detail      TEXT,
  user_id     INTEGER,
  user_email  TEXT
);

CREATE INDEX IF NOT EXISTS idx_ledger_ts        ON ledger (ts DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_wallet_id ON ledger (wallet_id);
CREATE INDEX IF NOT EXISTS idx_ledger_type      ON ledger (type);
`;

export async function migrate() {
  await pool.query(SCHEMA);
  console.log("[db] schema ready");
}

export async function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || "develguide@gmail.com").toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!password) {
    console.warn("[db] ADMIN_PASSWORD not set — skipping admin seed");
    return;
  }
  const existing = await query("SELECT id FROM app_users WHERE email=$1", [email]);
  if (existing.rowCount) {
    console.log(`[db] admin user exists: ${email}`);
    return;
  }
  const hash = await bcrypt.hash(password, 10);
  await query(
    "INSERT INTO app_users (email, password_hash, name, role) VALUES ($1,$2,$3,'admin')",
    [email, hash, "Administrator"],
  );
  console.log(`[db] seeded admin user: ${email}`);
}

export async function initDb() {
  await migrate();
  await seedAdmin();
}
