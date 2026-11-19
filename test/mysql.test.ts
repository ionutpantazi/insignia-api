import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createDatabasePool } from "../src/config.js";
import { MysqlBackupStore } from "../src/mysql-store.js";
import { MysqlProfileStore } from "../src/mysql-profile-store.js";
import { exampleBackup, exampleBackupV2, exampleProfile } from "./fixtures.js";

const skip = process.env.MYSQL_INTEGRATION_TEST !== "true" && "Set MYSQL_INTEGRATION_TEST=true with a dedicated *_test database.";

test("MySQL persists latest backups and isolates exact UID bytes across connections", {
  skip,
}, async () => {
  assert.match(process.env.MYSQL_DATABASE ?? "", /_test$/, "Use a dedicated database ending in _test.");
  const firstPool = createDatabasePool();
  const secondPool = createDatabasePool();
  const uid = `backup-test-${randomUUID()}`;
  const uids = [uid, uid.toUpperCase(), `${uid} `];
  try {
    const sql = await readFile(new URL("../migrations/001-settings-backups.sql", import.meta.url), "utf8");
    await firstPool.query(sql);
    const first = new MysqlBackupStore(firstPool);
    const second = new MysqlBackupStore(secondPool);
    assert.equal(await first.get(uid), null);
    const initial = exampleBackup();
    const changed = exampleBackup();
    changed.preferences.player.selection = "spotify";
    await first.save(uid, initial);
    assert.deepEqual((await second.get(uid))?.backup, initial);
    await first.save(uid, changed);
    const stored = await second.get(uid);
    assert.deepEqual(stored?.backup, changed);
    assert.match(stored?.updatedAt ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const v2 = exampleBackupV2();
    await first.save(uid, v2);
    assert.deepEqual((await second.get(uid))?.backup, v2);
    for (const otherUid of uids.slice(1)) {
      assert.equal(await second.get(otherUid), null);
      await second.save(otherUid, initial);
      assert.deepEqual((await first.get(otherUid))?.backup, initial);
    }
    assert.deepEqual((await second.get(uid))?.backup, v2);
  } finally {
    try {
      for (const ownUid of uids) {
        await firstPool.execute("DELETE FROM settings_backups WHERE firebase_uid = ?", [Buffer.from(ownUid, "utf8")]);
      }
    } finally {
      await Promise.all([firstPool.end(), secondPool.end()]);
    }
  }
});

test("MySQL stores profiles separately and overwrites only the matching UID and ID", { skip }, async () => {
  assert.match(process.env.MYSQL_DATABASE ?? "", /_test$/, "Use a dedicated database ending in _test.");
  const pool = createDatabasePool();
  const uid = `profile-test-${randomUUID()}`;
  const otherUid = uid.toUpperCase();
  const firstId = randomUUID();
  const secondId = randomUUID();
  try {
    for (const migration of ["001-settings-backups.sql", "002-settings-profiles.sql"]) {
      await pool.query(await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    }
    const profiles = new MysqlProfileStore(pool);
    const backups = new MysqlBackupStore(pool);
    const v2 = exampleBackupV2();
    const first = exampleProfile("Daily commute");
    const second = exampleProfile("Weekend");
    const changed = exampleProfile("Updated daily commute");
    const time = new Date("2026-11-19T18:20:00.123Z");
    const later = new Date("2026-11-19T18:22:00.456Z");
    await backups.save(uid, v2);
    await profiles.create(uid, firstId, first, time);
    await profiles.create(uid, secondId, second, time);
    assert.deepEqual(await profiles.list(uid, ""), [
      { id: firstId, name: first.name, updatedAt: time.toISOString() },
      { id: secondId, name: second.name, updatedAt: time.toISOString() },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    assert.deepEqual(await profiles.list(otherUid, ""), []);
    assert.equal(await profiles.get(otherUid, firstId), null);
    assert.equal(await profiles.overwrite(otherUid, firstId, changed, later), false);
    assert.deepEqual(await profiles.get(uid, firstId), { payload: first, updatedAt: time.toISOString() });
    assert.equal(await profiles.overwrite(uid, firstId, changed, later), true);
    assert.deepEqual(await profiles.get(uid, firstId), { payload: changed, updatedAt: later.toISOString() });
    assert.deepEqual(await profiles.get(uid, secondId), { payload: second, updatedAt: time.toISOString() });
    assert.deepEqual((await backups.get(uid))?.backup, v2);
  } finally {
    try {
      await pool.execute("DELETE FROM settings_profiles WHERE firebase_uid = ?", [Buffer.from(uid, "utf8")]);
      await pool.execute("DELETE FROM settings_backups WHERE firebase_uid = ?", [Buffer.from(uid, "utf8")]);
    } finally {
      await pool.end();
    }
  }
});
