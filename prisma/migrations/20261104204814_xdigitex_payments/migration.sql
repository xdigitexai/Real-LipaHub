-- CreateEnum
CREATE TYPE "PaymentRecordStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REVERSED', 'UNCERTAIN');

-- CreateEnum
CREATE TYPE "PaymentRecordKind" AS ENUM ('DEPOSIT', 'WITHDRAWAL');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'REJECTED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JournalKind" ADD VALUE 'ORG_DEPOSIT';
ALTER TYPE "JournalKind" ADD VALUE 'WALLET_TO_CAMPAIGN';
ALTER TYPE "JournalKind" ADD VALUE 'WITHDRAWAL_RESERVE';
ALTER TYPE "JournalKind" ADD VALUE 'WITHDRAWAL_REVERSAL';

-- CreateTable
CREATE TABLE "PaymentRecord" (
    "id" TEXT NOT NULL,
    "internalRef" TEXT NOT NULL,
    "providerRef" TEXT,
    "kind" "PaymentRecordKind" NOT NULL,
    "gateway" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'xdigitex',
    "organizationId" TEXT,
    "workerId" TEXT,
    "campaignId" TEXT,
    "initiatedById" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "feeMinor" BIGINT NOT NULL DEFAULT 0,
    "netMinor" BIGINT,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "status" "PaymentRecordStatus" NOT NULL DEFAULT 'PENDING',
    "providerResponse" JSONB,
    "failureReason" TEXT,
    "journalId" TEXT,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'xdigitex',
    "eventType" TEXT NOT NULL,
    "reference" TEXT,
    "payload" JSONB NOT NULL,
    "signaturePresent" BOOLEAN NOT NULL DEFAULT false,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'RECEIVED',
    "outcome" TEXT,
    "relatedPaymentId" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRecord_internalRef_key" ON "PaymentRecord"("internalRef");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRecord_providerRef_key" ON "PaymentRecord"("providerRef");

-- CreateIndex
CREATE INDEX "PaymentRecord_status_idx" ON "PaymentRecord"("status");

-- CreateIndex
CREATE INDEX "PaymentRecord_kind_status_idx" ON "PaymentRecord"("kind", "status");

-- CreateIndex
CREATE INDEX "PaymentRecord_organizationId_idx" ON "PaymentRecord"("organizationId");

-- CreateIndex
CREATE INDEX "PaymentRecord_workerId_idx" ON "PaymentRecord"("workerId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_reference_idx" ON "WebhookDelivery"("reference");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_idx" ON "WebhookDelivery"("status");
