import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EXTERNAL_ID, MongoLedger } from "../src/mongo/ledger.js";

const uri =
  process.env.MONGODB_URI ?? "mongodb://localhost:27017/?replicaSet=rs0&directConnection=true";
const client = new MongoClient(uri);
const db = client.db("ledger_test");
const ledger = new MongoLedger(client, db);

function transfer(from: string, to: string, amount: number, key: string = randomUUID()) {
  return ledger.transfer({ fromAccountId: from, toAccountId: to, amount, idempotencyKey: key });
}

async function balanceOf(id: string) {
  return (await ledger.getAccount(id))!.balance;
}

beforeAll(async () => {
  await client.connect();
});

beforeEach(async () => {
  await db.dropDatabase();
  await ledger.setup();
});

afterAll(async () => {
  await client.close();
});

describe("mongo transfers", () => {
  it("records balanced embedded entries", async () => {
    const alice = await ledger.createAccount("Alice");
    const tx = await transfer(EXTERNAL_ID, alice._id, 10000);

    expect(tx.entries.reduce((sum, e) => sum + e.amount, 0)).toBe(0);
    expect(await balanceOf(alice._id)).toBe(10000);
    expect((await ledger.reconcile()).balanced).toBe(true);
  });

  it("rejects overdrafts and leaves balances unchanged", async () => {
    const alice = await ledger.createAccount("Alice");
    const bob = await ledger.createAccount("Bob");
    await transfer(EXTERNAL_ID, alice._id, 5000);

    await expect(transfer(alice._id, bob._id, 5001)).rejects.toMatchObject({ statusCode: 422 });
    expect(await balanceOf(alice._id)).toBe(5000);
    expect(await balanceOf(bob._id)).toBe(0);
  });

  it("rejects invalid amounts and same-account transfers", async () => {
    const alice = await ledger.createAccount("Alice");
    await expect(transfer(EXTERNAL_ID, alice._id, -100)).rejects.toMatchObject({ statusCode: 400 });
    await expect(transfer(EXTERNAL_ID, alice._id, 10.5)).rejects.toMatchObject({ statusCode: 400 });
    await expect(transfer(alice._id, alice._id, 100)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("mongo idempotency", () => {
  it("replays a retried request instead of charging twice", async () => {
    const alice = await ledger.createAccount("Alice");
    const first = await transfer(EXTERNAL_ID, alice._id, 10000, "retry-key");
    const second = await transfer(EXTERNAL_ID, alice._id, 10000, "retry-key");

    expect(second.replayed).toBe(true);
    expect(second._id).toBe(first._id);
    expect(await balanceOf(alice._id)).toBe(10000);
  });

  it("processes identical simultaneous requests exactly once", { timeout: 60_000 }, async () => {
    const alice = await ledger.createAccount("Alice");
    const results = await Promise.all(
      Array.from({ length: 10 }, () => transfer(EXTERNAL_ID, alice._id, 10000, "same-key"))
    );

    expect(new Set(results.map((r) => r._id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await balanceOf(alice._id)).toBe(10000);
  });
});

describe("mongo concurrency", () => {
  it("never overdraws under simultaneous withdrawals", { timeout: 60_000 }, async () => {
    const alice = await ledger.createAccount("Alice");
    const bob = await ledger.createAccount("Bob");
    await transfer(EXTERNAL_ID, alice._id, 7500);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => transfer(alice._id, bob._id, 1000))
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(7);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(13);
    expect(rejected.every((r) => r.reason.statusCode === 422)).toBe(true);
    expect(await balanceOf(alice._id)).toBe(500);
    expect((await ledger.reconcile()).balanced).toBe(true);
  });

  it("handles 40 simultaneous opposite-direction transfers", { timeout: 60_000 }, async () => {
    const alice = await ledger.createAccount("Alice");
    const bob = await ledger.createAccount("Bob");
    await transfer(EXTERNAL_ID, alice._id, 5000);
    await transfer(EXTERNAL_ID, bob._id, 5000);

    const results = await Promise.allSettled([
      ...Array.from({ length: 20 }, () => transfer(alice._id, bob._id, 100)),
      ...Array.from({ length: 20 }, () => transfer(bob._id, alice._id, 100)),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await balanceOf(alice._id)).toBe(5000);
    expect(await balanceOf(bob._id)).toBe(5000);
    expect((await ledger.reconcile()).balanced).toBe(true);
  });
});

describe("mongo reconciliation", () => {
  it("detects a corrupted cached balance", async () => {
    const alice = await ledger.createAccount("Alice");
    await transfer(EXTERNAL_ID, alice._id, 5000);
    await db.collection("accounts").updateOne({ _id: alice._id as any }, { $set: { balance: 9999 } });

    const result = await ledger.reconcile();
    expect(result.balanced).toBe(false);
    expect(result.mismatchedAccounts).toEqual([
      { id: alice._id, cachedBalance: 9999, computedBalance: 5000 },
    ]);
  });
});