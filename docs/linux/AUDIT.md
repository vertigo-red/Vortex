# Linux native readiness — AUDIT

Severity / status conventions:

- CONFIRMED — reproduced against current source (with code reference).
- SUSPECTED — source suggests a problem, reproduction pending.
- FIXED — a change landed on this branch that addresses it.
- VERIFIED — reproduced as fixed on this branch (Linux CI / packaged app).
- BLOCKED — cannot proceed without an unavailable external component.

Findings below were re-checked against base `9c641bd78f7f551df3645a0f5b2bf08fe656e78f`.

## Build / packaging

### B-01 Linux extraResources reference Windows-only files — VERIFIED, FIXED
- `src/main/electron-builder.config.json` referenced `./temp/VC_redist.x64.exe`
  and `./temp/windowsdesktop-runtime-win-x64.exe` at top level; those files are
  produced only by the win32 branch of `src/main/prepare-dist-package.mjs`.
  electron-builder tolerates missing extraResources (the fork's Linux package
  built with them absent), so it did not fail the build; the payload would be
  wrong the moment Windows resources were prepared.
- FIXED in 63aef8b-wip: Windows runtime/NSIS resources moved under
  `win.extraResources`; top-level `extraResources` now only the shared
  `locales` entry, so Linux packages carry no Windows runtime payload.
- VERIFIED (run 34167843426): packaged zip contains 55 top-level locale packs,
  no Windows redistributables.

### B-05 electron-builder needs metadata.homepage for Linux targets — CONFIRMED, FIXED
- Package Linux failed with `? Please specify project homepage, see
  .../configuration#Metadata-homepage` (run 34166488835). The Linux packager
  requires the app metadata's `homepage` for the rpm artifact; `checkMetadata`
  itself only demands name/version. The fork never hit this shape because
  package steps ran with a pre-existing deployed dist.
- FIXED (d3be75403): `homepage` added to `src/main/package.json` (metadata only;
  Windows packaging is unaffected). VERIFIED: run 34167843426 built the rpm.

### B-02 GitHub workflow packaging — FIXED (this branch)
- `.github/workflows/package.yml` is windows-latest only. `.github/workflows/
  linux-readiness.yml` now runs the full Linux verify+package pipeline on
  ubuntu-24.04 for this branch only (never on upstream refs, no secrets, no
  signing, no release publishing).

### B-03 electron-builder EEXIST on unpacked modules — VERIFIED, FIXED
- Packaging fails with `EEXIST: file already exists, link
  '.../winapi-bindings/build/Release/winapi.node' -> '.../app.asar.unpacked/...'
  winapi.node` (run 34163391340, Package Linux). Hard links are enabled on CI
  (builder-util `_isUseHardLink`, `builder-util/src/fs.ts`); `copyOrLinkFile`
  only falls back to a copy on `EXDEV`, so a second link of a module selected
  twice from the pnpm deploy layout throws.
- FIXED: the packaging step sets `USE_HARD_LINKS: "false"` (the documented
  builder-util switch), making copies idempotent.
- VERIFIED (run 34167843426): `winapi-bindings/build/Release/winapi.node`
  present and unpacked in the zip payload.

### B-04 loot native module not built (silently) — CONFIRMED, GATED (product work open)
- node-loot `install` = `prebuild-install -r napi -t 9 -a x64 || npm run
  rebuild`. At cc1515667, `loot_api/` ships only Windows artifacts
  (`libloot.dll`/`.lib`/`.pdb` + headers); there is no Linux prebuild and the
  source fallback links `-l../loot_api/libloot`, which does not exist on Linux
  (`ld: cannot find -l../loot_api/libloot`, runs 34163391340/34165291581).
  pnpm tolerates the failed lifecycle silently; electron-builder would ship a
  payload without `loot.node`.
- GATED: the deploy-tree native-module check reports loot absence (WARN, not
  fatal) and the other native modules as OK/FAIL loudly. Producing a Linux
  `loot.node` is open product work (N-03): link against a system LOOT
  (`libloot-dev` on Debian) via an injected/autogypi binding, or vendor a
  built `loot_api/libloot` for the target. Until then, LOOT sorting on Linux is
  unavailable and the package must not claim otherwise.
- VERIFIED (run 34167843426): zip payload has no `loot/` slot; the gate's WARN
  fired with the expected text.

## Runtime / game environment

### R-01 Proton selection heuristic — FIXED (unit-verified, runtime pending)
- Base heuristic: `compatdata` presence + lexical `.sort().reverse()` over
  steamapps dirs.
- FIXED (ported 07219b778): `detectProtonUsage` probes the game's
  `compatdata/<appid>/pfx/drive_c`; `getConfiguredProtonName` honours
  case-insensitive config keys and global default `"0"`; version comparison is
  numeric and searches all libraries; unavailable configured runners are not
  silently replaced; no unconditional `LD_PRELOAD` (caller environment
  preserved). Unit coverage in `util/linux/proton.test.ts`.
