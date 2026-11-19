# Launcher settings backup API

Self-hosted Node.js/TypeScript API using **Firebase Authentication** and **MySQL 8+**.
This workspace was empty; this is a new API, not an integration with an existing server.
No Android source was accessed or changed.

## Contract

For multiple named, complete Settings-page snapshots with portable wallpapers,
see the [v3 profiles API](./PROFILES.md). The contract below describes the separate
legacy v1/v2 single-backup resource; v3 does not read or migrate those backups.

In v3, radio and Spotify `width` and `height` are all required: `0` means
Automatic and positive integers are explicit sizes in dp. The API stores
and returns `0` unchanged.

Public base URL: `https://backup.example.com` (replace with your own domain).
Every operation requires HTTPS and `Authorization: Bearer <Firebase ID token>`.

| Operation | Request | Success |
| --- | --- | --- |
| Save/replace my latest backup | `PUT /v2/me/settings-backup` | `204 No Content` |
| Retrieve my latest backup | `GET /v2/me/settings-backup` | `200` with the envelope below |

There is exactly one latest backup per Firebase UID, not per device. The UID comes
only from a verified Firebase ID token, never from a path, query parameter, or body.
There are no routes to list users or access someone else's backup. SQL statements
are parameterized, and the primary key uses exact UID bytes, not a case-insensitive
collation. One deployment/database belongs to one Firebase project.

A successful PUT atomically replaces that account's previous backup in MySQL.
Concurrent successful saves use last-database-write-wins; there is no history,
merge, or background sync. A response timeout can occur after a save committed:
report an uncertain result, not success; the same full PUT may safely be retried.

### Version compatibility

The Android contract below is **v2**. The unchanged
[v1 schema](src/schemas/settings-backup.v1.json) remains available through
`PUT /v1/me/settings-backup` and `GET /v1/me/settings-backup`.
Each PUT accepts only its endpoint's schema version; using the other version or
just relabeling a v1 payload as v2 returns 422.

There is still **one latest backup per account**, not one per schema version.
If the stored backup is valid but belongs to the other version, GET returns
**409 `BACKUP_VERSION_MISMATCH`**, without returning converted preferences.
For example, GET v2 when only a v1 backup exists does not return 404, reinterpret
normalized positions as dp, or map legacy clock presets into percentages.
GET v1 still returns that original v1 backup unchanged.

A successful explicit v2 PUT replaces the previous backup, including a v1 backup;
the reverse is also true for an explicit valid v1 PUT. Warn the user before replacing
a backup made by another app version/device. No automatic migration or fallback is
performed. Existing database rows and the table layout require no migration for v2.

### Save example

```http
PUT /v2/me/settings-backup HTTP/1.1
Host: backup.example.com
Authorization: Bearer <Firebase ID token>
Content-Type: application/json

{
  "schemaVersion": 2,
  "preferences": {
    "clock": {
      "style": "digital",
      "sizePercent": 125
    },
    "positions": {
      "clock": { "x": 24, "y": 80 },
      "shortcuts": { "x": 24, "y": 240 },
      "actions": null,
      "music": { "x": 24, "y": 400 }
    },
    "showShortcuts": true,
    "musicPlayer": "local"
  }
}
```

```http
HTTP/1.1 204 No Content
Cache-Control: no-store
```

PUT has no response body. Do not attempt to decode one.

### Retrieve example

```http
GET /v2/me/settings-backup HTTP/1.1
Host: backup.example.com
Authorization: Bearer <Firebase ID token>
```

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Cache-Control: no-store

