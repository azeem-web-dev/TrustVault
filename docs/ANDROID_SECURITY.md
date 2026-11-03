# TrustVault for Android: security

The Android app (`apps/mobile`, Flutter) is a client of the same API as the
website. Every authorisation decision (roles, per-document access, share
expiry, revocation, row-level security, audit) is made by the server, so every
server-side test in `apps/api` applies to the app too. This page covers what is
specific to the phone: what the app keeps, where, for how long, and how that is
tested. Threat-model row: `THREATS.md` S13 (and S14 for the missing `Origin`).

## 1. Threat model

| # | Threat | Defence | Status |
|---|---|---|---|
| A1 | Session token read from the phone's storage | Kept only in `flutter_secure_storage` (Android Keystore-backed encryption). Never in shared preferences, files or logs. CSRF token in memory only | **tested** (unit + on device: token not found in plaintext anywhere in app data) |
| A2 | App data copied off the phone by backup or device transfer | `allowBackup=false`, `fullBackupContent=false`, `data_extraction_rules.xml` excludes every domain for cloud backup and device transfer | **tested** (static check) |
| A3 | Traffic read or changed on the network | HTTPS only: `usesCleartextTraffic=false`, no network security config (so no user CAs), and the API client refuses `http://` in release builds even if `TV_ORIGIN` is set to one (`lib/core/transport_policy.dart`). Debug/profile builds allow HTTP only to loopback or the emulator host | **tested** (static check + unit) |
| A4 | A document stays on the phone after access ends | Downloads are saved in app-private storage, one folder per document (`<app files>/downloads/<docId>/`). When the server answers 404 for that document (revoked, share expired, deleted) the folder is removed; on sign-out, session expiry or "ended elsewhere" everything goes, including file-picker temp copies | **tested** (unit, widget, on device) |
| A5 | A session ended on the server keeps working in the app | Any 401 resets the app: token, CSRF, copies and temp files are wiped and the sign-in screen is shown; pushed pages are popped | **tested** |
| A6 | Another app opens our components or files | Only the launcher activity is exported; `taskAffinity=""` against task hijacking; the file provider (open_filex) is not exported and grants per-URI read only for the file being opened; storage/media permissions that plugins add are removed | **tested** (static check, source and merged manifest) |
| A7 | Server-chosen file name escapes the downloads folder | File names are reduced to one safe path segment; document ids from the path must match `[A-Za-z0-9_-]+` | **tested** (unit) |
| A8 | Screenshots, screen recording, recents thumbnail, casting | Not prevented on this branch. `FLAG_SECURE` is coming from the view-only branch | **open** (stubs written, see section 5) |
| A9 | Someone picks up an unlocked phone with the app signed in | Not prevented on this branch beyond the server's session expiry. Biometric app lock is coming from the mfa-advanced branch | **open** (stubs written) |
| A10 | Rooted phone, malware with root, instrumented app (Frida), modified APK | **Accepted.** See section 4 | accepted |
| A11 | The opened copy is handed to another app (the system viewer) | Needed to show Word/Excel/PDF. The viewer gets a one-off read grant to that file only; what it does with the content (its own cache, "Save as") is outside our control. The view-only branch replaces this with an in-app page viewer for view-only shares | **accepted for now** |

Things that are the server's job and are only *exercised* from the app:
roles, share levels, expiry dates, revocation, MFA, rate limits, audit.

## 2. Release checklist

Before publishing an APK:

1. `cd apps/mobile && flutter analyze` — no issues.
2. `flutter test` — all pass (unit, widget, static check).
3. `flutter build apk --release` with the real signing key in `android/key.properties`
   (git-ignored; without it the build falls back to the **debug key**, which is only for side-loading tests).
4. `dart run tool/android_security_check.dart --merged` — checks the merged release
   manifest, including everything plugins added.
5. Check the default origin is the production HTTPS address and no `--dart-define=TV_ORIGIN=…` was passed.
6. Install on the emulator and run `tool/android-device-checks.sh -s emulator-5554` (not debuggable, no backup flag, nothing on shared storage, no secrets in logcat).
7. Run the integration tests against the fake API on an emulator (section 3) using a debug build of the same commit.
8. Manual checks in section 3 that are not automated yet.
9. Record the APK's SHA-256 with the release notes.

