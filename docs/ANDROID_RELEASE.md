# Android release builds

The TrustVault Android app (`apps/mobile`) has a ready-to-install build kept as
a GitHub Actions artifact at all times. You never have to build it locally.

## Where the ready build is

Workflow: **`.github/workflows/android-release.yml`** (job *Build signed APK + AAB*).

It runs:

- on every push to `main` that touches `apps/mobile/**`, and
- on demand from the Actions tab (**Run workflow** → *Android release build*).

It runs `flutter pub get --enforce-lockfile`, `flutter analyze`, `flutter test`,
then builds both a release **APK** and a release **AAB**, using the same pinned
`subosito/flutter-action` and Flutter **3.47.9** as `ci.yml`.

### Downloading it

Open the latest run of *Android release build* in the **Actions** tab and
download the artifacts at the bottom of the run page:

| Artifact | File | Use |
| --- | --- | --- |
| `trustvault-apk` | `app-release.apk` | Install directly on a phone (sideload) for testing. |
| `trustvault-aab` | `app-release.aab` | Upload to the Play Console. |

Artifacts are kept for **90 days**.

## Signing

Signing is controlled entirely by GitHub Actions **secrets**. Nothing secret is
ever committed — `key.properties`, `*.jks` and `*.keystore` are git-ignored, and
the workflow deletes the decoded keystore and `key.properties` at the end of the
run.

### Without secrets (default)

If no signing secrets are set, the release build is **debug-signed**. It still
installs on a device for testing, but Google Play will not accept a debug-signed
build. This is the out-of-the-box behaviour.

### With your upload key

Set these four **repository secrets** (Settings → Secrets and variables →
Actions):

| Secret | What it is |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Your keystore (`.jks`) file, base64-encoded. |
| `ANDROID_KEYSTORE_PASSWORD` | The keystore (store) password. |
| `ANDROID_KEY_ALIAS` | The key alias inside the keystore. |
| `ANDROID_KEY_PASSWORD` | The password for that key. |

Encode the keystore like this (keep the original `.jks` safe and out of git):

```bash
# macOS / Linux
base64 -w0 upload-keystore.jks           # paste the output as ANDROID_KEYSTORE_BASE64

# Windows (PowerShell)
[Convert]::ToBase64String([IO.File]::ReadAllBytes("upload-keystore.jks"))
```

When the secrets are present the workflow decodes the keystore, writes
`android/key.properties`, and `android/app/build.gradle.kts` uses the release
`signingConfig` (it falls back to the debug key when `key.properties` is absent).
Both the APK and the AAB are then signed with your upload key.

## Play Console is yours

Uploading the AAB to the Play Console, Play App Signing, release tracks and
rollout are **the owner's step** and are intentionally **not** automated here.
This repository and CI never publish to Google Play.
