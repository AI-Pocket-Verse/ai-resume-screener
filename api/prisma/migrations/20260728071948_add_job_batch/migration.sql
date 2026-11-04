-- AlterTable
ALTER TABLE "EvalJob" ADD COLUMN "batchId" TEXT;
ALTER TABLE "EvalJob" ADD COLUMN "createdBy" TEXT;

-- AlterTable
ALTER TABLE "ParseJob" ADD COLUMN "batchId" TEXT;
ALTER TABLE "ParseJob" ADD COLUMN "createdBy" TEXT;

-- CreateIndex
CREATE INDEX "EvalJob_batchId_idx" ON "EvalJob"("batchId");

-- CreateIndex
CREATE INDEX "ParseJob_batchId_idx" ON "ParseJob"("batchId");
