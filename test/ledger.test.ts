import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db.js";

const app = buildApp();
const EXTERNAL = 1;

// ---------- helpers ----------

async function resetDb() {
  await pool.query(`TRUNCATE entries, transactions, accounts RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO accounts (name, allow_negative) VALUES ('external', true)`);
}

async function createAccount(name: string): Promise<number> {
  const res = await app.inject({ method: "POST", url: "/accounts", payload: { name } });
  return Number(res.json().id);
}

function transfer(from: number, to: number, amount: number, key: string = randomUUID()) {
  return app.inject({
    method: "POST",
    url: "/transfers",
    headers: { "idempotency-key": key },
    payload: { from_account_id: from, to_account_id: to, amount },
  });
}

async function balanceOf(id: number): Promise<string> {
  const res = await app.inject({ method: "GET", url: `/accounts/${id}` });
  return res.json().balance;
}

// The two invariants a double-entry ledger must never break
async function expectLedgerConsistent() {
  // 1. All entries across the whole system sum to zero
  const { rows: [total] } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::text AS sum FROM entries`
  );
  expect(total.sum).toBe("0");

  // 2. Every cached balance equals the sum of that account's entries
  const { rows: mismatched } = await pool.query(`
    SELECT a.id FROM accounts a
    LEFT JOIN entries e ON e.account_id = a.id
    GROUP BY a.id, a.balance
    HAVING a.balance <> COALESCE(SUM(e.amount), 0)
  `);
  expect(mismatched).toEqual([]);
}

beforeEach(resetDb);

afterAll(async () => {
  await app.close();
  await pool.end();
});

// ---------- tests ----------

describe("accounts", () => {
  it("creates an account with a zero balance", async () => {
    const res = await app.inject({ method: "POST", url: "/accounts", payload: { name: "Alice" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: "Alice", currency: "USD", balance: "0" });
  });

  it("returns 404 for a missing account", async () => {
    const res = await app.inject({ method: "GET", url: "/accounts/999" });
    expect(res.statusCode).toBe(404);
  });

  it("rejects invalid input", async () => {
    const res = await app.inject({ method: "POST", url: "/accounts", payload: { name: "" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("transfers", () => {
  it("records balanced entries that sum to zero", async () => {
    const alice = await createAccount("Alice");
    const res = await transfer(EXTERNAL, alice, 10000);

    expect(res.statusCode).toBe(201);
    const amounts = res.json().entries.map((e: { amount: string }) => BigInt(e.amount));
    expect(amounts.reduce((a: bigint, b: bigint) => a + b, 0n)).toBe(0n);
    expect(await balanceOf(alice)).toBe("10000");
    await expectLedgerConsistent();
  });

  it("rejects overdrafts and leaves balances unchanged", async () => {
    const alice = await createAccount("Alice");
    const bob = await createAccount("Bob");
    await transfer(EXTERNAL, alice, 5000);

    const res = await transfer(alice, bob, 5001);
    expect(res.statusCode).toBe(422);
    expect(await balanceOf(alice)).toBe("5000");
    expect(await balanceOf(bob)).toBe("0");
  });

  it("rejects transfers to the same account", async () => {
    const alice = await createAccount("Alice");
    const res = await transfer(alice, alice, 100);
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-positive and fractional amounts", async () => {
    const alice = await createAccount("Alice");
    expect((await transfer(EXTERNAL, alice, -100)).statusCode).toBe(400);
    expect((await transfer(EXTERNAL, alice, 0)).statusCode).toBe(400);
    expect((await transfer(EXTERNAL, alice, 10.5)).statusCode).toBe(400);
  });

  it("requires an Idempotency-Key header", async () => {
    const alice = await createAccount("Alice");
    const res = await app.inject({
      method: "POST",
      url: "/transfers",
      payload: { from_account_id: EXTERNAL, to_account_id: alice, amount: 100 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("idempotency", () => {
  it("replays a retried request instead of charging twice", async () => {
    const alice = await createAccount("Alice");

    const first = await transfer(EXTERNAL, alice, 10000, "retry-key");
    const second = await transfer(EXTERNAL, alice, 10000, "retry-key");

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(true);
    expect(second.json().id).toBe(first.json().id);
    expect(await balanceOf(alice)).toBe("10000");
  });

  it("processes identical simultaneous requests exactly once", async () => {
    const alice = await createAccount("Alice");

    const results = await Promise.all(
      Array.from({ length: 10 }, () => transfer(EXTERNAL, alice, 10000, "same-key"))
    );

    const ids = new Set(results.map((r) => r.json().id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(await balanceOf(alice)).toBe("10000");
    await expectLedgerConsistent();
  });
});

describe("concurrency", () => {
  it("never overdraws under simultaneous withdrawals", async () => {
    const alice = await createAccount("Alice");
    const bob = await createAccount("Bob");
    await transfer(EXTERNAL, alice, 7500);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => transfer(alice, bob, 1000))
    );

    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(7);
    expect(results.filter((r) => r.statusCode === 422)).toHaveLength(13);
    expect(await balanceOf(alice)).toBe("500");
    expect(await balanceOf(bob)).toBe("7000");
    await expectLedgerConsistent();
  });

  it("avoids deadlocks on transfers in opposite directions", async () => {
    const alice = await createAccount("Alice");
    const bob = await createAccount("Bob");
    await transfer(EXTERNAL, alice, 5000);
    await transfer(EXTERNAL, bob, 5000);

    const results = await Promise.all([
      ...Array.from({ length: 20 }, () => transfer(alice, bob, 100)),
      ...Array.from({ length: 20 }, () => transfer(bob, alice, 100)),
    ]);

    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    expect(await balanceOf(alice)).toBe("5000");
    expect(await balanceOf(bob)).toBe("5000");
    await expectLedgerConsistent();
  });
});