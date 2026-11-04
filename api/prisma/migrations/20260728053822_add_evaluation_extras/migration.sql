-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Evaluation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "scorecardSnapshot" TEXT NOT NULL,
    "scorecardId" TEXT,
    "promptVersion" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "model" TEXT,
    "gateResults" TEXT NOT NULL,
    "scores" TEXT NOT NULL,
    "highlights" TEXT NOT NULL,
    "concerns" TEXT NOT NULL,
    "summary" TEXT,
    "grade" TEXT,
    "weightedScore" REAL,
    "supersededBy" TEXT,
    "extras" TEXT NOT NULL DEFAULT '{}',
    "latencyMs" INTEGER,
    "tokenCost" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    CONSTRAINT "Evaluation_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Evaluation_scorecardId_fkey" FOREIGN KEY ("scorecardId") REFERENCES "Scorecard" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Evaluation" ("applicationId", "concerns", "createdAt", "createdBy", "gateResults", "grade", "highlights", "id", "latencyMs", "model", "parserVersion", "promptVersion", "providerId", "scorecardId", "scorecardSnapshot", "scores", "summary", "supersededBy", "tier", "tokenCost", "weightedScore") SELECT "applicationId", "concerns", "createdAt", "createdBy", "gateResults", "grade", "highlights", "id", "latencyMs", "model", "parserVersion", "promptVersion", "providerId", "scorecardId", "scorecardSnapshot", "scores", "summary", "supersededBy", "tier", "tokenCost", "weightedScore" FROM "Evaluation";
DROP TABLE "Evaluation";
ALTER TABLE "new_Evaluation" RENAME TO "Evaluation";
CREATE INDEX "Evaluation_applicationId_tier_createdAt_idx" ON "Evaluation"("applicationId", "tier", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
