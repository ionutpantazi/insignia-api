# Android settings profiles API (v3)

Use the [v3 JSON Schema](./src/schemas/settings-profile.v3.json) for the exact
write shape and to validate the snapshot portion of a load response. This API
does not touch [v1/v2 backups](./README.md#version-compatibility); it neither
converts them nor offers them in the v3 picker.

## Endpoints

Every request uses HTTPS and `Authorization: Bearer <Firebase ID token>`.
Keep Firebase Email/Password sign-in in Android. Obtain the ID token for the
current Firebase user at the time of the manual action. The API verifies it and
uses only its UID; clients never send a UID or credentials in the body. Responses
are not cacheable. POST and PUT require uncompressed UTF-8 `application/json`.

| Method and path | Success | Behavior |
| --- | --- | --- |
| `POST /v3/me/settings-profiles` | `201 Created` | Create a new profile and return its summary and a relative `Location` header. |
| `GET /v3/me/settings-profiles` | `200 OK` | List summaries for this account, with no settings or image bytes. |
| `GET /v3/me/settings-profiles/{id}` | `200 OK` | Load a complete snapshot, without changing it or setting an active profile. |
| `PUT /v3/me/settings-profiles/{id}` | `200 OK` | Replace the name and entire snapshot of that existing profile; return its summary. Does not create. |

IDs are server-generated lowercase UUIDs. Names are labels, not keys: duplicates
are allowed, and overwriting a name does not change the ID. Names must have 1–80
characters, at least one non-whitespace character, and no ASCII control characters.
Times are server-generated UTC ISO 8601 strings with millisecond precision.
Overwrites of the same ID use last-database-write-wins; there is no version history
or conflict detection. Different profiles are independent. If a response is lost,
the write may already have committed: refresh the picker before retrying,
especially for POST (repeating it creates another profile).

## Examples

Use `https://backup.example.com` as a placeholder for your API origin. The
authorization header applies to each example, including GET.

### Save a new profile

`POST /v3/me/settings-profiles` with `Content-Type: application/json`:

```json
{
  "schemaVersion": 3,
  "name": "Daily drive",
  "settings": {
    "clock": { "style": "digital", "sizePercent": 112.5 },
    "positions": {
      "clock": { "x": 24, "y": 80 },
      "shortcuts": { "x": 0, "y": 240 },
      "actions": null,
      "music": { "x": 24, "y": 400 }
    },
    "showShortcuts": false,
    "hideStatusBar": true,
    "useSteeringWheelButtons": true,
    "musicMode": "none",
    "radio": { "serverUrl": "https://radio.example.com/stream?station=jazz", "autoplay": true, "width": 360, "height": 126 },
    "spotify": {
      "clientId": "0123456789abcdef0123456789abcdef",
      "playbackUri": "spotify:playlist:0123456789abcdefghijAB",
      "autoConnect": true,
      "width": 360,
      "height": 142,
      "maxTitleLines": 2
    },
    "background": { "type": "dark" }
  }
}
```

`201 Created`, `Location: /v3/me/settings-profiles/86df72d0-26ad-41d7-904a-c17139126234`:

```json
{ "id": "86df72d0-26ad-41d7-904a-c17139126234", "name": "Daily drive", "updatedAt": "2026-11-19T18:20:00.123Z" }
```

### List profiles

`GET /v3/me/settings-profiles` (no body), `200 OK`:

```json
{
  "profiles": [
    { "id": "86df72d0-26ad-41d7-904a-c17139126234", "name": "Daily drive", "updatedAt": "2026-11-19T18:20:00.123Z" },
    { "id": "a9be09da-991e-4236-ae20-35aca9fd478d", "name": "Weekend", "updatedAt": "2026-11-19T18:21:00.456Z" }
  ],
  "nextCursor": null
}
```

Pages contain at most 50 entries sorted by ID. If `nextCursor` is non-null,
send `GET /v3/me/settings-profiles?after=<nextCursor>` to continue. Changes
made between pages are not presented as a frozen list; start without a cursor
to refresh. With no profiles, return `{"profiles":[],"nextCursor":null}`.
The launcher can sort accumulated entries by name or `updatedAt` for display.

### Load a profile

`GET /v3/me/settings-profiles/86df72d0-26ad-41d7-904a-c17139126234` (no body),
`200 OK`:

```json
{
  "id": "86df72d0-26ad-41d7-904a-c17139126234",
  "name": "Daily drive",
  "updatedAt": "2026-11-19T18:20:00.123Z",
  "schemaVersion": 3,
  "settings": {
    "clock": { "style": "digital", "sizePercent": 112.5 },
    "positions": {
      "clock": { "x": 24, "y": 80 },
      "shortcuts": { "x": 0, "y": 240 },
      "actions": null,
      "music": { "x": 24, "y": 400 }
    },
    "showShortcuts": false,
    "hideStatusBar": true,
    "useSteeringWheelButtons": true,
    "musicMode": "none",
    "radio": { "serverUrl": "https://radio.example.com/stream?station=jazz", "autoplay": true, "width": 360, "height": 126 },
    "spotify": {
      "clientId": "0123456789abcdef0123456789abcdef",
      "playbackUri": "spotify:playlist:0123456789abcdefghijAB",
      "autoConnect": true,
      "width": 360,
      "height": 142,
      "maxTitleLines": 2
    },
    "background": { "type": "dark" }
  }
}
```

### Overwrite a profile

`PUT /v3/me/settings-profiles/86df72d0-26ad-41d7-904a-c17139126234` with
`Content-Type: application/json`. Send the same complete body as POST, for example:

```json
{
  "schemaVersion": 3,
  "name": "Daily drive - radio",
  "settings": {
    "clock": { "style": "analog", "sizePercent": 100 },
    "positions": { "clock": null, "shortcuts": null, "actions": null, "music": { "x": 24, "y": 400 } },
    "showShortcuts": false,
    "hideStatusBar": true,
    "useSteeringWheelButtons": true,
    "musicMode": "radio",
    "radio": { "serverUrl": "https://radio.example.com/stream?station=jazz", "autoplay": true, "width": 360, "height": 126 },
    "spotify": { "clientId": null, "playbackUri": null, "autoConnect": false, "width": 360, "height": 142, "maxTitleLines": 2 },
    "background": { "type": "dark" }
  }
}
```

`200 OK`:

```json
{ "id": "86df72d0-26ad-41d7-904a-c17139126234", "name": "Daily drive - radio", "updatedAt": "2026-11-19T18:22:00.789Z" }
```

Do not send `id` or `updatedAt` in either write body.

## Settings and wallpaper transfer

- Every shown field is required. Unknown fields are rejected, including nested
  fields. `null` is explicit for automatic positions and unconfigured radio URL,
  Spotify public client ID or optional playback URI.
- Clock size is numeric, 50–200 inclusive; an intermediate percentage is
  preserved rather than rounded into a preset. Section positions are nonnegative
  integer dp, from the usable content's top-left to the section's top-left.
  Keep all positions even when a section is hidden; `none` hides the music box.
  Both players' settings must be included regardless of music mode.
- Radio/Spotify `width` and `height` are positive integer dp. `maxTitleLines`
  is a positive integer. Positions, dimensions and line count fit a signed
  32-bit Kotlin `Int`; the renderer remains responsible for display bounds.
- Radio `serverUrl` is stored verbatim and never fetched or resolved. Lowercase
  `http://` or `https://` is required; ordinary query parameters are supported.
  Use URLs of at most 2048 characters, without userinfo or fragments. The API
  rejects common credential-bearing query names (including percent-encoded
  names), such as `password`, `api_key`, `access_token`, and `signature`.
  The client must only submit credential-free URLs: a secret embedded in an
  arbitrary path or a parameter named like ordinary metadata cannot reliably
  be identified by the API. Do not send signed or private-access URLs.
- Spotify `clientId` is the public 32-hex-character ID, **not** a client secret.
  Supply a `spotify:<type>:<22-character ID>` playback URI or `null`. Supported
  types: `track`, `album`, `artist`, `playlist`, `show`, `episode`.
- Passwords, secrets, auth tokens, USB paths, Android permissions and URI grants,
  shortcut assignments, and playback/session state are not part of this contract.
  Treat both the settings and wallpaper as private user data; do not log bodies.

**Upload:** For a custom background, replace the `background` field in the full
write body with the following shape. Replace the placeholder string with actual
base64-encoded image bytes, not a local URI:

```json
{
  "type": "custom",
  "image": { "mediaType": "image/png", "dataBase64": "<padded standard base64 of the PNG bytes>" }
}
```

Android reads the selected image through its local content resolver and sends the
bytes. Standard canonical base64 (no line breaks, URL-safe substitutions or data
URL prefix) is required. Supported MIME types are `image/png` and `image/jpeg`.
Limits: **2 MiB decoded** before and after processing, **8 million pixels** on
input, and **3 MiB** total write body. The API verifies and re-encodes the image
with orientation applied and metadata removed; file bytes need not match the
upload exactly. JPEG is re-encoded with lossy compression. Animated input is
stored as a static image. If the file cannot be uploaded, keep the current
profile; do not retry as a dark background unless the user chooses dark.

**Download:** A custom profile's GET includes that same background shape with
the stored image bytes. There is no separate asset URL, upload token or race
between the image and snapshot revisions. Accept up to **3 MiB** for the load
response; validate the snapshot and image before using either. The server
validates the entire write and processes the image **before** a single atomic
MySQL insert/update of one row. An invalid, oversized, or incomplete upload
cannot replace a previous row. Switching to dark with a valid explicit PUT
removes the previous image from that row.

**Android apply:** List and load only after a manual user action, never on Home
startup or wake. Stage the settings and any decoded image in app-private storage,
ask for confirmation, then commit them together through the settings owner.
Only after success should Android publish the new settings and invalidate Home
caches. On cancel or failure leave local preferences and the current wallpaper
unchanged. Keep device-local keys untouched. On restore, persist `autoplay` and
`autoConnect` as configuration only: suppress side effects for the restore event
and do not start playback, launch an external app, or trigger Spotify sign-in.

## Errors and deployment

Errors use `{"error":{"code":"…","message":"…"}}`. Branch on `code`, not message.

| Status | Code | Client action |
| --- | --- | --- |
| 400 | `INVALID_CURSOR`, `INVALID_JSON`, `INVALID_REQUEST` | Fix the cursor or request. |
| 401 | `UNAUTHENTICATED` | Refresh the ID token once or sign in again. |
| 404 | `PROFILE_NOT_FOUND` | Refresh the picker. An ID owned by another user is indistinguishable from a missing ID. |
| 413 | `PAYLOAD_TOO_LARGE` | Shrink the image and retry. A proxy may return its own error body. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Use uncompressed UTF-8 JSON. |
| 422 | `VALIDATION_FAILED`, `INVALID_RADIO_URL`, `INVALID_WALLPAPER` | Fix the data. Schema failures include up to ten `details` entries with field paths. |
| 500 / 503 | `INTERNAL_ERROR` / `AUTH_UNAVAILABLE` | Report failure; reconcile the list after an uncertain write. |

Apply [migration 002](./migrations/002-settings-profiles.sql) with
`npm run migrate` before starting the updated server. The API runtime account
needs `SELECT`, `INSERT` and `UPDATE` on `settings_profiles` as well as the
existing backup table. Configure the proxy to accept 3 MiB requests for v3,
set MySQL `max_allowed_packet` to at least 4 MiB, and set request rate and
concurrency limits appropriate for image processing. There is no v3 delete
endpoint or account-wide profile count cap. Plan storage monitoring and account
deletion cleanup for both tables.
