/**
 * Sets the provider/model for all AI agent purposes (admin-editable at
 * runtime; this script is the CLI equivalent).
 *
 * Usage:
 *   npx tsx scripts/set-ai-provider.ts                 # deepseek/deepseek-flash
 *   npx tsx scripts/set-ai-provider.ts zai glm-5.3-flash
 *   npx tsx scripts/set-ai-provider.ts deepseek deepseek-v4-pro
 */
import "dotenv/config";
import { prisma } from "@/lib/db";

async function main() {
  const provider = process.argv[2] ?? "deepseek";
  const model = process.argv[3] ?? "deepseek-flash";
  const purposes = ["research", "trust-safety", "evidence-verification", "matching", "support"];

  for (const purpose of purposes) {
    await prisma.modelConfig.upsert({
      where: { purpose },
      update: { provider, model, enabled: true },
      create: { purpose, provider, model },
    });
  }
  const rows = await prisma.modelConfig.findMany({ orderBy: { purpose: "asc" } });
  console.log(`Set ${purposes.length} purpose(s) → ${provider}/${model}`);
  for (const r of rows) console.log(`  ${r.purpose}: ${r.provider}/${r.model} enabled=${r.enabled}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
