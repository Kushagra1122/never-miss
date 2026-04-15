import { isRunningInExpoGo } from "expo";
import { AppState, Platform } from "react-native";
import { notifInfo, notifWarn, redactPushToken } from "./notificationsLog";

/** Must match `channelId` sent from the API (see services/api push). */
export const ANDROID_MAIL_CHANNEL_ID = "important-mail";

/** Remote push tokens are not available in Expo Go on Android (SDK 53+). */
export function shouldSkipExpoNotificationsModule(): boolean {
  return isRunningInExpoGo() && Platform.OS === "android";
}

export async function initNotificationHandler(): Promise<void> {
  if (shouldSkipExpoNotificationsModule()) {
    notifInfo("init", "skipped (Expo Go on Android — no native push module)", {
      platform: Platform.OS,
      expoGo: true,
    });
    return;
  }
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
  notifInfo("init", "notification handler + Android channel ready", {
    platform: Platform.OS,
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
  notifInfo("android_channel", "channel configured", {
    channelId: ANDROID_MAIL_CHANNEL_ID,
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
    notifInfo("subscribe", "skipped (Expo Go on Android)");
    return () => {};
  }
  const Notifications = await import("expo-notifications");
  await ensureAndroidMailChannel();

  const subA = Notifications.addNotificationReceivedListener((notification) => {
    const { title, body, data } = notification.request.content;
    notifInfo("push_received", "notification delivered while app running", {
      appState: AppState.currentState,
      title: title ?? "(no title)",
      bodyPreview:
        typeof body === "string"
          ? body.length > 80
            ? `${body.slice(0, 80)}…`
            : body
          : String(body),
      dataKeys:
        data && typeof data === "object" ? Object.keys(data as object) : [],
    });
    if (AppState.currentState === "active") {
      void Promise.resolve(handlers.onRefresh());
    }
  });

  const subB = Notifications.addNotificationResponseReceivedListener(
    (response) => {
      const { title, data } = response.notification.request.content;
      notifInfo("push_opened", "user tapped notification", {
        title: title ?? "(no title)",
        actionId: response.actionIdentifier,
        dataKeys:
          data && typeof data === "object" ? Object.keys(data as object) : [],
      });
      void Promise.resolve(handlers.onRefresh());
      handlers.onOpen?.();
    },
  );

  notifInfo("subscribe", "listening for mail pushes (foreground + tap)");
  return () => {
    notifInfo("subscribe", "removed listeners");
    subA.remove();
    subB.remove();
  };
}

export type RegisterPushResult =
  | { ok: true }
  | { ok: false; userMessage: string };

/** Why registration ran — included in every log line for correlation. */
export type RegisterPushContext =
  | "session"
  | "app_resume"
  | "sign_in"
  | "manual";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Shorter UI copy when native Firebase was never wired for this APK. */
function pushFailureUserMessage(raw: string): string {
  if (
    raw.includes("FirebaseApp is not initialized") ||
    raw.includes("FirebaseApp.initializeApp")
  ) {
    return (
      "Firebase is not set up in this Android build (missing google-services.json processing). " +
      "Rebuild after: (1) npm run android:sync-firebase locally, or (2) EAS secret GOOGLE_SERVICES_JSON (File) + new APK. " +
      "See https://docs.expo.dev/push-notifications/fcm-credentials/"
    );
  }
  return `Could not register with the server: ${raw}`;
}

/**
 * Registers this device’s Expo push token with the API. Failures are non-throwing
 * so sign-in is not blocked; callers can show `userMessage` on Account.
 */
export async function registerExpoPushWithApi(
  session: string,
  registerDevice: (s: string, expoPushToken: string) => Promise<unknown>,
  context: RegisterPushContext = "session",
): Promise<RegisterPushResult> {
  const sessionLen = session?.length ?? 0;
  notifInfo("register_start", "begin push token registration", {
    context,
    platform: Platform.OS,
    expoGo: isRunningInExpoGo(),
    sessionTokenLen: sessionLen,
  });

  if (shouldSkipExpoNotificationsModule()) {
    const userMessage =
      "Expo Go on Android cannot register push tokens. Install your EAS preview APK for push.";
    notifWarn("register_skip", userMessage, { context });
    return { ok: false, userMessage };
  }
  try {
    const Notifications = await import("expo-notifications");
    const { status, canAskAgain } =
      await Notifications.requestPermissionsAsync();
    notifInfo("register_permission", "after requestPermissionsAsync", {
      context,
      status,
      canAskAgain,
    });
    if (status !== "granted") {
      const userMessage =
        "Notifications are off for this app. Enable them in system Settings, then tap Refresh push registration.";
      notifWarn("register_denied", userMessage, { context, status });
      return { ok: false, userMessage };
    }
    await ensureAndroidMailChannel();
    notifInfo("register_expo_token", "calling getExpoPushTokenAsync", {
      context,
    });
    const push = await Notifications.getExpoPushTokenAsync();
    const expoPushToken = push.data;
    if (!expoPushToken) {
      const userMessage =
        "No Expo push token from the device. On Android release builds, confirm Firebase/FCM is configured in Expo.";
      notifWarn("register_no_token", userMessage, { context });
      return { ok: false, userMessage };
    }
    notifInfo("register_api", "POST /v1/devices", {
      context,
      expoPushToken: redactPushToken(expoPushToken),
    });
    await registerDevice(session, expoPushToken);
    notifInfo("register_ok", "device token stored on server", {
      context,
      expoPushToken: redactPushToken(expoPushToken),
    });
    return { ok: true };
  } catch (e) {
    const detail = errText(e);
    notifWarn("register_error", detail, { context });
    return {
      ok: false,
      userMessage: pushFailureUserMessage(detail),
    };
  }
}
