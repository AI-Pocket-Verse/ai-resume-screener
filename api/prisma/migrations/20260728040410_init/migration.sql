-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ownerId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "location" TEXT,
    "level" TEXT,
    "headcount" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'open',
    "jdRaw" TEXT NOT NULL,
    "jdSource" TEXT NOT NULL DEFAULT 'paste',
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Job_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Scorecard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "gates" TEXT NOT NULL,
    "dimensions" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Scorecard_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Candidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "mergedIntoId" TEXT,
    "lastActivityAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "piiRedactedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Candidate_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "Candidate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CandidateIdentifier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "valueHash" TEXT NOT NULL,
    "valueEnc" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "CandidateIdentifier_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CandidateAlias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    CONSTRAINT "CandidateAlias_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CandidateTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CandidateTag_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResumeFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT,
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
    CONSTRAINT "ResumeFile_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ParseJob" (
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
    CONSTRAINT "ParseJob_resumeFileId_fkey" FOREIGN KEY ("resumeFileId") REFERENCES "ResumeFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResumeParsed" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resumeFileId" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "model" TEXT,
    "deliveryMode" TEXT NOT NULL,
    "raw" TEXT NOT NULL,
    "editedFields" TEXT NOT NULL DEFAULT '{}',
    "derived" TEXT NOT NULL DEFAULT '{}',
    "latencyMs" INTEGER,
    "tokenCost" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ResumeParsed_resumeFileId_fkey" FOREIGN KEY ("resumeFileId") REFERENCES "ResumeFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "hrDecision" TEXT,
    "hrDecidedBy" TEXT,
    "hrDecidedAt" DATETIME,
    "hrReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Application_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Application_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Evaluation" (
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
    "latencyMs" INTEGER,
    "tokenCost" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    CONSTRAINT "Evaluation_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Evaluation_scorecardId_fkey" FOREIGN KEY ("scorecardId") REFERENCES "Scorecard" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EvalJob" (
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
    CONSTRAINT "EvalJob_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DuplicateHint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "otherId" TEXT NOT NULL,
    "matchedField" TEXT NOT NULL,
    "score" REAL NOT NULL,
    "dismissedAt" DATETIME,
    "dismissedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MergeLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fromCandidateId" TEXT NOT NULL,
    "intoCandidateId" TEXT NOT NULL,
    "matchedField" TEXT,
    "autoMerged" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" DATETIME,
    "undoneBy" TEXT
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "targetLabel" TEXT,
    "detail" TEXT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Team_name_key" ON "Team"("name");

-- CreateIndex
CREATE INDEX "Team_ownerId_idx" ON "Team"("ownerId");

-- CreateIndex
CREATE INDEX "Job_teamId_status_idx" ON "Job"("teamId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Scorecard_jobId_key" ON "Scorecard"("jobId");

-- CreateIndex
CREATE INDEX "Candidate_mergedIntoId_idx" ON "Candidate"("mergedIntoId");

-- CreateIndex
CREATE INDEX "Candidate_lastActivityAt_idx" ON "Candidate"("lastActivityAt");

-- CreateIndex
CREATE INDEX "CandidateIdentifier_candidateId_idx" ON "CandidateIdentifier"("candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateIdentifier_kind_valueHash_key" ON "CandidateIdentifier"("kind", "valueHash");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateAlias_candidateId_alias_key" ON "CandidateAlias"("candidateId", "alias");

-- CreateIndex
CREATE INDEX "CandidateTag_label_idx" ON "CandidateTag"("label");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateTag_candidateId_label_key" ON "CandidateTag"("candidateId", "label");

-- CreateIndex
CREATE INDEX "ResumeFile_parseState_idx" ON "ResumeFile"("parseState");

-- CreateIndex
CREATE INDEX "ResumeFile_sha256_idx" ON "ResumeFile"("sha256");

-- CreateIndex
CREATE INDEX "ResumeFile_candidateId_idx" ON "ResumeFile"("candidateId");

-- CreateIndex
CREATE INDEX "ParseJob_status_nextRunAt_idx" ON "ParseJob"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "ParseJob_resumeFileId_idx" ON "ParseJob"("resumeFileId");

-- CreateIndex
CREATE UNIQUE INDEX "ParseJob_activeKey_key" ON "ParseJob"("activeKey");

-- CreateIndex
CREATE UNIQUE INDEX "ResumeParsed_resumeFileId_key" ON "ResumeParsed"("resumeFileId");

-- CreateIndex
CREATE INDEX "Application_jobId_hrDecision_idx" ON "Application"("jobId", "hrDecision");

-- CreateIndex
CREATE UNIQUE INDEX "Application_candidateId_jobId_key" ON "Application"("candidateId", "jobId");

-- CreateIndex
CREATE INDEX "Evaluation_applicationId_tier_createdAt_idx" ON "Evaluation"("applicationId", "tier", "createdAt");

-- CreateIndex
CREATE INDEX "EvalJob_status_nextRunAt_idx" ON "EvalJob"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "EvalJob_applicationId_idx" ON "EvalJob"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "EvalJob_activeKey_key" ON "EvalJob"("activeKey");

-- CreateIndex
CREATE INDEX "DuplicateHint_dismissedAt_idx" ON "DuplicateHint"("dismissedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DuplicateHint_candidateId_otherId_key" ON "DuplicateHint"("candidateId", "otherId");

-- CreateIndex
CREATE INDEX "MergeLog_fromCandidateId_idx" ON "MergeLog"("fromCandidateId");

-- CreateIndex
CREATE INDEX "MergeLog_intoCandidateId_idx" ON "MergeLog"("intoCandidateId");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_at_idx" ON "AuditLog"("targetType", "targetId", "at");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_at_idx" ON "AuditLog"("actorId", "at");
