import { Router, type NextFunction, type Request, type Response } from "express";
import { query } from "./db.js";
import { getClientByKey, type ClientRow } from "./billing.js";
import { placeEnergyOrder, validateOrderInput, OrderError } from "./energyService.js";

export const apiV1 = Router();

interface ClientRequest extends Request {
  client?: ClientRow;
}

// Client authentication via X-API-KEY header (or ?key=).
async function requireClientKey(req: ClientRequest, res: Response, next: NextFunction) {
  const key =
    (req.header("x-api-key") || "").trim() ||
    (typeof req.query.key === "string" ? req.query.key : "");
  if (!key) return res.status(401).json({ error: "Missing API key (header X-API-KEY)" });
  try {
    const client = await getClientByKey(key);
    if (!client) return res.status(401).json({ error: "Invalid API key" });
    if (client.status !== "active") return res.status(403).json({ error: "Client is blocked" });
    req.client = client;
    next();
  } catch {
    res.status(500).json({ error: "Auth error" });
  }
}

function fail(res: Response, e: unknown) {
  const err = e as { status?: number; message?: string };
  const status = err instanceof OrderError ? err.status : err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(status).json({ error: err?.message || "Error" });
}

apiV1.use(requireClientKey);

/** GET /api/v1/balance — current balance & deposit address. */
apiV1.get("/balance", (req: ClientRequest, res) => {
  const c = req.client!;
  res.json({
    balance: Number(c.balance_usdt),
    currency: "USDT",
    depositAddress: c.deposit_address,
    network: c.network,
    status: c.status,
  });
});

/** GET /api/v1/deposit — deposit address for topping up the balance. */
apiV1.get("/deposit", (req: ClientRequest, res) => {
  const c = req.client!;
  res.json({ depositAddress: c.deposit_address, network: c.network, currency: "USDT" });
});

/** POST /api/v1/energy/order — order energy delegation, billed to your balance. */
apiV1.post("/energy/order", async (req: ClientRequest, res) => {
  try {
    const { duration, amount, receiveAddress } = validateOrderInput(
      req.body?.duration,
      req.body?.amount,
      req.body?.receiveAddress,
    );
    const result = await placeEnergyOrder({
      duration,
      amount,
      receiveAddress,
      client: req.client,
      source: "api",
    });
    res.status(201).json({
      id: result.id,
      status: result.status,
      duration,
      amount,
      receiveAddress,
      balance: result.balanceUsdt,
    });
  } catch (e) {
    fail(res, e);
  }
});

/** GET /api/v1/energy/orders — your energy orders. */
apiV1.get("/energy/orders", async (req: ClientRequest, res) => {
  try {
    const { rows } = await query(
      `SELECT id, ts, duration, amount::float8 AS amount, receive_address AS "receiveAddress", status
         FROM energy_orders WHERE client_id=$1 ORDER BY ts DESC LIMIT 500`,
      [req.client!.id],
    );
    res.json({ orders: rows, count: rows.length });
  } catch (e) {
    fail(res, e);
  }
});

/** GET /api/v1/energy/orders/:id — status of one of your orders. */
apiV1.get("/energy/orders/:id", async (req: ClientRequest, res) => {
  try {
    const { rows } = await query(
      `SELECT id, ts, duration, amount::float8 AS amount, receive_address AS "receiveAddress", status
         FROM energy_orders WHERE id=$1 AND client_id=$2`,
      [Number(req.params.id), req.client!.id],
    );
    if (!rows[0]) return res.status(404).json({ error: "Order not found" });
    res.json({ order: rows[0] });
  } catch (e) {
    fail(res, e);
  }
});

/** GET /api/v1/transactions — your billing history. */
apiV1.get("/transactions", async (req: ClientRequest, res) => {
  try {
    const { rows } = await query(
      `SELECT id, ts, type, amount_usdt::float8 AS amount, balance_after::float8 AS balance, ref, detail
         FROM client_transactions WHERE client_id=$1 ORDER BY ts DESC LIMIT 500`,
      [req.client!.id],
    );
    res.json({ transactions: rows, count: rows.length });
  } catch (e) {
    fail(res, e);
  }
});
