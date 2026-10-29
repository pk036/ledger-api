import Fastify from "fastify";
import { z } from "zod";
import { pool } from "./db.js";
import { transfer, LedgerError } from "./ledger.js";

export function buildApp() {
  const app = Fastify({ logger: true });

  // Turn validation errors into clean 400 responses
  //now handles ledger errors
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: "invalid request", details: err.issues });
    }
    if (err instanceof LedgerError) 
    {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    reply.send(err);
  });

  app.get("/health", async () => ({ ok: true }));

  const CreateAccount = z.object({
    name: z.string().min(1),
    currency: z.string().length(3).default("USD"),
  });

  app.post("/accounts", async (req, reply) => {
    const body = CreateAccount.parse(req.body);
    const { rows } = await pool.query(
      `INSERT INTO accounts (name, currency) VALUES ($1, $2)
       RETURNING id, name, currency, balance, created_at`,
      [body.name, body.currency]
    );
    return reply.code(201).send(rows[0]);
  });

  app.get("/accounts/:id", async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { rows } = await pool.query(
      `SELECT id, name, currency, balance, created_at FROM accounts WHERE id = $1`,
      [id]
    );
    if (!rows[0]) return reply.code(404).send({ error: "account not found" });
    return rows[0];
  });

    const Transfer = z.object({
    from_account_id: z.number().int().positive(),
    to_account_id: z.number().int().positive(),
    amount: z.number().int().positive(),
    description: z.string().max(200).optional(),
  });

  app.post("/transfers", async (req, reply) => {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length === 0) {
      return reply.code(400).send({ error: "Idempotency-Key header is required" });
    }
    const body = Transfer.parse(req.body);
    const result = await transfer({
      fromAccountId: body.from_account_id,
      toAccountId: body.to_account_id,
      amount: body.amount,
      description: body.description,
      idempotencyKey: key,
    });
    // 201 for a new transfer, 200 for a replayed one
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.get("/accounts/:id/entries", async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { rows } = await pool.query(
      `SELECT e.transaction_id, e.amount, t.description, t.created_at
       FROM entries e
       JOIN transactions t ON t.id = e.transaction_id
       WHERE e.account_id = $1
       ORDER BY e.id DESC
       LIMIT 50`,
      [id]
    );
    return rows;
  });

  return app;
}