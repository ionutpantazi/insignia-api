import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createDatabasePool } from "../src/config.js";
import { MysqlProfileStore } from "../src/mysql-profile-store.js";
import { exampleProfile } from "./fixtures.js";

test("MySQL isolates v5 profiles by UID and leaves stored legacy profiles untouched", {
  skip: process.env.MYSQL_INTEGRATION_TEST !== "true" && "Set MYSQL_INTEGRATION_TEST=true with a dedicated *_test database.",
}, async () => {
  assert.match(process.env.MYSQL_DATABASE ?? "", /_test$/, "Use a dedicated database ending in _test.");
  const pool = createDatabasePool();
  const uid = `profile-test-${randomUUID()}`;
  const uidBytes = Buffer.from(uid, "utf8");
  const id = randomUUID();
  const legacyId = randomUUID();
  const time = new Date("2026-11-19T18:20:00.123Z");
  const later = new Date("2026-11-19T18:22:00.456Z");
  const profile = exampleProfile();
  const legacy = { schemaVersion: 4, name: "Legacy" };
  try {
    await pool.query(await readFile(new URL("../migrations/002-settings-profiles.sql", import.meta.url), "utf8"));
    await pool.execute(
      "INSERT INTO settings_profiles (firebase_uid, profile_id, name, payload, updated_at) VALUES (?, ?, ?, ?, ?)",
      [uidBytes, legacyId, legacy.name, JSON.stringify(legacy), time],
    );
    const profiles = new MysqlProfileStore(pool);
    await profiles.create(uid, id, profile, time);
    assert.deepEqual(await profiles.list(uid, ""), [{ id, name: profile.name, updatedAt: time.toISOString() }]);
    assert.deepEqual(await profiles.list(uid.toUpperCase(), ""), []);
    assert.equal(await profiles.get(uid, legacyId), null);
    assert.equal(await profiles.get(uid.toUpperCase(), id), null);
    const edited = exampleProfile("Updated");
    edited.settings.radio.width = 0;
    assert.equal(await profiles.overwrite(uid, legacyId, edited, later), false);
    assert.equal(await profiles.overwrite(uid.toUpperCase(), id, edited, later), false);
    assert.equal(await profiles.overwrite(uid, id, edited, later), true);
    assert.deepEqual(await profiles.get(uid, id), { payload: edited, updatedAt: later.toISOString() });
    const [rows] = await pool.query(
      "SELECT payload FROM settings_profiles WHERE firebase_uid = ? AND profile_id = ?", [uidBytes, legacyId],
    );
    assert.deepEqual(rows, [{ payload: legacy }]);
  } finally {
    try {
      await pool.execute("DELETE FROM settings_profiles WHERE firebase_uid = ?", [uidBytes]);
    } finally {
      await pool.end();
    }
  }
});
