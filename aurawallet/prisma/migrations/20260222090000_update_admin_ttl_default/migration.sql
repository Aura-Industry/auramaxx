-- Raise default admin token TTL from 7 days to 30 days.
-- Only migrate installs still on the old default value so custom overrides are preserved.
UPDATE "SystemDefault"
SET
  "value" = '2592000',
  "description" = 'Time-to-live for admin tokens (30 days)',
  "updatedAt" = datetime('now')
WHERE
  "key" = 'ttl.admin'
  AND trim("value") IN ('604800', '"604800"');
