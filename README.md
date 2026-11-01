# TrustVault audit witness

This branch is written only by the **Audit witness** GitHub Actions workflow (`.github/workflows/witness.yml` on `main`). Every 15 minutes it fetches the signed audit checkpoints from https://vault.rayyanazeem.cloud/api/witness/checkpoints and appends new ones here.

| File | What |
|---|---|
| `signing-key.json` | The Ed25519 public key the server signs checkpoints with, pinned on the first run. If the server ever reports a different key, the witness stops and fails. |
| `checkpoints.jsonl` | One line per checkpoint: `seq`, `headHash` (the hash chain's value at that event), `signature`, `createdAt` (server time), `witnessedAt` (GitHub's time), and, once published, `rekorLogIndex` / `rekorIntegratedTime`. |
| `public-log.jsonl` | Every entry in [Sigstore's public log](https://search.sigstore.dev/?logIndex=3633615638) signed with the audit key that this witness has checked, with the `seq` it matched. |

Why this matters: the hash at each `seq` commits to every audit event before it. The TrustVault server has no credential for this repository, so even someone with root on the server cannot change what is recorded here. Each run also checks that every earlier checkpoint is still on the server unchanged, and that the chain's current hash at the last recorded `seq` is still the recorded one. If not, nothing is committed and the workflow fails.

Between runs, the server publishes each checkpoint to Sigstore's public transparency log (Rekor) within about a minute (`tools/anchor.mjs`). Nobody can remove an entry there. Each run checks that every public entry signed with the audit key still matches a checkpoint on the server, and fails if a checkpoint stays unpublished for an hour.

Check an exported audit bundle against this record and the public log:

```bash
node tools/verify-audit.mjs trustvault-audit.json --witness checkpoints.jsonl --rekor
```

The git history of this branch is the timeline: force pushes and deletion are blocked by a repository ruleset.
