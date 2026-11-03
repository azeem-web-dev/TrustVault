# Access policies: download approval, working hours, networks, managed devices

Checklist items 16 and 18. What is built, how both locks enforce it, and — for managed devices — what is designed but deliberately **not** built. Threat rows: THREATS.md P1-P15. Endpoints: docs/API.md, "Access policies".

## What a share can say

| Condition | Who sets it | Effect |
|---|---|---|
| **Downloads need approval** | The owner (or a manager creating a new share) | The recipient keeps every other right of the share (details, versions list, EDIT/MANAGE if given). The bytes of a version are released only against an approval for that person and that version. |
| **Approver** | The owner | One manager (someone with MANAGE now) who may also decide requests on that share. The owner always may. Nobody decides their own request. |
| **Time window** | The owner (or a manager creating a new share) | ISO days of the local date, local minutes `[start, end)`, a named IANA zone. Outside it the share gives nothing at all. |
| **Networks** | Same | Up to 32 IPv4/IPv6 CIDR ranges. From anywhere else the share gives nothing at all. |

Administrators can set a time window and networks **per role** (OWNER, VIEWER, EXTERNAL). Role rules apply on top of every share held by people with that role. They never affect an owner's own documents, and an owner's exception cannot lift them.

Grants are additive, as before: a person's access is the best of their **usable** shares. A share outside its window or network does not count, and does not lend its level to another share (an EDIT share outside its window plus a READ share inside it gives READ). Downloads need approval unless at least one usable share that allows downloading (READ, EDIT or MANAGE, matched by name) does not ask for it. So an owner who wants approval to bind a person must not also give them an unconditioned share, directly or through a group.

## Download approval

1. The recipient asks: `POST /documents/:id/download-requests {reason, versionNo?}`. The row is created PENDING by a trigger whatever the client sends; one pending request per person and version. The owner and the nominated approver are emailed (never demo accounts).
2. The owner or approver decides: `tv_decide_download()` (SECURITY DEFINER) re-checks that the caller is not the requester and may decide, sets the terms (1-72 hours, 1-10 downloads) and records who and when. The app role has no UPDATE or DELETE on the table. A CHECK constraint (`decided_by_id <> requester_id`) holds for every writer, including the schema owner.
3. Each download calls `tv_consume_download(approval, version)` inside the download transaction: it row-locks the approval, checks requester, version, status, window, remaining uses and that the person still has access, then counts one use and stamps the transaction id. The RESTRICTIVE policy `blobs_release` on `document_blobs` releases the encrypted bytes only when no approval is needed, or when an approval for this person and version was used **in this same transaction**. A later transaction sees nothing again.
4. Ends: USED when the uses run out; EXPIRED (by the hourly job, and whenever lists are read) when its window ends or a request waits 7 days; CANCELLED when the person's share is revoked (trigger), so a re-share does not revive it; REJECTED.

Every step is audited: `download_approval.request / approve / reject / use / expire`, plus `document.download` DENIED `approval_required` and ALLOWED with the `approvalId`.

The owner, the person who uploaded a version, and an admin with break-glass are not asked (break-glass has its own one-hour limit and alert).

## Time windows and daylight saving

The database computes `p_at AT TIME ZONE tz`, then the ISO weekday and `hour*60+minute` of that local time (`tv_in_window`). The API does the same with `Intl.DateTimeFormat` in that zone (`schedule.ts`). Because both convert the instant with the zone's own rules:

- on a spring-forward day the skipped local hour never occurs: a window 02:00-03:00 simply never opens that day;
- on a fall-back day the repeated hour occurs twice, and both are inside a window that covers it;
- `09:00-17:00 America/New_York` opens at 13:00 UTC in summer and 14:00 UTC in winter.

`test/fixtures/window-cases.json` (37 cases: New York, London, Auckland DST changes, Kolkata day boundaries, end-of-day 24:00) is run against both implementations; the database cases also run with an unrelated session time zone. Only named zones are accepted; POSIX strings such as `UTC+5` are refused in both layers (Postgres reads their sign the other way round). Windows over midnight are refused rather than guessed (use two days). Both locks read their own clock (`clock_timestamp()` in Postgres); within the clock difference at a window edge one of them may already refuse, which fails closed.

