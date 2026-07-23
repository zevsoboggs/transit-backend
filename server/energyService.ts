import { query } from "./db.js";
import { nettsApi, extractOrderId, extractStatus, ENERGY_MIN, ENERGY_MAX } from "./netts.js";
import { computeCharge, debitClient, creditClient, type ClientRow } from "./billing.js";
import { logLedger } from "./ledger.js";

export class OrderError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const TRON_ADDR = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

export function validateOrderInput(duration: unknown, amountRaw: unknown, receiveAddress: unknown) {
  const dur = String(duration || "1h");
  const amount = Math.trunc(Number(amountRaw));
  const addr = String(receiveAddress || "").trim();
  if (dur !== "1h" && dur !== "5m") throw new OrderError("duration должен быть '1h' или '5m'");
  if (!Number.isFinite(amount) || amount < ENERGY_MIN || amount > ENERGY_MAX) {
    throw new OrderError(`Объём энергии должен быть от ${ENERGY_MIN} до ${ENERGY_MAX}`);
  }
  if (!TRON_ADDR.test(addr)) throw new OrderError("Некорректный TRON-адрес получателя");
  return { duration: dur as "1h" | "5m", amount, receiveAddress: addr };
}

export interface PlaceResult {
  id: string;
  providerOrderId: string | null;
  status: string;
  chargeUsdt: number | null;
  estCostTrx: number | null;
  balanceUsdt: number | null;
}

/**
 * Place an energy order. If `client` is given, the order is billed to that
 * client's balance (cost + markup); insufficient balance throws 402. Provider
 * failures refund the client. Used by both the admin panel and the client API.
 */
export async function placeEnergyOrder(params: {
  duration: "1h" | "5m";
  amount: number;
  receiveAddress: string;
  client?: ClientRow | null;
  admin?: { id: number; email: string } | null;
  source: "admin" | "api";
}): Promise<PlaceResult> {
  const { duration, amount, receiveAddress, client, admin, source } = params;

  const charge = await computeCharge(duration, amount);

  // Billing: reserve funds up-front when there is a client.
  let chargeUsdt: number | null = null;
  let balanceAfter: number | null = null;
  if (client) {
    if (charge.chargeUsdt == null) {
      throw new OrderError("Цена временно недоступна, попробуйте позже", 503);
    }
    chargeUsdt = charge.chargeUsdt;
    balanceAfter = await debitClient(client.id, chargeUsdt, {
      type: "charge",
      detail: `Энергия ${amount} (${duration}) → ${receiveAddress}`,
    });
  }

  let resp: unknown;
  try {
    resp = await nettsApi.order(duration, amount, receiveAddress);
  } catch (e) {
    // Refund on provider failure.
    if (client && chargeUsdt != null) {
      balanceAfter = await creditClient(client.id, chargeUsdt, {
        type: "refund",
        detail: "Возврат: заказ энергии не прошёл",
      });
    }
    await logLedger({
      type: "energy",
      status: "error",
      address: receiveAddress,
      network: "tron",
      amount,
      coinSymbol: "ENERGY",
      detail: `${duration}: ${e instanceof Error ? e.message : "order failed"}`,
      user: admin ?? null,
    });
    throw e;
  }

  const providerOrderId = extractOrderId(resp);
  const status = extractStatus(resp) || "submitted";

  const ins = await query<{ id: string }>(
    `INSERT INTO energy_orders
      (duration, amount, receive_address, provider_order_id, status, est_cost_trx, client_id, charge_usdt, price_trx, trx_rate, source, response, user_id, user_email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [
      duration,
      amount,
      receiveAddress,
      providerOrderId,
      status,
      charge.costTrx,
      client?.id ?? null,
      chargeUsdt,
      charge.priceTrx,
      charge.trxUsd,
      source,
      JSON.stringify(resp ?? null),
      admin?.id ?? null,
      admin?.email ?? null,
    ],
  );

  await logLedger({
    type: "energy",
    status: "success",
    address: receiveAddress,
    network: "tron",
    amount,
    coinSymbol: "ENERGY",
    detail:
      `${duration}` +
      (client ? ` · клиент #${client.id}` : "") +
      (chargeUsdt != null ? ` · $${chargeUsdt}` : ""),
    user: admin ?? null,
  });

  return {
    id: ins.rows[0]?.id,
    providerOrderId,
    status,
    chargeUsdt,
    estCostTrx: charge.costTrx,
    balanceUsdt: balanceAfter,
  };
}
