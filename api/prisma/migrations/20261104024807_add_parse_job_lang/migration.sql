-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ParseJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resumeFileId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activeKey" TEXT,
    "batchId" TEXT,
    "createdBy" TEXT,
    "lang" TEXT NOT NULL DEFAULT 'zh',
    CONSTRAINT "ParseJob_resumeFileId_fkey" FOREIGN KEY ("resumeFileId") REFERENCES "ResumeFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ParseJob" ("activeKey", "attempt", "batchId", "createdAt", "createdBy", "finishedAt", "id", "lastError", "nextRunAt", "resumeFileId", "startedAt", "status") SELECT "activeKey", "attempt", "batchId", "createdAt", "createdBy", "finishedAt", "id", "lastError", "nextRunAt", "resumeFileId", "startedAt", "status" FROM "ParseJob";
DROP TABLE "ParseJob";
ALTER TABLE "new_ParseJob" RENAME TO "ParseJob";
CREATE INDEX "ParseJob_status_nextRunAt_idx" ON "ParseJob"("status", "nextRunAt");
CREATE INDEX "ParseJob_resumeFileId_idx" ON "ParseJob"("resumeFileId");
CREATE INDEX "ParseJob_batchId_idx" ON "ParseJob"("batchId");
CREATE UNIQUE INDEX "ParseJob_activeKey_key" ON "ParseJob"("activeKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
