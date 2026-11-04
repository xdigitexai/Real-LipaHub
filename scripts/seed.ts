/**
 * Seed script — platform admin, AI model defaults, chart of accounts.
 * Idempotent: safe to run repeatedly.
 * Run: npm run db:seed
 *
 * Admin credentials come from env with local-dev fallback:
 *   LIPAHUB_ADMIN_EMAIL / LIPAHUB_ADMIN_PASSWORD
 */
import "dotenv/config";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/crypto";
import { ensureChartOfAccounts } from "@/modules/finance";
import { logger } from "@/lib/logger";

async function main() {
  await ensureChartOfAccounts();
  logger.info("seed_chart_of_accounts_ok");

  const adminEmail = (process.env.LIPAHUB_ADMIN_EMAIL ?? "admin@lipahub.local").toLowerCase();
  const adminPassword = process.env.LIPAHUB_ADMIN_PASSWORD ?? "LipaHubAdmin!2026";
  const admin = await prisma.user.upsert({
    where: { emailNormalized: adminEmail },
    update: { role: "ADMIN", status: "ACTIVE" },
    create: {
      email: adminEmail,
      emailNormalized: adminEmail,
      passwordHash: await hashPassword(adminPassword),
      name: "LipaHub Admin",
      role: "ADMIN",
    },
  });
  logger.info("seed_admin_ready", { email: adminEmail });

  // AI model defaults — admin-editable in the dashboard; adapter reads DB first.
  const defaults = [
    { purpose: "research", model: process.env.LIPAHUB_AI_MODEL ?? "glm-5.3-flash" },
    { purpose: "trust-safety", model: process.env.LIPAHUB_AI_MODEL ?? "glm-5.3-flash" },
    { purpose: "evidence-verification", model: process.env.LIPAHUB_AI_MODEL ?? "glm-5.3-flash" },
    { purpose: "matching", model: process.env.LIPAHUB_AI_MODEL ?? "glm-5.3-flash" },
    { purpose: "support", model: process.env.LIPAHUB_AI_MODEL ?? "glm-5.3-flash" },
  ];
  for (const d of defaults) {
    await prisma.modelConfig.upsert({
      where: { purpose: d.purpose },
      update: {},
      create: { purpose: d.purpose, provider: "zai", model: d.model },
    });
  }
  logger.info("seed_model_configs_ok", { count: defaults.length });

  logger.info("seed_done", { adminId: admin.id });
  console.log(`\nAdmin login: ${adminEmail} / ${process.env.LIPAHUB_ADMIN_PASSWORD ? "(from env)" : adminPassword}\n`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
