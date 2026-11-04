/*
  Warnings:

  - Added the required column `jobId` to the `CandidateTag` table without a default value. This is not possible if the table is not empty.
  - Added the required column `jobId` to the `ResumeFile` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Application" ADD COLUMN "createdById" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CandidateTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CandidateTag_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CandidateTag_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_CandidateTag" ("candidateId", "color", "createdAt", "createdBy", "id", "label") SELECT "candidateId", "color", "createdAt", "createdBy", "id", "label" FROM "CandidateTag";
DROP TABLE "CandidateTag";
ALTER TABLE "new_CandidateTag" RENAME TO "CandidateTag";
CREATE INDEX "CandidateTag_label_idx" ON "CandidateTag"("label");
CREATE INDEX "CandidateTag_jobId_idx" ON "CandidateTag"("jobId");
CREATE UNIQUE INDEX "CandidateTag_candidateId_jobId_label_key" ON "CandidateTag"("candidateId", "jobId", "label");
CREATE TABLE "new_ResumeFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT,
    "jobId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT,
    "sha256" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "pageCount" INTEGER,
    "storagePath" TEXT NOT NULL,
    "parseState" TEXT NOT NULL DEFAULT 'pending',
    "parseStage" TEXT,
    "parseError" TEXT,
    "turnsExhausted" BOOLEAN NOT NULL DEFAULT false,
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResumeFile_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ResumeFile_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ResumeFile" ("bytes", "candidateId", "externalId", "filename", "id", "mimeType", "pageCount", "parseError", "parseStage", "parseState", "sha256", "source", "storagePath", "turnsExhausted", "uploadedAt", "uploadedById") SELECT "bytes", "candidateId", "externalId", "filename", "id", "mimeType", "pageCount", "parseError", "parseStage", "parseState", "sha256", "source", "storagePath", "turnsExhausted", "uploadedAt", "uploadedById" FROM "ResumeFile";
DROP TABLE "ResumeFile";
ALTER TABLE "new_ResumeFile" RENAME TO "ResumeFile";
CREATE INDEX "ResumeFile_parseState_idx" ON "ResumeFile"("parseState");
CREATE INDEX "ResumeFile_sha256_idx" ON "ResumeFile"("sha256");
CREATE INDEX "ResumeFile_candidateId_idx" ON "ResumeFile"("candidateId");
CREATE INDEX "ResumeFile_jobId_idx" ON "ResumeFile"("jobId");
CREATE INDEX "ResumeFile_uploadedAt_idx" ON "ResumeFile"("uploadedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
