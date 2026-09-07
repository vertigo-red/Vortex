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
- Impact before fix: reused Windows redistributables baked into a Linux package.

### B-02 GitHub workflow packaging — FIXED (this branch)
- `.github/workflows/package.yml` is windows-latest only. `.github/workflows/
  linux-readiness.yml` now runs the full Linux verify+package pipeline on
  ubuntu-24.04 for this branch only (never on upstream refs, no secrets, no
  signing, no release publishing).

### B-03 electron-builder EEXIST on unpacked modules — CONFIRMED, FIXED
- Packaging fails with `EEXIST: file already exists, link
  '.../winapi-bindings/build/Release/winapi.node' -> '.../app.asar.unpacked/...'
  winapi.node` (run 34163391340, Package Linux). Hard links are enabled on CI
  (builder-util `_isUseHardLink`, `builder-util/src/fs.ts`); `copyOrLinkFile`
  only falls back to a copy on `EXDEV`, so a second link of a module selected
  twice from the pnpm deploy layout throws.
- FIXED: the packaging step sets `USE_HARD_LINKS: "false"` (the documented
  builder-util switch), making copies idempotent.

### B-04 loot native module not built (silently) — CONFIRMED, FIXED
- node-loot `install` = `prebuild-install -r napi -t 9 -a x64 || npm run
  rebuild`. When the prebuilt download fails, the fallback links
  `-l../loot_api/libloot` (autogypi CMake output) and `ld: cannot find
  -l../loot_api/libloot` (run 34163391340 Install workspace). pnpm tolerated
  the failure, so the package job proceeded with NO `loot.node` in the payload.
- FIXED: the deploy-tree native module check fails loudly when any of
  fomod-installer-native/winapi-bindings/leveldown/drivelist/@parcel/watcher/
  xxhash-addon/loot ships without a `.node`; a native-build cache (incl. the
  loot build dir and loot_api) makes the result reproducible across runs.
- Residual risk tracked in N-03 (LOOT runtime on Linux).

## Runtime / game environment

### R-01 Proton selection heuristic — FIXED (verification pending)
- Base heuristic: `compatdata` presence + lexical `.sort().reverse()` over
  steamapps dirs.
- FIXED (ported 07219b778): `detectProtonUsage` probes the game's
  `compatdata/<appid>/pfx/drive_c`; `getConfiguredProtonName` honours
  case-insensitive config keys and global default `"0"`; version comparison is
  numeric and searches all libraries; unavailable configured runners are not
  silently replaced; no unconditional `LD_PRELOAD` (caller environment
  preserved). Unit coverage in `util/linux/proton.test.ts`.
- Verification pending: unit tests + packaged smoke on the new base (next CI).

### R-02 Tool path ownership via string `startsWith` — FIXED (verification pending)
- FIXED (ported bcd5af1bc): `StarterInfo` splits both paths into components and
  uses `contains`/boundary (`/Games/FooBar` is no longer a child of `/Games/Foo`);
  `Foo`/`FooBar` fixtures in the test suite cover the regression.

### R-03 Non-Steam (GOG/Heroic/Faugus/Bottles) discovery — SUSPECTED
- `extensions/gamestore-gog/src/index.ts` registers a Windows-only launcher.
- Impact: no automatic import of Heroic/Legendary/GOG, Faugus or Bottles
  installs. Manual attach of installPath + prefix + runner must be possible even
  when launcher manifests are absent.
- Test: fixture for manual attach (Dragon Age: Origins GOG + manual Wine prefix).

### R-04 Game paths inside a Wine/Proton prefix — FIXED PARTIALLY (verification pending)
- Ported bcd5af1bc advances discovery/paths (Windows path separators, external
  tool prefix through its owning game). Game-specific registry/Documents
  mappings (DA:Origins, Bethesda) remain porting work; keep this row open as
  SUSPECTED for those specific games until tested against a packed app.

### R-05 Case-insensitive deployment on case-sensitive FS — FIXED (verification pending)
- FIXED (ported 0005+0007): `util/linux/caseInsensitivePaths.ts` resolver,
  `LinkingDeployment.deployedPath`, destination-casing preservation for
  replacements/restoration and for external changes/fallback purge.
  Unit + fixture tests (incl. a disk-backed deploy/restore) added. The
  resolver rejects ambiguous trees (`Data`+`data`) instead of guessing.
- Verification pending on the new base in Linux CI; real-game integration still
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
- Still unverified: cold/warm start with a real desktop, mode transitions,
  Flatpak registration path, and the packaged artifact's behaviour.

## Native modules / installers

### N-01 Native .node/.so in packaged app — SUSPECTED
- Binary modules exist (fomod-installer-native, drivelist, leveldown,
  winapi-bindings, xxhash-addon, @parcel/watcher). Their presence in the lockfile
  does not prove loadability/function inside a packaged Linux Electron.
- Test: packaged Electron smoke that actually loads and calls each module.

### N-02 FOMOD — SUSPECTED
- Native + IPC implementations exist. Actual XML conditions, optional choices,
  cancellation, unattended/collection mode and error handling must be exercised
  on Linux; a .NET runtime dependency (if required) needs discovery/packaging.
- Test: installer fixtures incl. malicious traversal entries.

### N-03 LOOT — SUSPECTED
- Linux build/runtime libs, masterlist/userlist, sorting, missing masters,
  conflict and load-order save need real verification, no pre-sorted results.

## Flatpak

### F-01 Flatpak — CONFIRMED (upstream-documented broken pnpm)
- `docs/packaging/flatpak.md` documents a broken build and needed pnpm support
  fix. Do not make Flatpak the first testable artifact; fix after a working
  portable build.