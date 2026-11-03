#!/usr/bin/env bash
# Verify a TrustVault release tarball before installing it.
#   verify-release.sh trustvault-v1.2.3.tar.gz [refs/tags/v1.2.3]
#
# Checks, in order:
#  1. the SHA-256 matches the .sha256 file next to it;
#  2. the Sigstore provenance attestation: the file was built by
#     release.yml in azeem-web-dev/TrustVault, from the stated ref, on
#     GitHub-hosted runners (the signature is anchored in Sigstore's public
#     log; there is no key to manage on the server).
# Needs the GitHub CLI (`gh`, 2.49 or newer); no login is needed for a public repo.
# Exit status is non-zero on any failure: do not install in that case.
set -euo pipefail
REPO=azeem-web-dev/TrustVault
ART=${1:?usage: verify-release.sh <tarball> [git-ref e.g. refs/tags/v1.2.3]}
REF=${2:-}

( cd "$(dirname "$ART")" && sha256sum --check --strict "$(basename "$ART").sha256" )

args=(--repo "$REPO"
      --signer-workflow "$REPO/.github/workflows/release.yml"
      --deny-self-hosted-runners)
[ -n "$REF" ] && args+=(--source-ref "$REF")
gh attestation verify "$ART" "${args[@]}"
echo "verify-release: OK ($ART)"

# Alternative without gh (cosign 2 or newer): fetch the bundle once with
#   gh attestation download "$ART" --repo "$REPO"
# then run
#   cosign verify-blob-attestation --bundle <bundle> --new-bundle-format \
#     --type slsaprovenance1 \
#     --certificate-identity-regexp "^https://github.com/$REPO/.github/workflows/release.yml@refs/tags/v" \
#     --certificate-oidc-issuer https://token.actions.githubusercontent.com "$ART"
