import {
  boolean,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const ruleTypeEnum = pgEnum("rule_type", [
  "sender_email",
  "domain",
  "gmail_label_id",
]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const googleAccounts = pgTable(
  "google_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull().unique(),
    refreshTokenEnc: text("refresh_token_enc").notNull(),
    historyId: text("history_id"),
    lastSyncError: text("last_sync_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
);

export const rules = pgTable("rules", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: ruleTypeEnum("type").notNull(),
  value: text("value").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const capturedMessages = pgTable(
  "captured_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    gmailMessageId: text("gmail_message_id").notNull(),
    threadId: text("thread_id").notNull(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => rules.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    fromAddr: text("from_addr").notNull(),
    snippet: text("snippet").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("captured_user_msg_rule").on(
      t.userId,
      t.gmailMessageId,
      t.ruleId,
    ),
  }),
);

export const deviceTokens = pgTable("device_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expoPushToken: text("expo_push_token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type User = typeof users.$inferSelect;
export type GoogleAccount = typeof googleAccounts.$inferSelect;
export type Rule = typeof rules.$inferSelect;
export type CapturedMessage = typeof capturedMessages.$inferSelect;
export type DeviceToken = typeof deviceTokens.$inferSelect;
