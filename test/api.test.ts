import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";
import sharp from "sharp";
import { createApp } from "../src/app.js";
import { type ProfileStore, type ProfileWrite, profilePageSize } from "../src/profiles.js";
import { exampleProfile } from "./fixtures.js";

const profileRows = new Map<string, Map<string, { payload: { schemaVersion: number; name: string }; updatedAt: string }>>();
const profiles: ProfileStore = {
  async list(uid, after) {
    return [...(profileRows.get(uid) ?? [])]
      .filter(([id, row]) => id > after && row.payload.schemaVersion === 5)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, profilePageSize + 1)
      .map(([id, row]) => ({ id, name: row.payload.name, updatedAt: row.updatedAt }));
  },
  async get(uid, id) {
    const row = profileRows.get(uid)?.get(id);
    return row?.payload.schemaVersion === 5 ? row : null;
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
const app = createApp({
  profiles,
  verifyIdToken: async (token) => {
    if (token === "user-a-token") return { uid: "user-a" };
    if (token === "user-b-token") return { uid: "user-b" };
    if (token === "auth-outage") throw Object.assign(new Error("Auth unavailable"), { code: "app/network-error" });
    const code = token === "revoked" ? "auth/id-token-revoked" : "auth/argument-error";
    throw Object.assign(new Error("Invalid token"), { code });
  },
  logger: { error() {} },
});
const server = app.listen(0, "127.0.0.1");
let baseUrl: string;

before(async () => {
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve(); });
    server.closeAllConnections();
  });
});

beforeEach(() => {
  profileRows.clear();
});

function profileRequest(method: "GET" | "POST" | "PUT", suffix = "", body?: unknown, token = "user-a-token") {
  return fetch(`${baseUrl}/v5/me/settings-profiles${suffix}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createProfile(payload: ProfileWrite) {
  const response = await profileRequest("POST", "", payload);
  assert.equal(response.status, 201);
  const summary = await response.json();
  assert.equal(response.headers.get("location"), `/v${payload.schemaVersion}/me/settings-profiles/${summary.id}`);
  assert.equal(summary.name, payload.name);
  assert.equal(new Date(summary.updatedAt).toISOString(), summary.updatedAt);
  return summary;
}

test("v5 saves and overwrites distinct layouts with music disabled, preserving nulls, zero and Int bounds", async () => {
  const profile = exampleProfile();
  assert.equal(profile.settings.musicMode, "none");
  profile.settings.radio.width = 0;
  profile.settings.spotify.height = 0;
  const created = await createProfile(profile);
  const path = `/${created.id}`;
  const loaded = await profileRequest("GET", path);
  assert.equal(loaded.status, 200);
  assert.deepEqual(await loaded.json(), { ...profile, ...created });

  const edited = structuredClone(profile);
  edited.settings.musicLayouts.local.position = { x: 2147483647, y: 0 };
  edited.settings.musicLayouts.local.size = { width: 1, height: 2147483647 };
  const saved = await profileRequest("PUT", path, edited);
  assert.equal(saved.status, 200);
  const updated = await saved.json();
  assert.equal(updated.id, created.id);
  assert.deepEqual(await (await profileRequest("GET", path)).json(), { ...edited, ...updated });
});

test("v5 rejects missing, invalid, unknown, and legacy shared music layout fields", async () => {
  const profile = exampleProfile();
  const { musicLayouts, positions, sectionSizes } = profile.settings;
  const invalidSettings: Record<string, unknown>[] = [
    { musicLayouts: undefined },
    { musicLayouts: null },
    { musicLayouts: { ...musicLayouts, extra: musicLayouts.local } },
    { positions: { ...positions, music: null } },
    { sectionSizes: { ...sectionSizes, music: null } },
  ];
  for (const player of ["local", "radio", "spotify"] as const) {
    const layout = musicLayouts[player];
    for (const value of [
      undefined, null, { position: null }, { size: null }, { ...layout, extra: null },
      { ...layout, position: { x: -1, y: 0 } },
      { ...layout, position: { x: 0, y: 1.5 } },
      { ...layout, position: { x: 2147483648, y: 0 } },
      { ...layout, size: { width: 0, height: 1 } },
      { ...layout, size: { width: 1.5, height: 1 } },
      { ...layout, size: { width: 1, height: 2147483648 } },
    ]) {
      invalidSettings.push({ musicLayouts: { ...musicLayouts, [player]: value } });
    }
  }
  for (const changes of invalidSettings) {
    const invalid = { ...profile, settings: { ...profile.settings, ...changes } };
    const response = await profileRequest("POST", "", invalid);
    assert.equal(response.status, 422, JSON.stringify(changes));
    assert.equal((await response.json()).error.code, "VALIDATION_FAILED");
  }
});

test("v1–v4 routes are retired and v5 cannot read or overwrite an older profile", async () => {
  const id = "86df72d0-26ad-41d7-904a-c17139126234";
  const legacy = { payload: { schemaVersion: 4, name: "Legacy" }, updatedAt: new Date(0).toISOString() };
  profileRows.set("user-a", new Map([[id, legacy]]));
  for (const [method, path] of [
    ["GET", "/v1/me/settings-backup"], ["PUT", "/v1/me/settings-backup"],
    ["GET", "/v2/me/settings-backup"], ["PUT", "/v2/me/settings-backup"],
    ...[3, 4].flatMap((version) => {
      const path = `/v${version}/me/settings-profiles`;
      return [["POST", path], ["GET", path], ["GET", `${path}/${id}`], ["PUT", `${path}/${id}`]];
    }),
  ]) {
    const response = await fetch(baseUrl + path, { method, headers: { Authorization: "Bearer user-a-token" } });
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.equal((await response.json()).error.code, "NOT_FOUND");
  }
  assert.deepEqual(await (await profileRequest("GET")).json(), { profiles: [], nextCursor: null });
  assert.equal((await profileRequest("GET", `/${id}`)).status, 404);
  assert.equal((await profileRequest("PUT", `/${id}`, exampleProfile())).status, 404);
  assert.equal((await profileRequest("POST", "", { ...exampleProfile(), schemaVersion: 4 })).status, 422);
  assert.equal(profileRows.get("user-a")?.get(id), legacy);
});

test("v5 creates two named snapshots, lists metadata only, and overwrites just the selected stable ID", async () => {
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

test("v5 preserves mixed Automatic and explicit dimensions on create, load, and overwrite", async () => {
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

test("v5 rejects missing, null, negative, and fractional dimensions for both players", async () => {
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

test("v5 scopes list, load, and overwrite to a verified UID; PUT never creates", async () => {
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

test("v5 list cursor advances without returning a snapshot or another account's data", async () => {
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

test("v5 rejects incomplete snapshots, private fields, and invalid or credential-bearing settings", async () => {
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

