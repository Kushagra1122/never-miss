import { loadEnv } from "./lib/loadEnv.js";
loadEnv();
if (!process.env.API_PUBLIC_URL?.trim() && process.env.RENDER_EXTERNAL_URL) {
  process.env.API_PUBLIC_URL = process.env.RENDER_EXTERNAL_URL;
}

import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { authRoutes } from "./routes/auth.js";
import { v1Routes } from "./routes/v1.js";
import { getPollIntervalMs } from "./lib/config.js";
import { syncAllAccounts } from "./services/sync.js";

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "0.0.0.0";

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const app = Fastify({
    logger: true,
  });

  await app.register(cors, {
    origin: true,
  });

  await app.register(rateLimit, {
    global: true,
    max: Number(process.env.RATE_LIMIT_MAX) || 200,
    timeWindow: process.env.RATE_LIMIT_WINDOW_MS || "1 minute",
  });

  await app.register(authRoutes);
  await app.register(v1Routes, { prefix: "/v1" });

  const intervalMs = getPollIntervalMs();
  const timer = setInterval(() => {
    syncAllAccounts().catch((e) => app.log.error(e, "syncAllAccounts"));
  }, intervalMs);
  timer.unref?.();

  await app.listen({ port, host });
  app.log.info(
    { port, host, pollIntervalMs: intervalMs, apiPublicUrl: process.env.API_PUBLIC_URL },
    "never-miss API listening",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
