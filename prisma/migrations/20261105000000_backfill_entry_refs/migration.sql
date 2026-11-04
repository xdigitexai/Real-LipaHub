-- Backfill entry-level references from their journals for rows created
-- before entry-level attribution was introduced.
UPDATE "LedgerEntry"
SET "referenceType" = j."referenceType",
    "referenceId"  = j."referenceId"
FROM "LedgerJournal" j
WHERE "LedgerEntry"."journalId" = j."id"
  AND "LedgerEntry"."referenceType" IS NULL
  AND j."referenceType" IS NOT NULL;
