# Windows release runbook

This runbook covers the signed Windows x64 NSIS release defined by `.github/workflows/release-windows.yml`.

## Release invariants

- The release tag must be an annotated, GitHub-verified signed tag whose name exactly equals the stable numeric SemVer in `package.json`, with no `v` prefix, and its target commit must be reachable from `origin/main`.
- `package.json` and the root `package-lock.json` entry must have the same version.
- The `production-release` GitHub environment must provide `CSC_LINK` and `CSC_KEY_PASSWORD`. Protect that environment with required reviewers and restrict who can create release tags.
- The workflow must finish `release:win`, packaged-content/fuse verification, the packaged smoke test, and timestamped Authenticode verification for both `release/win-unpacked/CrossExamination.exe` and the NSIS installer.
- Only the installer, its CycloneDX SBOM, and its SHA-256 checksum manifest published by that workflow are release assets.
- `package:dir`, `package:qa`, `release/win-unpacked`, and CI packaging output are unsigned local QA artifacts unless independently proven otherwise. They are **not releasable** and must never be uploaded as substitutes.

No signed artifact is implied merely by the presence of packaging configuration or a local `release/` directory.

## Certificate and timestamp prerequisites

1. Use a currently valid Windows code-signing certificate whose subject and chain match the organization releasing the application. Keep its private key only in the protected release environment.
2. Store the electron-builder-compatible certificate reference or encoded certificate as `CSC_LINK`, and its password as `CSC_KEY_PASSWORD`. Never place either value in the repository, logs, workflow inputs, or release notes.
3. Ensure the signing provider can reach its timestamp service. The workflow rejects a signature unless `Get-AuthenticodeSignature` reports `Valid`, a signer certificate, and a timestamp certificate.
4. Confirm certificate renewal and timestamp-service changes with a non-release signing rehearsal before the old certificate expires. A timestamp is required so Windows can validate the signature after certificate expiry.

## Prepare a clean release commit

Work from a fresh checkout rather than a long-lived development directory:

```powershell
git clone https://github.com/Tzodec1526/cross-examination.git cross-examination-release
Set-Location cross-examination-release
git switch main
git pull --ff-only
git status --porcelain
```

The final command must print nothing. Update `package.json`, `package-lock.json`, and `CHANGELOG.md` in a normal reviewed commit. Then, using the Node version in `.nvmrc` and the npm version in `packageManager`, run:

```powershell
npm ci
npm run check
npm run package:qa
```

This local package is only a QA rehearsal; it is not a release candidate. Push the release commit and wait for Windows CI to pass on `main`.

## Create and publish the signed tag

From a clean checkout of the reviewed commit:

```powershell
$version = node -p "require('./package.json').version"
git tag --sign $version --message "Cross Examination $version"
git tag --verify $version
git push origin $version
```

Do not prefix the tag with `v`, create a lightweight tag, reuse a version, or move a published tag. The tag push starts the protected release workflow. It fails closed when GitHub cannot verify the tag signature, signing secrets are absent, signing or timestamping fails, package verification fails, or the tag/version/lockfile values differ.

Only after all checks pass, the workflow uses `gh` to create a draft release, upload every asset, and then publish it as latest. A failed upload therefore leaves a non-public draft for operator review. It generates:

- `Cross-Examination-Setup-<version>-x64.exe`
- `Cross-Examination-<version>.cdx.json` (the complete locked dependency/build graph, including the Electron runtime source package)
- `Cross-Examination-<version>-SHA256SUMS.txt`

## Verify the published release

On a separate Windows machine or clean VM:

1. Download all three assets from the same GitHub Release.
2. Recompute the installer's SHA-256 hash with `Get-FileHash -Algorithm SHA256` and compare it byte-for-byte with the matching checksum-manifest line.
3. Run `Get-AuthenticodeSignature` on the installer. Require `Status` to be `Valid`, inspect the expected signer subject/thumbprint, and require a timestamp certificate.
4. Confirm the release tag shown by GitHub is verified and exactly matches the application version.
5. Retain the checksum manifest and SBOM with the release record.

Do not waive a SmartScreen, signature, timestamp, or checksum discrepancy. Stop distribution and investigate it as a release failure.

## Provider and model compatibility review

Treat the provider contract as a release dependency, not a timeless assumption:

- Live voice is deliberately pinned to `grok-voice-think-fast-2.0` (flagship) rather than the floating `grok-voice-latest` alias, following xAI's production guidance to use a versioned model name. (`grok-voice-latest` aliases think-fast 2.0.) Report generation is pinned to `grok-4.7`.
- For every release, recheck current official xAI documentation and the release account for model availability, endpoint/request compatibility, supported voices, realtime audio and tool-calling behavior, report response shape, and any transcription dependency.
- Revalidate pricing, quotas/rate limits, regional availability, API terms, privacy terms, and Zero Data Retention eligibility for the actual account and deployment. Record the review date and decision with the release evidence.
- Exercise a synthetic realtime session and report generation during acceptance. A model substitution or fallback is a reviewed code/configuration change; do not make one ad hoc during release operations.

## Installer, upgrade, uninstall, and retention acceptance

Use synthetic, non-client data and a standard-user Windows account.

### Clean install

- Install with the default per-user flow and again with a permitted custom install directory.
- Confirm the selected Start menu/desktop shortcuts launch the packaged application.
- Confirm the displayed version matches the tag, the production renderer loads, and a second launch focuses the existing instance.
- Create a synthetic matter, import and reindex a sample file, add a person, close the app, and confirm the matter survives relaunch.
- With a QA xAI account, validate microphone permission, realtime connectivity, session save, and optional report generation. Do not use privileged client material for release testing.
- On first voice use, verify the xAI-processing acknowledgement blocks **Begin** until checked, Cancel leaves practice stopped, and acceptance persists for the local profile without hiding the adjacent live/report disclosure.
- Import a synthetic QA key through the native clipboard confirmation. Confirm the renderer never displays the key, success clears only an unchanged clipboard value, cancellation leaves both settings and clipboard untouched, and unavailable secure storage fails closed.
- Open **About & Support**, verify the application/Electron versions, and exercise the diagnostics-folder action; confirm the UI reports success or failure without exposing an absolute path.

### Upgrade

- Install the immediately previous signed release, create synthetic matter/session/settings data, then run the new signed installer over it.
- Confirm the existing user-data store remains readable, imported documents and sessions remain present, encrypted-key state is reported correctly, and a new session can be saved.
- Exercise both the default and previously customized install paths supported by the NSIS flow.

There is no automatic updater in the current application; upgrades are explicit installer operations.

### Uninstall and data retention

- Uninstall and confirm application binaries and created shortcuts are removed.
- Confirm matters/settings remain under the app-managed `cross-examination` directory beneath Electron's Windows `userData` location (normally under `%APPDATA%`), and local diagnostics/crash dumps remain under that `userData` location as well. This is intentional: `deleteAppDataOnUninstall` is `false`.
- Reinstall the same signed version and confirm the synthetic matter is still available.
- If organizational policy requires erasure, archive or delete that user-data directory only after explicit approval and verification. Uninstall alone is not evidence deletion.

## Rollback

1. Stop promoting the affected release and place a prominent warning on it; if necessary, return it to draft or remove its downloadable assets under release-owner approval.
2. Mark the last known-good signed release as latest and communicate the affected versions, impact, and operator action. Installed copies do not roll back automatically.
3. Before downgrading a workstation, back up its retained user-data directory. Validate data compatibility with the prior version using synthetic data first; persisted-schema changes may not be backward compatible.
4. Never move or reuse the bad tag. Fix forward with a new package version, reviewed commit, and newly signed tag.
5. Preserve the failed workflow logs, hashes, SBOM, signer/timestamp details, and incident decision record.

## API, proxy, and privacy notes

- Live practice connects from the Electron main process to `wss://api.x.ai/v1/realtime`. Report generation connects to `https://api.x.ai/v1/responses`.
- Revalidate provider API behavior, model availability, pricing, and retention terms during every release using current official sources; the pinned model names do not freeze those external terms.
- Imported files and the full local index are not uploaded wholesale. During practice, xAI receives microphone audio, matter/person metadata, a bounded file inventory and initial evidence excerpts, later retrieved filenames/metadata and excerpts, and the resulting realtime conversation. Report generation sends matter caption, court, person/role, mode, and a bounded saved transcript. xAI account retention and Zero Data Retention terms therefore matter for client use even though report requests set `store: false`.
- The app has no in-app proxy setting and does not explicitly configure an HTTP(S) or WebSocket proxy. Do not assume `HTTP_PROXY`, `HTTPS_PROXY`, or an intercepting enterprise proxy is supported. Validate DNS, TLS trust, firewall allowlisting, WebSocket upgrade, and both xAI endpoints in the deployment environment before approval.
- A stored API key is encrypted with Electron `safeStorage` or supplied through `XAI_API_KEY`; storage fails closed when OS encryption is unavailable. Never bake a key into an installer or release workflow.
- Crash dumps and bounded diagnostics are local (`uploadToServer: false`). They may still contain operational details and should follow the organization's collection and retention policy.
