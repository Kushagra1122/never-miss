import * as BackgroundTask from "expo-background-task";
import * as SecureStore from "expo-secure-store";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { triggerSync } from "./api";
import { SESSION_TOKEN_KEY } from "./sessionKey";

export const GMAIL_BACKGROUND_SYNC_TASK = "nevermiss-gmail-background-sync";

TaskManager.defineTask(GMAIL_BACKGROUND_SYNC_TASK, async () => {
  try {
    const token = await SecureStore.getItemAsync(SESSION_TOKEN_KEY);
    if (!token) {
      return BackgroundTask.BackgroundTaskResult.Success;
    }
    await triggerSync(token);
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/**
 * Schedules periodic Gmail sync on the server while the app is backgrounded (OS-dependent timing).
 * Android uses WorkManager (~15+ min). Requires a dev/production build, not Expo Go on Android.
 */
export async function registerGmailBackgroundSync(): Promise<void> {
  if (Platform.OS === "web") return;
  const available = await TaskManager.isAvailableAsync();
  if (!available) return;
  const status = await BackgroundTask.getStatusAsync();
  if (status !== BackgroundTask.BackgroundTaskStatus.Available) return;
  if (await TaskManager.isTaskRegisteredAsync(GMAIL_BACKGROUND_SYNC_TASK)) {
    return;
  }
  await BackgroundTask.registerTaskAsync(GMAIL_BACKGROUND_SYNC_TASK, {
    minimumInterval: 15,
  });
}

export async function unregisterGmailBackgroundSync(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    if (await TaskManager.isTaskRegisteredAsync(GMAIL_BACKGROUND_SYNC_TASK)) {
      await BackgroundTask.unregisterTaskAsync(GMAIL_BACKGROUND_SYNC_TASK);
    }
  } catch {
    /* already unregistered */
  }
}
