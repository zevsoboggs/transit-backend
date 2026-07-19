import { Router } from "express";
import { query } from "./db.js";
import {
  resolveCoinSymbol,
  transitApi,
  UpstreamError,
  type UpstreamWallet,
} from "./transit.js";
import { login, requireAuth, type AuthedRequest } from "./auth.js";
import {
  DEPOSIT_ADDRESS,
  ENERGY_MAX,
  ENERGY_MIN,
  extractOrderId,
  extractStatus,
  nettsApi,
  NettsError,
} from "./netts.js";

const DAILY_LIMIT = Number(process.env.DAILY_WALLET_LIMIT || 3000);
const PANEL_PROJECT = process.env.PANEL_PROJECT || "tranzor";

export const router = Router();

// ---- helpers ---------------------------------------------------------------

interface WalletRow {
  id: string;
  wallet_id: string | null;
  address: string;
  network: string;
  network_label: string | null;
  usdt_net: string | null;
  native: string | null;
  label: string | null;
  project: string | null;
  transit_created_at: string | null;
  created_at: string;
}

function rowToApi(r: WalletRow, balances: unknown[] = []) {
  return {
    id: r.id,
    walletId: r.wallet_id ? Number(r.wallet_id) : null,
    address: r.address,
    network: r.network,
    networkLabel: r.network_label,
    usdtNet: r.usdt_net,
    native: r.native,
    label: r.label,
    project: r.project,
    balances,
    createdAt: r.transit_created_at || r.created_at,
  };
}

async function issuedToday(): Promise<number> {
  const { rows } = await query<{ n: string }>(
    "SELECT count(*)::int AS n FROM issued_wallets WHERE created_at >= date_trunc('day', now())",
  );
  return Number(rows[0]?.n || 0);
}

async function findOwned(id: string): Promise<WalletRow | null> {
  const { rows } = await query<WalletRow>("SELECT * FROM issued_wallets WHERE id=$1", [id]);
  return rows[0] || null;
}

interface LedgerEntry {
  type: "issue" | "topup" | "transfer" | "rename" | "energy";
  status: "success" | "error";
  walletId?: string | null;
  address?: string | null;
  network?: string | null;
  direction?: "in" | "out" | null;
  coin?: number | null;
  coinSymbol?: string | null;
  amount?: number | null;
  toAddress?: string | null;
  detail?: string | null;
  user?: { id: number; email: string } | null;
}

// Never let a ledger write break the actual operation.
async function logLedger(e: LedgerEntry) {
  try {
    await query(
      `INSERT INTO ledger
        (type, status, wallet_id, address, network, direction, coin, coin_symbol, amount, to_address, detail, user_id, user_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        e.type,
        e.status,
        e.walletId ?? null,
        e.address ?? null,
        e.network ?? null,
        e.direction ?? null,
        e.coin ?? null,
        e.coinSymbol ?? null,
        e.amount ?? null,
        e.toAddress ?? null,
        e.detail ?? null,
        e.user?.id ?? null,
        e.user?.email ?? null,
      ],
    );
  } catch (err) {
    console.warn("[ledger] write failed:", err instanceof Error ? err.message : err);
  }
}

function handleError(res: import("express").Response, e: unknown) {
  if (e instanceof UpstreamError || e instanceof NettsError) {
    return res.status(e.status >= 400 && e.status < 600 ? e.status : 502).json({ error: e.message });
  }
  const msg = e instanceof Error ? e.message : "Внутренняя ошибка";
  console.error("[api]", msg);
  return res.status(500).json({ error: msg });
}

// ---- auth ------------------------------------------------------------------

router.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Укажите email и пароль" });
    const result = await login(String(email), String(password));
    res.json(result);
  } catch (e) {
    res.status(401).json({ error: e instanceof Error ? e.message : "Ошибка входа" });
  }
});

router.get("/auth/me", requireAuth, (req: AuthedRequest, res) => {
  res.json({ user: req.user });
});

// everything below requires auth
router.use(requireAuth);

// ---- reference / master ----------------------------------------------------

router.get("/networks", async (_req, res) => {
  try {
    res.json({ networks: await transitApi.networks() });
  } catch (e) {
    handleError(res, e);
  }
});

router.get("/master", async (_req, res) => {
  try {
    res.json(await transitApi.master());
  } catch (e) {
    handleError(res, e);
  }
});

router.get("/stats", async (_req, res) => {
  try {
    const today = await issuedToday();
    const { rows } = await query<{ network: string; n: string }>(
      "SELECT network, count(*)::int AS n FROM issued_wallets GROUP BY network",
    );
    const total = rows.reduce((a, r) => a + Number(r.n), 0);
    res.json({
      issuedToday: today,
      remaining: Math.max(0, DAILY_LIMIT - today),
      limit: DAILY_LIMIT,
      total,
      byNetwork: Object.fromEntries(rows.map((r) => [r.network, Number(r.n)])),
    });
  } catch (e) {
    handleError(res, e);
  }
});

// ---- ledger ----------------------------------------------------------------

router.get("/ledger", async (req, res) => {
  try {
    const conds: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, val: unknown) => {
      params.push(val);
      conds.push(clause.replace("?", `$${params.length}`));
    };
    if (req.query.type) add("type = ?", String(req.query.type));
    if (req.query.status) add("status = ?", String(req.query.status));
    if (req.query.direction) add("direction = ?", String(req.query.direction));
    if (req.query.walletId) add("wallet_id = ?", String(req.query.walletId));
    if (req.query.from) add("ts >= ?", String(req.query.from));
    if (req.query.to) add("ts <= ?", String(req.query.to));

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const offset = Number(req.query.offset) || 0;

    const totalRes = await query<{ n: string }>(
      `SELECT count(*)::int AS n FROM ledger ${where}`,
      params,
    );
    const total = Number(totalRes.rows[0]?.n || 0);

    const { rows } = await query(
      `SELECT id, ts, type, status, wallet_id AS "walletId", address, network,
              direction, coin, coin_symbol AS "coinSymbol", amount::float8 AS amount,
              to_address AS "toAddress", detail, user_email AS "userEmail"
         FROM ledger ${where}
         ORDER BY ts DESC
         LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    res.json({ entries: rows, count: total });
  } catch (e) {
    handleError(res, e);
  }
});

