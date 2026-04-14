import { google } from "googleapis";
import type { Rule } from "../db/schema.js";
import { getApiPublicUrl } from "../lib/config.js";

const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";

export function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET required");
  }
  return new google.auth.OAuth2(
    clientId,
    clientSecret,
    `${getApiPublicUrl()}/auth/google/callback`,
  );
}

export type GoogleAuthUrlOptions = {
  /** Pre-fills Google’s account chooser (any Gmail or Google Workspace address). */
  loginHint?: string;
};

export function buildGoogleAuthUrl(
  state: string,
  options?: GoogleAuthUrlOptions,
): string {
  const oauth2 = getOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "select_account consent",
    scope: [GMAIL_READONLY, "openid", "email", "profile"],
    state,
    include_granted_scopes: true,
    ...(options?.loginHint
      ? { login_hint: options.loginHint.trim() }
      : {}),
  });
}

export async function exchangeCode(code: string): Promise<{
  refresh_token?: string | null;
  access_token?: string | null;
  expiry_date?: number | null;
}> {
  const oauth2 = getOAuth2Client();
  const { tokens } = await oauth2.getToken(code);
  return {
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expiry_date: tokens.expiry_date ?? null,
  };
}

export function gmailClientForRefresh(refreshToken: string) {
  const oauth2 = getOAuth2Client();
  oauth2.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: "v1", auth: oauth2 });
}

export async function getProfileEmail(refreshToken: string): Promise<string> {
  const gmail = gmailClientForRefresh(refreshToken);
  const prof = await gmail.users.getProfile({ userId: "me" });
  const email = prof.data.emailAddress;
  if (!email) throw new Error("No email on Gmail profile");
  return email;
}

export function parseFromHeader(from: string): { email: string; domain: string } {
  const m = from.match(/<([^>]+)>/);
  const addr = (m ? m[1] : from).trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  const domain = at >= 0 ? addr.slice(at + 1) : "";
  return { email: addr, domain };
}

export function messageMatchesRule(
  fromHeader: string,
  labelIds: string[] | undefined,
  rule: Pick<Rule, "type" | "value">,
): boolean {
  const v = rule.value.trim().toLowerCase();
  const { email, domain } = parseFromHeader(fromHeader);
  switch (rule.type) {
    case "sender_email":
      return email === v;
    case "domain":
      return domain === v || email.endsWith(`@${v}`);
    case "gmail_label_id":
      return (labelIds ?? []).includes(v);
    default:
      return false;
  }
}

export async function fetchMessageMeta(
  gmail: ReturnType<typeof gmailClientForRefresh>,
  messageId: string,
): Promise<{
  id: string;
  threadId: string;
  snippet: string;
  internalDate: number;
  from: string;
  subject: string;
  labelIds: string[];
}> {
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "metadata",
    metadataHeaders: ["From", "Subject", "Date"],
  });
  const headers = res.data.payload?.headers ?? [];
  const get = (n: string) =>
    headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value ??
    "";
  const internalDate = Number(res.data.internalDate ?? 0);
  return {
    id: res.data.id ?? messageId,
    threadId: res.data.threadId ?? "",
    snippet: res.data.snippet ?? "",
    internalDate,
    from: get("From"),
    subject: get("Subject"),
    labelIds: res.data.labelIds ?? [],
  };
}

export async function syncHistory(
  refreshToken: string,
  startHistoryId: string | null,
): Promise<{
  nextHistoryId: string;
  messageIds: string[];
  historyInvalid: boolean;
}> {
  const gmail = gmailClientForRefresh(refreshToken);
  const prof = await gmail.users.getProfile({ userId: "me" });
  const latest = prof.data.historyId;
  if (!latest) throw new Error("No historyId in profile");

  if (!startHistoryId) {
    return { nextHistoryId: latest, messageIds: [], historyInvalid: false };
  }

  const messageIds = new Set<string>();
  let pageToken: string | undefined;
  let historyInvalid = false;

  try {
    for (;;) {
      const hist = await gmail.users.history.list({
        userId: "me",
        startHistoryId,
        pageToken,
        historyTypes: ["messageAdded"],
      });
      for (const h of hist.data.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          const id = added.message?.id;
          if (id) messageIds.add(id);
        }
      }
      pageToken = hist.data.nextPageToken ?? undefined;
      if (!pageToken) break;
    }
  } catch (e: unknown) {
    const err = e as { code?: number; message?: string };
    if (err.code === 404 || String(err.message).includes("historyId")) {
      historyInvalid = true;
    } else {
      throw e;
    }
  }

  return {
    nextHistoryId: latest,
    messageIds: [...messageIds],
    historyInvalid,
  };
}

export async function listRecentMessageIds(
  refreshToken: string,
  maxResults: number,
): Promise<string[]> {
  const gmail = gmailClientForRefresh(refreshToken);
  // Do not require `in:inbox` — mail can land in Updates/Promotions or be matched late
  // after a rule is added (history cursor would otherwise skip it).
  const res = await gmail.users.messages.list({
    userId: "me",
    maxResults,
    q: "newer_than:14d",
  });
  return (res.data.messages ?? []).map((m) => m.id!).filter(Boolean);
}
