import { readFile } from "node:fs/promises";
import { createDatabasePool } from "./config.js";
import { errorSummary } from "./errors.js";

async function main() {
  const pool = createDatabasePool();
  try {
    for (const migration of ["001-settings-backups.sql", "002-settings-profiles.sql"]) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8");
      await pool.query(sql);
      console.log(`Applied ${migration}.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Database migration failed", errorSummary(error));
  process.exitCode = 1;
});
