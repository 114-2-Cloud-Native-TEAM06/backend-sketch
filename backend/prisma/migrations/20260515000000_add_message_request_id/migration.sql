-- AlterTable
ALTER TABLE "Message" ADD COLUMN "requestId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Message_senderId_requestId_key" ON "Message"("senderId", "requestId");
