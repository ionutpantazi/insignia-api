import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";
import { createApp } from "../src/app.js";
import { type Backup, type BackupStore, type StoredBackup } from "../src/backup.js";
import { exampleBackup, exampleBackupV2 } from "./fixtures.js";

class MemoryStore implements BackupStore {
  readonly backups = new Map<string, StoredBackup>();
  fail = false;
  calls = 0;

  async save(uid: string, backup: Backup) {
    this.calls++;
    if (this.fail) throw new Error("Database unavailable");
    this.backups.set(uid, { backup: structuredClone(backup), updatedAt: "2026-11-19T16:00:00.000Z" });
  }

  async get(uid: string) {
    this.calls++;
    if (this.fail) throw new Error("Database unavailable");
    return structuredClone(this.backups.get(uid) ?? null);
  }
}

const store = new MemoryStore();
const logs: unknown[][] = [];
const app = createApp({
  store,
  verifyIdToken: async (token) => {
    if (token === "user-a-token") return { uid: "user-a" };
    if (token === "user-b-token") return { uid: "user-b" };
    if (token === "auth-outage") throw Object.assign(new Error("Auth unavailable"), { code: "app/network-error" });
    const code = token === "revoked" ? "auth/id-token-revoked" : "auth/argument-error";
    throw Object.assign(new Error("Invalid token"), { code });
  },
  logger: { error: (...args: unknown[]) => { logs.push(args); } },
});
const server = app.listen(0, "127.0.0.1");
let baseUrl: string;