// ---- energy delegation (netts.io) ------------------------------------------

router.get("/energy/config", async (_req, res) => {
  try {
    let pricing = null;
    try {
      pricing = await nettsApi.priceSummary();
    } catch {
      /* pricing is optional; never block the form on it */
    }
    // Deliberately NO account balance is exposed here.
    res.json({
      depositAddress: DEPOSIT_ADDRESS,
      min: ENERGY_MIN,
      max: ENERGY_MAX,
      durations: ["1h", "5m"],
      pricing,
    });
  } catch (e) {
    handleError(res, e);
  }
});

router.get("/energy/orders", async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, ts, duration, amount::float8 AS amount, receive_address AS "receiveAddress",
              provider_order_id AS "providerOrderId", status, est_cost_trx::float8 AS "estCostTrx",
              detail, user_email AS "userEmail"
         FROM energy_orders
         ORDER BY ts DESC
         LIMIT 500`,
    );
    res.json({ orders: rows, count: rows.length });
  } catch (e) {
    handleError(res, e);
  }
});

router.post("/energy/order", async (req: AuthedRequest, res) => {
  const duration = String((req.body || {}).duration || "1h") as "1h" | "5m";
  const amount = Math.trunc(Number((req.body || {}).amount));
  const receiveAddress = String((req.body || {}).receiveAddress || "").trim();

  if (duration !== "1h" && duration !== "5m") {
    return res.status(400).json({ error: "duration должен быть '1h' или '5m'" });
  }
  if (!Number.isFinite(amount) || amount < ENERGY_MIN || amount > ENERGY_MAX) {
    return res
      .status(400)
      .json({ error: `Объём энергии должен быть от ${ENERGY_MIN} до ${ENERGY_MAX}` });
  }
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(receiveAddress)) {
    return res.status(400).json({ error: "Некорректный TRON-адрес получателя" });
  }

  // Best-effort estimated cost (sun/energy → TRX), never blocks the order.
  let estCostTrx: number | null = null;
  try {
    const s = await nettsApi.priceSummary();
    const priceSun = duration === "1h" ? s.priceSun1h : s.priceSun5m;
    if (priceSun) estCostTrx = (amount * priceSun) / 1_000_000;
  } catch {
    /* ignore */
  }

  try {
    const resp = await nettsApi.order(duration, amount, receiveAddress);
    const providerOrderId = extractOrderId(resp);
    const status = extractStatus(resp) || "submitted";

    const ins = await query<{ id: string }>(
      `INSERT INTO energy_orders
        (duration, amount, receive_address, provider_order_id, status, est_cost_trx, response, user_id, user_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        duration,
        amount,
        receiveAddress,
        providerOrderId,
        status,
        estCostTrx,
        JSON.stringify(resp ?? null),
        req.user?.id ?? null,
        req.user?.email ?? null,
      ],
    );

    await logLedger({
      type: "energy",
      status: "success",
      address: receiveAddress,
      network: "tron",
      amount,
      coinSymbol: "ENERGY",
      detail: `${duration} · ${estCostTrx ? `≈${estCostTrx.toFixed(2)} TRX` : ""}`.trim(),
      user: req.user ? { id: req.user.id, email: req.user.email } : null,
    });

    res.status(201).json({ id: ins.rows[0]?.id, providerOrderId, status, estCostTrx, response: resp });
  } catch (e) {
    await logLedger({
      type: "energy",
      status: "error",
      address: receiveAddress,
      network: "tron",
      amount,
      coinSymbol: "ENERGY",
      detail: `${duration}: ${e instanceof Error ? e.message : "order failed"}`,
      user: req.user ? { id: req.user.id, email: req.user.email } : null,
    });
    handleError(res, e);
  }
});

