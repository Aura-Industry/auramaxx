-- Raise default agent/action token TTLs.
-- Preserve custom overrides by only migrating old default values.
UPDATE "SystemDefault"
SET
  "value" = '604800',
  "description" = 'Default time-to-live for agent tokens (7 days)',
  "updatedAt" = datetime('now')
WHERE
  "key" = 'ttl.agent'
  AND trim("value") IN ('3600', '"3600"');

UPDATE "SystemDefault"
SET
  "value" = '3600',
  "description" = 'Default time-to-live for action tokens (1 hour)',
  "updatedAt" = datetime('now')
WHERE
  "key" = 'ttl.action'
  AND trim("value") IN ('60', '"60"', '600', '"600"');