## 3. What is tested, and how

### Automatically, on every push (`flutter test`, CI job "Android app")

| File | What it proves |
|---|---|
| `test/api_client_test.dart` | Cookie sent back, no `Origin`; MFA rotates the session; empty `Set-Cookie` clears it; **CSRF header on every POST/PATCH/PUT/DELETE and uploads, not on GET**; CSRF never stored; 401 → `onUnauthorized`; 403 `mfa_required` → `onMfaRequired`; revoked document is a plain 404 for reads and downloads; network failure handled; **release builds refuse `http://` before sending anything**; HTTP only to loopback/emulator host in debug |
| `test/session_storage_test.dart` | Token only in secure storage — not shared preferences, any file, or `print`/`debugPrint` output; sign-out tells the server (with CSRF) and wipes token, CSRF, copies and temp files, **also when offline**; 401 anywhere → signed out and wiped; a stored session the server no longer accepts is dropped at start-up; wrong password stores nothing |
| `test/local_copies_test.dart` | Copies only under app documents `downloads/<docId>/`, nothing on external storage; path traversal in file names and ids; per-document removal; wipe removes old flat layout and file-picker temp copies but not unrelated cache |
| `test/app_flow_widget_test.dart` | The whole app against the fake API: wrong MFA code keeps you out; download → copy; **revoke → next open shows "Nothing to see here" and the copy is gone**; refused download removes the earlier copy; expired share = revoked; session ended on the server → sign-in screen and wipe; sign-out from the menu wipes |
| `test/android_static_security_test.dart` | Runs `tool/android_security_check.dart` on the real project, then on edited copies to prove the checker catches each problem (backup on, cleartext, debuggable, exported component, missing `exported`, deep link, `taskAffinity`, storage permission, backup domain left out, cleartext/user-CA network config, debuggable/unminified release, old `minSdk`, release manifest override) |
| `test/pending_features_test.dart` | Skipped until FLAG_SECURE / biometric lock / encrypted copies are merged; then they check the wiring (section 5) |

The fake API (`test/support/fake_api.dart`) copies the real API's rules that
matter here: cookie session rotated at MFA, CSRF on changes, `403
mfa_required`, 404 for anything you cannot see, 401 for ended sessions. It is
in-memory and never talks to a real server.

### On an emulator (`integration_test/`, manual or optional CI)

```sh
emulator -avd tv_test -no-window -no-audio &      # from the Android SDK
cd apps/mobile
flutter test integration_test/app_security_test.dart -d emulator-5554
tool/android-device-checks.sh -s emulator-5554
```

The fake API runs inside the test on the phone (`127.0.0.1`, real sockets),
so no `adb reverse` or host server is needed. Real Keystore storage, real
files. `app_security_test.dart` covers: sign-in → MFA prompt (nothing
reachable before it) → open → download into app-private storage → revoke →
next open refused and the copy gone, with **every file in the app's data
directory scanned for the document's random marker**; expired share; token
only in Keystore-encrypted storage (scan finds neither the token nor the CSRF
token in plaintext); cold start reuses the session; sign-out wipes token,
copies and file-picker temp files; backgrounding then the session ended
elsewhere → 401 on return → signed out and wiped; wrong MFA code leaves the
half-signed-in session unable to list documents.

### Manually, until automated

| Check | How |
|---|---|
| Recents thumbnail / screenshots / screen recording / casting | Open a document, press Overview; take a screenshot; start screen recording; cast. Today all show content (A8). After FLAG_SECURE: all must be black/blocked |
| Opened copy in a third-party viewer | Open a .docx/.pdf, check which app opened it and whether it kept a copy (its own "recent files") |
| Real backup | `adb shell bmgr backupnow cloud.rayyanazeem.trustvault` must report the app is not eligible; device-to-device transfer to a second emulator must not carry the session |
| Release APK | `tool/android-device-checks.sh` on an installed release build: not debuggable, no backup |
| Rooted device | Section 4 |
| API parity with the web app | The app calls only routes the web app calls (see `docs/API.md`); every rule is server-side and covered by `apps/api` tests. The fake API is deliberately strict (CSRF, 404, 401) so the app is tested against the same contract |

