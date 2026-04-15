/** Grep Metro / adb logcat for this tag. */
export const NOTIF_TAG = "[NeverMiss/notifications]";

/** Safe preview of an Expo push token (never log full token). */
export function redactPushToken(token: string): string {
  if (!token) return "(empty)";
  const n = token.length;
  if (n <= 28) return `${token.slice(0, 12)}…(len=${n})`;
  return `${token.slice(0, 24)}…${token.slice(-10)} (len=${n})`;
}

function fmtExtra(extra?: Record<string, unknown>): string {
  if (!extra || Object.keys(extra).length === 0) return "";
  try {
    return ` ${JSON.stringify(extra)}`;
  } catch {
    return " (extra not serializable)";
  }
}

export function notifInfo(
  step: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  console.log(`${NOTIF_TAG} ${step}`, message + fmtExtra(extra));
}

export function notifWarn(
  step: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  console.warn(`${NOTIF_TAG} ${step}`, message + fmtExtra(extra));
}
