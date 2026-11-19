import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { createApp } from "./app.js";
import { createDatabasePool, portFromEnv, requiredEnv } from "./config.js";
import { ConfigurationError, errorSummary } from "./errors.js";
import { MysqlBackupStore } from "./mysql-store.js";
import { MysqlProfileStore } from "./mysql-profile-store.js";

async function main() {
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new ConfigurationError("FIREBASE_AUTH_EMULATOR_HOST must not be set for this API.");
  }
  const port = portFromEnv("PORT", 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  const firebase = initializeApp({
    credential: applicationDefault(),
    projectId: requiredEnv("FIREBASE_PROJECT_ID"),
  });
  const auth = getAuth(firebase);
  const pool = createDatabasePool();
  try {
    await pool.query("SELECT firebase_uid FROM settings_backups LIMIT 0");
    await pool.query("SELECT firebase_uid FROM settings_profiles LIMIT 0");
  } catch (error) {
    await pool.end();
    throw error;
  }
  const app = createApp({
    store: new MysqlBackupStore(pool),
    profiles: new MysqlProfileStore(pool),
    verifyIdToken: (token) => auth.verifyIdToken(token, true),
    logger: console,
  });
  const server = app.listen(port, host, () => {
    console.log(`Settings backup API listening on ${host}:${port}`);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  const closeDatabase = async () => {
    try {
      await pool.end();
    } catch (error) {
      console.error("Database shutdown failed", errorSummary(error));
      process.exitCode = 1;
    }
  };
  server.on("error", (error) => {
    console.error("HTTP server failed", errorSummary(error));
    process.exitCode = 1;
    void closeDatabase();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close(() => {
        void closeDatabase();
      });
    });
  }
}

main().catch((error: unknown) => {
  console.error("API startup failed", errorSummary(error));
  process.exitCode = 1;
});
