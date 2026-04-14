import crypto from "node:crypto";

const HEADER = Buffer.from(
  JSON.stringify({ alg: "HS256", typ: "JWT" }),
).toString("base64url");

function signPayload(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const data = `${HEADER}.${body}`;
  const sig = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64url");
  return `${data}.${sig}`;
}

function verifyToken<T extends Record<string, unknown>>(
  token: string,
  secret: string,
): T | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, b, s] = parts;
  const data = `${h}.${b}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64url");
  const sb = Buffer.from(s);
  const eb = Buffer.from(expected);
  if (sb.length !== eb.length) return null;
  if (!crypto.timingSafeEqual(sb, eb)) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(b, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function signSession(userId: string, expSec: number): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("JWT_SECRET must be set (min 16 chars)");
  }
  const now = Math.floor(Date.now() / 1000);
  return signPayload(
    { sub: userId, iat: now, exp: now + expSec, typ: "session" },
    secret,
  );
}

export function verifySession(token: string): { userId: string } | null {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  const p = verifyToken<{ sub?: string; exp?: number; typ?: string }>(
    token,
    secret,
  );
  if (!p || p.typ !== "session" || typeof p.sub !== "string") return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof p.exp !== "number" || p.exp < now) return null;
  return { userId: p.sub };
}

export function signOAuthState(nonce: string, expSec: number): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET must be set");
  const now = Math.floor(Date.now() / 1000);
  return signPayload(
    { nonce, iat: now, exp: now + expSec, typ: "oauth_state" },
    secret,
  );
}

export function verifyOAuthState(token: string): { nonce: string } | null {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  const p = verifyToken<{ nonce?: string; exp?: number; typ?: string }>(
    token,
    secret,
  );
  if (!p || p.typ !== "oauth_state" || typeof p.nonce !== "string")
    return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof p.exp !== "number" || p.exp < now) return null;
  return { nonce: p.nonce };
}
