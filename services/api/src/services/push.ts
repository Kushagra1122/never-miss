import { Expo, type ExpoPushMessage } from "expo-server-sdk";

const expo = new Expo();

/** Android channel id — client creates this in `notificationService.ensureAndroidMailChannel`. */
export const EXPO_ANDROID_MAIL_CHANNEL_ID = "important-mail";

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
      priority: "high",
      channelId: EXPO_ANDROID_MAIL_CHANNEL_ID,
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
