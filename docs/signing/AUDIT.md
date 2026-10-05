# Release signing — verification record

Every claim below was produced by running the command shown. Anything not run is
marked **NOT VERIFIED**. This file replaces the top-level tracking documents that
were removed from the repository on 2026-10-05.

Key fingerprint under test:
`0A0BDF9C7A1C544D22505E4BC91B55788C7458A1`

---

## Verified

| Check | Command | Result |
|---|---|---|
| Typecheck, node | `npm run typecheck:node` | exit 0 |
| Typecheck, web | `npm run typecheck:web` | exit 0 |
| Full unit suite | `npx vitest run` | **566 passed / 21 files**, exit 0 |
| Signing suite | `npx vitest run tests/unit/signing.test.ts` | **48 passed**, exit 0 |
| Sign the real built exe | `node scripts/sign-release.mjs --dir .review/tmp/realrel` | exit 0, `Signed 1 artifact(s)` |
| Verify the real built exe | `node scripts/verify-release.mjs .review/tmp/realrel/cryptoricagent.exe` | `GOOD`, exit 0, 0.6 s |
| Independent cross-check | `gpg --verify <file>.asc <file>` | `Good signature from "Cryptoric Agent Release Signing Key"`, exit 0 |
| Tamper detection | append one byte, re-verify | `BAD`, exit 1, `the signature does not match the file` |
| Missing signature | delete the `.asc`, re-verify | `BAD`, exit 1, `no signature file at …` |
| Missing artifact | verify a path that does not exist | `BAD`, exit 1 (a failure, not a crash) |
| Private key not tracked | `git check-ignore -v .signing/private-key.asc` | ignored by `.gitignore` |
| Public key carries no secret | `grep -c "PRIVATE KEY" docs/signing/cryptoric-agent-signing-key.asc` | **0** |
| Artifact bytes unchanged | re-sign, compare artifact contents | identical — updater hashes stay valid |
| Update feed left alone | sign a dir containing `latest.yml` | only the `.exe` got a `.asc` |
| Empty directory refused | sign an empty dir | throws `No signable artifacts`, exit 1 |
| Missing key refused | sign with no env vars | throws `No signing key configured`, exit 1 |
| Wrong fingerprint refused | pin a fingerprint that is not the imported key | throws `Refusing to sign with the wrong key` |
| Workflow YAML valid | `js-yaml` parse; resolve every `needs` | jobs `verify, build, sign, release`, all resolve |
| Signing block inert without a cert | `npx electron-builder --win --dir --publish never` | exit 0, `no signing info identified, signing is skipped` |
| electron-builder has no `gpgKey` | `grep -c gpg node_modules/app-builder-lib/scheme.json` | **0** — the option no longer exists |

---

## Not verified / blocked

| Item | Status | Why |
|---|---|---|
| Windows Authenticode signature | **NOT IMPLEMENTED** | Requires a certificate. `win.signtoolOptions` is configured and proven inert without one; the signature cannot exist until SignPath Foundation approves the project. |
| SmartScreen warning cleared | **NOT VERIFIED** | Follows from the above. SmartScreen reputation also accrues from download history over time and cannot be tested in a single run. |
| The `sign` job in CI | **NOT VERIFIED** | Needs repository secret `CRYPTORIC_GPG_KEY`, which is not set. By design the job **fails loudly** rather than publishing unsigned artifacts, so it has not run green. |
| macOS Developer ID + notarisation | **OUT OF SCOPE** | Requires a paid Apple Developer Program membership. Not attempted. |
| SignPath Foundation approval | **BLOCKED** | External human application at <https://signpath.org>; days to weeks. Not a code problem. |

---

## Bugs this feature actually had

Recorded because each was a way to ship something that *looked* signed and was
not.

1. **The passphrase was never delivered to gpg.**
   `child_process.execFile` has no `input` option, so the computed passphrase was
   silently discarded and gpg blocked forever waiting on stdin. A signing step
   that hangs is not a signing step. Fixed by `--passphrase-file` inside the
   throwaway GnuPG home, which also keeps the secret out of the process table.

2. **The guard checked the wrong field.**
   `readSigningMaterialFromEnv` returns `armoredKey: null` legitimately when the
   key comes from a *file*, so testing `!material.armoredKey` made the file
   path permanently unreachable. The signal that a key is configured is
   `source`, not `armoredKey`.

3. **`--list-keys` parsed as an empty keyring.**
   The colon-format parser only recognised `sec` records, so verifying a *public*
   key reported `no public key found` — a perfectly good key reported as
   missing.

4. **Path spelling differed between gpg builds.**
   Git Bash's MSYS build treats `C:\Users\…` as a *relative* path and resolves it
   against the cwd, so every call failed with "directory does not exist". A
   native GnuPG for Windows build wants the opposite. Guessing would have been
   wrong for half the audience, so `detectGpgPathStyle` probes which form the
   installed gpg accepts and caches the answer.

---

## Design decisions worth defending

**Detached signatures, not `dpkg-sig`.** `dpkg-sig` embeds a `_binary.gpgsig`
member by rewriting the `.deb` archive. electron-builder writes
`latest-linux.yml` — containing the `.deb`'s sha512 — *before* any
post-processing, and `electron-updater`'s `DebUpdater` verifies that hash when it
downloads an update. Signing after the fact would have invalidated the feed and
silently broken auto-update, with no error at signing time to point at the
cause. A detached `.asc` is a separate file and leaves every artifact
byte-identical. A test asserts this.

**Refuse rather than degrade.** The signer exits non-zero when no key is
configured, when the release directory holds no artifacts, and when the pinned
fingerprint does not match the imported key. A signer that quietly produces
nothing is indistinguishable from one that quietly produced nothing
*correct* — which is exactly when a missing failure becomes the failure.

**Parse machine output, not prose.** GPG's human-readable `--verify` output is
localised and its wording shifts between releases. `--status-fd` is a documented,
stable machine interface. A verifier written against prose breaks on a user's
German locale.

**An expired or revoked key is a failure, not a warning.** `EXPKEYSIG`,
`REVKEYSIG` and `EXPSIG` are the exact moments a user needs to stop and think.
Treating them as advisory is how an abandoned or compromised key goes unnoticed.

**Pin the fingerprint.** The key id is committed in code and pinned in the
workflow, so a substituted secret is rejected before anything is signed instead
of being used quietly. That is the same threat the signature exists to detect,
applied to the signing step itself.

**`sign` is a separate CI job.** The three build runners each produce artifacts
for a different operating system, but an OpenPGP signature is not
platform-specific: one Linux runner signs the Windows `.exe`, the macOS `.dmg`
and the Linux `.deb` alike. One signing run, one key, one place in the log to
look when a signature is disputed.

**The release job takes one named artifact.** It downloads `signed` by name
rather than merging everything. Merging would also pull in the per-platform
`installers-*` artifacts the `sign` job already consumed, publishing the same
installer twice and letting whichever copy landed last decide whether it was the
signed one.