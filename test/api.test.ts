import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";
import sharp from "sharp";
import { createApp } from "../src/app.js";
import { type Backup, type BackupStore, type StoredBackup } from "../src/backup.js";
import { type ProfileStore, type ProfileVersion, type ProfileWrite, profilePageSize } from "../src/profiles.js";
import { exampleBackup, exampleBackupV2, exampleProfile, exampleProfileV4 } from "./fixtures.js";

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
const profileRows = new Map<string, Map<string, { payload: ProfileWrite; updatedAt: string }>>();
const profiles: ProfileStore = {
  async list(uid, after, version) {
    return [...(profileRows.get(uid) ?? [])]
      .filter(([id, row]) => id > after && row.payload.schemaVersion === version)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, profilePageSize + 1)
      .map(([id, row]) => ({ id, name: row.payload.name, updatedAt: row.updatedAt }));
  },
  async get(uid, id, version) {
    const row = profileRows.get(uid)?.get(id);
    return row?.payload.schemaVersion === version ? row : null;
  },
  async create(uid, id, payload, updatedAt) {
    const rows = profileRows.get(uid) ?? new Map();
    rows.set(id, { payload, updatedAt: updatedAt.toISOString() });
    profileRows.set(uid, rows);
  },
  async overwrite(uid, id, payload, updatedAt) {
    const rows = profileRows.get(uid);
    if (rows?.get(id)?.payload.schemaVersion !== payload.schemaVersion) return false;
    rows.set(id, { payload, updatedAt: updatedAt.toISOString() });
    return true;
  },
};
const logs: unknown[][] = [];
const app = createApp({
  store,
  profiles,
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
  profileRows.clear();
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

function profileRequest(method: "GET" | "POST" | "PUT", suffix = "", body?: unknown, token = "user-a-token", version: ProfileVersion = 3) {
  return fetch(baseUrl.replace("/v1/me/settings-backup", `/v${version}/me/settings-profiles`) + suffix, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createProfile(payload: ProfileWrite) {
  const response = await profileRequest("POST", "", payload, undefined, payload.schemaVersion);
  assert.equal(response.status, 201);
  const summary = await response.json();
  assert.equal(response.headers.get("location"), `/v${payload.schemaVersion}/me/settings-profiles/${summary.id}`);
  assert.equal(summary.name, payload.name);
  assert.equal(new Date(summary.updatedAt).toISOString(), summary.updatedAt);
  return summary;
}

test("v4 round-trips section sizes and positions without resizing hidden or overlapping sections", async () => {
  const profile = exampleProfileV4();
  profile.settings.radio.width = 0;
  profile.settings.positions.shortcuts = profile.settings.positions.music = { x: 24, y: 80 };
  const summary = await createProfile(profile);
  const path = `/${summary.id}`;
  const load = await profileRequest("GET", path, undefined, undefined, 4);
  assert.equal(load.status, 200);
  assert.deepEqual(await load.json(), { ...profile, ...summary });
  profile.settings.sectionSizes = { clock: { width: 1, height: 2147483647 }, shortcuts: null, music: null };
  const overwritten = await profileRequest("PUT", path, profile, undefined, 4);
  assert.equal(overwritten.status, 200);
  const updated = await overwritten.json();
  assert.equal(updated.id, summary.id);
  assert.deepEqual(await (await profileRequest("GET", path, undefined, undefined, 4)).json(), { ...profile, ...updated });
});

test("v4 requires all three size entries and rejects non-positive, fractional, or incomplete overrides", async () => {
  const profile = exampleProfileV4();
  const validSizes = profile.settings.sectionSizes;
  for (const sectionSizes of [
    undefined, null, { ...validSizes, actions: null },
    { ...validSizes, clock: undefined },
    { ...validSizes, shortcuts: undefined },
    { ...validSizes, music: undefined },
    { ...validSizes, clock: { width: 0, height: 1 } },
    { ...validSizes, shortcuts: { width: 1, height: -1 } },
    { ...validSizes, music: { width: 1.5, height: 1 } },
    { ...validSizes, music: { width: 2147483648, height: 1 } },
    { ...validSizes, music: { width: 1 } },
  ]) {
    const response = await profileRequest("POST", "", { ...profile, settings: { ...profile.settings, sectionSizes } }, undefined, 4);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, "VALIDATION_FAILED");
  }
});

test("v4 is scoped to the verified account and cannot read or overwrite v3 snapshots", async () => {
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: "blue" } }).png().toBuffer();
  const legacy = exampleProfile();
  legacy.settings.background = { type: "custom", image: { mediaType: "image/png", dataBase64: png.toString("base64") } };
  const legacySummary = await createProfile(legacy);
  const legacyPath = `/${legacySummary.id}`;
  const before = await (await profileRequest("GET", legacyPath)).json();
  const layout = exampleProfileV4();
  const layoutSummary = await createProfile(layout);
  const layoutPath = `/${layoutSummary.id}`;
  assert.deepEqual(await (await profileRequest("GET", "", undefined, undefined, 4)).json(), { profiles: [layoutSummary], nextCursor: null });
  assert.deepEqual(await (await profileRequest("GET")).json(), { profiles: [legacySummary], nextCursor: null });
  assert.equal((await profileRequest("GET", legacyPath, undefined, undefined, 4)).status, 404);
  assert.equal((await profileRequest("PUT", legacyPath, layout, undefined, 4)).status, 404);
  assert.equal((await profileRequest("PUT", layoutPath, legacy)).status, 404);
  assert.equal((await profileRequest("POST", "", legacy, undefined, 4)).status, 422);
  assert.equal((await profileRequest("GET", layoutPath, undefined, "user-b-token", 4)).status, 404);
  assert.equal((await profileRequest("PUT", layoutPath, layout, "user-b-token", 4)).status, 404);
  assert.deepEqual(await (await profileRequest("GET", legacyPath)).json(), before);
});