- Unit tests green in Linux CI (runs 34165291581, 34167843426). Runtime still
  needs a packed app + a real Steam prefix.

### R-02 Tool path ownership via string `startsWith` — FIXED (unit-verified, runtime pending)
- FIXED (ported bcd5af1bc): `StarterInfo` splits both paths into components and
  uses `contains`/boundary (`/Games/FooBar` is no longer a child of `/Games/Foo`);
  `Foo`/`FooBar` fixtures in the test suite cover the regression. Green in CI.

### R-03 Non-Steam (GOG/Heroic/Faugus/Bottles) discovery — SUSPECTED
- `extensions/gamestore-gog/src/index.ts` registers a Windows-only launcher.
- Impact: no automatic import of Heroic/Legendary/GOG, Faugus or Bottles
  installs. Manual attach of installPath + prefix + runner must be possible even
  when launcher manifests are absent.
- Test: fixture for manual attach (Dragon Age: Origins GOG + manual Wine prefix).

### R-04 Game paths inside a Wine/Proton prefix — FIXED PARTIALLY (game-specific runtime pending)
- Ported bcd5af1bc advances discovery/paths (Windows path separators, external
  tool prefix through its owning game). Game-specific registry/Documents
  mappings (DA:Origins, Bethesda) remain porting work; keep this row open as
  SUSPECTED for those specific games until tested against a packed app. Unit
  coverage landed green in CI.

### R-05 Case-insensitive deployment on case-sensitive FS — FIXED (unit-verified, runtime pending)
- FIXED (ported 0005+0007): `util/linux/caseInsensitivePaths.ts` resolver,
  `LinkingDeployment.deployedPath`, destination-casing preservation for
  replacements/restoration and for external changes/fallback purge.
  Unit + fixture tests (incl. a disk-backed deploy/restore) added. The
  resolver rejects ambiguous trees (`Data`+`data`) instead of guessing.
- Green in Linux CI (runs 34165291581, 34167843426); real-game integration still
  needs a packed app + real install.

### R-06 Hardlink activation — SUSPECTED
- Need to verify actual link feasibility (EXDEV, Btrfs subvolumes, different
  mounts) beyond a single `stat.dev` check; copy/symlink fallback must be
  available and the manifest must reflect reality on partial failure.

## nxm / protocol

### P-01 nxm handler — PARTIAL (portable registration landed, packaged unverified)
- FIXED (ported c7c7ef494): `util/protocolRegistration/linux/nxm.ts` hides the
  executable behind a wrapper that keeps the URI as one argument; APPIMAGE /
  execPath handled; unit tests incl. quoting. The same commit adds `rpm` to
  `linux.target`.
- Unit-green in CI. Still unverified: cold/warm start with a real desktop, mode
  transitions, Flatpak registration path, and the packaged artifact's behaviour.

## Native modules / installers

### N-01 Native .node/.so in packaged app — PARTIAL (presence verified, loadability pending)
- Binary modules exist (fomod-installer-native, drivelist, leveldown,
  winapi-bindings, xxhash-addon, @parcel/watcher, @duckdb/node-api).
- Presence verified in the zip payload (run 34167843426) as linux-x64 ELF
  `.node` files (`winapi-bindings/.../winapi.node` etc). Loadability/function
  inside a packaged Linux Electron still needs a packaged smoke.

### N-02 FOMOD — SUSPECTED
- Native + IPC implementations exist. Actual XML conditions, optional choices,
  cancellation, unattended/collection mode and error handling must be exercised
  on Linux; a .NET runtime dependency (if required) needs discovery/packaging.
- Test: installer fixtures incl. malicious traversal entries.

### N-03 LOOT — CONFIRMED OPEN (blocked, no Linux build path)
- `loot` (node-loot@6.2.3, cc1515667) cannot produce `loot.node` on Linux:
  `loot_api/` ships Windows-only prebuilt artifacts; the source fallback
  links a nonexistent `loot_api/libloot`; no linux-x64 napi-9 prebuild is
  consumable. pnpm's install tolerates the failure, so subsystems still build.
- Path forward: link against system `libloot` (Debian `libloot-dev`) via a
  vendor patch/autogypi binding, or vendor a built Linux `libloot`.

### I-01 BSA/BA2 / gamebryo-archive-support — FIXED (unit-verified, runtime pending)
- 0009 (ported 71e15aad4) enables `gamebryo-archive-support` off-Windows and
  adds portable extraction path resolution (BSA/BA2 plugin). Unit coverage in
  `archivePath.test.ts`, green in CI (run 34167843426). Runtime verification
  with a real archive still pending.

## Flatpak

### F-01 Flatpak — CONFIRMED (upstream-documented broken pnpm)
- `docs/packaging/flatpak.md` documents a broken build and needed pnpm support
  fix. Do not make Flatpak the first testable artifact; fix after a working
  portable build.