import {
  Expo,
  type ExpoPushMessage,
  type ExpoPushReceipt,
  type ExpoPushTicket,
} from "expo-server-sdk";

/** Expo Push defaults to FCM HTTP v1; in expo-server-sdk@3.13 only `useFcmV1: false` alters the send URL. */
const expo = new Expo();

/** Android channel id — client creates this in `notificationService.ensureAndroidMailChannel`. */
export const EXPO_ANDROID_MAIL_CHANNEL_ID = "important-mail";

/** Subset of Expo receipt `details.fcm` (when present) — helps distinguish credential vs payload issues. */
export type ExpoReceiptFcmDiagnostic = {
  httpStatus?: number;
  /** Truncated plain text / HTML snippet from FCM (no tokens). */
  responsePreview?: string;
};

export type ExpoPushReceiptProbe = {
  waitedMs: number;
  receiptOk: number;
  receiptErr: number;
  pendingCount: number;
  errors: string[];
  fcmDiagnostics?: ExpoReceiptFcmDiagnostic[];
};

export type ExpoPushSendResult = {
  skippedInvalid: number;
  messageCount: number;
  ticketOk: number;
  ticketErr: number;
  /** Human-readable samples for clients / logs (deduped, capped). */
  errorSamples: string[];
  /** FCM/APNs outcome after Expo handoff — only set when `receiptProbeMs` was used. */
  receiptProbe?: ExpoPushReceiptProbe;
};

export type SendExpoPushOptions = {
  /**
   * Wait N ms then call Expo getReceipts. Surfaces FCM errors (e.g. MismatchSenderId,
   * InvalidCredentials) that tickets hide. Use only on `/v1/push/test` — adds latency.
   */
  receiptProbeMs?: number;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function receiptErrorLine(r: ExpoPushReceipt): string {
  if (r.status === "ok") return "ok";
  const code =
    r.details && typeof r.details === "object" && "error" in r.details
      ? String((r.details as { error?: string }).error ?? "unknown")
      : "unknown";
  return `${code}: ${r.message}`;
}

function extractFcmDiagnostic(details: unknown): ExpoReceiptFcmDiagnostic | null {
  if (!details || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
  const fcm = d.fcm;
  if (!fcm || typeof fcm !== "object") return null;
  const f = fcm as Record<string, unknown>;
  const httpStatus = typeof f.httpStatus === "number" ? f.httpStatus : undefined;
  const raw = typeof f.response === "string" ? f.response : "";
  const responsePreview =
    raw.length > 0
      ? raw.replace(/\s+/g, " ").trim().slice(0, 200)
      : undefined;
  if (httpStatus == null && !responsePreview) return null;
  return { httpStatus, responsePreview };
}

function fcmDiagnosticKey(x: ExpoReceiptFcmDiagnostic): string {
  return `${x.httpStatus ?? ""}|${x.responsePreview ?? ""}`;
}

async function probePushReceipts(
  okTicketIds: string[],
  waitMs: number,
): Promise<ExpoPushReceiptProbe> {
  await sleep(waitMs);
  if (okTicketIds.length === 0) {
    return { waitedMs: waitMs, receiptOk: 0, receiptErr: 0, pendingCount: 0, errors: [] };
  }
  let receiptOk = 0;
  let receiptErr = 0;
  let pendingCount = 0;
  const errors: string[] = [];
  const fcmSeen = new Set<string>();
  const fcmDiagnostics: ExpoReceiptFcmDiagnostic[] = [];
  const chunks = expo.chunkPushNotificationReceiptIds(okTicketIds);
  for (const chunk of chunks) {
    try {
      const map = await expo.getPushNotificationReceiptsAsync(chunk);
      for (const id of chunk) {
        const r = map[id];
        if (!r) {
          pendingCount++;
          continue;
        }
        if (r.status === "ok") {
          receiptOk++;
        } else {
          receiptErr++;
          const line = receiptErrorLine(r);
          if (!errors.includes(line)) errors.push(line);
          const diag =
            r.status === "error" ? extractFcmDiagnostic(r.details) : null;
          if (diag) {
            const k = fcmDiagnosticKey(diag);
            if (!fcmSeen.has(k) && fcmDiagnostics.length < 5) {
              fcmSeen.add(k);
              fcmDiagnostics.push(diag);
            }
          }
        }
      }
    } catch (e) {
      console.warn(
        "[NeverMiss/push] receipt_fetch_failed",
        JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      );
    }
  }
  const probe: ExpoPushReceiptProbe = {
    waitedMs: waitMs,
    receiptOk,
    receiptErr,
    pendingCount,
    errors: errors.slice(0, 10),
  };
  if (fcmDiagnostics.length > 0) probe.fcmDiagnostics = fcmDiagnostics;
  return probe;
}

export async function sendExpoPush(
  tokens: string[],
  title: string,
  body: string,
  data?: Record<string, string>,
  options?: SendExpoPushOptions,
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
  const allTickets: ExpoPushTicket[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      allTickets.push(...tickets);
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

  const base: ExpoPushSendResult = {
    skippedInvalid,
    messageCount: messages.length,
    ticketOk,
    ticketErr,
    errorSamples: allErrorSamples.slice(0, 8),
  };

  const probeMs = options?.receiptProbeMs;
  if (probeMs != null && probeMs > 0 && ticketOk > 0) {
    const okIds = allTickets.filter((t) => t.status === "ok").map((t) => t.id);
    const receiptProbe = await probePushReceipts(okIds, probeMs);
    base.receiptProbe = receiptProbe;
    const fcm404 =
      receiptProbe.fcmDiagnostics?.some((x) => x.httpStatus === 404) ?? false;
    console.log(
      "[NeverMiss/push] receipt_probe",
      JSON.stringify({
        ...receiptProbe,
        hint:
          receiptProbe.receiptErr > 0
            ? fcm404
              ? "FCM returned HTTP 404 for Expo→FCM (common: wrong FCM V1 service account in expo.dev credentials vs Firebase project in google-services.json)."
              : "Fix FCM: Expo dashboard credentials must match google-services.json (same Firebase project / sender)."
            : receiptProbe.pendingCount > 0
              ? "Some receipts not ready yet; retry getReceipts later per Expo docs."
              : "FCM/APNs accepted handoff from Expo.",
      }),
    );
  }

  return base;
}
