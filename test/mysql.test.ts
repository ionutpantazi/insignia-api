import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createDatabasePool } from "../src/config.js";
import { MysqlBackupStore } from "../src/mysql-store.js";
import { exampleBackup, exampleBackupV2 } from "./fixtures.js";

test("MySQL persists latest backups and isolates exact UID bytes across connections", {
  skip: process.env.MYSQL_INTEGRATION_TEST !== "true" && "Set MYSQL_INTEGRATION_TEST=true with a dedicated *_test database.",
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
