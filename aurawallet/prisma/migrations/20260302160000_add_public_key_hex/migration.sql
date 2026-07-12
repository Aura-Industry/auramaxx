-- AlterTable
ALTER TABLE "AgentProfile" ADD COLUMN "publicKeyHex" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AgentProfile_publicKeyHex_key" ON "AgentProfile"("publicKeyHex");
