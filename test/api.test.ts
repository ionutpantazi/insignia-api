import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";
import { createApp } from "../src/app.js";
import { type Backup, type BackupStore, type StoredBackup } from "../src/backup.js";
import { exampleBackup } from "./fixtures.js";

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
) {
  return fetch(baseUrl + suffix, {
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
  for (const method of ["GET", "PUT"] as const) {
    for (const authorization of ["", "Basic abc", "Bearer invalid", "Bearer revoked", "Bearer two tokens"]) {
      const response = await fetch(baseUrl, {
        method,
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        ...(method === "PUT" ? { body: JSON.stringify(exampleBackup()) } : {}),
      });
      assert.equal(response.status, 401);
      assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer/);
      assert.equal((await response.json()).error.code, "UNAUTHENTICATED");
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
  const backup = exampleBackup();
  const body = JSON.stringify(backup);
  const exactSize = body + " ".repeat(16384 - Buffer.byteLength(body, "utf8"));
  const headers = { Authorization: "Bearer user-a-token", "Content-Type": "application/json" };
  assert.equal(Buffer.byteLength(exactSize, "utf8"), 16384);
  assert.equal((await fetch(baseUrl, { method: "PUT", headers, body: exactSize })).status, 204);
  const oversized = await fetch(baseUrl, { method: "PUT", headers, body: exactSize + " " });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, "PAYLOAD_TOO_LARGE");
  assert.equal(store.calls, 1);
  assert.deepEqual((await (await request("GET")).json()).backup, backup);
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
