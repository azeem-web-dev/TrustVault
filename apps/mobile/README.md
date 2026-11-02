# TrustVault for Android

A Flutter app with the same screens, look and security rules as the web app.
It talks to the live API at `https://vault.rayyanazeem.cloud/api`, so every
check (roles, per-document access, RLS, audit) is the same server-side code.

## What's in it

| Screen | Matches web page | Notes |
|---|---|---|
| Sign in, demo accounts | `/login` | Same four demo buttons |
| Second factor | `/login/mfa` | Authenticator code and setup (QR) |
| Documents | `/` | Stats, scopes, search, filters, list/grid, upload, folders |
| Document | `/documents/[id]` | Download, versions, sharing, suggestions, history, owner actions |
| Account | `/account` | Security score, passkeys list, authenticator, password, theme |
| Audit log | `/admin/audit` | Verify integrity, quick filters, event details, evidence export |
| Alerts | `/admin/alerts` | Severity counts, alert list, break-glass |
| People | `/admin/users` + `/admin/groups` | One tab with Users / Groups |

Light, dark and "match phone" themes; Geist font and Phosphor duotone icons,
both taken from the web app.

## How sign-in works on a phone

The API keeps the session in the `__Host-tv_session` cookie. The app stores
that value in Android's encrypted storage (Keystore-backed) and sends it
itself; the CSRF token stays in memory only, as on the web. Native requests
carry no `Origin` header, which the API's origin check allows (it only
refuses a *different* browser origin). No API changes were needed.

App data is excluded from cloud backup and device transfer, and cleartext
HTTP is disabled.

**Passkeys:** added and used in the app through Android's Credential
Manager (package `passkeys`). They belong to the website address
(`vault.rayyanazeem.cloud`), so one passkey works on the website and in the
app. Android allows this only because the site serves
`/.well-known/assetlinks.json` naming this package and the release signing
certificate, and the API accepts the app's `android:apk-key-hash:` origin
(`PASSKEY_ANDROID_ORIGINS`, THREATS.md S21). A build signed with any other
key (for example the debug key) cannot use them.

**App lock:** a face / fingerprint / phone-PIN lock (`local_auth`) when the
app is opened or comes back after 30 seconds away. On by default when the
phone has a screen lock; switch it in Account. It only covers the screen; the
server session is unchanged (S23).

**Step-up:** when the API asks for a fresh second factor before a risky
action (`403 step_up_required`), the app asks for a code or passkey and sends
the request again.

## Build

Needs Flutter 3.47+, JDK 17 and the Android SDK.

```sh
cd apps/mobile
flutter pub get
flutter build apk --release                 # one APK for every phone
flutter build apk --release --split-per-abi # smaller, one per CPU type
```

Release signing reads `android/key.properties` (not committed). Without it
the build falls back to the debug key, which is fine for side-loading tests.

`flutter analyze` must report no issues.

## Regenerating icons and artwork

Icons (`lib/widgets/phosphor.dart`) and the illustrations in `assets/art`
are generated from the web app so the two never drift:

```sh
node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/mobile/tool/gen-assets.tsx
```

Run it after using a new `PhosphorIcons<Weight>.<name>` in the app. (The
`phosphor_flutter` package does not compile on Flutter 3.47, where
`IconData` became a final class, so the icons are drawn as SVG instead.)
