-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_EvalJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
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
    CONSTRAINT "EvalJob_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_EvalJob" ("activeKey", "applicationId", "attempt", "batchId", "createdAt", "createdBy", "finishedAt", "id", "lastError", "nextRunAt", "startedAt", "status", "tier") SELECT "activeKey", "applicationId", "attempt", "batchId", "createdAt", "createdBy", "finishedAt", "id", "lastError", "nextRunAt", "startedAt", "status", "tier" FROM "EvalJob";
DROP TABLE "EvalJob";
ALTER TABLE "new_EvalJob" RENAME TO "EvalJob";
CREATE INDEX "EvalJob_status_nextRunAt_idx" ON "EvalJob"("status", "nextRunAt");
CREATE INDEX "EvalJob_applicationId_idx" ON "EvalJob"("applicationId");
CREATE INDEX "EvalJob_batchId_idx" ON "EvalJob"("batchId");
CREATE UNIQUE INDEX "EvalJob_activeKey_key" ON "EvalJob"("activeKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
