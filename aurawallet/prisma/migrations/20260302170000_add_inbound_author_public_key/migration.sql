-- AlterTable
ALTER TABLE "InboundMessage" ADD COLUMN "authorPublicKey" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "InboundMessage_authorPublicKey_idx" ON "InboundMessage"("authorPublicKey");
