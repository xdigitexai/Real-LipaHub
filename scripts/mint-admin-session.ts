/** Mints a short-lived admin session for local HTTP verification (dev only). Prints the token. */
import "dotenv/config";
import { prisma } from "@/lib/db";
import { generateSessionToken, sha256 } from "@/lib/crypto";

async function main() {
  // Dev-only operational helper: never allow minting sessions in production.
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to mint a session in production");
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { emailNormalized: "admin@lipahub.local" } });
  const token = generateSessionToken();
  await prisma.session.create({
    data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 24 * 3600 * 1000), userAgent: "ops-verification" },
  });
  console.log(token);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
