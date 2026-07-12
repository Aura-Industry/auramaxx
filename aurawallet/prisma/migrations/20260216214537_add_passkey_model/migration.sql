-- CreateTable
CREATE TABLE "Passkey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "credentialId" TEXT NOT NULL,
    "publicKey" BLOB NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "transports" TEXT NOT NULL DEFAULT '[]',
    "rpId" TEXT NOT NULL,
    "aaguid" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "Passkey_credentialId_key" ON "Passkey"("credentialId");

-- CreateIndex
CREATE INDEX "Passkey_rpId_idx" ON "Passkey"("rpId");
