-- CreateEnum
CREATE TYPE "MessageWriteStatus" AS ENUM ('PENDING', 'PERSISTED', 'DEAD');

-- CreateTable
CREATE TABLE "MessageWrite" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" "MessageWriteStatus" NOT NULL DEFAULT 'PENDING',
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "persistedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,

    CONSTRAINT "MessageWrite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageWrite_senderId_requestId_key" ON "MessageWrite"("senderId", "requestId");

-- CreateIndex
CREATE INDEX "MessageWrite_roomId_acceptedAt_idx" ON "MessageWrite"("roomId", "acceptedAt");

-- AddForeignKey
ALTER TABLE "MessageWrite" ADD CONSTRAINT "MessageWrite_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageWrite" ADD CONSTRAINT "MessageWrite_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
