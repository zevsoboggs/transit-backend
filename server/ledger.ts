import { query } from "./db.js";

export interface LedgerEntry {
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
export async function logLedger(e: LedgerEntry): Promise<void> {
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
