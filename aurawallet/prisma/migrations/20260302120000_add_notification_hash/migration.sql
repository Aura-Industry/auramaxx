-- AlterTable: add hash column to Notification for dedup
ALTER TABLE "Notification" ADD COLUMN "hash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Notification_hash_key" ON "Notification"("hash");

-- CreateIndex
CREATE INDEX "Notification_category_agentId_idx" ON "Notification"("category", "agentId");
