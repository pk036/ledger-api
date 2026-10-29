CREATE TABLE accounts (
  id             BIGSERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  currency       CHAR(3) NOT NULL DEFAULT 'USD',
  balance        BIGINT NOT NULL DEFAULT 0,          -- in cents
  allow_negative BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (allow_negative OR balance >= 0)              -- database-level safety net
);

CREATE TABLE transactions (
  id              BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE entries (
  id             BIGSERIAL PRIMARY KEY,
  transaction_id BIGINT NOT NULL REFERENCES transactions(id),
  account_id     BIGINT NOT NULL REFERENCES accounts(id),
  amount         BIGINT NOT NULL CHECK (amount <> 0)  -- + money in, − money out
);

CREATE INDEX entries_account_idx ON entries(account_id);

-- The external account: where deposits come from and withdrawals go to
INSERT INTO accounts (name, allow_negative) VALUES ('external', true);