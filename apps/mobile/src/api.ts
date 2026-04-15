import { getApiUrl } from "./config";

const base = () => getApiUrl();

export type Rule = {
  id: string;
  userId: string;
  type: "sender_email" | "domain" | "gmail_label_id";
  value: string;
  enabled: boolean;
  createdAt: string;
};

export type Capture = {
  id: string;
  userId: string;
  gmailMessageId: string;
  threadId: string;
  ruleId: string;
  subject: string;
  fromAddr: string;
  snippet: string;
  receivedAt: string;
  notifiedAt: string | null;
  createdAt: string;
};

async function req<T>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const body = init?.body;
  const hasJsonBody =
    typeof body === "string" && body.length > 0;
  const res = await fetch(`${base()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(hasJsonBody ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export async function registerDevice(token: string, expoPushToken: string) {
  return req<{ ok: boolean }>("/v1/devices", token, {
    method: "POST",
    body: JSON.stringify({ expoPushToken }),
  });
}

export type Me = {
  userId: string;
  email: string | null;
  lastSyncError: string | null;
  deviceTokenCount: number;
};

export async function getMe(token: string) {
  return req<Me>("/v1/me", token);
}

export type TestPushReceiptFcmDiagnostic = {
  httpStatus?: number;
  responsePreview?: string;
};

export type TestPushReceiptProbe = {
  waitedMs: number;
  receiptOk: number;
  receiptErr: number;
  pendingCount: number;
  errors: string[];
  fcmDiagnostics?: TestPushReceiptFcmDiagnostic[];
};

export type TestPushDelivery = {
  messageCount: number;
  ticketOk: number;
  ticketErr: number;
  errorSamples: string[];
  /** Present after server waits ~3s and asks Expo for FCM/APNs receipts (real delivery layer). */
  receiptProbe?: TestPushReceiptProbe;
};

export type TestPushResponse = {
  ok: true;
  deviceCount: number;
  delivery: TestPushDelivery;
};

export async function sendTestPush(token: string) {
  return req<TestPushResponse>("/v1/push/test", token, {
    method: "POST",
  });
}

export async function getRules(token: string) {
  return req<{ rules: Rule[] }>("/v1/rules", token);
}

export async function createRule(
  token: string,
  body: { type: Rule["type"]; value: string; enabled?: boolean },
) {
  return req<{ rule: Rule }>("/v1/rules", token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function patchRule(
  token: string,
  id: string,
  body: { value?: string; enabled?: boolean },
) {
  return req<{ rule: Rule }>(`/v1/rules/${id}`, token, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function deleteRule(token: string, id: string) {
  return req<{ ok: boolean }>(`/v1/rules/${id}`, token, {
    method: "DELETE",
  });
}

export async function getCaptures(token: string, limit = 50) {
  return req<{ captures: Capture[] }>(`/v1/captures?limit=${limit}`, token);
}

export async function triggerSync(token: string) {
  return req<{ ok: boolean }>("/v1/sync", token, { method: "POST" });
}

export async function deleteAccount(token: string) {
  return req<{ ok: boolean }>("/v1/account", token, { method: "DELETE" });
}
