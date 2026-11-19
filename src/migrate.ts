import { readFile } from "node:fs/promises";
import { createDatabasePool } from "./config.js";
import { errorSummary } from "./errors.js";

async function main() {
  const pool = createDatabasePool();
  try {
    const sql = await readFile(new URL("../migrations/002-settings-profiles.sql", import.meta.url), "utf8");
    await pool.query(sql);
    console.log("Settings profile table is ready.");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Database migration failed", errorSummary(error));
  process.exitCode = 1;
});
