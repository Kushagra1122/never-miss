export function getPollIntervalMs(): number {
  const raw = process.env.POLL_INTERVAL_MS;
  const n = raw ? Number.parseInt(raw, 10) : 120_000;
  if (!Number.isFinite(n) || n < 10_000) return 120_000;
  return n;
}

export function getApiPublicUrl(): string {
  const u = process.env.API_PUBLIC_URL;
  if (!u) throw new Error("API_PUBLIC_URL is required");
  return u.replace(/\/$/, "");
}

export function getMobileDeepLinkBase(): string {
  const scheme = process.env.MOBILE_APP_SCHEME ?? "nevermiss";
  return `${scheme}://auth`;
}
