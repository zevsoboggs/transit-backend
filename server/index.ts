import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { initDb } from "./db.js";
import { router } from "./routes.js";
import { apiV1 } from "./apiV1.js";
import { openapiSpec, swaggerHtml } from "./openapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3001);

async function main() {
  await initDb();

  const app = express();
  // CORS_ORIGIN can be a comma-separated allowlist (e.g. https://transit.tranzor.io).
  // Unset => reflect any origin (fine for a JWT-in-header API, and unused entirely
  // when the frontend proxies /api same-origin via Vercel rewrites).
  const corsOrigin = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim())
    : true;
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Public client API + its documentation.
  app.get("/api/openapi.json", (_req, res) => res.json(openapiSpec));
  app.get("/docs", (_req, res) => res.type("html").send(swaggerHtml));
  app.use("/api/v1", apiV1);

  // Admin panel API (JWT).
  app.use("/api", router);

  // Serve the built frontend in production.
  const dist = path.resolve(__dirname, "..", "dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
  }

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((e) => {
  const err = e as { message?: string; code?: string };
  console.error(
    `[server] fatal: ${err.code ? `[${err.code}] ` : ""}${err.message ?? e}`,
  );
  process.exit(1);
});
