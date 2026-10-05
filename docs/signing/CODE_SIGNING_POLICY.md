# Code signing policy

Cryptoric Agent is distributed as prebuilt Windows installers, macOS disk images
and Linux packages on the [GitHub Releases page](https://github.com/Itz-Npg/Cryptoric-Agent/releases).
This page states who is allowed to sign those artifacts, on what terms, and what
a signature does and does not prove. It is kept here and in the project README so
that the terms are visible to anyone who downloads a binary.

The specific term **"Code signing policy"** is used deliberately: SignPath
Foundation requires a project to publish a code signing policy using exactly that
wording as a condition of free code signing.

## What is signed today, and what is not

| Artifact | Signature | Status |
| --- | --- | --- |
| Windows `.exe` (NSIS installer) | OpenPGP detached signature (`.asc`) | Active |
| macOS `.dmg` | OpenPGP detached signature (`.asc`) | Active |
| Linux `.AppImage`, `.deb` | OpenPGP detached signature (`.asc`) | Active |
| Windows Authenticode signature | — | Pending SignPath Foundation approval |
| macOS Developer ID signature and notarisation | — | Not done; requires a paid Apple Developer Program membership |

A detached OpenPGP signature answers one question: *is this file byte-for-byte
the one the release pipeline produced?* It does not make Windows SmartScreen or
macOS Gatekeeper stop warning. Those trust decisions come from a certificate
issued by a recognised authority, which is a separate thing, described below.

No signature in this project is ever produced by a test double, a self-signed
placeholder, or a mocked code path. An artifact is either signed by the release
key or it is published unsigned and says so.

## Who may sign release artifacts

Only the automated release pipeline in
[`.github/workflows/release.yml`](../../.github/workflows/release.yml), running
on a tag matching `v*` that agrees with `package.json`.

Signing requires the repository secret `CRYPTORIC_GPG_KEY`. That secret is
readable by anyone with administrative access to this repository, which is the
same trust boundary as the ability to publish a release at all. There is no
route by which a fork, a pull request, or an unprivileged contributor can
produce an artifact carrying this project's signature.

The signing job additionally pins the key fingerprint
(`0A0BDF9C7A1C544D22505E4BC91B55788C7458A1`). A substituted secret is rejected
before any artifact is signed, rather than silently used.

## Conditions on this project

These are the commitments the project makes in exchange for signed releases, and
they match the conditions SignPath Foundation places on the projects it signs:

1. **The licence is OSI-approved.** This project is MIT, which is OSI-approved.
2. **There is no proprietary code in the distributed binary.** Everything
   packaged into the installer is in this repository under the same licence.
   The one exception a user can opt into is their own provider API key, which is
   read at runtime and is not bundled in published builds — see the warning in
   the README about `npm run stage:keys`.
3. **The project is maintained and already released.** Releases exist, and
   commits are not abandoned.
4. **The project is documented.** This repository has a README, a `LICENSE`, a
   `CONTRIBUTING`-grade description of the build, and this policy.
5. **No signing tool is used to sign a hacking tool, malware, or anything
   intended to subvert a user's system.**
6. **Multi-factor authentication is enabled** on both the GitHub account and the
   SignPath account.

## Rules for contributors

- Contributors do not receive access to the signing key. Opening a pull request
  never grants it, and no contributor can produce a signed build.
- Artifacts built locally are unsigned. That is expected and is not a defect.
- If a contribution is merged, the release pipeline signs the artifact built
  from the merged `main`, not from the contributor's branch.

## Key management

- The signing key is an RSA-4096 OpenPGP key used **only** for signing, never for
  encryption, so it can be published without weakening anything.
- The private key is stored in the repository secret `CRYPTORIC_GPG_KEY` and is
  protected by a passphrase held in `CRYPTORIC_GPG_PASSPHRASE`.
- The private key is gitignored and is never committed. A private key in git
  history is permanent and cannot be rotated away.
- The **public** key is committed at
  [`cryptoric-agent-signing-key.asc`](cryptoric-agent-signing-key.asc). That is
  the key users verify against, so it has to be in the repository.
- The key expires. Rotation is done by generating a new key, committing its
  public half, updating the fingerprint pin in the workflow, and publishing the
  old key's revocation certificate.
- A revocation certificate for the key exists locally and offline. Revoking is
  the correct response to any suspected compromise.

## Verifying a download

```bash
npm run verify:release -- path/to/CryptoricAgent-0.1.4-x64-setup.exe
```

The verifier imports the committed public key into a temporary keyring, checks
the signature, and exits non-zero if anything does not match. See
[`SIGNING.md`](SIGNING.md) for the full procedure and for what a failure means.

## Changes to this policy

Any change to this policy is a commit to this repository and therefore visible in
the history. Reducing the protections above requires the explicit agreement of
the project owner.