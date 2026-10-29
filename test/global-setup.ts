//runs once before all tests: creates ledger_test if it doesn't exist, then rebuilds from schema so every test run starts clean
import { readFile } from "node:fs/promises";
import pg from "pg";

const BASE = "postgres://ledger:ledger@localhost:5433";

export default async function setup() {
  // Create the test database if it doesn't exist yet
  const admin = new pg.Client({ connectionString: `${BASE}/ledger` });
  await admin.connect();
  const { rowCount } = await admin.query(
    `SELECT 1 FROM pg_database WHERE datname = 'ledger_test'`
  );
  if (rowCount === 0) await admin.query(`CREATE DATABASE ledger_test`);
  await admin.end();

  // Rebuild the schema from scratch
  const test = new pg.Client({ connectionString: `${BASE}/ledger_test` });
  await test.connect();
  const schema = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
  await test.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await test.query(schema);
  await test.end();
}