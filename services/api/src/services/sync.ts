import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  capturedMessages,
  deviceTokens,
  googleAccounts,
  rules,
} from "../db/schema.js";
import { decryptSecret } from "../lib/crypto.js";
import {
  fetchMessageMeta,
  gmailClientForRefresh,
  messageMatchesRule,
  listRecentMessageIds,
  syncHistory,
} from "./gmail.js";
import { sendExpoPush } from "./push.js";

export async function syncAccount(accountId: string): Promise<void> {
  const [acc] = await db
    .select()
    .from(googleAccounts)
    .where(eq(googleAccounts.id, accountId))
    .limit(1);
  if (!acc) return;

  const refreshToken = decryptSecret(acc.refreshTokenEnc);
  const userRules = await db
    .select()
    .from(rules)
    .where(and(eq(rules.userId, acc.userId), eq(rules.enabled, true)));

  try {
    let messageIds: string[];
    const hist = await syncHistory(refreshToken, acc.historyId);

    if (!acc.historyId) {
      messageIds = await listRecentMessageIds(refreshToken);
    } else if (hist.historyInvalid) {
      messageIds = await listRecentMessageIds(refreshToken);
    } else {
      messageIds = hist.messageIds;
    }

    // Incremental history only sees *new* changes. If the user adds a rule after mail
    // already arrived, those message IDs are never in history — merge a recent scan.
    if (
      userRules.length > 0 &&
      acc.historyId &&
      !hist.historyInvalid
    ) {
      const recent = await listRecentMessageIds(refreshToken);
      messageIds = [...new Set([...messageIds, ...recent])];
    }

    const nextHistoryId = hist.nextHistoryId;

    if (userRules.length === 0 || messageIds.length === 0) {
      await db
        .update(googleAccounts)
        .set({
          historyId: nextHistoryId,
          lastSyncError: null,
          updatedAt: new Date(),
        })
        .where(eq(googleAccounts.id, acc.id));
      return;
    }

    const gmail = gmailClientForRefresh(refreshToken);

    for (const mid of messageIds) {
      let meta: Awaited<ReturnType<typeof fetchMessageMeta>>;
      try {
        meta = await fetchMessageMeta(gmail, mid);
      } catch {
        continue;
      }

      const receivedAt = new Date(meta.internalDate || Date.now());

      for (const rule of userRules) {
        if (
          !messageMatchesRule(meta.from, meta.labelIds, {
            type: rule.type,
            value: rule.value,
          })
        ) {
          continue;
        }

        const inserted = await db
          .insert(capturedMessages)
          .values({
            userId: acc.userId,
            gmailMessageId: meta.id,
            threadId: meta.threadId,
            ruleId: rule.id,
            subject: meta.subject || "(no subject)",
            fromAddr: meta.from,
            snippet: meta.snippet,
            receivedAt,
          })
          .onConflictDoNothing({
            target: [
              capturedMessages.userId,
              capturedMessages.gmailMessageId,
              capturedMessages.ruleId,
            ],
          })
          .returning({ id: capturedMessages.id });

        if (inserted.length === 0) continue;

        const tokens = await db
          .select({ t: deviceTokens.expoPushToken })
          .from(deviceTokens)
          .where(eq(deviceTokens.userId, acc.userId));

        const uniq = [...new Set(tokens.map((x) => x.t))];
        if (uniq.length > 0) {
          const pushResult = await sendExpoPush(
            uniq,
            meta.subject || "Important mail",
            meta.snippet.slice(0, 120),
            { captureId: inserted[0]!.id },
          );
          if (pushResult.ticketErr > 0) {
            console.warn(
              "[NeverMiss/sync] push_expo_ticket_errors",
              JSON.stringify({
                userId: acc.userId,
                captureId: inserted[0]!.id,
                ...pushResult,
              }),
            );
          }
        } else {
          console.warn(
            "[NeverMiss/sync] skip_push_no_device_tokens",
            JSON.stringify({
              userId: acc.userId,
              captureId: inserted[0]!.id,
              hint: "App must POST /v1/devices (Account → Refresh push registration)",
            }),
          );
        }

        await db
          .update(capturedMessages)
          .set({ notifiedAt: new Date() })
          .where(eq(capturedMessages.id, inserted[0]!.id));
      }
    }

    await db
      .update(googleAccounts)
      .set({
        historyId: nextHistoryId,
        lastSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(googleAccounts.id, acc.id));
  } catch (e) {
    let msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("invalid_grant")) {
      msg =
        "invalid_grant — Google access was revoked; sign in again from the app.";
    }
    await db
      .update(googleAccounts)
      .set({ lastSyncError: msg, updatedAt: new Date() })
      .where(eq(googleAccounts.id, acc.id));
  }
}

export async function syncAllAccounts(): Promise<void> {
  const accs = await db.select({ id: googleAccounts.id }).from(googleAccounts);
  for (const a of accs) {
    await syncAccount(a.id);
  }
}
