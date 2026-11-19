# Launcher settings backup API

Self-hosted Node.js/TypeScript API using **Firebase Authentication** and **MySQL 8+**.
The [v5 profiles API](./PROFILES.md) is the only supported API. Versions 1–4
are retired; existing database records are not deleted or migrated.

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
SharedPreferences/device assets and RAM caches. **No profile endpoint is called on
launch/wake**, for rendering, by a timer, or when ordinary settings change.
Firebase token refresh is separate from backup; it must never gate Home.

### Back up settings button

1. Require an authenticated, recoverable account. Let the user create a profile
   or explicitly choose a profile to overwrite.
2. Read a consistent snapshot from the app's settings owner. Serialize only the
   schema's allowlisted portable fields; never enumerate all SharedPreferences.
3. Validate locally, then perform authenticated POST or PUT off the main thread.
   Configure finite network timeouts and prevent duplicate button actions.
4. Show success only after `201` for create or `200` for overwrite. A failure
   changes nothing locally. Refresh the picker after a timeout before retrying.

### Restore settings button

1. On explicit action only, sign in if necessary and GET. Download to a candidate
   object, with a bounded response size (3 MiB including the wallpaper and metadata),
   without touching preferences, rendered state, or RAM caches.
2. Require 200, the expected envelope, supported schema version, and complete local
   validation (types, enums, finite coordinates, ranges, forbidden/unknown fields).
   Do not substitute defaults on validation failure.
3. Ask the user before replacing their portable preferences, with the backup time
   and account shown. Cancellation, 404, offline/network/auth
   failures, malformed JSON or unsupported versions must leave **all local settings
   and caches unchanged**.
4. Serialize the apply step through the same settings owner/lock used by normal
   edits. Capture current portable values immediately before applying. Merge **only**
   the allowlisted keys into the current local snapshot; never call
   `SharedPreferences.Editor.clear()` or replace a full stale settings map. Preserve
   file grants, shortcut assignments, credentials, and every other local-only
   setting. Stage any restored wallpaper before applying the profile.
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
   the repeatable migration creates `settings_profiles`.
   The runtime account needs only SELECT, INSERT and UPDATE on that table; no
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
   from this application's profile feature.

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
then run `npm test`. It verifies v5 read/write, UID isolation, and protection
of stored legacy profiles. It is skipped otherwise.

Before deploying, run that MySQL test and a live Firebase smoke test with two
different users: A creates a profile, B gets `404 PROFILE_NOT_FOUND` for A's
profile ID, and B creating a profile leaves A's profile unchanged.
Also test expired/revoked/wrong-project tokens and HTTPS reachability. Never use
real user tokens in committed examples or test fixtures.
