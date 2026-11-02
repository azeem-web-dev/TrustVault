# Supply chain: dependencies, builds, releases

What stands between a malicious or vulnerable dependency and the production
server, and what is still open. Covers checklist item 12.

## 1. Vulnerability scanning (CI job `audit`)

| Scanner | Covers | Gate |
|---|---|---|
| `npm audit --omit=dev --audit-level=high` | production npm tree | fails on high or critical |
| OSV-Scanner (pinned action) | `package-lock.json`, `keyd/Cargo.lock`, `apps/mobile/pubspec.lock` | fails on **any** known vulnerability not in `osv-scanner.toml` |
| `cargo audit --deny warnings` | `keyd/Cargo.lock` against RustSec | fails on advisories and on unmaintained/yanked crates |
| gitleaks | full git history | fails on any secret (`.gitleaks.toml` allowlists only the published demo logins) |

**Allowlist policy.** Accepted findings go in `osv-scanner.toml` only, as
`[[IgnoredVulns]]` with `id`, `ignoreUntil` (at most 90 days ahead) and a
`reason` (why unreachable, what the plan is). When the date passes the
finding fails CI again, so nothing is accepted forever. Upgrading is
preferred to allowlisting. A cargo-audit-only finding is handled the same
way via an `[advisories] ignore` entry in `keyd/.cargo/audit.toml` with the
same justification in a comment. `npm audit` has no allowlist: if it blocks
and OSV agrees the finding is not reachable, use `overrides` in
`package.json` to move to a fixed version, or lower the gate in a reviewed PR.

**Triage on 2026-11-03** (run locally before the PR): npm audit (all and
prod-only) 0 vulnerabilities; OSV-Scanner 2.7.0 over the three lockfiles
(557 npm, 54 Cargo, 92 pub packages) no issues. Allowlist is empty.
Not scanned: transitive pub packages are only as good as OSV's Pub coverage;
`cargo audit` was not run locally (it runs in CI).

**Dependabot** (`.github/dependabot.yml`): weekly, grouped PRs for npm
(root workspace), cargo (`/keyd`), pub (`/apps/mobile`) and github-actions
(which also keeps the SHA pins fresh).

## 2. Locked, pinned, least-privilege CI

* `Cargo.lock` was **not committed** before this change, so `keyd` built
  whatever crate versions were newest on the day (on the server and in CI).
  It is now committed and CI uses `cargo test --locked` and
  `cargo build --locked`. `deploy`'s `install-keyd.sh` still runs without
  `--locked`; adding it is a one-word change recommended with the artifact
  switch (section 4).
* `npm ci` is already lockfile-exact. Install scripts stay off except the
  three approved packages (`allowScripts` in `package.json`).
* Every `uses:` in every workflow is pinned to a full commit SHA with a
  version comment (Dependabot updates them). The rust toolchain is pinned to
  1.91.1, the version `install-keyd.sh` uses on the server.
* Each workflow has top-level `permissions: contents: read`; jobs widen only
  as needed (`release.yml` build: `id-token`, `attestations`, `contents:
  write`; `witness.yml` needs `contents: write` to push the witness branch).
  Checkouts use `persist-credentials: false` except where the job pushes.

## 3. SBOMs

CI job `sbom` (every push/PR) and the release job produce CycloneDX 1.5 JSON:
`npm.cdx.json` (`npm sbom`, production deps) and `tvkeyd.cdx.json`
(`cargo-cyclonedx`). They are CI artifacts (90 days) and files inside and
beside the release tarball. Root `package.json` and the lockfile gained
`"version": "0.0.0"` because `npm sbom` refuses a root package without one.
The Flutter app is not in the SBOM (not part of the server release).

## 4. Signed builds and provenance (`.github/workflows/release.yml`)

On a `v*` tag (or manual run) the workflow builds the API (`tsc`), web
(`next build`) and keyd (`cargo build --release --locked`) from the locked
inputs and packs `trustvault-<tag>.tar.gz` (deterministic tar and gzip:
sorted names, fixed owner, mtime = commit time) with a `.sha256` file and
the SBOMs. `actions/attest-build-provenance` signs a SLSA provenance
statement with a short-lived Sigstore certificate bound to the workflow
identity (GitHub OIDC; no long-lived signing key exists to steal) and logs
it in Sigstore's transparency log. Tag pushes also attach files to a GitHub
release.

