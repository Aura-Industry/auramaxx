-- CreateTable
CREATE TABLE "CredentialAccessAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "credentialId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL,
    "result" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "httpStatus" INTEGER NOT NULL,
    "tokenHash" TEXT,
    "actorAgentId" TEXT,
    "requestId" TEXT,
    "actorType" TEXT NOT NULL,
    "projectScope" TEXT,
    "sensitiveRead" BOOLEAN NOT NULL DEFAULT true,
    "metadata" TEXT
);

-- CreateIndex
CREATE INDEX "CredentialAccessAudit_credentialId_timestamp_idx" ON "CredentialAccessAudit"("credentialId", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "CredentialAccessAudit_tokenHash_timestamp_idx" ON "CredentialAccessAudit"("tokenHash", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "CredentialAccessAudit_allowed_timestamp_idx" ON "CredentialAccessAudit"("allowed", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "CredentialAccessAudit_reasonCode_timestamp_idx" ON "CredentialAccessAudit"("reasonCode", "timestamp" DESC);
