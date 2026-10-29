# Ledger API

A double-entry accounting ledger and payments API built with TypeScript, Fastify, and PostgreSQL. It models how real payment systems move money: every transaction balances to zero, retried requests never double-charge, and concurrent transfers can't overdraw an account.

## Features

- [x] Double-entry data model: transactions made of balanced debit and credit entries
- [x] Accounts API with input validation
- [x] Money stored as integer cents (no floating-point errors)
- [x] Database-level constraint preventing negative balances
- [x] Atomic transfers between accounts using database transactions
- [x] Idempotency keys so retried requests are processed exactly once
- [x] Row-level locking with consistent lock ordering to prevent race conditions and deadlocks
- [ ] Reconciliation endpoint verifying cached balances match the entry history
- [ ] Automated concurrency tests and CI with GitHub Actions
- [ ] Live deployment

## Tech Stack

| Layer      | Technology                     |
| ---------- | ------------------------------ |
| Language   | TypeScript (Node.js)           |
| Framework  | Fastify                        |
| Database   | PostgreSQL 16                  |
| Validation | Zod                            |
| Testing    | Vitest                         |
| DevOps     | Docker Compose, GitHub Actions |

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

- **Entries are the source of truth.** The `balance` column is a cache for fast reads, and a reconciliation check verifies it always equals the sum of the account's entries.
- **Defense in depth.** A `CHECK` constraint makes the database itself reject negative balances on normal accounts, even if application code has a bug.
- **Precision.** Amounts are stored as `BIGINT` cents and returned as strings, since JavaScript numbers lose precision on very large integers.

### Atomicity

Each transfer writes a transaction, two entries, and two balance updates inside a single database transaction. If any step fails, everything rolls back, so money can never be partially moved.

### Concurrency safety

Two simultaneous withdrawals could both read the same balance and overdraw an account. To prevent this, each transfer locks both account rows with `SELECT ... FOR UPDATE`, so concurrent transfers on the same account run one at a time. Accounts are always locked in ID order, which prevents deadlocks when two transfers involve the same pair of accounts in opposite directions.

### Idempotency

Every transfer requires an `Idempotency-Key` header. If a client retries a request after a timeout, the server returns the original result instead of moving money again. The key is claimed with `INSERT ... ON CONFLICT DO NOTHING` against a unique constraint, which also handles two identical requests arriving at the same moment: one proceeds, and the other waits and then replays the result. If a transfer fails (for example, insufficient funds), the key is released by the rollback, so the client can safely retry.

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
| ------