import type { PoolClient } from "pg";
import { pool } from "./db.js";

export class LedgerError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export interface TransferInput {
  fromAccountId: number;
  toAccountId: number;
  amount: number; // in cents, always positive
  description?: string;
  idempotencyKey: string;
}

async function loadTransaction(client: PoolClient, id: string) {
  const { rows: [tx] } = await client.query(
    `SELECT id, description, created_at FROM transactions WHERE id = $1`,
    [id]
  );
  const { rows: entries } = await client.query(
    `SELECT account_id, amount FROM entries WHERE transaction_id = $1 ORDER BY id`,
    [id]
  );
  return { ...tx, entries };
}

export async function transfer(input: TransferInput) {
  const { fromAccountId, toAccountId, amount, description, idempotencyKey } = input;

  if (fromAccountId === toAccountId) {
    throw new LedgerError(400, "cannot transfer to the same account");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Claim the idempotency key. If another request already used it,
    //    nothing is inserted. If that request is still in progress,
    //    Postgres makes this one wait until it finishes.
    const { rows: [claimed] } = await client.query(
      `INSERT INTO transactions (idempotency_key, description)
       VALUES ($1, $2)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [idempotencyKey, description ?? null]
    );

    if (!claimed) {
      // This key was already processed: return the original result.
      const { rows: [existing] } = await client.query(
        `SELECT id FROM transactions WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      const result = await loadTransaction(client, existing.id);
      await client.query("COMMIT");
      return { ...result, replayed: true };
    }

    // 2. Lock both accounts, always in ID order to prevent deadlocks.
    const { rows: accounts } = await client.query(
      `SELECT id, currency, balance, allow_negative FROM accounts
       WHERE id = ANY($1::bigint[])
       ORDER BY id
       FOR UPDATE`,
      [[fromAccountId, toAccountId]]
    );
    const from = accounts.find((a) => Number(a.id) === fromAccountId);
    const to = accounts.find((a) => Number(a.id) === toAccountId);

    if (!from || !to) throw new LedgerError(404, "account not found");
    if (from.currency !== to.currency) throw new LedgerError(422, "currency mismatch");

    // 3. Check funds. Only the external account may go negative.
    if (!from.allow_negative && BigInt(from.balance) < BigInt(amount)) {
      throw new LedgerError(422, "insufficient funds");
    }

    // 4. Write balanced entries (they sum to zero) and update cached balances.
    await client.query(
      `INSERT INTO entries (transaction_id, account_id, amount)
       VALUES ($1, $2, $3), ($1, $4, $5)`,
      [claimed.id, fromAccountId, -amount, toAccountId, amount]
    );
    await client.query(
      `UPDATE accounts SET balance = balance - $2 WHERE id = $1`,
      [fromAccountId, amount]
    );
    await client.query(
      `UPDATE accounts SET balance = balance + $2 WHERE id = $1`,
      [toAccountId, amount]
    );

    const result = await loadTransaction(client, claimed.id);
    await client.query("COMMIT");
    return { ...result, replayed: false };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release(); // always return the connection to the pool
  }
}