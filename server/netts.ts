// Client for the netts.io energy-delegation API.
// Auth: X-API-KEY + X-Real-IP (a whitelisted IP; netts trusts the header value).
const ORIGIN = process.env.NETTS_ORIGIN || "https://netts.io";
const BASE = `${ORIGIN}/apiv2`;
const KEY = process.env.NETTS_API_KEY || "";
const REAL_IP = process.env.NETTS_REAL_IP || ""; // whitelisted IP
export const DEPOSIT_ADDRESS =
  process.env.NETTS_DEPOSIT_ADDRESS || "TEWxUUUU9ngJ1PZf7JTsW1javtTiYKnSof";

export const ENERGY_MIN = 61000;
export const ENERGY_MAX = 3000000;

export class NettsError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Opts = { method?: string; body?: unknown; query?: Record<string, string | number | undefined> };

async function netts<T = unknown>(path: string, { method = "GET", body, query }: Opts = {}): Promise<T> {
  const url = new URL(`${BASE}${path.startsWith("/") ? path : `/${path}`}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = { "X-API-KEY": KEY, Accept: "application/json" };
  if (REAL_IP) headers["X-Real-IP"] = REAL_IP;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok || (data && typeof data === "object" && (data as Record<string, unknown>).success === false)) {
    const obj = (data ?? {}) as Record<string, unknown>;
    const msg =
      (typeof obj.error === "string" && obj.error) ||
      (typeof obj.message === "string" && obj.message) ||
      (typeof obj.detail === "string" && obj.detail) ||
      `Сервис энергии недоступен (${res.status})`;
    throw new NettsError(String(msg), res.ok ? 400 : res.status);
  }
  return data as T;
}

interface PricingPeriod {
  id: string;
  label: string;
  start: string;
  end: string;
  is_current: boolean;
  price: number; // sun per energy unit
}

interface PricingResponse {
  data?: {
    trx_rate_usd?: number;
    services?: Record<
      string,
      { unit?: string; current_period?: string; periods?: PricingPeriod[]; price?: number }
    >;
  };
}

// Current sun-per-energy price for a duration ("1h" | "5m"), or null if unknown.
function currentPrice(pricing: PricingResponse, duration: string): number | null {
  const svc = pricing.data?.services?.[`energy_${duration}`];
  if (!svc) return null;
  if (typeof svc.price === "number") return svc.price;
  const cur = svc.periods?.find((p) => p.is_current);
  return cur ? cur.price : svc.periods?.[0]?.price ?? null;
}

export const nettsApi = {
  pricing: () => netts<PricingResponse>("/pricing"),

  async priceSummary() {
    const p = await netts<PricingResponse>("/pricing");
    return {
      trxUsd: p.data?.trx_rate_usd ?? null,
      priceSun1h: currentPrice(p, "1h"),
      priceSun5m: currentPrice(p, "5m"),
    };
  },

  order: (duration: "1h" | "5m", amount: number, receiveAddress: string) =>
    netts(`/order${duration}`, { method: "POST", body: { amount, receiveAddress } }),

  orderCheck: (orderId: string) =>
    netts("/order_check", { query: { order_id: orderId, id: orderId } }),
};

// Extract a provider order id from a netts response of unknown exact shape.
export function extractOrderId(resp: unknown): string | null {
  const r = (resp ?? {}) as Record<string, unknown>;
  const d = (r.data ?? {}) as Record<string, unknown>;
  const cand =
    r.order_id ?? r.orderId ?? r.id ?? d.order_id ?? d.orderId ?? d.id ?? r.tx ?? d.tx;
  return cand != null ? String(cand) : null;
}

export function extractStatus(resp: unknown): string | null {
  const r = (resp ?? {}) as Record<string, unknown>;
  const d = (r.data ?? {}) as Record<string, unknown>;
  const s = r.status ?? d.status ?? r.state ?? d.state;
  return typeof s === "string" ? s : null;
}
