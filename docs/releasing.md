# Release guide

PhaseAtlas releases are immutable macOS artifacts published from Git tags by GitHub Actions. The
current public channel is temporarily ad-hoc signed and not notarized; users must explicitly remove
quarantine when Gatekeeper blocks a verified download. This document defines the version, changelog,
branch, build, and recovery contract for a production release.

## Version policy

PhaseAtlas follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html):

- `MAJOR` changes for incompatible public contracts after 1.0;
- `MINOR` changes for backwards-compatible features; and
- `PATCH` changes for backwards-compatible fixes.

Before 1.0, a minor version may include a breaking contract or storage change, but it must be called
out under `Changed` or `Removed` in the changelog. Pre-release identifiers use normal SemVer syntax,
for example `0.2.0-beta.1`.

The root `package.json` is the only application release-version authority. Workspace packages are
private implementation units and are not versioned or published independently. A release tag must be
exactly `v<package.version>`.

## Changelog policy

`CHANGELOG.md` follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/). User-visible
changes are added under `Unreleased` as part of the pull request that introduces them. Use only the
standard categories:

- `Added`
- `Changed`
- `Deprecated`
- `Removed`
- `Fixed`
- `Security`

Release notes describe user and operator impact, not commit history. Before tagging, move the relevant
entries into `## [x.y.z] - YYYY-MM-DD`, restore an empty `Unreleased` heading, and update the comparison
links at the bottom of the file.

The release workflow rejects a missing `Unreleased` section, invalid SemVer, missing dated version
section, empty version notes, or a tag that does not match the root package version.

## Branch and tag policy

- Feature and fix pull requests target `develop`.
- A release pull request promotes `develop` into `main` and contains the final version and changelog.
- The release tag points to the reviewed merge commit on `main`.
- Tags and published artifacts are immutable. Never move or reuse a release tag.

Signed annotated tags are recommended:

```bash
git switch main
git pull --ff-only origin main
git tag -s v0.1.0 -m "PhaseAtlas 0.1.0"
git push origin v0.1.0
```

Pushing the tag is the production deployment trigger. The workflow verifies that the tagged commit is
contained by `origin/main` before building any release artifacts.

## Preparing a release

1. Confirm `develop` is green and contains the intended changes only.
2. Choose the next version from the SemVer policy.
3. Update the root version without creating a tag:

   ```bash
   pnpm version 0.1.0 --no-git-tag-version
   ```

4. Move completed `Unreleased` entries into the dated version section and update comparison links.
5. Validate locally:

   ```bash
   pnpm release:validate -- --tag v0.1.0
   pnpm check
   pnpm test
   pnpm build
   ```

6. Open and review the release pull request from `develop` into `main`.
7. Merge the release pull request, create the exact version tag on its merge commit, and push the tag.

## GitHub production environment

Create a GitHub Actions environment named `production`. Require maintainer approval and restrict it to
protected version tags. The temporary unsigned workflow does not require environment secrets.

## Temporary unsigned distribution

The workflow sets `PHASEATLAS_RELEASE_UNSIGNED=1`. This is an explicit exception: packaging still
uses an ad-hoc code signature for bundle consistency, but does not use a Developer ID certificate,
submit to Apple notarization, staple a ticket, or enable signed update metadata. GitHub publishes
SHA-256 checksums so users can verify the ZIP before removing quarantine.

After comparing the downloaded ZIP with `SHA256SUMS.txt`, users can try **Control-click → Open**. If
Gatekeeper still blocks the verified application, remove quarantine explicitly:

```bash
xattr -dr com.apple.quarantine /Applications/PhaseAtlas.app
```

Never remove quarantine from an artifact whose origin and checksum have not been verified.

## Future signed distribution

When Developer ID distribution is enabled, remove `PHASEATLAS_RELEASE_UNSIGNED=1` from the workflow
and configure these `production` environment secrets:

| Secret | Purpose |
| --- | --- |
| `APPLE_CERTIFICATE_P12_BASE64` | Base64-encoded Developer ID Application certificate and private key |
| `APPLE_CERTIFICATE_PASSWORD` | Password protecting the exported PKCS#12 file |
| `APPLE_SIGNING_IDENTITY` | Exact Developer ID Application identity used by `codesign` |
| `APPLE_ID` | Apple account used by `notarytool` |
| `APPLE_TEAM_ID` | Apple Developer team identifier |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific Apple password for notarization |
| `UPDATE_SIGNING_PRIVATE_KEY_BASE64` | Base64-encoded private key used to sign update metadata |

Do not store any of these values in repository variables, workflow files, release assets, build logs,
or `.env` files. A future signed workflow derives and publishes only the update public key.

Create a dedicated RSA update-signing key outside the repository and back it up in the maintainer
credential store:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out phaseatlas-update-private.pem
openssl pkey -in phaseatlas-update-private.pem -pubout -out phaseatlas-update-public.pem
base64 < phaseatlas-update-private.pem | tr -d '\n'
```

Paste the final command's output into `UPDATE_SIGNING_PRIVATE_KEY_BASE64`. Never upload the private
PEM. Rotating this key changes the trust root and requires an explicit migration plan for previously
installed applications.

## Production workflow

`.github/workflows/release.yml` runs only for tags matching `v*.*.*`:

1. **Validate** on Linux:
   - require the tagged commit on `main`;
   - install the frozen lockfile with the pinned Node and pnpm versions;
   - validate SemVer, tag, and changelog;
   - run `pnpm check` and `pnpm test`.
2. **Build** on separate Apple Silicon and Intel macOS runners:
   - build the static renderer, Electron runtime, repository worker, and embedded Theia runtime;
   - ad-hoc sign and verify `PhaseAtlas.app`;
   - run the packaged repository smoke test; and
   - upload each architecture ZIP as an intermediate Actions artifact.
3. **Publish** after both builds succeed:
   - download both unsigned ZIP files;
   - produce `SHA256SUMS.txt` for both architectures;
   - create or update the GitHub Release with notes extracted from `CHANGELOG.md`; and
   - attach the ZIPs and checksums.

GitHub-provided actions are pinned to immutable commit SHAs. The workflow uses the job-scoped
`GITHUB_TOKEN` with `contents: write` only in the final publish job.

## Release outputs

Every GitHub Release contains:

```text
PhaseAtlas-<version>-darwin-arm64.zip
PhaseAtlas-<version>-darwin-x64.zip
SHA256SUMS.txt
```

The Actions run also retains each architecture artifact for 14 days and the assembled release set for
30 days. GitHub Release assets are the durable public distribution source.

## Failure and recovery

- No release is published unless validation and both architecture builds succeed.
- A failed build can be rerun against the same immutable tag. The publish job replaces release assets
  by name and restores release notes from the matching changelog section.
- If a release is invalid after publication, do not move its tag or replace it with a different build.
  Mark the release as affected, revert the defect, increment the patch version, and publish a new tag.
- Keep the previous verified ZIP and checksums available for manual rollback.
- When signed distribution is enabled, revoke and rotate signing credentials immediately if a
  production secret is suspected to be exposed.

The lower-level bundle inputs, verification evidence, installation, manual update, and rollback checks
are documented in the [development guide](development.md#desktop-distribution).
