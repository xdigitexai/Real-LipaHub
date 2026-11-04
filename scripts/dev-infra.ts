/**
 * Dev infrastructure — embedded PostgreSQL 17 (no Docker/WSL needed).
 *
 * Uses the @embedded-postgres/windows-x64 binaries driven through
 * initdb/pg_ctl directly (the wrapper library's beta binaries crash on
 * this machine). Data dir lives outside the repo. Run: npm run infra
 *
 * NOTES:
 *  - initdb uses --no-sync and the server runs with fsync=off: LOCAL
 *    DEVELOPMENT ONLY. Production uses a real PostgreSQL server.
 *  - Idempotent: re-running starts the existing cluster.
 */
import "dotenv/config";
import { spawnSync, spawn } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

const PG_PORT = 5433;
const DATA_DIR = resolve(process.env.LIPAHUB_PGDATA ?? "C:/Users/Admin/lipahub-pgdata");
const BIN_DIR = resolve(__dirname, "../node_modules/@embedded-postgres/windows-x64/native/bin");

function run(cmd: string, args: string[]): number {
  const r = spawnSync(cmd, args, { stdio: "pipe", encoding: "utf8" });
  if (r.status !== 0) {
    logger.error("infra_cmd_failed", { cmd, args, stderr: (r.stderr ?? "").slice(0, 400) });
  }
  return r.status ?? 1;
}

async function main() {
  const initdb = resolve(BIN_DIR, "initdb.exe");
  const pgctl = resolve(BIN_DIR, "pg_ctl.exe");

  if (!existsSync(resolve(DATA_DIR, "PG_VERSION"))) {
    mkdirSync(DATA_DIR, { recursive: true });
    const pwFile = resolve(DATA_DIR, "..", "lipahub-pw.tmp");
    writeFileSync(pwFile, "lipahub_dev_password\n");
    const status = run(initdb, [
      "-D", DATA_DIR, "--no-locale", "-E", "UTF8", "-U", "lipahub",
      "--no-sync", "-A", "md5", `--pwfile=${pwFile}`,
    ]);
    if (status !== 0) throw new Error("initdb failed");
    logger.info("pg_initialised", { dataDir: DATA_DIR });
  } else {
    logger.info("pg_using_existing_cluster", { dataDir: DATA_DIR });
  }

  // Start (long-running server process, detached; logs to its own file)
  const serverLog = resolve(DATA_DIR, "..", "lipahub-pg.log");
  const child = spawn(pgctl, [
    "-D", DATA_DIR, "-l", serverLog, "start",
    "-o", `-p ${PG_PORT} -F -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
  ], { stdio: "ignore", detached: true, shell: false });
  child.unref();
  // pg_ctl start exits once the server is up; keep a handle briefly.
  await new Promise((r) => setTimeout(r, 3000));

  // Wait for readiness, then ensure the app database exists.
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const c = new Client({ host: "localhost", port: PG_PORT, user: "lipahub", password: "lipahub_dev_password", database: "postgres" });
    try {
      await c.connect();
      const res = await c.query("SELECT 1 FROM pg_database WHERE datname = 'lipahub'");
      if (res.rowCount === 0) {
        await c.query("CREATE DATABASE lipahub");
        logger.info("pg_database_created", { database: "lipahub" });
      }
      await c.end();
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!ready) throw new Error("PostgreSQL did not become ready in time");

  logger.info("infra_running", {
    port: PG_PORT,
    databaseUrl: env.databaseUrl.replace(/:[^:@]+@/, ":***@"),
    note: "Keep this process alive while developing; server keeps running after exit",
  });
}

main().catch((e) => {
  logger.error("infra_fatal", { error: String(e) });
  process.exit(1);
});
