import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { googleAccounts, users } from "../db/schema.js";
import { encryptSecret } from "../lib/crypto.js";
import { getMobileDeepLinkBase } from "../lib/config.js";
import {
  signOAuthState,
  verifyOAuthState,
  signSession,
} from "../lib/jwt.js";
import {
  buildGoogleAuthUrl,
  exchangeCode,
  getOAuth2Client,
  getProfileEmail,
} from "../services/gmail.js";

const LOGIN_HINT_MAX = 254;
/** Loose email-shaped hint for Google’s login_hint (Gmail or Workspace). */
function parseLoginHint(raw: unknown): string | undefined {
  if (raw == null || typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (t.length === 0 || t.length > LOGIN_HINT_MAX) return undefined;
  if (/[\r\n\0]/.test(t)) return undefined;
  if (!t.includes("@")) return undefined;
  return t;
}
import { google } from "googleapis";

async function resolveAccountEmail(
  tokens: Awaited<ReturnType<typeof exchangeCode>>,
): Promise<string> {
  if (tokens.refresh_token) {
    return getProfileEmail(tokens.refresh_token);
  }
  if (!tokens.access_token) {
    throw new Error("no_tokens");
  }
  const oauth2 = getOAuth2Client();
  oauth2.setCredentials({ access_token: tokens.access_token });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });
  const prof = await gmail.users.getProfile({ userId: "me" });
  const email = prof.data.emailAddress;
  if (!email) throw new Error("no_email");
  return email;
}

function deepLinkError(message: string): string {
  const base = getMobileDeepLinkBase();
  return `${base}?error=${encodeURIComponent(message)}`;
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get("/auth/google", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const loginHint = parseLoginHint(q.login_hint);
    const nonce = crypto.randomBytes(16).toString("hex");
    const state = signOAuthState(nonce, 600);
    const url = buildGoogleAuthUrl(state, { loginHint });
    return reply.redirect(url);
  });

  app.get("/auth/google/callback", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const code = q.code;
    const state = q.state;
    const err = q.error;
    if (err) {
      return reply.redirect(deepLinkError(`google_${err}`));
    }
    if (!code || !state) {
      return reply.redirect(deepLinkError("missing_code_or_state"));
    }
    const st = verifyOAuthState(state);
    if (!st) {
      return reply.redirect(deepLinkError("invalid_state"));
    }

    try {
      const tokens = await exchangeCode(code);
      const email = await resolveAccountEmail(tokens);

      let refreshEnc: string;
      if (tokens.refresh_token) {
        refreshEnc = encryptSecret(tokens.refresh_token);
      } else {
        const [existing] = await db
          .select()
          .from(googleAccounts)
          .where(eq(googleAccounts.email, email))
          .limit(1);
        if (!existing) {
          return reply.redirect(
            deepLinkError("missing_refresh_reauthorize"),
          );
        }
        refreshEnc = existing.refreshTokenEnc;
      }

      const [existingGa] = await db
        .select()
        .from(googleAccounts)
        .where(eq(googleAccounts.email, email))
        .limit(1);

      let userId: string;
      if (existingGa) {
        userId = existingGa.userId;
        await db
          .update(googleAccounts)
          .set({
            refreshTokenEnc: refreshEnc,
            lastSyncError: null,
            updatedAt: new Date(),
          })
          .where(eq(googleAccounts.id, existingGa.id));
      } else {
        const [u] = await db.insert(users).values({}).returning();
        userId = u!.id;
        await db.insert(googleAccounts).values({
          userId,
          email,
          refreshTokenEnc: refreshEnc,
        });
      }

      const session = signSession(userId, 60 * 60 * 24 * 30);
      const redirect = `${getMobileDeepLinkBase()}?token=${encodeURIComponent(session)}`;
      return reply.redirect(redirect);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "oauth_failed";
      return reply.redirect(deepLinkError(msg));
    }
  });

  app.get("/auth/google/url", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const loginHint = parseLoginHint(q.login_hint);
    const nonce = crypto.randomBytes(16).toString("hex");
    const state = signOAuthState(nonce, 600);
    const url = buildGoogleAuthUrl(state, { loginHint });
    return { url, state };
  });

  app.get("/.well-known/health", async () => ({ ok: true }));
  app.get("/health", async () => ({ ok: true }));
};
