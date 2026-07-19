// Server-side client for the upstream transit-api. The API key lives here only.
const ORIGIN = process.env.TRANSIT_API_ORIGIN || "http://lnpapp.rest";
const BASE = `${ORIGIN}/api/transit-api`;
const KEY = process.env.TRANSIT_API_KEY || "";

export class UpstreamError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Opts = {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
};

export async function upstream<T = unknown>(
  path: string,
  { method = "GET", body, query }: Opts = {},
): Promise<T> {
  const url = new URL(`${BASE}${path.startsWith("/") ? path : `/${path}`}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    method,
    headers: {
      "x-api-key": KEY,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg =
      (data && typeof data === "object" && "error" in data
        ? String((data as Record<string, unknown>).error)
        : undefined) || `Upstream error ${res.status}`;
    throw new UpstreamError(msg, res.status);
  }
  return data as T;
}

export interface UpstreamNetwork {
  network: string;
  blockchain: string;
  label: string;
  usdtNet: string | null;
  native: string;
  coins: { id: number; symbol: string }[];
}

export interface UpstreamWallet {
  id: string;
  project: string | null;
  label: string | null;
  network: string;
  networkLabel: string;
  usdtNet: string | null;
  native: string;
  walletId: number;
  address: string;
  balances: unknown[];
  createdAt: string;
}

let networksCache: { at: number; data: UpstreamNetwork[] } | null = null;

export async function cachedNetworks(): Promise<UpstreamNetwork[]> {
  if (networksCache && Date.now() - networksCache.at < 5 * 60_000) {
    return networksCache.data;
  }
  const data = await upstream<{ networks: UpstreamNetwork[] }>("/networks").then((r) => r.networks);
  networksCache = { at: Date.now(), data };
  return data;
}

export async function resolveCoinSymbol(
  network: string,
  coinId?: number | null,
): Promise<string | null> {
  if (coinId == null) return null;
  try {
    const nets = await cachedNetworks();
    const net = nets.find((n) => n.network === network);
    return net?.coins.find((c) => c.id === coinId)?.symbol ?? null;
  } catch {
    return null;
  }
}

export const transitApi = {
  networks: () => upstream<{ networks: UpstreamNetwork[] }>("/networks").then((r) => r.networks),
  master: () => upstream("/master"),
  createWallet: (input: { network: string; label?: string; project?: string }) =>
    upstream<{ wallet?: UpstreamWallet } | UpstreamWallet>("/wallets", {
      method: "POST",
      body: input,
    }),
  getWallet: (id: string) =>
    upstream<{ wallet: UpstreamWallet }>(`/wallets/${id}`).then((r) => r.wallet),
  getBalance: (id: string) => upstream(`/wallets/${id}/balance`),
  topup: (id: string, body: unknown) => upstream(`/wallets/${id}/topup`, { method: "POST", body }),
  transfer: (id: string, body: unknown) =>
    upstream(`/wallets/${id}/transfer`, { method: "POST", body }),
  rename: (id: string, label: string) =>
    upstream(`/wallets/${id}/rename`, { method: "POST", body: { label } }),
};
