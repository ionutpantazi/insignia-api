import { readFile } from "node:fs/promises";
import { createDatabasePool } from "./config.js";
import { errorSummary } from "./errors.js";

async function main() {
  const sql = await readFile(new URL("../migrations/001-settings-backups.sql", import.meta.url), "utf8");
  const pool = createDatabasePool();
  try {
    await pool.query(sql);
    console.log("Settings backup table is ready.");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Database migration failed", errorSummary(error));
  process.exitCode = 1;
});