**Verifying on the server:** `infra/server/verify-release.sh <tarball>
refs/tags/<tag>` checks the hash and runs `gh attestation verify` pinned to
repo `azeem-web-dev/TrustVault`, signer workflow `release.yml`, the tag, and
GitHub-hosted runners only. A cosign alternative is in the script.

**Moving from "build on server" to "install signed artifact".**
`infra/server/deploy-artifact.sh vX.Y.Z` is implemented but *not* the
default; `deploy.sh` is unchanged and the artifact path is untested on the
server. Plan:

1. Install `gh` on the server (apt repo from cli.github.com, or a pinned
   release `.deb` whose checksum you verify).
2. Push a tag, confirm the Release workflow is green, run
   `verify-release.sh` by hand on the server.
3. Run `deploy-artifact.sh` once; `/opt/trustvault/app` must first be moved
   aside (the script refuses to replace a real directory) and becomes a
   symlink to `/opt/trustvault/releases/<tag>`; rollback is re-pointing it.
4. Retire `deploy.sh` and `install-keyd.sh`'s on-server compile; remove
   `rustc`, `cargo` and the `tvbuild` user from the server. The server then
   runs no compilers and fetches nothing that is not signature-checked
   (`npm ci` for runtime deps still downloads from the registry, locked by
   integrity hashes in `package-lock.json`).
5. Protect tags (repo settings) so only the owner can create `v*` tags.

**Reproducibility, honestly.**

| Piece | Status |
|---|---|
| keyd binary | Intended reproducible: `--locked`, fixed toolchain, `--remap-path-prefix`, `SOURCE_DATE_EPOCH`, `codegen-units=1`, `lto`, `strip`. CI job `keyd-reproducible` builds twice in different directories and compares SHA-256 (`tools/repro-check-keyd.sh`). It was written without a Linux machine to run on, so treat the first CI result as the real answer. |
| Tarball packing | Deterministic (see above), but its contents are only as reproducible as the files in it. |
| `npm ci` | Deterministic given the lockfile (integrity hashes); packages are not rebuilt. `prisma`/`esbuild` rebuild step downloads engines: not hash-pinned by us. |
| `next build` | Not guaranteed reproducible (build ids, chunk hashes can vary); not checked. |
| `tsc` output | Deterministic for a given input and compiler; not checked yet. |
| Provenance | Proves *which workflow and commit* produced the file, not that the build is reproducible; reproducibility is what lets a third party confirm the runner was not tampered with. |

## 5. OS and containers

There are no containers. The host is Ubuntu with `unattended-upgrades`
enabled (security pocket). Operator check:
`sudo bash infra/server/patch-report.sh` lists pending security updates,
whether a reboot is required (kernel updates do not apply until reboot) and
services running old libraries (needs `needrestart`). Suggested cadence:
weekly, and after any Ubuntu security notice for OpenSSL, nginx, Redis,
PostgreSQL or the kernel. Not automated by CI (no access to the server, by
design).

## 6. Secrets and pre-commit

gitleaks stays in CI on full history. For a local check before committing,
`.pre-commit-config.yaml` runs the same tool (`pipx install pre-commit &&
pre-commit install`). It is optional and unenforced; CI is the gate.

## 7. Repo settings the owner must enable (not expressible in files)

* Dependabot alerts and Dependabot security updates; secret scanning and push
  protection.
* Branch protection on `main`: require PR, require the CI jobs (`api`,
  `keyd`, `audit`, `secrets`, `sbom`) and up-to-date branches.
* Tag protection / ruleset for `v*`; Actions setting "Workflow permissions:
  read repository contents" as default, and "Allow only selected actions"
  or at least require SHA pinning.
* If the repository is private, `gh attestation verify` needs a token and
  attestations require GitHub Enterprise; keep the repo public or use
  cosign with a bundle uploaded to the release.

## 8. Remaining gaps

* `deploy.sh` and `install-keyd.sh` still build on the server (until the
  owner switches); `install-keyd.sh` does not pass `--locked`.
* Reproducibility of web/tsc output unchecked; keyd check unproven on CI.
* The prisma engine download during `npm rebuild` is outside lockfile
  hashing.
* Server credentials review (checklist: build-server and deployment
  credentials) is not covered here: the server holds no GitHub credential;
  the artifact path needs only read access to a public release.
* Actions are pinned, but the first runs of the new jobs have not executed
  (workflows linted with actionlint 1.7.7 only).