test("v3 creates two named snapshots, lists metadata only, and overwrites just the selected stable ID", async () => {
  const first = exampleProfile();
  const second = exampleProfile("Weekend");
  const firstSummary = await createProfile(first);
  const secondSummary = await createProfile(second);
  assert.notEqual(firstSummary.id, secondSummary.id);
  const list = await (await profileRequest("GET")).json();
  assert.deepEqual(list, {
    profiles: [firstSummary, secondSummary].sort((a, b) => a.id.localeCompare(b.id)),
    nextCursor: null,
  });
  const firstPath = `/${firstSummary.id}`;
  const secondPath = `/${secondSummary.id}`;
  assert.deepEqual(await (await profileRequest("GET", firstPath)).json(), { ...first, ...firstSummary });
  const edited = exampleProfile("Updated daily drive");
  edited.settings.musicMode = "radio";
  const overwritten = await profileRequest("PUT", firstPath, edited);
  assert.equal(overwritten.status, 200);
  const updated = await overwritten.json();
  assert.deepEqual(updated, { id: firstSummary.id, name: edited.name, updatedAt: new Date(updated.updatedAt).toISOString() });
  assert.deepEqual(await (await profileRequest("GET", firstPath)).json(), { ...edited, ...updated });
  assert.deepEqual(await (await profileRequest("GET", secondPath)).json(), { ...second, ...secondSummary });
});