### Optional CI on an emulator

`integration_test` can run on GitHub's Linux runners with KVM using
`reactivecircus/android-emulator-runner` (pin it to a commit SHA): API 35
x86_64, `script: cd apps/mobile && flutter test integration_test/app_security_test.dart`.
It is not in `ci.yml` because it adds 10–15 minutes and is flaky on shared
runners; run it before releases instead.

## 4. Rooted and modified devices (limits)

Everything above assumes Android's app sandbox holds. On a rooted phone, or
with malware that has root, or with an instrumented/repackaged APK:

- The session token can be read: Keystore-backed encryption stops a file copy,
  but root can call the Keystore as the app or hook the app in memory. The
  token works until it expires or is ended (password change, admin action,
  sign-out elsewhere). There is no device binding (S13).
- Downloaded copies (plaintext today; encrypted with server-fetched keys after
  view-only) can be read while the document is open, and screenshots can be
  taken despite FLAG_SECURE.
- Certificate checks can be patched out, so traffic can be read by the device owner.
- We do **not** ship root/emulator detection or Play Integrity: they are bypassed
  by the same tools and would only give a false sense of safety. If needed
  later, Play Integrity verdicts must be checked **on the server**.
- Mitigations that do hold: short sessions and server-side revocation, every
  access audited server-side, copies deleted on revoke/sign-out, watermarking
  (deterrence/attribution, never prevention), and the external camera is
  always possible.

Test: on a rooted emulator image (`google_apis`, `adb root`), confirm what an
attacker sees — `adb shell ls -R /data/data/cloud.rayyanazeem.trustvault`,
`shared_prefs/FlutterSecureStorage.xml` (values encrypted), `app_flutter/downloads`
(only while signed in). Record the result; it documents the limit, it is not a pass/fail.

## 5. Features from other branches: how to test after merge

Stubs are already in place and light up after the rebase:

- **FLAG_SECURE (view-only).** `test/pending_features_test.dart` runs once
  `MainActivity.kt` mentions `FLAG_SECURE`: it checks the flag is added and a
  Dart `MethodChannel` drives it. On device: `integration_test/pending_features_test.dart`
  with `--dart-define=TV_HAS_FLAG_SECURE=true` (adjust the channel name to the
  branch's), and `tool/android-device-checks.sh --expect-secure` with a document
  open: the screenshot must be blank. Also check the recents thumbnail and
  screen recording by hand.
- **Biometric app lock (mfa-advanced).** Runs once `local_auth` is in
  `pubspec.yaml`: `MainActivity` is a `FlutterFragmentActivity`,
  `USE_BIOMETRIC` declared (already on the static check's allowlist), lock wired
  to `AppLifecycleState`. On device: `--dart-define=TV_HAS_APP_LOCK=true`;
  extend the backgrounding test in `app_security_test.dart` to expect the lock
  screen on `resumed` before any document title is visible. The emulator can
  simulate a finger with `adb -e emu finger touch 1`.
- **Encrypted local copies (view-only).** Runs once `cryptography` is in
  `pubspec.yaml`: an AEAD cipher is used and downloaded bytes are not written
  raw. On device: `--dart-define=TV_HAS_ENCRYPTED_COPIES=true`; reuse
  `filesContaining(marker)` — it must find nothing **even while the document is
  open**, and after a revoke the server must refuse the key. The revoke/sign-out
  tests in this suite must keep passing: they check the files are removed,
  encrypted or not.
- **Passkeys via Credential Manager (mfa-advanced).** Server-side WebAuthn
  checks stay in `apps/api`. Add a widget test with the Credential Manager
  channel mocked: a cancelled or failed ceremony must leave the user on the MFA
  screen with no session upgrade.