{
  "backup": {
    "schemaVersion": 2,
    "preferences": {
      "clock": {
        "style": "digital",
        "sizePercent": 125
      },
      "positions": {
        "clock": { "x": 24, "y": 80 },
        "shortcuts": { "x": 24, "y": 240 },
        "actions": null,
        "music": { "x": 24, "y": 400 }
      },
      "showShortcuts": true,
      "musicPlayer": "local"
    }
  },
  "updatedAt": "2026-11-19T16:00:00.000Z"
}
```

`updatedAt` is server-generated UTC metadata, not client time or a playback timestamp.

### Payload semantics and validation

The authoritative, reusable payload schema is
[settings-backup.v2.json](src/schemas/settings-backup.v2.json).
The Android adapter should explicitly map its local settings to/from these fields;
these names are a proposed wire contract, not claims about existing SharedPreferences keys.

- Both the route (`v2`) and payload (`schemaVersion: 2`) are versioned.
  Unsupported payload versions are rejected, not silently migrated or downgraded.
  Breaking changes require an explicit new contract/migration.
- All fields shown in the request are required. Only a position may be `null`;
  omitting a position is invalid and is not the same as automatic placement.
- Clock style: `digital | analog`; `sizePercent` is an integer from **50 through 200**
  inclusive, relative to the launcher's base clock size. There are no separate
  hour-cycle, seconds, or clock-visibility preferences in v2; those fields are
  not in its allowlist and must not be sent.
- `positions` includes **clock, shortcuts, actions, and music**. Each value is
  either `null` for automatic placement or an object with required `x` and `y`,
  both nonnegative integer **dp** offsets. They are measured from the **top-left
  of usable Home content to the top-left of the section**, not screen pixels,
  normalized fractions, center anchors, or coordinates including system insets.
  `(0,0)` is a valid manual position, not automatic placement.
  Preserve positions even when a section is hidden; changing visibility/player
  mode must not clear, reset, or normalize them. Overlap is permitted.
  On different-size displays Android may clamp rendered bounds to the usable area,
  but must retain the saved dp position rather than rewriting the backup.
- `showShortcuts` is a boolean controlling shortcuts visibility only.
- `musicPlayer`: `none | local | spotify | radio`. **`none` hides the music box**,
  without clearing `positions.music`. Other values choose a UI/player mode only;
  it does not sign in, assign a station, grant file access, or start playback.
  If a service is unavailable, retain the selection and show a local setup/unavailable
  state without importing credentials or silently changing the backup.
- Unknown fields are rejected at **every** object level. No type coercion, stripping,
  implicit defaults, partial patches, or generic SharedPreferences upload.
- Maximum request body: **16,384 UTF-8 bytes**, uncompressed `application/json`.
  Invalid JSON (including non-finite numeric literals) is not accepted.

**Never include:** wallpaper images or paths/URIs, local music folders or file URIs,
music files, shortcut app/package/intent assignments, passwords, Firebase/Spotify
tokens, media service or radio URLs, station assignments, playback state, queues,
volume, Android permissions, device identifiers, or default-Home registration.
The visibility and position of the shortcuts *section* are portable; its shortcut
assignments are not. Custom wallpaper and all other non-allowlisted preferences
remain device-local and unchanged on restore.

### Errors

Error body:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The backup does not match schema version 2.",
    "details": [
      {
        "path": "/preferences/musicPlayer",
        "keyword": "enum",
        "message": "must be equal to one of the allowed values"
      }
    ]
  }
}
```

`details` is present only for schema errors, with at most ten entries; `path` uses
JSON Pointer (`/` denotes the root in these errors). Treat messages as diagnostic,
not stable localized UI strings; branch on status and `error.code`.

| HTTP | Code | Meaning / client action |
| --- | --- | --- |
| 400 | `INVALID_JSON` | Malformed JSON or non-object JSON primitive. Fix serialization. |
| 400 | `INVALID_REQUEST` | Incomplete request body. Allow a manual retry. |
| 401 | `UNAUTHENTICATED` | Missing, invalid, expired, revoked, disabled-user, or wrong-project token. Refresh once or prompt sign-in. |
| 404 | `NO_BACKUP` | This signed-in account has never saved a backup. Show "No backup found"; change nothing locally. |
| 404 | `NOT_FOUND` | Unknown route. |
| 409 | `BACKUP_VERSION_MISMATCH` | The latest backup belongs to the other supported schema version. Do not relabel or apply it as this version. |
| 413 | `PAYLOAD_TOO_LARGE` | Body exceeds 16,384 bytes. Fix serialization; do not silently truncate. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Use uncompressed UTF-8 `application/json`. |
| 422 | `VALIDATION_FAILED` | Invalid/missing/extra fields or unsupported `schemaVersion`. Do not apply a partial backup. |
| 500 | `INTERNAL_ERROR` | Storage/server failure. No successful result is asserted. |
| 503 | `AUTH_UNAVAILABLE` | Token verification infrastructure failed. Retry later, do not erase local data. |

For example, GET before the first backup returns **404**, never empty preferences:

```json
{
  "error": {
    "code": "NO_BACKUP",
    "message": "No settings backup exists for this account."
  }
}
```

401 responses include `WWW-Authenticate: Bearer realm="settings-backup"`.
All application responses use `Cache-Control: no-store`. Proxies/network failures
may return non-JSON, HTML, or no response: treat any unexpected status/body as failure.

## Authentication

1. Keep **Firebase Email/Password** sign-in enabled in the Firebase project and
   configure the Android Firebase SDK for that same project. Android signs in with
   `signInWithEmailAndPassword` (and uses Firebase's account creation/password reset
   flows as needed). The backup API does not receive or store the user's password.
   Anonymous accounts alone are unsuitable for reinstall/device replacement unless
   linked to a recoverable sign-in method.
2. The user must sign into the **same Firebase account/UID** on the replacement
   head unit. Email strings are not identity keys; deleting/recreating an account,
   using a different Firebase project, or an unlinked provider may produce a new UID
   with no backup.
3. On an explicit button action, obtain `FirebaseAuth.currentUser.getIdToken(false)`
   and send the returned **Firebase ID token** as a Bearer token. Do not send a
   Google OAuth access token, Firebase custom token, refresh token, or service-account
   key. On 401, optionally call `getIdToken(true)` and retry **once**; if it fails,
   require sign-in again. Do not loop or retry restores in the background.
4. The server uses Firebase Admin `verifyIdToken(token, true)`, pinned to
   `FIREBASE_PROJECT_ID`. The SDK verifies signature, issuer, audience, expiry,
   disabled-user status and revocation. Failed verification cannot reach storage.
   Revocation checks require access to Firebase Authentication and can fail closed
   during an outage (503 for recognizable infrastructure errors; some Firebase SDK
   verification failures are reported as invalid tokens). This API refuses to
   start if `FIREBASE_AUTH_EMULATOR_HOST` is set, so emulator tokens cannot be
   accidentally enabled on the deployed service.
5. Configure server-only Application Default Credentials, for example via
   `GOOGLE_APPLICATION_CREDENTIALS` pointing to a protected service-account file
   **outside** this repository. Grant only the Firebase Auth read permissions needed
   for verification/revocation checks (such as Firebase Authentication Viewer);
   do not grant Owner/Editor just to run this API.

No server secret is embedded in Android. Firebase's Android client configuration
and Firebase API key identify the project; they are not Admin credentials and do
not authorize access to backups. Only the authenticated user's ID token does.
Never disable TLS verification or log Authorization headers/tokens.

## Android integration handoff (no Android changes made)

Home launch, process recreation and wake must render exclusively from local
SharedPreferences/device assets and RAM caches. **Neither endpoint is called on
launch/wake**, for rendering, by a timer, or when ordinary settings change.
Firebase token refresh is separate from backup; it must never gate Home.

### Back up settings button

1. Require an authenticated, recoverable account; explain that this replaces its
   previous cloud backup, including a backup made on another head unit.
2. Read a consistent snapshot from the app's settings owner. Serialize only the
   schema's allowlisted portable fields; never enumerate all SharedPreferences.
3. Validate locally, then perform authenticated PUT off the main thread.
   Configure finite network timeouts and prevent duplicate button actions.
4. Show success only after 204. A failure changes nothing locally. A timeout may
   mean the remote save committed; offer manual retry rather than claiming success.

### Restore settings button

1. On explicit action only, sign in if necessary and GET. Download to a candidate
   object, with a bounded response size (for example 32 KiB including the envelope),
   without touching preferences, rendered state, or RAM caches.
2. Require 200, the expected envelope, supported schema version, and complete local
   validation (types, enums, finite coordinates, ranges, forbidden/unknown fields).
   Do not substitute defaults on validation failure.
3. Ask the user before replacing their portable preferences, with the backup time
   and account shown. Cancellation, 404, 409 version mismatch, offline/network/auth
   failures, malformed JSON or unsupported versions must leave **all local settings
   and caches unchanged**.
4. Serialize the apply step through the same settings owner/lock used by normal
   edits. Capture current portable values immediately before applying. Merge **only**
   the allowlisted keys into the current local snapshot; never call
   `SharedPreferences.Editor.clear()` or replace a full stale settings map. Preserve
   current wallpaper, file grants, shortcut assignments, service URLs, credentials,
   and every other local-only setting.
