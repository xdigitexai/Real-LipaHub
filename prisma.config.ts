import path from "node:path";
import { defineConfig } from "prisma/config";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, ".env") });

export default defineConfig({
  schema: path.resolve(__dirname, "prisma/schema.prisma"),
  migrations: {
    path: path.resolve(__dirname, "prisma/migrations"),
  },
  datasource: {
    url: process.env.LIPAHUB_DATABASE_URL ?? "",
  },
});
