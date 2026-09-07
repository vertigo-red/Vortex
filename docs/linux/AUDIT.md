# Linux native readiness — AUDIT

Severity / status conventions:

- CONFIRMED — reproduced against current source (with code reference).
- SUSPECTED — source suggests a problem, reproduction pending.
- FIXED — a change landed on this branch that addresses it.
- VERIFIED — reproduced as fixed on this branch (Linux CI / packaged app).
- BLOCKED — cannot proceed without an unavailable external component.

Findings below were re-checked against base `9c641bd78f7f551df3645a0f5b2bf08fe656e78f`.

## Build / packaging

### B-01 Linux packaging target — CONFIRMED
- `src/main/electron-builder.config.json`: `linux.target` is only `zip`;
  `extraResources` unconditionally references `./temp/VC_redist.x64.exe` and
  `./temp/windowsdesktop-runtime-win-x64.exe`, which are produced only by the
  win32 branch of `src/main/prepare-dist-package.mjs`. A Linux electron-builder
  run will fail unless the resources are split and/or prepared per-OS.
- Impact: no Linux package artifact at all today.
- Test: run `pnpm nx run @vortex/main:publish` on ubuntu runner; expect
  failure on missing `temp/VC_redist.x64.exe`.

### B-02 GitHub workflow packaging — CONFIRMED
- `.github/workflows/package.yml` is windows-latest only and assumes
  CodeSignTool / NSIS / latest.yml.
- Impact: no workflow produces a Linux artifact even when B-01 is fixed.
- Test: n/a (absent workflow).

## Runtime / game environment

### R-01 Proton selection heuristic — CONFIRMED
- `src/renderer/src/util/linux/proton.ts`: Proton is considered in use when a
  `compatdata` directory exists; selection of a Proton binary falls back to
  `.sort().reverse()` over `steamapps/common`/`compatibilitytools.d`, i.e. a
  lexical "latest" guess instead of metadata (installed app, compat tool
  manifest, per-game override, default compatibility mapping).
- Impact: wrong runner may be picked; a stale compatdata (e.g. from a deleted
  game, or left over from an old Proton) silently selects legacy behaviour.
- Test: unit tests with two Proton versions on disk with distinct versions.

### R-02 Tool path ownership via string `startsWith` — CONFIRMED
- `src/renderer/src/util/StarterInfo.ts`: `shouldRunWithProton()` requires
  `store === "steam"` and matches tool path via `toLowerCase().startsWith(gamePath)`.
- `/Games/FooBar` is treated as a child of `/Games/Foo`; Linux paths must be
  compared by path component boundaries; case folding must not be global.
- Impact: wrong runner selection for tools next to / after a game directory.
- Test: `/Games/FooBar` vs `/Games/Foo` fixtures.

### R-03 Non-Steam (GOG/Heroic/Faugus/Bottles) discovery — SUSPECTED
- `extensions/gamestore-gog/src/index.ts` registers a Windows-only launcher.
- Impact: no automatic import of Heroic/Legendary/GOG, Faugus or Bottles
  installs. Manual attach of installPath + prefix + runner must be possible even
  when launcher manifests are absent.
- Test: fixture for manual attach (Dragon Age: Origins GOG + manual Wine prefix).

### R-04 Game paths inside a Wine/Proton prefix — CONFIRMED
- Extensions use host Electron paths (`getVortexPath("documents")`) or
  `LOCALAPPDATA` / host `appData` instead of paths inside the game's own prefix
  (e.g. `game-dragonage` uses `util.getVortexPath("documents")` + `BioWare` vs
  `Bioware`; Bethesda `appDataPath()`).
- Impact: saves/configs/plugins/Documents resolve to the Vortex host profile,
  not the prefix; Linux case-sensitivity makes the BioWare/Bioware split real.
- Test: unit for DA:Origins Documents resolution in a synthetic prefix; Skyrim
  SE plugins.txt/loadorder.txt/INI under `pfx/drive_c/users/<user>/...`.

### R-05 Case-insensitive deployment on case-sensitive FS — SUSPECTED
- `src/renderer/src/util/getNormalizeFunc.ts` keys off the real FS
  case-sensitivity; `LinkingDeployment.ts` builds physical targets from
  `relPath`. For a Windows-targeting game on ext4 this does not give Windows
  name semantics.
- Impact: a mod shipping `DATA\textures\x.dds` may not land in an existing
  `Data/Textures` directory; purge/redeploy and conflict detection differ.
- Test: Linux filesystem integration fixtures (mixed-case mods, `Data`/`data`,
  native case preservation, hardlink EXDEV).

### R-06 Hardlink activation — SUSPECTED
- Need to verify actual link feasibility (EXDEV, Btrfs subvolumes, different
  mounts) beyond a single `stat.dev` check; copy/symlink fallback must be
  available and the manifest must reflect reality on partial failure.

## nxm / protocol

### P-01 nxm handler — PARTIAL (dev works, packaged unverified)
- `src/renderer/src/util/protocolRegistration/linux/nxm.ts` exists; dev build
  creates wrapper/desktop entry; packaged build expects
  `com.nexusmods.vortex.desktop`. Cold/warm start and installed/portable
  paths not verified in packaged Linux artifacts.
- Test: packaged smoke for cold and warm `nxm://` with parameters incl. spaces.

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