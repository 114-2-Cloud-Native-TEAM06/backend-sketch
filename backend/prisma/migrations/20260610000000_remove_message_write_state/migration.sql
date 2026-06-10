-- Move durable write/fanout state onto Message and remove the MessageWrite buffer table.
CREATE TYPE "MessageStatus" AS ENUM ('PERSISTED', 'FANOUTED', 'FANOUT_FAILED');

ALTER TABLE "Message"
  ADD COLUMN "status" "MessageStatus" NOT NULL DEFAULT 'PERSISTED',
  ADD COLUMN "persistedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "fanoutedAt" TIMESTAMP(3),
  ADD COLUMN "failedAt" TIMESTAMP(3),
  ADD COLUMN "failureReason" TEXT;

UPDATE "Message" AS m
SET
  "status" = CASE
    WHEN mw."status"::text = 'FANOUTED' THEN 'FANOUTED'::"MessageStatus"
    ELSE 'PERSISTED'::"MessageStatus"
  END,
  "persistedAt" = COALESCE(mw."persistedAt", m."createdAt"),
  "fanoutedAt" = CASE
    WHEN mw."status"::text = 'FANOUTED' THEN COALESCE(mo."publishedAt", mw."persistedAt", m."createdAt")
    ELSE NULL
  END,
  "failedAt" = mw."failedAt",
  "failureReason" = mw."failureReason"
FROM "MessageWrite" AS mw
LEFT JOIN "MessageOutbox" AS mo
  ON mo."messageId" = mw."id"
  AND mo."eventType" = 'message.created'
WHERE
  m."id" = mw."id"
  OR (
    m."senderId" = mw."senderId"
    AND m."requestId" = mw."requestId"
  );

DROP TABLE "MessageWrite";
DROP TYPE "MessageWriteStatus";
