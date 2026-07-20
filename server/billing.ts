import crypto from "node:crypto";
import type pg from "pg";
import { query, withTx } from "./db.js";
import { nettsApi } from "./netts.js";
import { transitApi, type UpstreamWallet } from "./transit.js";

export const MARKUP_PERCENT = Number(process.env.ENERGY_MARKUP_PERCENT || 30);
export const MIN_DEPOSIT_USDT = Number(process.env.MIN_DEPOSIT_USDT || 500);
const CLIENT_PROJECT = process.env.CLIENT_PROJECT || "billing";

export interface ClientRow {
  id: number;
  name: string;
  note: string | null;
  api_key: string;
  deposit_wallet_id: string | null;
  deposit_address: string | null;
  network: string;
  balance_usdt: string;
  deposited_total_usdt: string;
  status: string;
  created_at: string;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function newApiKey(): string {
  return `tzr_${crypto.randomBytes(24).toString("hex")}`;
}

// Public (client-safe) client view — no internal columns leaked.
export function clientPublic(c: ClientRow) {
  return {
    id: c.id,
    name: c.name,
    depositAddress: c.deposit_address,
    network: c.network,
    balanceUsdt: Number(c.balance_usdt),
    status: c.status,
  };
}

export function clientAdmin(c: ClientRow) {
  return {
    id: c.id,
    name: c.name,
    note: c.note,
    apiKey: c.api_key,
    depositWalletId: c.deposit_wallet_id,
    depositAddress: c.deposit_address,
    network: c.network,
    balanceUsdt: Number(c.balance_usdt),
    depositedTotalUsdt: Number(c.deposited_total_usdt),
    status: c.status,
    createdAt: c.created_at,
  };
}

export interface Charge {
  priceSun: number | null;
  costTrx: number | null;
  costUsdt: number | null;
  chargeUsdt: number | null; // what the client pays
  trxUsd: number | null;
  markupPercent: number;
}

// Cost (provider) vs charge (what we bill the client, cost + markup).
export async function computeCharge(duration: "1h" | "5m", amount: number): Promise<Charge> {
  const s = await nettsApi.priceSummary();
  const priceSun = duration === "1h" ? s.priceSun1h : s.priceSun5m;
  const costTrx = priceSun != null ? (amount * priceSun) / 1_000_000 : null;
  const costUsdt = costTrx != null && s.trxUsd != null ? costTrx * s.trxUsd : null;
  const chargeUsdt = costUsdt != null ? round2(costUsdt * (1 + MARKUP_PERCENT / 100)) : null;
  return {
    priceSun,
    costTrx,
    costUsdt,
    chargeUsdt,
    trxUsd: s.trxUsd,
    markupPercent: MARKUP_PERCENT,
  };
}

export async function getClientById(id: number): Promise<ClientRow | null> {
  const { rows } = await query<ClientRow>("SELECT * FROM clients WHERE id=$1", [id]);
  return rows[0] || null;
}

export async function getClientByKey(key: string): Promise<ClientRow | null> {
  const { rows } = await query<ClientRow>("SELECT * FROM clients WHERE api_key=$1", [key]);
  return rows[0] || null;
}

// Create a client and auto-issue a transit deposit wallet for them.
export async function createClient(input: {
  name: string;
  note?: string;
  adminId?: number | null;
}): Promise<ClientRow> {
  const created = await transitApi.createWallet({
    network: "tron",
    label: `client:${input.name}`,
    project: CLIENT_PROJECT,
  });
  const w = ((created as { wallet?: UpstreamWallet }).wallet ?? created) as UpstreamWallet;

  const { rows } = await query<ClientRow>(
    `INSERT INTO clients (name, note, api_key, deposit_wallet_id, deposit_address, network, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      input.name,
      input.note ?? null,
      newApiKey(),
      w.id,
      w.address,
      w.network || "tron",
      input.adminId ?? null,
    ],
  );
  return rows[0];
}

async function insertTx(
  c: pg.PoolClient,
  entry: {
    clientId: number;
    type: "deposit" | "charge" | "refund" | "adjust";
    amount: number;
    balanceAfter: number;
    ref?: string | null;
    detail?: string | null;
    admin?: { id: number; email: string } | null;
  },
) {
  await c.query(
    `INSERT INTO client_transactions (client_id, type, amount_usdt, balance_after, ref, detail, admin_id, admin_email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      entry.clientId,
      entry.type,
      entry.amount,
      entry.balanceAfter,
      entry.ref ?? null,
      entry.detail ?? null,
      entry.admin?.id ?? null,
      entry.admin?.email ?? null,
    ],
  );
}

// Deduct `amount` from a client's balance atomically. Throws if insufficient.
export async function debitClient(
  clientId: number,
  amount: number,
  meta: { type: "charge"; ref?: string; detail?: string; admin?: { id: number; email: string } | null },
): Promise<number> {
  return withTx(async (c) => {
    const { rows } = await c.query<{ balance_usdt: string }>(
      "SELECT balance_usdt FROM clients WHERE id=$1 FOR UPDATE",
      [clientId],
    );
    if (!rows[0]) throw new Error("Клиент не найден");
    const balance = Number(rows[0].balance_usdt);
    if (balance < amount) {
      const err = new Error("Недостаточно средств на балансе клиента") as Error & { status?: number };
      err.status = 402;
      throw err;
    }
    const after = round2(balance - amount);
    await c.query("UPDATE clients SET balance_usdt=$1 WHERE id=$2", [after, clientId]);
    await insertTx(c, {
      clientId,
      type: "charge",
      amount: -amount,
      balanceAfter: after,
      ref: meta.ref,
      detail: meta.detail,
      admin: meta.admin,
    });
    return after;
  });
}

// Credit a client's balance (deposit / refund / manual adjust).
export async function creditClient(
  clientId: number,
  amount: number,
  meta: {
    type: "deposit" | "refund" | "adjust";
    ref?: string;
    detail?: string;
    admin?: { id: number; email: string } | null;
  },
): Promise<number> {
  return withTx(async (c) => {
    const { rows } = await c.query<{ balance_usdt: string }>(
      "SELECT balance_usdt FROM clients WHERE id=$1 FOR UPDATE",
      [clientId],
    );
    if (!rows[0]) throw new Error("Клиент не найден");
    const after = round2(Number(rows[0].balance_usdt) + amount);
    await c.query("UPDATE clients SET balance_usdt=$1 WHERE id=$2", [after, clientId]);
    await insertTx(c, {
      clientId,
      type: meta.type,
      amount,
      balanceAfter: after,
      ref: meta.ref,
      detail: meta.detail,
      admin: meta.admin,
    });
    return after;
  });
}

// Read the deposit wallet's live USDT balance and credit any un-credited delta.
export interface SyncResult {
  credited: number;
  balanceUsdt: number;
  onchainTotal: number;
  pending: number; // received but not yet credited (below the minimum)
  minDeposit: number;
  belowMin: boolean;
}

export async function syncDeposit(
  client: ClientRow,
  admin?: { id: number; email: string } | null,
): Promise<SyncResult> {
  if (!client.deposit_wallet_id) throw new Error("У клиента нет депозитного кошелька");
  const bal = (await transitApi.getBalance(client.deposit_wallet_id)) as {
    balances?: { isUsdt?: boolean; amount?: number }[];
  };
  const usdt = (bal.balances || []).find((b) => b.isUsdt);
  const onchainTotal = round2(Number(usdt?.amount || 0));
  const alreadyCredited = Number(client.deposited_total_usdt);
  const delta = round2(onchainTotal - alreadyCredited);

  // Nothing new, or the un-credited amount hasn't reached the minimum deposit yet.
  if (delta <= 0 || delta < MIN_DEPOSIT_USDT) {
    return {
      credited: 0,
      balanceUsdt: Number(client.balance_usdt),
      onchainTotal,
      pending: Math.max(0, delta),
      minDeposit: MIN_DEPOSIT_USDT,
      belowMin: delta > 0,
    };
  }

  const newBalance = await withTx(async (c) => {
    const { rows } = await c.query<{ balance_usdt: string }>(
      "SELECT balance_usdt FROM clients WHERE id=$1 FOR UPDATE",
      [client.id],
    );
    const after = round2(Number(rows[0].balance_usdt) + delta);
    await c.query("UPDATE clients SET balance_usdt=$1, deposited_total_usdt=$2 WHERE id=$3", [
      after,
      onchainTotal,
      client.id,
    ]);
    await insertTx(c, {
      clientId: client.id,
      type: "deposit",
      amount: delta,
      balanceAfter: after,
      ref: client.deposit_address,
      detail: "Зачисление депозита (USDT)",
      admin,
    });
    return after;
  });

  return {
    credited: delta,
    balanceUsdt: newBalance,
    onchainTotal,
    pending: 0,
    minDeposit: MIN_DEPOSIT_USDT,
    belowMin: false,
  };
}