test("v3 preserves mixed Automatic and explicit dimensions on create, load, and overwrite", async () => {
  const profile = exampleProfile();
  profile.settings.radio.width = 0;
  profile.settings.spotify.height = 0;
  const created = await createProfile(profile);
  const path = `/${created.id}`;
  const loaded = await profileRequest("GET", path);
  assert.equal(loaded.status, 200);
  assert.deepEqual(await loaded.json(), { ...profile, ...created });

  const edited = exampleProfile();
  edited.settings.radio.height = 0;
  edited.settings.spotify.width = 0;
  const overwritten = await profileRequest("PUT", path, edited);
  assert.equal(overwritten.status, 200);
  const updated = await overwritten.json();
  assert.equal(updated.id, created.id);
  const reloaded = await profileRequest("GET", path);
  assert.equal(reloaded.status, 200);
  assert.deepEqual(await reloaded.json(), { ...edited, ...updated });
});

test("v3 rejects missing, null, negative, and fractional dimensions for both players", async () => {
  const profile = exampleProfile();
  for (const player of ["radio", "spotify"] as const) {
    for (const field of ["width", "height"] as const) {
      for (const value of [undefined, null, -1, 0.5]) {
        const invalid = {
          ...profile,
          settings: {
            ...profile.settings,
            [player]: { ...profile.settings[player], [field]: value },
          },
        };
        const response = await profileRequest("POST", "", invalid);
        assert.equal(response.status, 422, `${player}.${field}: ${value}`);
        assert.equal((await response.json()).error.code, "VALIDATION_FAILED");
      }
    }
  }
});

test("v3 scopes list, load, and overwrite to a verified UID; PUT never creates", async () => {
  const summary = await createProfile(exampleProfile());
  const path = `/${summary.id}?uid=user-a`;
  for (const [method, suffix] of [["GET", ""], ["GET", path], ["POST", ""], ["PUT", path]] as const) {
    const body = method === "GET" ? undefined : exampleProfile();
    for (const token of ["", "invalid", "revoked"]) {
      assert.equal((await profileRequest(method, suffix, body, token)).status, 401);
    }
  }
  assert.deepEqual(await (await profileRequest("GET", "?uid=user-a", undefined, "user-b-token")).json(), {
    profiles: [], nextCursor: null,
  });
  const missing = await profileRequest("GET", path, undefined, "user-b-token");
  const denied = await profileRequest("PUT", path, exampleProfile("Wrong account"), "user-b-token");
  assert.equal(missing.status, 404);
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), await missing.json());
  assert.equal((await (await profileRequest("GET", `/${summary.id}`)).json()).name, summary.name);
});

test("v3 list cursor advances without returning a snapshot or another account's data", async () => {
  for (let index = 0; index < 51; index++) {
    const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    await profiles.create("user-a", id, exampleProfile(`Profile ${index}`), new Date(0));
  }
  const first = await (await profileRequest("GET")).json();
  assert.equal(first.profiles.length, 50);
  assert.equal(first.nextCursor, first.profiles[49].id);
  const second = await (await profileRequest("GET", `?after=${first.nextCursor}`)).json();
  assert.equal(second.profiles.length, 1);
  assert.equal(second.profiles[0].name, "Profile 50");
  assert.equal(second.nextCursor, null);
  assert.equal((await profileRequest("GET", "?after=invalid")).status, 400);
});

test("v3 rejects incomplete snapshots, private fields, and invalid or credential-bearing settings", async () => {
  const profile = exampleProfile();
  const { settings } = profile;
  for (const invalid of [
    { ...profile, schemaVersion: 2 },
    { ...profile, name: "\u0000" },
    { ...profile, settings: { ...settings, clock: { style: "analog", sizePercent: 200.01 } } },
    { ...profile, settings: { ...settings, positions: { ...settings.positions, music: { x: -1, y: 10 } } } },
    { ...profile, settings: { ...settings, spotify: undefined } },
    { ...profile, settings: { ...settings, spotify: { ...settings.spotify, clientSecret: "private" } } },
    { ...profile, settings: { ...settings, spotify: { ...settings.spotify, playbackUri: "content://usb" } } },
    { ...profile, settings: { ...settings, playbackState: "playing", shortcutAssignments: [] } },
    { ...profile, settings: { ...settings, background: { type: "custom", uri: "content://wallpaper" } } },
  ]) {
    assert.equal((await profileRequest("POST", "", invalid)).status, 422);
  }
  for (const serverUrl of [
    "https://user:pass@radio.example.com", "http://@radio.example.com",
    "https://radio.example.com/?station=jazz&api%5Fkey=private",
    "https://radio.example.com/?AuthToken=private", "https://radio.example.com/#fragment", "https:///radio",
  ]) {
    const response = await profileRequest("POST", "", { ...profile, settings: { ...settings, radio: { ...settings.radio, serverUrl } } });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, "INVALID_RADIO_URL");
  }
  assert.deepEqual(await (await profileRequest("GET")).json(), { profiles: [], nextCursor: null });
});

