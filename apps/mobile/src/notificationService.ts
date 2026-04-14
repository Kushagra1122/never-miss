import { isRunningInExpoGo } from "expo";
import { AppState, Platform } from "react-native";

/** Must match `channelId` sent from the API (see services/api push). */
export const ANDROID_MAIL_CHANNEL_ID = "important-mail";

/** Remote push tokens are not available in Expo Go on Android (SDK 53+). */
export function shouldSkipExpoNotificationsModule(): boolean {
  return isRunningInExpoGo() && Platform.OS === "android";
}

export async function initNotificationHandler(): Promise<void> {
  if (shouldSkipExpoNotificationsModule()) return;
  const Notifications = await import("expo-notifications");
  await ensureAndroidMailChannel();
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

export async function ensureAndroidMailChannel(): Promise<void> {
  if (Platform.OS !== "android" || shouldSkipExpoNotificationsModule()) return;
  const Notifications = await import("expo-notifications");
  await Notifications.setNotificationChannelAsync(ANDROID_MAIL_CHANNEL_ID, {
    name: "Important mail",
    description: "Alerts when new mail matches your rules",
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    bypassDnd: false,
  });
}

export type MailNotificationHandlers = {
  /** Refresh captures / rules when a push arrives or user opens a notification */
  onRefresh: () => void | Promise<void>;
  /** e.g. switch to Important tab when user taps a notification */
  onOpen?: () => void;
};

/**
 * Foreground: refresh list when a push is received while app is active.
 * Background: refresh when user taps the notification.
 */
export async function subscribeMailNotifications(
  handlers: MailNotificationHandlers,
): Promise<() => void> {
  if (shouldSkipExpoNotificationsModule()) {
    return () => {};
  }
  const Notifications = await import("expo-notifications");
  await ensureAndroidMailChannel();

  const subA = Notifications.addNotificationReceivedListener(() => {
    if (AppState.currentState === "active") {
      void Promise.resolve(handlers.onRefresh());
    }
  });

  const subB = Notifications.addNotificationResponseReceivedListener(() => {
    void Promise.resolve(handlers.onRefresh());
    handlers.onOpen?.();
  });

  return () => {
    subA.remove();
    subB.remove();
  };
}

export async function registerExpoPushWithApi(
  session: string,
  registerDevice: (s: string, expoPushToken: string) => Promise<unknown>,
): Promise<void> {
  if (shouldSkipExpoNotificationsModule()) return;
  const Notifications = await import("expo-notifications");
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== "granted") return;
  await ensureAndroidMailChannel();
  const push = await Notifications.getExpoPushTokenAsync();
  const expoPushToken = push.data;
  if (expoPushToken) {
    await registerDevice(session, expoPushToken);
  }
}
