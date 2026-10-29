import Fastify from "fastify";
import { z } from "zod";
import { pool } from "./db.js";

export function buildApp() {
  const app = Fastify({ logger: true });

  // Turn validation errors into clean 400 responses
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: "invalid request", details: err.issues });
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

  return app;
}