# Signing Cryptoric Agent releases

This document covers what is signed today, how to verify a download, and how to
complete the Windows Authenticode signing process.

The short version of where things stand:

| Platform | Signature status | Cost |
| --- | --- | --- |
| Linux, macOS, Windows — provenance | **Built and proven, not yet published.** The pipeline signs; no release carries a signature yet. | Free, self-serve |
| Windows — Authenticode (SmartScreen) | **Pending.** Configured and ready; blocked on SignPath Foundation approval. | Free for open source |
| macOS — Developer ID + notarisation | **Not done.** Requires a paid Apple Developer Program membership. | $99/year |

---

## 1. What the project signs, and what that actually buys you

**No published release is currently signed.** All 23 assets across the five
releases on the GitHub Releases page carry zero `.asc` files. The signing job
exists and has been proven against the real 188 MB installer, but it requires
the `CRYPTORIC_GPG_KEY` repository secret and a pinned fingerprint, and it
**fails the build** rather than skipping when they are absent — which is the
correct behaviour for a signing step, and the reason nothing has shipped signed.

Once the secret is set, each asset is published beside a signature:

```
CryptoricAgent-0.1.4-x64.exe
CryptoricAgent-0.1.4-x64.exe.asc
```

The `.asc` is a **detached OpenPGP signature**. It proves the file is
byte-for-byte the one the release pipeline produced, and nothing was modified in
transit.

It does **not** stop Windows SmartScreen from warning. SmartScreen builds its
opinion from a Windows Authenticode signature chaining to a certificate from a
recognised authority, plus the download history of the file. An OpenPGP
signature contributes to neither. This is stated plainly because a `.asc` file
sitting next to an `.exe` looks like it should make the warning go away, and it
does not.

---

## 2. Verifying a download

```bash
# From a clone of this repository:
npm run verify:release -- ~/Downloads/CryptoricAgent-0.1.4-x64.exe
```

Or with plain GnuPG, no checkout needed:

```bash
gpg --keyserver keyserver.ubuntu.com --recv-keys 0A0BDF9C7A1C544D22505E4BC91B55788C7458A1
gpg --verify CryptoricAgent-0.1.4-x64.exe.asc CryptoricAgent-0.1.4-x64.exe
```

A good result looks like:

```
gpg: Good signature from "Cryptoric Agent Release Signing Key <152873138+Itz-Npg@users.noreply.github.com>" [ultimate]
```

The verifier is stricter than plain `gpg` in one way: it refuses to run against
a key that is not the one committed to this repository, and it treats a
signature from an **expired or revoked** key as a failure rather than a warning.
It exits non-zero on any problem, so it can gate a script.

The public key is committed at
[`cryptoric-agent-signing-key.asc`](cryptoric-agent-signing-key.asc) with
fingerprint:

```
0A0BDF9C7A1C544D22505E4BC91B55788C7458A1
```

---

## 3. How Linux and macOS signing works

### Why a detached signature rather than `dpkg-sig`

The obvious way to sign a `.deb` is `dpkg-sig`, which embeds a `_binary.gpgsig`
member inside the package. **This project does not do that**, for a concrete
reason:

`dpkg-sig` *rewrites the `.deb` archive*. electron-builder writes
`latest-linux.yml` — containing the `.deb`'s sha512 — **before** any
post-processing runs, and `electron-updater`'s `DebUpdater` verifies that hash
when it downloads an update. Signing after the fact silently invalidates the
update feed, and the failure mode is users who cannot update, with no error at
signing time to point at the cause.

A detached `.asc` is a **separate file**. It leaves every artifact
byte-identical, so `latest.yml` and `latest-linux.yml` stay correct on every
platform. This is also the ordinary way projects on GitHub Releases sign, and it
is why the CI job signs all platforms in one pass.

If you specifically want a Debian-native embedded signature for a package you
built yourself, run `dpkg-sig --sign builder <file>.deb` on it, and recompute
the hash in any feed that references it. That is a deliberate, manual decision —
the release pipeline does not do it for you.

### Why there is no `gpgKey` in `electron-builder.yml`

electron-builder 25 **removed** built-in GPG signing. Verified against the
installed version:

```bash
grep -c gpg node_modules/app-builder-lib/scheme.json   # -> 0
```

Adding a `gpgKey` key to `linux:` would fail schema validation before a single
file is written. Signing is therefore a post-packaging step, `npm run sign:release`.

### Signing locally

```bash
# export the armored private key and its passphrase, then:
export CRYPTORIC_GPG_KEY="$(cat ~/.cryptoric/release-key.asc)"
export CRYPTORIC_GPG_PASSPHRASE='...'
export CRYPTORIC_GPG_FINGERPRINT='0A0BDF9C7A1C544D22505E4BC91B55788C7458A1'

npx electron-builder --publish never
npm run sign:release            # signs everything in release/
```

Or point at a file instead of an environment variable:

```bash
export CRYPTORIC_GPG_KEY_FILE=/secure/path/release-key.asc
npm run sign:release
```

The script refuses to run if no key is configured. It never falls back to
producing unsigned artifacts while reporting success.

---

## 4. Completing the Windows Authenticode signature

This is the part that makes SmartScreen stop warning. It requires a certificate,
and a self-signed one does **not** qualify — Windows will show an unknown-publisher
warning on it, exactly as on an unsigned binary.

### 4.1 What is already done

`electron-builder.yml` carries the signing block, so nothing has to be built for
this to work the moment a certificate exists:

```yaml
win:
  signtoolOptions:
    rfc3161TimeStampServer: http://timestamp.digicert.com
    signingHashAlgorithms:
      - sha256
```

