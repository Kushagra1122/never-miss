/** Prefix so Metro / device logs are easy to filter: `npx react-native log-android` or Xcode console */
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
 * Read token / error from the post-login redirect. Handles:
 * - `scheme://auth?token=...`
 * - `exp://.../--/auth?token=...`
 * - Hash-only: `scheme://path#token=...` (some WebView stacks)
 */
/** Safe log line for openAuthSessionAsync outcome */
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