test("custom wallpaper round-trips with its snapshot and invalid uploads cannot replace it", async () => {
  const png = await sharp({ create: { width: 2, height: 1, channels: 3, background: "blue" } }).png().toBuffer();
  const original = exampleProfile();
  original.settings.background = { type: "custom", image: { mediaType: "image/png", dataBase64: png.toString("base64") } };
  const created = await createProfile(original);
  const path = `/${created.id}`;
  const initial = await (await profileRequest("GET", path)).json();
  const { image } = initial.settings.background;
  assert.equal(image.mediaType, "image/png");
  const pixels = await sharp(Buffer.from(image.dataBase64, "base64")).raw().toBuffer();
  assert.deepEqual(pixels, Buffer.from([0, 0, 255, 0, 0, 255]));
  assert.deepEqual(initial, {
    ...original, ...created, settings: { ...original.settings, background: { type: "custom", image } },
  });
  const tooManyPixels = await sharp({ create: { width: 4001, height: 2000, channels: 3, background: "blue" } }).png().toBuffer();
  for (const badImage of [
    { mediaType: "image/png", dataBase64: "aaaa@" },
    { mediaType: "image/jpeg", dataBase64: png.toString("base64") },
    { mediaType: "image/png", dataBase64: png.subarray(0, 8).toString("base64") },
    { mediaType: "image/png", dataBase64: tooManyPixels.toString("base64") },
    { mediaType: "image/png", dataBase64: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64") },
  ] as const) {
    const edited = exampleProfile("Do not save");
    edited.settings.background = { type: "custom", image: badImage };
    const response = await profileRequest("PUT", path, edited);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, "INVALID_WALLPAPER");
  }
  assert.equal((await profileRequest("PUT", path, { padding: "x".repeat(3 * 1024 * 1024) })).status, 413);
  assert.equal((await profileRequest("PUT", path, { ...original, settings: { ...original.settings, background: { type: "custom" } } })).status, 422);
  assert.deepEqual(await (await profileRequest("GET", path)).json(), initial);
  const dark = exampleProfile();
  assert.equal((await profileRequest("PUT", path, dark)).status, 200);
  assert.deepEqual((await (await profileRequest("GET", path)).json()).settings.background, { type: "dark" });
});

test("v3 profiles and existing v1/v2 backups remain independent", async () => {
  const v1 = exampleBackup();
  assert.equal((await request("PUT", "user-a-token", v1)).status, 204);
  assert.deepEqual(await (await profileRequest("GET")).json(), { profiles: [], nextCursor: null });
  assert.equal((await profileRequest("POST", "", { ...v1, schemaVersion: 3 })).status, 422);
  const profile = exampleProfile();
  const summary = await createProfile(profile);
  assert.deepEqual((await (await request("GET")).json()).backup, v1);
  const v2 = exampleBackupV2();
  assert.equal((await request("PUT", "user-a-token", v2, "", 2)).status, 204);
  assert.deepEqual((await (await request("GET", "user-a-token", undefined, "", 2)).json()).backup, v2);
  assert.deepEqual(await (await profileRequest("GET", `/${summary.id}`)).json(), { ...profile, ...summary });
});
