import { Expo, type ExpoPushMessage } from "expo-server-sdk";

const expo = new Expo();

export async function sendExpoPush(
  tokens: string[],
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {

  const messages: ExpoPushMessage[] = [];
  for (const token of tokens) {
    if (!Expo.isExpoPushToken(token)) continue;
    messages.push({
      to: token,
      sound: "default",
      title,
      body,
      data: data ?? {},
    });
  }

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      await expo.sendPushNotificationsAsync(chunk);
    } catch {
      // logged by caller if needed
    }
  }
}
