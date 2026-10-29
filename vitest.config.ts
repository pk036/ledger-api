import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./test/global-setup.ts",
    env: {
      DATABASE_URL: "postgres://ledger:ledger@localhost:5433/ledger_test",
    },
  },
});