5. Commit all changed portable keys in one editor operation off the main thread.
   Do not use fire-and-forget `apply()` as proof of successful persistence.
   **Important:** SharedPreferences `commit()` updates its in-process map before
   disk persistence; `false` is not a rollback guarantee. To meet "unchanged on
   failure", the Android integration must implement and test a transactional
   settings-owner apply/rollback path (including persistence errors) before shipping.
   A failed rollback is an explicit storage error, not a successful restore.
   A crash-safe atomic-file/DataStore migration is another Android-side option if
   the existing SharedPreferences design cannot provide the required guarantee.
6. Publish the new in-memory settings and invalidate/rebuild affected Home caches
   **only after successful persistence**. Because the launcher process survives
   sleep, writing SharedPreferences alone is insufficient. Coordinate readers and
   writers so Home never observes a partially applied candidate. Do not evict local
   assets, restart playback, or force process termination as a restore shortcut.

The API makes a remote backup write atomic; it cannot make Android SharedPreferences
or RAM updates transactional. Android integration acceptance tests must simulate
network/validation errors, cancellation, concurrent local edits, persistence failure,
rollback failure, and restore while the existing Home process remains alive.

## Run and deploy

Requires Node.js 22+ and MySQL 8+. No database credentials or Firebase Admin keys
are included. A separate Firebase-backed document database is **not** required.

1. Install: `npm ci`.
2. Copy `.env.example` to `.env` and set your project, server credential path and MySQL
   connection. Never commit `.env` or credential JSON. Run commands from the project
   root: the shared configuration loads `.env` from the current working directory
   for development, migration, `npm start`, and direct execution. Variables already
   supplied by the shell/service manager take precedence. The file is optional for
   deployments that supply environment variables externally; required variables
   are still validated before startup.
3. Create the MySQL database and dedicated accounts using an administrator.
   Run `npm run migrate` with a migration account authorized to CREATE the table;
   the repeatable migrations create `settings_backups` and `settings_profiles`.
   The runtime account needs only SELECT, INSERT and UPDATE on those tables; no
   administrative, DROP, CREATE or other application-table privileges.
4. Run `npm run build`, then `npm start` under a supervised service.
   The server checks table accessibility before listening and binds to
   `127.0.0.1:3000` by default. Keep the database private.
5. Terminate HTTPS at your self-hosted reverse proxy with a publicly trusted
   certificate, then proxy to this loopback HTTP listener. For example, Caddy:

   ```caddyfile
   backup.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

   Configure DNS/certificate issuance appropriately. Publish only HTTPS for API
   traffic; HTTP may redirect but must never accept authenticated API operations.
   Block direct access to port 3000 with the firewall. If proxy/backend are on
   separate hosts, protect that connection with TLS as well.
6. Use loopback/private MySQL on the same host, or `MYSQL_TLS=true` for a remote
   database, optionally specifying `MYSQL_SSL_CA_FILE`. Certificate verification
   stays enabled. Keep MySQL durable InnoDB commit settings (notably
   `innodb_flush_log_at_trx_commit=1`) and operate database backups independently
   from this application's one-latest-backup-per-user feature.

At the proxy enforce request/time/rate limits appropriate to your deployment and
do not cache API responses or log request bodies/Authorization. The application
logs sanitized error categories/codes, not preference payloads, tokens or SQL values.
Monitor these failures. Set a retention/account-deletion policy and implement
operational deletion of an account's row before a public launch; automatic Firebase
account-deletion cleanup and a user-facing delete endpoint are not implemented.

### Verification

```text
npm test
npm run typecheck
npm run build
```

HTTP tests use a fake token verifier and memory store; they do not prove live
Firebase/MySQL connectivity. The opt-in MySQL test requires a **dedicated database
ending in `_test`** and permission to create the table and delete its own test rows.
Supply its MYSQL_* environment variables, set `MYSQL_INTEGRATION_TEST=true`,
then run `npm test`. It verifies upsert/readback across independent connections
and case/trailing-space-sensitive account isolation. It is skipped otherwise.

Before deploying, run that MySQL test and a live Firebase smoke test with two
different users: A saves, B gets NO_BACKUP, B saves, A's backup is unchanged.
Also test expired/revoked/wrong-project tokens and HTTPS reachability. Never use
real user tokens in committed examples or test fixtures.
