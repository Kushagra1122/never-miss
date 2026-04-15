-- Deduplicate before unique index (safe if no duplicates)
DELETE FROM "device_tokens" a
WHERE EXISTS (
  SELECT 1 FROM "device_tokens" b
  WHERE b.user_id = a.user_id
    AND b.expo_push_token = a.expo_push_token
    AND b.id < a.id
);
--> statement-breakpoint
CREATE UNIQUE INDEX "device_tokens_user_expo_token" ON "device_tokens" USING btree ("user_id","expo_push_token");
