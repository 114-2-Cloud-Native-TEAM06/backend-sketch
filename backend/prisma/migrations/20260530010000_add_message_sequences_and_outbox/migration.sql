-- Add room-local message sequence state.
ALTER TABLE "Room" ADD COLUMN "nextMessageSeq" BIGINT NOT NULL DEFAULT 1;

ALTER TABLE "Message" ADD COLUMN "roomSequence" BIGINT;

WITH sequenced AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (PARTITION BY "roomId" ORDER BY "createdAt", "id")::BIGINT AS "roomSequence"
  FROM "Message"
)
UPDATE "Message" AS m
SET "roomSequence" = s."roomSequence"
FROM sequenced AS s
WHERE m."id" = s."id";

UPDATE "Room" AS r
SET "nextMessageSeq" = COALESCE(room_max."maxSequence", 0) + 1
FROM (
  SELECT "roomId", MAX("roomSequence") AS "maxSequence"
  FROM "Message"
  GROUP BY "roomId"
) AS room_max
WHERE r."id" = room_max."roomId";

ALTER TABLE "Message" ALTER COLUMN "roomSequence" SET NOT NULL;

CREATE INDEX "Message_roomId_roomSequence_idx" ON "Message"("roomId", "roomSequence");
CREATE UNIQUE INDEX "Message_roomId_roomSequence_key" ON "Message"("roomId", "roomSequence");

-- Move message writes to an explicit persistence/fanout state machine.
ALTER TYPE "MessageWriteStatus" ADD VALUE IF NOT EXISTS 'FANOUTED';

-- Add a durable fanout outbox.
CREATE TYPE "MessageOutboxStatus" AS ENUM ('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED');

CREATE TABLE "MessageOutbox" (
  "id" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "status" "MessageOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "lockedAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "originConnectionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MessageOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MessageOutbox_eventType_messageId_key" ON "MessageOutbox"("eventType", "messageId");
CREATE INDEX "MessageOutbox_status_nextAttemptAt_idx" ON "MessageOutbox"("status", "nextAttemptAt");
CREATE INDEX "MessageOutbox_messageId_idx" ON "MessageOutbox"("messageId");

ALTER TABLE "MessageOutbox"
ADD CONSTRAINT "MessageOutbox_messageId_fkey"
FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
