/** Prefix so device logs are filterable (Metro often won’t show device console.log). */
const TAG = "[NeverMiss OAuth]";

export function redactUrlForLog(url: string | undefined): string {
  if (url == null || url === "") return "(empty)";
  try {
    return url.replace(/token=[^&#]*/gi, "token=<redacted>");
  } catch {
    return "(unparseable)";
  }
}

export function logOAuth(step: string, data: Record<string, unknown>): void {
  const line = { step, ...data };
  console.log(TAG, JSON.stringify(line));
}

/**
 * Extract URL from openAuthSessionAsync result (only success carries `url`).
 */
export function getWebBrowserCallbackUrl(result: {
  type: string;
  url?: string;
}): string | undefined {
  if (result.type === "success" && result.url?.length) return result.url;
  return undefined;
}

export function summarizeAuthSessionResult(result: {
  type: string;
  url?: string;
}): Record<string, unknown> {
  if (result.type === "success") {
    return {
      type: result.type,
      url: result.url ? redactUrlForLog(result.url) : "(no url on success)",
    };
  }
  return { type: result.type };
}

/**
 * Android: `openAuthSessionAsync` uses a polyfill that races AppState vs Linking.
 * Often `dismiss` wins before the `exp://…?token=` URL is observed — wait for the deep link.
 */
export async function waitForOAuthDeepLink(
  getCaptured: () => string | undefined,
  ms = 3500,
  intervalMs = 60,
): Promise<string | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const u = getCaptured();
    if (u && (u.includes("token=") || u.includes("error="))) return u;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const last = getCaptured();
  if (last && (last.includes("token=") || last.includes("error="))) return last;
  return undefined;
}

/**
 * Read token / error from the post-login redirect. Handles:
 * - `scheme://auth?token=...`
 * - `exp://.../--/auth?token=...`
 * - Hash-only: `scheme://path#token=...` (some WebView stacks)
 */
export function parseAuthRedirect(url: string): {
  token?: string;
  error?: string;
} {
  try {
    const u = url.trim();
    if (!u) return {};

    const qMark = u.indexOf("?");
    const hash = u.indexOf("#");

    let queryPart = "";
    if (qMark >= 0) {
      const end = hash > qMark ? hash : u.length;
      queryPart = u.slice(qMark + 1, end);
    }

    let hashPart = "";
    if (hash >= 0) {
      hashPart = u.slice(hash + 1);
    }

    const fromQuery = new URLSearchParams(queryPart);
    const fromHash = new URLSearchParams(hashPart);

    const token =
      fromQuery.get("token") ?? fromHash.get("token") ?? undefined;
    const error =
      fromQuery.get("error") ?? fromHash.get("error") ?? undefined;

    return {
      token: token ?? undefined,
      error: error ?? undefined,
    };
  } catch {
    return {};
  }
}
