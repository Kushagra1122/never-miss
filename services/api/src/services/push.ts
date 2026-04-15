import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";

const expo = new Expo({ useFcmV1: true });

/** Android channel id — client creates this in `notificationService.ensureAndroidMailChannel`. */
export const EXPO_ANDROID_MAIL_CHANNEL_ID = "important-mail";

export type ExpoPushSendResult = {
  skippedInvalid: number;
  messageCount: number;
  ticketOk: number;
  ticketErr: number;
  /** Human-readable samples for clients / logs (deduped, capped). */
  errorSamples: string[];
};

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
        "[NeverMiss/push] expo_ticket_error",
        JSON.stringify({
          message: t.message,
          errorCode: err ?? null,
          tokenPrefix: t.details?.expoPushToken
            ? `${t.details.expoPushToken.slice(0, 24)}…`
            : null,
        }),
      );
    }
  }
}

function summarizeTicketErrors(tickets: ExpoPushTicket[], maxSamples: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tickets) {
    if (t.status !== "error") continue;
    const code = t.details?.error ?? "unknown";
    const line = `${code}: ${t.message}`;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= maxSamples) break;
  }
  return out;
}

export async function sendExpoPush(
  tokens: string[],
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<ExpoPushSendResult> {
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
      "[NeverMiss/push] skipped_invalid_tokens",
      JSON.stringify({
        count: skippedInvalid,
        hint: "DB may contain bad rows or stale installs",
      }),
    );
  }
  if (messages.length === 0) {
    console.warn(
      "[NeverMiss/push] nothing_to_send",
      JSON.stringify({
        inputTokenRows: tokens.length,
        skippedInvalid,
        reason: "no_valid_expo_tokens_after_filter",
      }),
    );
    return {
      skippedInvalid,
      messageCount: 0,
      ticketOk: 0,
      ticketErr: 0,
      errorSamples: [],
    };
  }

  const chunks = expo.chunkPushNotifications(messages);
  console.log(
    "[NeverMiss/push] send_start",
    JSON.stringify({
      inputTokenRows: tokens.length,
      skippedInvalid,
      validMessages: messages.length,
      chunkCount: chunks.length,
      titleLen: (title || "Important mail").length,
      bodyLen: (body || " ").length,
      hasData: Boolean(payload && Object.keys(payload).length),
    }),
  );

  let ticketOk = 0;
  let ticketErr = 0;
  const allErrorSamples: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      let chunkOk = 0;
      let chunkErr = 0;
      for (const t of tickets) {
        if (t.status === "ok") {
          chunkOk++;
          ticketOk++;
        } else {
          chunkErr++;
          ticketErr++;
        }
      }
      logTicketErrors(tickets);
      for (const s of summarizeTicketErrors(tickets, 8)) {
        if (!allErrorSamples.includes(s)) allErrorSamples.push(s);
        if (allErrorSamples.length >= 8) break;
      }
      console.log(
        "[NeverMiss/push] chunk_sent",
        JSON.stringify({
          chunkIndex: i + 1,
          of: chunks.length,
          batchSize: chunk.length,
          chunkOk,
          chunkErr,
          cumulativeOk: ticketOk,
          cumulativeErr: ticketErr,
        }),
      );
    } catch (e) {
      console.warn(
        "[NeverMiss/push] chunk_failed",
        JSON.stringify({
          chunkIndex: i + 1,
          of: chunks.length,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }
  console.log(
    "[NeverMiss/push] send_done",
    JSON.stringify({ ticketOk, ticketErr, chunks: chunks.length }),
  );

  return {
    skippedInvalid,
    messageCount: messages.length,
    ticketOk,
    ticketErr,
    errorSamples: allErrorSamples.slice(0, 8),
  };
}