router.post("/energy/orders/:id/check", async (req, res) => {
  try {
    const { rows } = await query<{ provider_order_id: string | null }>(
      "SELECT provider_order_id FROM energy_orders WHERE id=$1",
      [Number(req.params.id)],
    );
    const pid = rows[0]?.provider_order_id;
    if (!pid) return res.status(404).json({ error: "Заказ не найден или без provider id" });
    const resp = await nettsApi.orderCheck(pid);
    const status = extractStatus(resp);
    if (status) {
      await query("UPDATE energy_orders SET status=$1, response=$2 WHERE id=$3", [
        status,
        JSON.stringify(resp ?? null),
        Number(req.params.id),
      ]);
    }
    res.json({ status, response: resp });
  } catch (e) {
    handleError(res, e);
  }
});

// ---- wallets (OUR db only) -------------------------------------------------

router.get("/wallets", async (req, res) => {
  try {
    const project = req.query.project ? String(req.query.project) : undefined;
    const withBalances = req.query.balances === "1" || req.query.balances === "true";

    const params: unknown[] = [];
    let sql = "SELECT * FROM issued_wallets";
    if (project) {
      params.push(project);
      sql += ` WHERE project=$1`;
    }
    sql += " ORDER BY created_at DESC";
    const { rows } = await query<WalletRow>(sql, params);

    let wallets;
    if (withBalances) {
      wallets = await Promise.all(
        rows.map(async (r) => {
          try {
            const b = (await transitApi.getBalance(r.id)) as { balances?: unknown[] };
            return rowToApi(r, b.balances || []);
          } catch {
            return rowToApi(r, []);
          }
        }),
      );
    } else {
      wallets = rows.map((r) => rowToApi(r));
    }
    res.json({ wallets, count: wallets.length });
  } catch (e) {
    handleError(res, e);
  }
});

router.post("/wallets", async (req: AuthedRequest, res) => {
  try {
    const { network, label, project } = req.body || {};
    if (!network) return res.status(400).json({ error: "Укажите сеть" });

    const today = await issuedToday();
    if (today >= DAILY_LIMIT) {
      return res.status(429).json({
        error: `Достигнут суточный лимит выпуска (${DAILY_LIMIT}). Попробуйте завтра.`,
      });
    }

    const proj = project ? String(project) : PANEL_PROJECT;
    const created = await transitApi.createWallet({ network, label, project: proj });
    const w = ((created as { wallet?: UpstreamWallet }).wallet ??
      created) as UpstreamWallet;

    await query(
      `INSERT INTO issued_wallets
        (id, wallet_id, address, network, network_label, usdt_net, native, label, project, issued_by, transit_created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO NOTHING`,
      [
        w.id,
        w.walletId ?? null,
        w.address,
        w.network,
        w.networkLabel ?? null,
        w.usdtNet ?? null,
        w.native ?? null,
        w.label ?? label ?? null,
        w.project ?? proj,
        req.user?.id ?? null,
        w.createdAt ?? null,
      ],
    );

    await logLedger({
      type: "issue",
      status: "success",
      walletId: w.id,
      address: w.address,
      network: w.network,
      detail: w.label ?? label ?? null,
      user: req.user ? { id: req.user.id, email: req.user.email } : null,
    });

    const row = await findOwned(w.id);
    res.status(201).json({ wallet: row ? rowToApi(row, (w.balances as unknown[]) || []) : w });
  } catch (e) {
    await logLedger({
      type: "issue",
      status: "error",
      network: (req.body || {}).network ?? null,
      detail: e instanceof Error ? e.message : "issue failed",
      user: req.user ? { id: req.user.id, email: req.user.email } : null,
    });
    handleError(res, e);
  }
});

