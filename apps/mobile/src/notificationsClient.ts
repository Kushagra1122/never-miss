import { isRunningInExpoGo } from "expo";
import { Platform } from "react-native";

/** Remote push tokens are not available in Expo Go on Android (SDK 53+). */
export function shouldSkipExpoNotificationsModule(): boolean {
  return isRunningInExpoGo() && Platform.OS === "android";
}

export async function initNotificationHandler(): Promise<void> {
  if (shouldSkipExpoNotificationsModule()) return;
  const Notifications = await import("expo-notifications");
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

export async function registerExpoPushWithApi(
  session: string,
  registerDevice: (s: string, expoPushToken: string) => Promise<unknown>,
): Promise<void> {
  if (shouldSkipExpoNotificationsModule()) return;
  const Notifications = await import("expo-notifications");
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== "granted") return;
  const push = await Notifications.getExpoPushTokenAsync();
  const expoPushToken = push.data;
  if (expoPushToken) {
    await registerDevice(session, expoPushToken);
  }
}