- `rfc3161TimeStampServer` is not optional in practice. An Authenticode signature
  is only trusted while the signing certificate is valid. A timestamp
  counter-signature records *when* signing happened, so the installer keeps
  verifying after the certificate expires. Without it, an old release silently
  becomes untrusted on a date nobody chose.
- `signingHashAlgorithms: [sha256]` avoids the legacy SHA-1 Authenticode
  algorithm.

electron-builder reads the certificate from the standard environment variables,
so no further configuration is needed:

| Variable | Value |
| --- | --- |
| `CSC_LINK` | Path to a `.pfx`, or a base64-encoded `.pfx` |
| `CSC_KEY_PASSWORD` | Password for that `.pfx` |
| `CSC_IDENTITY_AUTO_DISCOVERY` | `false` on CI, so no job stalls waiting for a human |

**Verified:** with this block present and no certificate in the machine's store,
`electron-builder --win --dir` completes normally and logs
`no signing info identified, signing is skipped`. Local builds without a
certificate are unaffected.

### 4.2 Applying to SignPath Foundation

SignPath Foundation provides free code signing to qualifying open source
projects. The certificate is issued **to SignPath**, not to you; the private key
lives in their hardware security module, and they sign artifacts your CI
produces. You never handle a `.pfx`.

This project qualifies on the face of it: public repository, MIT licence
(OSI-approved), actively maintained, already released, documented, no
proprietary code in the binary, not a hacking tool.

**The application is an external human process. It cannot be automated from this
repository, and it typically takes days to weeks.**

Apply at <https://signpath.org>.

Conditions taken from <https://signpath.org/terms.html> that must hold:

1. An OSI-approved open source licence — MIT. ✔
2. No proprietary code in the distributed artifact. ✔
3. The project is actively maintained. ✔
4. The project is already released. ✔
5. The project is documented. ✔
6. Not a hacking tool or anything intended to subvert a user's system. ✔
7. MFA enabled on both SignPath and GitHub. **Action required.**
8. Define **Authors**, **Reviewers** and **Approvers** roles for the repository.
9. Publish a **"Code signing policy"** on the project home page. ✔ — see
   [`CODE_SIGNING_POLICY.md`](CODE_SIGNING_POLICY.md) and the matching section in
   the README.
10. Sign only artifacts built from your own source.

### 4.3 Wiring SignPath into CI, once approved

SignPath post-signs the GitHub Release directly, so the release pipeline needs
only one addition: upload the artifacts under the release tag so SignPath has
something to sign.

1. In SignPath, add this repository and configure the product for the Windows
   installer.
2. Set the **artifact configuration** to the artifacts `build` produces for
   Windows: `release/*.exe`.
3. Connect SignPath to the GitHub release. It signs and re-uploads as
   `<artifact>.signed.exe`, and adds `<artifact>.signed.exe.p7s`.

That is the whole integration. The existing `sign` job already publishes the
OpenPGP `.asc` signatures, so a signed release then carries both:

- `CryptoricAgent-0.1.4-x64.exe.asc` — OpenPGP, ours, already working
- `CryptoricAgent-0.1.4-x64.signed.exe` — Authenticode, from SignPath

### 4.4 What to expect afterwards, honestly

Signing does not make SmartScreen silent immediately. SmartScreen reputation is
built from download history, so a newly signed, rarely downloaded binary can
still warn. What signing *does* give you:

- the publisher name is visible instead of "Unknown publisher"
- the binary is tamper-evident through the OS trust chain, not only through GPG
- antivirus heuristics treat a signed binary far more favourably
- enterprise allow-listing by publisher becomes possible

---

## 5. macOS

Out of scope and not started. Notarisation requires a paid Apple Developer
Program membership; there is no free route. A macOS user must currently clear
Gatekeeper manually, and a detached OpenPGP signature is the only provenance
check available.

---

## 6. Rotating or revoking the signing key

**Revoke immediately** if the private key is exposed:

```bash
gpg --import ~/.gnupg/openpgp-revocs.d/0A0BDF9C7A1C544D22505E4BC91B55788C7458A1.rev
gpg --send-keys 0A0BDF9C7A1C544D22505E4BC91B55788C7458A1
```

Remove `CRYPTORIC_GPG_KEY` from the repository secrets in the same session. The
release pipeline then fails loudly rather than publishing unsigned builds.

**Rotate** when the key approaches expiry:

1. Generate a new RSA-4096 signing-only key.
2. Commit its public half to `cryptoric-agent-signing-key.asc`.
3. Update `EXPECTED_FINGERPRINT` in `scripts/verify-release.mjs`.
4. Update `CRYPTORIC_GPG_FINGERPRINT` in `.github/workflows/release.yml`.
5. Replace the repository secrets.
6. Publish the old key's revocation certificate.
7. Announce both fingerprints in the release notes.

---

## 7. Files

| Path | Purpose |
| --- | --- |
| [`cryptoric-agent-signing-key.asc`](cryptoric-agent-signing-key.asc) | Public key. Committed; this is what users verify against. |
| [`AUDIT.md`](AUDIT.md) | Verification record: what was proven, what was not, and why. |
| [`CODE_SIGNING_POLICY.md`](CODE_SIGNING_POLICY.md) | Who may sign, under what terms. Required wording for SignPath. |
| [`SIGNING.md`](SIGNING.md) | This file. |
| [`../../scripts/sign-release.mjs`](../../scripts/sign-release.mjs) | Signs a release directory. |
| [`../../scripts/verify-release.mjs`](../../scripts/verify-release.mjs) | Verifies a downloaded artifact. |
| [`../../scripts/lib/signing.mjs`](../../scripts/lib/signing.mjs) | Shared GPG primitives. |
| [`../../tests/unit/signing.test.ts`](../../tests/unit/signing.test.ts) | Tests, including a real sign/tamper round trip. |

The private key is gitignored under `.signing/` and is never committed.