router.get("/wallets/:id", async (req, res) => {
  try {
    const row = await findOwned(String(req.params.id));
    if (!row) return res.status(404).json({ error: "Кошелёк не найден в этой панели" });
    let balances: unknown[] = [];
    try {
      const live = (await transitApi.getWallet(row.id)) as { balances?: unknown[] };
      balances = live.balances || [];
    } catch {
      /* keep empty on upstream hiccup */
    }
    res.json({ wallet: rowToApi(row, balances) });
  } catch (e) {
    handleError(res, e);
  }
});

router.get("/wallets/:id/balance", async (req, res) => {
  try {
    const row = await findOwned(String(req.params.id));
    if (!row) return res.status(404).json({ error: "Кошелёк не найден в этой панели" });
    res.json(await transitApi.getBalance(row.id));
  } catch (e) {
    handleError(res, e);
  }
});

router.post("/wallets/:id/topup", async (req: AuthedRequest, res) => {
  const row = await findOwned(String(req.params.id));
  if (!row) return res.status(404).json({ error: "Кошелёк не найден в этой панели" });
  const body = req.body || {};
  const amount = body.amount != null ? Number(body.amount) : null;
  const coin = body.coin != null ? Number(body.coin) : null;
  try {
    const result = await transitApi.topup(row.id, body);
    await logLedger({
      type: "topup",
      status: "success",
      walletId: row.id,
      address: row.address,
      network: row.network,
      direction: "in",
      coin,
      coinSymbol: await resolveCoinSymbol(row.network, coin),
      amount,
      user: req.user ? { id: req.user.id, email: req.user.email } : null,
    });
    res.json(result);
  } catch (e) {
    await logLedger({
      type: "topup",
      status: "error",
      walletId: row.id,
      address: row.address,
      network: row.network,
      direction: "in",
      coin,
      amount,
      detail: e instanceof Error ? e.message : "topup failed",
      user: req.user ? { id: req.user.id, email: req.user.email } : null,
    });
    handleError(res, e);
  }
});

router.post("/wallets/:id/transfer", async (req: AuthedRequest, res) => {
  const row = await findOwned(String(req.params.id));
  if (!row) return res.status(404).json({ error: "Кошелёк не найден в этой панели" });
  const body = req.body || {};
  const amount = body.amount != null ? Number(body.amount) : null;
  const coin = body.coin != null ? Number(body.coin) : null;
  const toAddress = body.toAddress ? String(body.toAddress) : null;
  try {
    const result = await transitApi.transfer(row.id, body);
    await logLedger({
      type: "transfer",
      status: "success",
      walletId: row.id,
      address: row.address,
      network: row.network,
      direction: "out",
      coin,
      coinSymbol: await resolveCoinSymbol(row.network, coin),
      amount,
      toAddress,
      user: req.user ? { id: req.user.id, email: req.user.email } : null,
    });
    res.json(result);
  } catch (e) {
    await logLedger({
      type: "transfer",
      status: "error",
      walletId: row.id,
      address: row.address,
      network: row.network,
      direction: "out",
      coin,
      amount,
      toAddress,
      detail: e instanceof Error ? e.message : "transfer failed",
      user: req.user ? { id: req.user.id, email: req.user.email } : null,
    });
    handleError(res, e);
  }
});

router.post("/wallets/:id/rename", async (req: AuthedRequest, res) => {
  try {
    const row = await findOwned(String(req.params.id));
    if (!row) return res.status(404).json({ error: "Кошелёк не найден в этой панели" });
    const label = String((req.body || {}).label ?? "");
    const result = await transitApi.rename(row.id, label);
    await query("UPDATE issued_wallets SET label=$1 WHERE id=$2", [label || null, row.id]);
    await logLedger({
      type: "rename",
      status: "success",
      walletId: row.id,
      address: row.address,
      network: row.network,
      detail: label || "(пусто)",
      user: req.user ? { id: req.user.id, email: req.user.email } : null,
    });
    res.json(result);
  } catch (e) {
    handleError(res, e);
  }
});
