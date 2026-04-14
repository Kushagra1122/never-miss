import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";

const expo = new Expo({ useFcmV1: true });

/** Android channel id — client creates this in `notificationService.ensureAndroidMailChannel`. */
export const EXPO_ANDROID_MAIL_CHANNEL_ID = "important-mail";

/** FCM / Expo expect string values in `data`. */
function stringifyData(
  data?: Record<string, string>,
): Record<string, string> | undefined {
  if (!data || Object.keys(data).length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = v == null ? "" : String(v);
  }
  return out;
}

function logTicketErrors(tickets: ExpoPushTicket[]): void {
  for (const t of tickets) {
    if (t.status === "error") {
      const err = t.details?.error;
      console.warn(
        "[push] expo ticket error:",
        t.message,
        err ? `(${err})` : "",
        t.details?.expoPushToken
          ? `token=${t.details.expoPushToken.slice(0, 24)}…`
          : "",
      );
    }
  }
}

export async function sendExpoPush(
  tokens: string[],
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {
  const payload = stringifyData(data);
  const messages: ExpoPushMessage[] = [];
  let skippedInvalid = 0;
  for (const token of tokens) {
    if (!Expo.isExpoPushToken(token)) {
      skippedInvalid++;
      continue;
    }
    messages.push({
      to: token,
      sound: "default",
      title: title || "Important mail",
      body: body || " ",
      priority: "high",
      channelId: EXPO_ANDROID_MAIL_CHANNEL_ID,
      ...(payload ? { data: payload } : {}),
    });
  }

  if (skippedInvalid > 0) {
    console.warn(
      "[push] skipped",
      skippedInvalid,
      "non-Expo token(s); DB may contain bad rows or stale installs",
    );
  }
  if (messages.length === 0) {
    console.warn("[push] no valid Expo push tokens; nothing sent");
    return;
  }

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      logTicketErrors(tickets);
    } catch (e) {
      console.warn(
        "[push] sendPushNotificationsAsync failed:",
        e instanceof Error ? e.message : String(e),
      );
    }
  }
}
