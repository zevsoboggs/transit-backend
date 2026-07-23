// Binance TRX/USDT rate — used to price partner energy orders (fixed at order time).
const BINANCE = process.env.BINANCE_ORIGIN || "https://api.binance.com";

export class RateError extends Error {
  status = 503;
}

let cache: { at: number; rate: number } | null = null;
const CACHE_MS = 15000;

export async function getTrxUsdtRate(): Promise<number> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rate;
  const res = await fetch(`${BINANCE}/api/v3/ticker/price?symbol=TRXUSDT`);
  if (!res.ok) throw new RateError(`Курс TRX/USDT недоступен (${res.status})`);
  const j = (await res.json()) as { price?: string };
  const rate = Number(j.price);
  if (!Number.isFinite(rate) || rate <= 0) throw new RateError("Некорректный курс TRX/USDT");
  cache = { at: Date.now(), rate };
  return rate;
}
