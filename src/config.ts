import { existsSync, readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { createPool } from "mysql2/promise";
import { ConfigurationError } from "./errors.js";

if (existsSync(".env")) {
  loadEnvFile(".env");
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ConfigurationError(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function portFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new ConfigurationError(`${name} must be an integer between 1 and 65535.`);
  }
  return Number(value);
}

export function createDatabasePool() {
  const tls = process.env.MYSQL_TLS ?? "false";
  if (tls !== "true" && tls !== "false") {
    throw new ConfigurationError("MYSQL_TLS must be true or false.");
  }
  if (process.env.MYSQL_SSL_CA_FILE && tls !== "true") {
    throw new ConfigurationError("MYSQL_SSL_CA_FILE requires MYSQL_TLS=true.");
  }
  return createPool({
    host: requiredEnv("MYSQL_HOST"),
    port: portFromEnv("MYSQL_PORT", 3306),
    database: requiredEnv("MYSQL_DATABASE"),
    user: requiredEnv("MYSQL_USER"),
    password: requiredEnv("MYSQL_PASSWORD"),
    charset: "utf8mb4",
    timezone: "Z",
    connectionLimit: 10,
    waitForConnections: true,
    queueLimit: 100,
    ...(tls === "true"
      ? {
          ssl: {
            rejectUnauthorized: true,
            ...(process.env.MYSQL_SSL_CA_FILE
              ? { ca: readFileSync(process.env.MYSQL_SSL_CA_FILE, "utf8") }
              : {}),
          },
        }
      : {}),
  });
}
