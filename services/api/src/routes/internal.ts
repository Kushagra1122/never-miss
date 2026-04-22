import type { FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { syncAllAccounts } from "../services/sync.js";

function verifyCronBearer(
  authorization: string | undefined,
  secret: string,
): boolean {
  if (!authorization || !authorization.startsWith("Bearer ")) return false;
  const token = authorization.slice(7).trim();
  if (!token || !secret) return false;
  try {
    const a = Buffer.from(token, "utf8");
    const b = Buffer.from(secret, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * POST /internal/sync-all — runs Gmail sync for every connected account and may send pushes.
 * Protect with Authorization: Bearer $CRON_SECRET.
 *
 * On hosts that spin down when idle (e.g. Render Free), the in-process poll timer does not run
 * while sleeping; an external cron hitting this route wakes the service and performs sync.
 */
export const internalRoutes: FastifyPluginAsync = async (app) => {
  app.post("/sync-all", async (req, reply) => {
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret) {
      return reply.code(503).send({
        error: "cron_not_configured",
        message:
          "Set CRON_SECRET on the API, then schedule POST /internal/sync-all with Authorization: Bearer <secret> every few minutes (e.g. cron-job.org or UptimeRobot).",
      });
    }
    if (!verifyCronBearer(req.headers.authorization, secret)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const t0 = Date.now();
    await syncAllAccounts();
    const ms = Date.now() - t0;
    req.log.info({ ms }, "[NeverMiss/internal] sync_all_done");
    return { ok: true, ms };
  });
};
