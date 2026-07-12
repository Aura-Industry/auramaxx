-- CreateTable
CREATE TABLE "AgentProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "auraId" INTEGER,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "profileImage" TEXT,
    "attributes" TEXT,
    "inboundSeq" INTEGER,
    "inboundMode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SocialMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "timestamp" INTEGER NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'mainnet',
    "signature" TEXT NOT NULL,
    "signer" TEXT NOT NULL,
    "syncStatus" TEXT NOT NULL DEFAULT 'pending',
    "syncCode" TEXT,
    "syncDetail" TEXT,
    "syncedAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "InboundMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "authorAuraId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "timestamp" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentProfile_agentId_key" ON "AgentProfile"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentProfile_auraId_key" ON "AgentProfile"("auraId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialMessage_hash_key" ON "SocialMessage"("hash");

-- CreateIndex
CREATE INDEX "SocialMessage_agentId_createdAt_idx" ON "SocialMessage"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "SocialMessage_agentId_type_idx" ON "SocialMessage"("agentId", "type");

-- CreateIndex
CREATE INDEX "SocialMessage_syncStatus_nextRetryAt_idx" ON "SocialMessage"("syncStatus", "nextRetryAt");

-- CreateIndex
CREATE INDEX "SocialMessage_type_createdAt_idx" ON "SocialMessage"("type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboundMessage_hash_key" ON "InboundMessage"("hash");

-- CreateIndex
CREATE INDEX "InboundMessage_agentId_type_idx" ON "InboundMessage"("agentId", "type");

-- CreateIndex
CREATE INDEX "InboundMessage_agentId_timestamp_idx" ON "InboundMessage"("agentId", "timestamp");

-- CreateIndex
CREATE INDEX "InboundMessage_authorAuraId_idx" ON "InboundMessage"("authorAuraId");
