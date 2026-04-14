/**
 * @deprecated Import from `./notificationService` instead; this file re-exports for compatibility.
 */
export {
  ANDROID_MAIL_CHANNEL_ID,
  ensureAndroidMailChannel,
  initNotificationHandler,
  registerExpoPushWithApi,
  shouldSkipExpoNotificationsModule,
  subscribeMailNotifications,
} from "./notificationService";
export type { MailNotificationHandlers } from "./notificationService";