before(async () => {
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}/v1/me/settings-backup`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve(); });
    server.closeAllConnections();
  });
});

beforeEach(() => {
  store.backups.clear();
  store.fail = false;
  store.calls = 0;
  logs.length = 0;
});

function request(
  method: "PUT" | "GET",
  token = "user-a-token",
  body?: unknown,
  suffix = "",
  version: 1 | 2 = 1,
) {
  return fetch(baseUrl.replace("/v1/", `/v${version}/`) + suffix, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("manual save/retrieve round-trips the exact backup and disables caching", async () => {
  const backup = exampleBackup();
  const saved = await request("PUT", "user-a-token", backup);
  assert.equal(saved.status, 204);
  assert.equal(await saved.text(), "");
  const restored = await request("GET");
  assert.equal(restored.status, 200);
  assert.equal(restored.headers.get("cache-control"), "no-store");
  assert.equal(restored.headers.get("etag"), null);
  assert.deepEqual(await restored.json(), { backup, updatedAt: "2026-11-19T16:00:00.000Z" });
});

test("no backup returns a distinct 404 rather than defaults", async () => {
  const response = await request("GET");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: { code: "NO_BACKUP", message: "No settings backup exists for this account." },
  });
});

test("token identity controls reads and writes even when a query names another user", async () => {
  const a = exampleBackup();
  const b = exampleBackup();
  b.preferences.player.selection = "spotify";
  assert.equal((await request("PUT", "user-a-token", a)).status, 204);
  assert.equal((await request("GET", "user-b-token", undefined, "?uid=user-a")).status, 404);
  assert.equal((await request("PUT", "user-b-token", b, "?uid=user-a")).status, 204);
  assert.deepEqual((await (await request("GET")).json()).backup, a);
  assert.deepEqual((await (await request("GET", "user-b-token")).json()).backup, b);
  assert.equal((await fetch(baseUrl.replace("/me/", "/user-a/"), {
    headers: { Authorization: "Bearer user-b-token" },
  })).status, 404);
});

test("a save replaces only that user's latest backup", async () => {
  await request("PUT", "user-a-token", exampleBackup());
  const latest = exampleBackup();
  latest.preferences.sections.clock.visible = false;
  latest.preferences.player.selection = "radio";
  assert.equal((await request("PUT", "user-a-token", latest)).status, 204);
  assert.equal(store.backups.size, 1);
  assert.deepEqual((await (await request("GET")).json()).backup, latest);
});

test("missing, malformed, invalid, and revoked credentials cannot access storage", async () => {
  for (const version of [1, 2] as const) {
    for (const method of ["GET", "PUT"] as const) {
      for (const authorization of ["", "Basic abc", "Bearer invalid", "Bearer revoked", "Bearer two tokens"]) {
        const response = await fetch(baseUrl.replace("/v1/", `/v${version}/`), {
          method,
          headers: { Authorization: authorization, "Content-Type": "application/json" },
          ...(method === "PUT" ? { body: JSON.stringify(version === 1 ? exampleBackup() : exampleBackupV2()) } : {}),
        });
        assert.equal(response.status, 401);
        assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer/);
        assert.equal((await response.json()).error.code, "UNAUTHENTICATED");
      }
    }
  }
  assert.equal(store.calls, 0);
});

test("auth infrastructure failures return 503 and are logged without tokens", async () => {
  const response = await request("GET", "auth-outage");
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "AUTH_UNAVAILABLE");
  assert.equal(store.calls, 0);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(JSON.stringify(logs), /auth-outage/);
});

test("unknown versions, missing fields, wrong types, enums, and positions are rejected without overwriting", async () => {
  const original = exampleBackup();
  await request("PUT", "user-a-token", original);
  const invalidBackups: unknown[] = [
    { ...exampleBackup(), schemaVersion: 2 },
    { ...exampleBackup(), schemaVersion: "1" },
    { schemaVersion: 1, preferences: {} },
    { ...exampleBackup(), userId: "user-b" },
    [],
  ];
  const wrongTypes = exampleBackup();
  invalidBackups.push({
    ...wrongTypes,
    preferences: { ...wrongTypes.preferences, clock: { ...wrongTypes.preferences.clock, showSeconds: "false" } },
  });
  const wrongEnum = exampleBackup();
  invalidBackups.push({
    ...wrongEnum,
    preferences: { ...wrongEnum.preferences, player: { selection: "youtube" } },
  });
  for (const coordinate of [-0.001, 1.001]) {
    for (const axis of ["x", "y"] as const) {
      const outside = exampleBackup();
      outside.preferences.sections.player.position[axis] = coordinate;
      invalidBackups.push(outside);
    }
  }
  for (const backup of invalidBackups) {
    const response = await request("PUT", "user-a-token", backup);
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error.code, "VALIDATION_FAILED");
    assert.ok(body.error.details.length > 0);
    assert.ok(body.error.details.length <= 10);
  }
  assert.equal(store.calls, 1);
  assert.deepEqual((await (await request("GET")).json()).backup, original);
});

test("normalized positions accept exact boundaries and hidden sections", async () => {
  const backup = exampleBackup();
  backup.preferences.sections.clock = { visible: false, position: { x: 0, y: 1 } };
  assert.equal((await request("PUT", "user-a-token", backup)).status, 204);
  assert.deepEqual((await (await request("GET")).json()).backup, backup);
});

test("device-local data is rejected at every payload level", async () => {
  const backup = exampleBackup();
  const invalidBackups = [
    { ...backup, token: "secret" },
    { ...backup, preferences: { ...backup.preferences, wallpaperUri: "content://wallpaper" } },
    { ...backup, preferences: { ...backup.preferences, clock: { ...backup.preferences.clock, credential: "secret" } } },
    { ...backup, preferences: { ...backup.preferences, player: { selection: "radio", url: "https://radio.example" } } },
    { ...backup, preferences: { ...backup.preferences, sections: { ...backup.preferences.sections, shortcuts: {
      ...backup.preferences.sections.shortcuts, assignments: ["com.example"],
    } } } },
    { ...backup, preferences: { ...backup.preferences, sections: { ...backup.preferences.sections, clock: {
      visible: true, position: { x: 0.5, y: 0.5, uri: "file://local" },
    } } } },
  ];
  for (const invalid of invalidBackups) {
    const response = await request("PUT", "user-a-token", invalid);
    assert.equal(response.status, 422);
  }
  assert.equal(store.calls, 0);
});

test("malformed JSON, wrong media types, and excessive payloads produce documented errors", async () => {
  for (const [body, contentType, status, code] of [
    ["{", "application/json", 400, "INVALID_JSON"],
    [JSON.stringify(exampleBackup()), "text/plain", 415, "UNSUPPORTED_MEDIA_TYPE"],
    [JSON.stringify({ padding: "x".repeat(16384) }), "application/json", 413, "PAYLOAD_TOO_LARGE"],
  ] as const) {
    const response = await fetch(baseUrl, {
      method: "PUT",
      headers: { Authorization: "Bearer user-a-token", "Content-Type": contentType },
      body,
    });
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }
  assert.equal(store.calls, 0);
});

test("the 16384-byte limit accepts an exact-size backup and rejects one extra byte", async () => {
  for (const backup of [exampleBackup(), exampleBackupV2()]) {
    const body = JSON.stringify(backup);
    const exactSize = body + " ".repeat(16384 - Buffer.byteLength(body, "utf8"));
    const headers = { Authorization: "Bearer user-a-token", "Content-Type": "application/json" };
    const url = baseUrl.replace("/v1/", `/v${backup.schemaVersion}/`);
    const callsBefore = store.calls;
    assert.equal(Buffer.byteLength(exactSize, "utf8"), 16384);
    assert.equal((await fetch(url, { method: "PUT", headers, body: exactSize })).status, 204);
    const oversized = await fetch(url, { method: "PUT", headers, body: exactSize + " " });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, "PAYLOAD_TOO_LARGE");
    assert.equal(store.calls, callsBefore + 1);
    assert.deepEqual((await (await request("GET", "user-a-token", undefined, "", backup.schemaVersion)).json()).backup, backup);
  }
});

test("UTF-16 and compressed bodies are rejected instead of relaxing the wire format", async () => {
  for (const [contentType, contentEncoding, body] of [
    ["application/json; charset=utf-16le", "identity", Buffer.from(JSON.stringify(exampleBackup()), "utf16le")],
    ["application/json", "gzip", Buffer.from("not-a-gzip-stream")],
  ] as const) {
    const response = await fetch(baseUrl, {
      method: "PUT",
      headers: {
        Authorization: "Bearer user-a-token",
        "Content-Type": contentType,
        "Content-Encoding": contentEncoding,
      },
      body,
    });
    assert.equal(response.status, 415);
    assert.equal((await response.json()).error.code, "UNSUPPORTED_MEDIA_TYPE");
  }
  assert.equal(store.calls, 0);
});

test("non-finite coordinates cannot enter a backup through JSON number overflow", async () => {
  const body = JSON.stringify(exampleBackup()).replace('"x":0.5', '"x":1e400');
  const response = await fetch(baseUrl, {
    method: "PUT",
    headers: { Authorization: "Bearer user-a-token", "Content-Type": "application/json" },
    body,
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, "VALIDATION_FAILED");
  assert.equal(store.calls, 0);
});

test("storage failures return an explicit error and do not invent a backup or save result", async () => {
  store.fail = true;
  for (const [method, body] of [["GET", undefined], ["PUT", exampleBackup()]] as const) {
    const response = await request(method, "user-a-token", body);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: { code: "INTERNAL_ERROR", message: "The request could not be completed." },
    });
  }
  assert.equal(logs.length, 2);
});

test("corrupt stored data fails instead of being served as a usable backup", async () => {
  store.backups.set("user-a", {
    backup: { ...exampleBackup(), preferences: { ...exampleBackup().preferences, player: { selection: "radio" } } },
    updatedAt: "2026-11-19T16:00:00.000Z",
  });
  const stored = store.backups.get("user-a")!;
  Object.assign(stored.backup, { token: "must-not-be-returned" });
  const response = await request("GET");
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /must-not-be-returned/);
});

test("v2 round-trips the requested fields without requiring legacy clock preferences", async () => {
  const backup = exampleBackupV2();
  const saved = await request("PUT", "user-a-token", backup, "", 2);
  assert.equal(saved.status, 204);
  assert.equal(await saved.text(), "");
  const restored = await request("GET", "user-a-token", undefined, "", 2);
  assert.equal(restored.status, 200);
  assert.equal(restored.headers.get("cache-control"), "no-store");
  assert.deepEqual(await restored.json(), { backup, updatedAt: "2026-11-19T16:00:00.000Z" });
});

test("v2 accepts clock size boundaries, both styles, all player modes and automatic placement", async () => {
  for (const [sizePercent, style, musicPlayer] of [
    [50, "digital", "none"], [200, "analog", "local"],
    [100, "digital", "spotify"], [125, "analog", "radio"],
  ] as const) {
    const backup = exampleBackupV2();
    backup.preferences.clock = { style, sizePercent };
    backup.preferences.positions = { clock: null, shortcuts: null, actions: null, music: null };
    backup.preferences.musicPlayer = musicPlayer;
    assert.equal((await request("PUT", "user-a-token", backup, "", 2)).status, 204);
    assert.deepEqual((await (await request("GET", "user-a-token", undefined, "", 2)).json()).backup, backup);
  }
});

test("v2 retains dp positions, including zero and positions of hidden sections", async () => {
  const backup = exampleBackupV2();
  backup.preferences.showShortcuts = false;
  backup.preferences.musicPlayer = "none";
  backup.preferences.positions.actions = { x: 0, y: 0 };
  assert.equal((await request("PUT", "user-a-token", backup, "", 2)).status, 204);
  assert.deepEqual((await (await request("GET", "user-a-token", undefined, "", 2)).json()).backup, backup);
});

test("v2 rejects invalid clock sizes, flags, player modes and incomplete preferences without overwriting", async () => {
  const backup = exampleBackupV2();
  await request("PUT", "user-a-token", backup, "", 2);
  const invalidBackups: unknown[] = [
    { ...backup, schemaVersion: 3 },
    { ...backup, schemaVersion: "2" },
    { schemaVersion: 2, preferences: {} },
    { ...backup, preferences: { ...backup.preferences, showShortcuts: 1 } },
    { ...backup, preferences: { ...backup.preferences, musicPlayer: "youtube" } },
    { ...backup, preferences: { ...backup.preferences, positions: { clock: null, shortcuts: null, music: null } } },
    { ...backup, preferences: { ...backup.preferences, clock: { style: "digital" } } },
    { ...backup, preferences: { ...backup.preferences, clock: { style: "other", sizePercent: 100 } } },
  ];
  for (const sizePercent of [49, 201, 125.5, "100", null]) {
    invalidBackups.push({
      ...backup,
      preferences: { ...backup.preferences, clock: { style: "digital", sizePercent } },
    });
  }
  for (const invalid of invalidBackups) {
    const response = await request("PUT", "user-a-token", invalid, "", 2);
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error.code, "VALIDATION_FAILED");
    assert.equal(body.error.message, "The backup does not match schema version 2.");
    assert.ok(body.error.details.length > 0);
    assert.ok(body.error.details.length <= 10);
  }
  assert.equal(store.calls, 1);
  assert.deepEqual((await (await request("GET", "user-a-token", undefined, "", 2)).json()).backup, backup);
});

test("v2 requires nonnegative integer dp coordinates or null for each position", async () => {
  const backup = exampleBackupV2();
  for (const section of ["clock", "shortcuts", "actions", "music"] as const) {
    for (const position of [
      { x: -1, y: 80 }, { x: 24, y: -1 }, { x: 0.5, y: 80 }, { x: 24, y: 0.5 },
      { x: "24", y: 80 }, { x: 24 }, { y: 80 }, {}, [], false, "automatic",
    ]) {
      const invalid = {
        ...backup,
        preferences: {
          ...backup.preferences,
          positions: { ...backup.preferences.positions, [section]: position },
        },
      };
      assert.equal((await request("PUT", "user-a-token", invalid, "", 2)).status, 422);
    }
  }
  const response = await fetch(baseUrl.replace("/v1/", "/v2/"), {
    method: "PUT",
    headers: { Authorization: "Bearer user-a-token", "Content-Type": "application/json" },
    body: JSON.stringify(backup).replace('"x":24', '"x":1e400'),
  });
  assert.equal(response.status, 422);
  assert.equal(store.calls, 0);
});

test("v2 rejects private data and legacy preferences at every object level", async () => {
  const backup = exampleBackupV2();
  const invalidBackups: unknown[] = [{ ...backup, token: "secret" }];
  for (const field of ["wallpaperUri", "usbUri", "shortcutAssignments", "serviceUrl", "credentials", "playbackState"]) {
    invalidBackups.push({ ...backup, preferences: { ...backup.preferences, [field]: "private" } });
  }
  for (const field of ["hourCycle", "showSeconds", "visible", "size"]) {
    invalidBackups.push({
      ...backup,
      preferences: { ...backup.preferences, clock: { ...backup.preferences.clock, [field]: "legacy" } },
    });
  }
  invalidBackups.push({
    ...backup,
    preferences: { ...backup.preferences, positions: { ...backup.preferences.positions, extra: null } },
  });
  for (const section of ["clock", "shortcuts", "actions", "music"] as const) {
    invalidBackups.push({
      ...backup,
      preferences: {
        ...backup.preferences,
        positions: { ...backup.preferences.positions, [section]: { x: 24, y: 80, uri: "content://private" } },
      },
    });
  }
  for (const invalid of invalidBackups) {
    assert.equal((await request("PUT", "user-a-token", invalid, "", 2)).status, 422);
  }
  assert.equal(store.calls, 0);
});

test("v2 authorization isolates accounts and returns NO_BACKUP for an account with no backup", async () => {
  const backup = exampleBackupV2();
  assert.equal((await request("PUT", "user-a-token", backup, "", 2)).status, 204);
  const missing = await request("GET", "user-b-token", undefined, "?uid=user-a", 2);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "NO_BACKUP");
  const other = exampleBackupV2();
  other.preferences.musicPlayer = "spotify";
  assert.equal((await request("PUT", "user-b-token", other, "?uid=user-a", 2)).status, 204);
  assert.deepEqual((await (await request("GET", "user-a-token", undefined, "", 2)).json()).backup, backup);
  assert.deepEqual((await (await request("GET", "user-b-token", undefined, "", 2)).json()).backup, other);
});

test("v1 and v2 are never relabeled or converted and only an explicit valid PUT replaces the latest backup", async () => {
  const legacy = exampleBackup();
  await request("PUT", "user-a-token", legacy);
  const mismatch = await request("GET", "user-a-token", undefined, "", 2);
  assert.equal(mismatch.status, 409);
  assert.deepEqual(await mismatch.json(), {
    error: {
      code: "BACKUP_VERSION_MISMATCH",
      message: "The latest backup uses schema version 1; this endpoint requires version 2.",
    },
  });
  assert.equal((await request("PUT", "user-a-token", legacy, "", 2)).status, 422);
  assert.equal((await request("PUT", "user-a-token", { ...legacy, schemaVersion: 2 }, "", 2)).status, 422);
  const v2 = exampleBackupV2();
  assert.equal((await request("PUT", "user-a-token", v2)).status, 422);
  assert.deepEqual((await (await request("GET")).json()).backup, legacy);
  assert.equal((await request("PUT", "user-a-token", v2, "", 2)).status, 204);
  assert.deepEqual((await (await request("GET", "user-a-token", undefined, "", 2)).json()).backup, v2);
  const reverseMismatch = await request("GET");
  assert.equal(reverseMismatch.status, 409);
  assert.equal((await reverseMismatch.json()).error.code, "BACKUP_VERSION_MISMATCH");
  assert.equal(store.backups.size, 1);
});
