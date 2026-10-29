# Ledger API

[![CI](https://github.com/pk036/ledger-api/actions/workflows/ci.yml/badge.svg)](https://github.com/pk036/ledger-api/actions/workflows/ci.yml)

**Live API:** https://ledger-api-0878.onrender.com (may take up to a minute to wake up)

A double-entry accounting ledger and payments API built with TypeScript, Fastify, and PostgreSQL. It models how real payment systems move money: every transaction balances to zero, retried requests never double-charge, and concurrent transfers can't overdraw an account.

## Features

- [x] Double-entry data model: transactions made of balanced debit and credit entries
- [x] Accounts API with input validation
- [x] Money stored as integer cents (no floating-point errors)
- [x] Database-level constraint preventing negative balances
- [x] Atomic transfers between accounts using database transactions
- [x] Idempotency keys so retried requests are processed exactly once
- [x] Row-level locking with consistent lock ordering to prevent race conditions and deadlocks
- [x] Reconciliation endpoint verifying cached balances match the entry history
- [x] Automated concurrency tests and CI with GitHub Actions
- [x] Live deployment on Render with a Neon PostgreSQL database

## Tech Stack

| Layer      | Technology                     |
| ---------- | ------------------------------ |
| Language   | TypeScript (Node.js)           |
| Framework  | Fastify                        |
| Database   | PostgreSQL                     |
| Validation | Zod                            |
| Testing    | Vitest                         |
| DevOps     | Docker Compose, GitHub Actions |
| Hosting    | Render (API), Neon (database)  |

## How It Works

### Double-entry accounting

Money is never created or destroyed. Every transaction consists of two or more entries whose amounts sum to zero. Moving $50 from Alice to Bob records:

| Account | Amount (cents) |
| ------- | -------------- |
| Alice   | −5000          |
| Bob     | +5000          |

Deposits and withdrawals move money to and from a special `external` account (ID 1), the only account allowed to carry a negative balance. This mirrors how production ledgers represent money entering and leaving the system.

### Data model

```
accounts      id, name, currency, balance (cached, cents), allow_negative
transactions  id, idempotency_key (unique), description
entries       id, transaction_id → transactions, account_id → accounts, amount
```

- **Entries are the source of truth.** The `balance` column is a cache for fast reads, and the reconciliation endpoint verifies it always equals the sum of the account's entries.
- **Defense in depth.** A `CHECK` constraint makes the database itself reject negative balances on normal accounts, even if application code has a bug.
- **Precision.** Amounts are stored as `BIGINT` cents and returned as strings, since JavaScript numbers lose precision on very large integers.

### Atomicity

Each transfer writes a transaction, two entries, and two balance updates inside a single database transaction. If any step fails, everything rolls back, so money can never be partially moved.

### Concurrency safety

Two simultaneous withdrawals could both read the same balance and overdraw an account. To prevent this, each transfer locks both account rows with `SELECT ... FOR UPDATE`, so concurrent transfers on the same account run one at a time. Accounts are always locked in ID order, which prevents deadlocks when two transfers involve the same pair of accounts in opposite directions.

### Idempotency

Every transfer requires an `Idempotency-Key` header. If a client retries a request after a timeout, the server returns the original result instead of moving money again. The key is claimed with `INSERT ... ON CONFLICT DO NOTHING` against a unique constraint, which also handles two identical requests arriving at the same moment: one proceeds, and the other waits and then replays the result. If a transfer fails (for example, insufficient funds), the key is released by the rollback, so the client can safely retry.

### Reconciliation

The `/reconcile` endpoint checks the two invariants a double-entry ledger must never break: all entries across the system sum to zero, and every account's cached balance equals the sum of its entries. Any mismatched accounts are reported with both values.

## Getting Started

### Prerequisites

- Node.js 20+
- Docker Desktop

### Run locally

```bash
git clone https://github.com/pk036/ledger-api.git
cd ledger-api
npm install
docker compose up -d   # starts Postgres on port 5433 and applies db/schema.sql
npm run dev            # starts the API on http://localhost:3000
```

To reset the database after changing the schema:

```bash
docker compose down -v && docker compose up -d
```

## API Reference

### API overview

```
GET /
```

Returns the API's name, description, source link, and available endpoints.

### Health check

```
GET /health
```

### Create an account

```
POST /accounts
Content-Type: application/json

{ "name": "Alice", "currency": "USD" }
```

Response `201 Created`:

```json
{
  "id": "2",
  "name": "Alice",
  "currency": "USD",
  "balance": "0",
  "created_at": "2026-10-29T18:00:00.000Z"
}
```

### Get an account

```
GET /accounts/:id
```

Returns `404` if the account does not exist.

### Transfer money

```
POST /transfers
Content-Type: application/json
Idempotency-Key: <unique key>

{ "from_account_id": 1, "to_account_id": 2, "amount": 10000, "description": "Initial deposit" }
```

Response `201 Created` for a new transfer, or `200 OK` when replaying a previously used key:

```json
{
  "id": "1",
  "description": "Initial deposit",
  "created_at": "2026-10-29T18:05:00.000Z",
  "entries": [
    { "account_id": "1", "amount": "-10000" },
    { "account_id": "2", "amount": "10000" }
  ],
  "replayed": false
}
```

| Status | Meaning                                              |
| ------ | ---------------------------------------------------- |
| `400`  | Invalid body, missing key, or same source and target |
| `404`  | Account not found                                    |
| `422`  | Insufficient funds or currency mismatch              |

### Account history

```
GET /accounts/:id/entries
```

Returns the account's 50 most recent entries, newest first.

### Reconcile the ledger

```
GET /reconcile
```

Verifies that all entries sum to zero and every cached balance equals the sum of its account's entries.

```json
{
  "balanced": true,
  "entries_sum": "0",
  "mismatched_accounts": []
}
```

## Testing

```bash
npm test
```

Integration tests run against a real PostgreSQL database (`ledger_test`), created and rebuilt from `db/schema.sql` automatically. The suite covers:

- Balanced double-entry postings and ledger invariants
- Overdraft, validation, and missing-key rejections
- Idempotent replay of retried requests, including identical simultaneous requests
- 20 simultaneous withdrawals against one account (no overdraft)
- Opposite-direction transfers between the same accounts (no deadlocks)
- Reconciliation, including detection of a deliberately corrupted balance

Tests and type checks run on every push via GitHub Actions.

## Deployment

The API is deployed on Render, which redeploys automatically on every push to `main`. The database is hosted on Neon, and its connection string is provided to Render through the `DATABASE_URL` environment variable rather than stored in the repository.

## Project Structure

```
ledger-api/
├── .github/
│   └── workflows/
│       └── ci.yml        # GitHub Actions: type check and tests on every push
├── db/
│   └── schema.sql        # tables, constraints, and seed data
├── src/
│   ├── app.ts            # Fastify app and routes
│   ├── db.ts             # Postgres connection pool
│   ├── index.ts          # server entry point
│   └── ledger.ts         # transfer logic: locking, idempotency, double entry
├── test/
│   ├── global-setup.ts   # creates and resets the test database
│   └── ledger.test.ts    # integration tests
├── docker-compose.yml
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## License

MIT