Node's ICU and Postgres's tzdata are separate copies of the IANA database. A zone whose rules changed recently could differ until both are updated; keep the OS packages and Node current.

## Networks and the client address

- **Where the address comes from.** Express takes it from the TCP connection and believes `X-Forwarded-For` only from `TRUSTED_PROXIES` (default `loopback`: nginx on the same machine, which overwrites the header with `$remote_addr`). It uses the right-most address not added by a trusted proxy, so a client-supplied `X-Forwarded-For: 10.0.0.5` in front of the real address is ignored. If the deployment moves behind a load balancer, `TRUSTED_PROXIES` must list exactly that balancer, or every allowlist is either useless or spoofable.
- **IPv4 over IPv6.** `::ffff:a.b.c.d` is normalised to `a.b.c.d` before matching, in the API and before it is handed to Postgres. IPv4 rules never match IPv6 addresses and vice versa.
- **In the database.** The API sets `app.client_ip` next to `app.user_id` (transaction-local). Unset or malformed means unknown, and unknown matches no allowlist. The database cannot verify the address: a compromised API process can claim any IP. The database half of this rule protects against application bugs (a route that forgets to check), not against a compromised server.
- **What an allowlist does not do.** It checks the network a request comes from, not the device or the person. Office VPNs and NAT put many devices behind one address; a stolen password used over the VPN passes; people on mobile networks and at home fail. Use it with MFA, short shares and download approval, never as the only control. Emergency access when someone is off-network: the owner's exception (per document, at most 24 hours), or an administrator changing the role rule — both audited.

## Emergency exceptions

`POST /documents/:id/overrides {userId, reason, hours}` — owner only (both locks: the API needs owner level; the insert policy and a trigger require the document's owner, a share to apply to, a 10+ character reason, and at most 24 hours from now, with the start time set by the database). It lifts the window, network and approval conditions of that person's shares on that document until it ends or the owner ends it. It never raises the level and never lifts role rules. The person is emailed; the owner gets a receipt (so a hijacked owner session handing out exceptions is noticed). Audited as `access.override` / `access.override_end`.

## Managed devices: designed, not built

A web service cannot see device posture. An honest version needs the device to prove itself cryptographically, which the company's MDM can arrange with client certificates. This is the design; **none of it is implemented**, and the UI says so.

1. **Issuance.** The MDM (Intune, Jamf, …) enrols managed laptops and phones with a client certificate from a dedicated company CA, in the device's hardware key store, non-exportable, short-lived (days), re-issued only while the device is compliant. Revocation by not renewing, plus a CRL/OCSP the proxy checks.
2. **Verification at the edge.** nginx on a separate hostname (e.g. `managed.vault…`) uses `ssl_verify_client optional; ssl_client_certificate <company CA>; ssl_crl …;` and passes `$ssl_client_verify` and `$ssl_client_fingerprint` (and the serial) to the API in headers it always overwrites. TLS is terminated on the same machine; the headers are believed only from the loopback proxy, exactly like `X-Forwarded-For`.
3. **Binding.** A `devices` table maps certificate fingerprints to the person they were issued for (imported from the MDM or registered by an admin). A request counts as "from a managed device" only if the certificate verified, is not revoked, and belongs to the signed-in user.
4. **Policy.** A share or role condition `requireManagedDevice` would join the window and networks: evaluated in `decide()` and, through `app.device_id` set per transaction like `app.client_ip`, in `tv_grant_usable()`. The same caveat applies: the database trusts what the API tells it.
5. **Off by default.** Enabled by configuration only when the CA, the nginx hostname and the device import exist; otherwise the condition cannot be chosen.

Limits even when built: a compromised managed device passes; a user can screen-capture or photograph on a managed device; the Android app would need its own mTLS client and Play Integrity/attestation to say anything about the phone.
