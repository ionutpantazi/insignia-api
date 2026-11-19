import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const configUrl = new URL("../src/config.ts", import.meta.url);
const variable = "INSIGNIA_ENV_LOADING_TEST";

function readConfiguration(fileContents: string | undefined, existingValue?: string) {
  const directory = mkdtempSync(join(tmpdir(), "insignia-config-test-"));
  try {
    if (fileContents !== undefined) {
      writeFileSync(join(directory, ".env"), fileContents);
    }
    const env = { ...process.env };
    delete env[variable];
    if (existingValue !== undefined) env[variable] = existingValue;
    return spawnSync(process.execPath, [
      "--import", import.meta.resolve("tsx"),
      "--input-type=module",
      "-e",
      `const { requiredEnv } = await import(${JSON.stringify(configUrl.href)});
       process.stdout.write(requiredEnv(${JSON.stringify(variable)}));`,
    ], { cwd: directory, env, encoding: "utf8", timeout: 10_000 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("configuration loads .env before reading required environment variables", () => {
  const result = readConfiguration(`${variable}=from-file\n`);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "from-file");
});

test("existing environment variables take precedence over .env values", () => {
  const result = readConfiguration(`${variable}=from-file\n`, "from-service-manager");
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "from-service-manager");
});

test("configuration works without .env when variables are supplied externally", () => {
  const result = readConfiguration(undefined, "from-service-manager");
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "from-service-manager");
});

test("missing required variables still produce an explicit configuration error", () => {
  const result = readConfiguration(undefined);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing required environment variable: INSIGNIA_ENV_LOADING_TEST/);
});
