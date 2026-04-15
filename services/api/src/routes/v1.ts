import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  capturedMessages,
  deviceTokens,
  googleAccounts,
  rules,
  users,
} from "../db/schema.js";
import { decryptSecret } from "../lib/crypto.js";
import { verifySession } from "../lib/jwt.js";
import { sendExpoPush } from "../services/push.js";
import { syncAccount } from "../services/sync.js";

const ruleBody = z.object({
  type: z.enum(["sender_email", "domain", "gmail_label_id"]),
  value: z.string().min(1).max(512),
  enabled: z.boolean().optional(),
});

const rulePatch = z.object({
  value: z.string().min(1).max(512).optional(),
  enabled: z.boolean().optional(),
});

const deviceBody = z.object({
  expoPushToken: z.string().min(10).max(512),
});

async function requireUser(
  authorization: string | undefined,
): Promise<string | null> {
  const m = authorization?.match(/^Bearer (.+)$/i);
  if (!m?.[1]) return null;
  return verifySession(m[1].trim())?.userId ?? null;
}

export const v1Routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (req, reply) => {
    const userId = await requireUser(req.headers.authorization);
    if (!userId) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    req.userId = userId;
  });

  app.get("/me", async (req) => {
    const [ga] = await db
      .select()
      .from(googleAccounts)
      .where(eq(googleAccounts.userId, req.userId!))
      .limit(1);
    const [tok] = await db
      .select({ deviceTokenCount: count() })
      .from(deviceTokens)
      .where(eq(deviceTokens.userId, req.userId!));
    return {
      userId: req.userId,
      email: ga?.email ?? null,
      lastSyncError: ga?.lastSyncError ?? null,
      deviceTokenCount: Number(tok?.deviceTokenCount ?? 0),
    };
  });

  app.post("/devices", async (req, reply) => {
    const parsed = deviceBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    await db
      .insert(deviceTokens)
      .values({
        userId: req.userId!,
        expoPushToken: parsed.data.expoPushToken,
      })
      .onConflictDoNothing({
        target: [deviceTokens.userId, deviceTokens.expoPushToken],
      });
    return { ok: true };
  });

  app.get("/rules", async (req) => {
    const list = await db
      .select()
      .from(rules)
      .where(eq(rules.userId, req.userId!));
    return { rules: list };
  });

  app.post("/rules", async (req, reply) => {
    const parsed = ruleBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const [row] = await db
      .insert(rules)
      .values({
        userId: req.userId!,
        type: parsed.data.type,
        value: parsed.data.value.trim(),
        enabled: parsed.data.enabled ?? true,
      })
      .returning();
    return { rule: row };
  });

  app.patch("/rules/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const parsed = rulePatch.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const [existing] = await db
      .select()
      .from(rules)
      .where(and(eq(rules.id, id), eq(rules.userId, req.userId!)))
      .limit(1);
    if (!existing) {
      return reply.code(404).send({ error: "not_found" });
    }
    const [row] = await db
      .update(rules)
      .set({
        ...(parsed.data.value !== undefined
          ? { value: parsed.data.value.trim() }
          : {}),
        ...(parsed.data.enabled !== undefined
          ? { enabled: parsed.data.enabled }
          : {}),
      })
      .where(eq(rules.id, id))
      .returning();
    return { rule: row };
  });

  app.delete("/rules/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const res = await db
      .delete(rules)
      .where(and(eq(rules.id, id), eq(rules.userId, req.userId!)))
      .returning({ id: rules.id });
    if (res.length === 0) {
      return reply.code(404).send({ error: "not_found" });
    }
    return { ok: true };
  });

  app.get("/captures", async (req) => {
    const limit = Math.min(
      100,
      Math.max(1, Number((req.query as { limit?: string }).limit) || 50),
    );
    const list = await db
      .select()
      .from(capturedMessages)
      .where(eq(capturedMessages.userId, req.userId!))
      .orderBy(desc(capturedMessages.receivedAt))
      .limit(limit);
    return { captures: list };
  });

  app.post("/sync", async (req, reply) => {
    const [ga] = await db
      .select({ id: googleAccounts.id })
      .from(googleAccounts)
      .where(eq(googleAccounts.userId, req.userId!))
      .limit(1);
    if (!ga) {
      return reply.code(400).send({ error: "no_gmail_account" });
    }
    await syncAccount(ga.id);
    return { ok: true };
  });

  /** Sends one test push to all tokens for this user (verifies Expo/FCM end-to-end). */
  app.post("/push/test", async (req, reply) => {
    const rows = await db
      .select({ t: deviceTokens.expoPushToken })
      .from(deviceTokens)
      .where(eq(deviceTokens.userId, req.userId!));
    const uniq = [...new Set(rows.map((r) => r.t))];
    if (uniq.length === 0) {
      return reply.code(400).send({
        error: "no_device_tokens",
        message:
          "No Expo push token stored. In the app: Account → Refresh push registration.",
      });
    }
    await sendExpoPush(uniq, "Never Miss", "Test notification — pipeline OK.", {
      type: "test",
    });
    return { ok: true, deviceCount: uniq.length };
  });

  app.delete("/account", async (req) => {
    const uid = req.userId!;
    const [ga] = await db
      .select()
      .from(googleAccounts)
      .where(eq(googleAccounts.userId, uid))
      .limit(1);
    if (ga) {
      try {
        const rt = decryptSecret(ga.refreshTokenEnc);
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: rt }).toString(),
        });
      } catch {
        /* best-effort revoke */
      }
    }
    await db.delete(users).where(eq(users.id, uid));
    return { ok: true };
  });
};
