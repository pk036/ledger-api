import { randomUUID } from "node:crypto";
import { MongoClient, MongoServerError, type Collection, type Db } from "mongodb";
import { LedgerError } from "../errors.js";

export interface AccountDoc {
  _id: string;
  name: string;
  currency: string;
  balance: number; // cached, in cents
  allowNegative: boolean;
  createdAt: Date;
}

export interface Entry {
  accountId: string;
  amount: number; // + money in, − money out
}

// Entries are embedded in the transaction document: they are always
// written and read together, so they belong in one document.
export interface TransactionDoc {
  _id: string;
  idempotencyKey: string;
  description: string | null;
  entries: Entry[];
  createdAt: Date;
}

export const EXTERNAL_ID = "external";

export class MongoLedger {
  private accounts: Collection<AccountDoc>;
  private transactions: Collection<TransactionDoc>;

  constructor(private client: MongoClient, db: Db) {
    this.accounts = db.collection<AccountDoc>("accounts");
    this.transactions = db.collection<TransactionDoc>("transactions");
  }

  async setup() {
    // A unique index is what makes idempotency keys safe under concurrency
    await this.transactions.createIndex({ idempotencyKey: 1 }, { unique: true });
    await this.transactions.createIndex({ "entries.accountId": 1, createdAt: -1 });
    await this.accounts.updateOne(
      { _id: EXTERNAL_ID },
      {
        $setOnInsert: {
          name: "external",
          currency: "USD",
          balance: 0,
          allowNegative: true,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );
  }

  async createAccount(name: string, currency = "USD") {
    const doc: AccountDoc = {
      _id: randomUUID(),
      name,
      currency,
      balance: 0,
      allowNegative: false,
      createdAt: new Date(),
    };
    await this.accounts.insertOne(doc);
    return doc;
  }

  getAccount(id: string) {
    return this.accounts.findOne({ _id: id });
  }

  async transfer(input: {
    fromAccountId: string;
    toAccountId: string;
    amount: number;
    description?: string;
    idempotencyKey: string;
  }) {
    const { fromAccountId, toAccountId, amount, description, idempotencyKey } = input;

    if (fromAccountId === toAccountId) {
      throw new LedgerError(400, "cannot transfer to the same account");
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new LedgerError(400, "amount must be a positive integer number of cents");
    }

    const session = this.client.startSession();
    try {
      let created: TransactionDoc | undefined;

      // withTransaction automatically retries when MongoDB reports a write
      // conflict, which is how concurrent transfers on one account are resolved.
      await session.withTransaction(async () => {
        const doc: TransactionDoc = {
          _id: randomUUID(),
          idempotencyKey,
          description: description ?? null,
          entries: [
            { accountId: fromAccountId, amount: -amount },
            { accountId: toAccountId, amount },
          ],
          createdAt: new Date(),
        };

        // 1. Claim the idempotency key (unique index rejects duplicates)
        await this.transactions.insertOne(doc, { session });

        // 2. Validate both accounts
        const from = await this.accounts.findOne({ _id: fromAccountId }, { session });
        const to = await this.accounts.findOne({ _id: toAccountId }, { session });
        if (!from || !to) throw new LedgerError(404, "account not found");
        if (from.currency !== to.currency) throw new LedgerError(422, "currency mismatch");

        // 3. Conditional debit: only matches if funds are sufficient
        //    (or the account is allowed to go negative)
        const debit = await this.accounts.updateOne(
          {
            _id: fromAccountId,
            $or: [{ allowNegative: true }, { balance: { $gte: amount } }],
          },
          { $inc: { balance: -amount } },
          { session }
        );
        if (debit.matchedCount === 0) throw new LedgerError(422, "insufficient funds");

        // 4. Credit the receiver
        await this.accounts.updateOne(
          { _id: toAccountId },
          { $inc: { balance: amount } },
          { session }
        );

        created = doc;
      });

      return { ...created!, replayed: false };
    } catch (err) {
      // 11000 = duplicate key: this idempotency key was already processed
      if (err instanceof MongoServerError && err.code === 11000) {
        const existing = await this.transactions.findOne({ idempotencyKey });
        if (existing) return { ...existing, replayed: true };
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async reconcile() {
    const [total] = await this.transactions
      .aggregate<{ sum: number }>([
        { $unwind: "$entries" },
        { $group: { _id: null, sum: { $sum: "$entries.amount" } } },
      ])
      .toArray();

    const perAccount = await this.transactions
      .aggregate<{ _id: string; sum: number }>([
        { $unwind: "$entries" },
        { $group: { _id: "$entries.accountId", sum: { $sum: "$entries.amount" } } },
      ])
      .toArray();

    const computed = new Map(perAccount.map((a) => [a._id, a.sum]));
    const accounts = await this.accounts.find().toArray();

    const mismatchedAccounts = accounts
      .filter((a) => a.balance !== (computed.get(a._id) ?? 0))
      .map((a) => ({
        id: a._id,
        cachedBalance: a.balance,
        computedBalance: computed.get(a._id) ?? 0,
      }));

    const entriesSum = total?.sum ?? 0;
    return {
      balanced: entriesSum === 0 && mismatchedAccounts.length === 0,
      entriesSum,
      mismatchedAccounts,
    };
  }
}