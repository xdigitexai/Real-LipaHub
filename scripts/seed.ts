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
  // Provider choice follows env: DeepSeek when its key is present, else Z.ai.
  const useDeepSeek = Boolean(process.env.DEEPSEEK_API_KEY);
  const provider = useDeepSeek ? "deepseek" : "zai";
  const model = useDeepSeek ? "deepseek-flash" : (process.env.LIPAHUB_AI_MODEL ?? "glm-5.3-flash");
  const purposes = ["research", "trust-safety", "evidence-verification", "matching", "support"];
  for (const purpose of purposes) {
    const pricing = purpose === "evidence-verification" ? { temperature: 0.0 } : {};
    await prisma.modelConfig.upsert({
      where: { purpose },
      update: {}, // admin-managed at runtime; seeding never overrides
      create: { purpose, provider, model, ...pricing },
    });
  }
  logger.info("seed_model_configs_ok", { count: purposes.length, provider, model });

  logger.info("seed_done", { adminId: admin.id });
  console.log(`\nAdmin login: ${adminEmail} / ${process.env.LIPAHUB_ADMIN_PASSWORD ? "(from env)" : adminPassword}\n`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
