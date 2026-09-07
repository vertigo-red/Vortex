# Vortex Linux — Test scenarios

Commands assume Ubuntu 22.04/24.04 runners and the `linux-readiness.yml`
workflow. Each scenario lists the exact command and the observable success
criterion. This file deliberately documents how to run the tests referenced by
`STATUS.md`, `AUDIT.md` and `COMPATIBILITY.md`.

## Baseline build + test

```sh
pnpm install
pnpm run build
pnpm run test
```

Excludes `@vortex/e2e`. A passing baseline on the fixed base SHA separates
pre-existing upstream failures from new regressions.

## Packaging (per-OS resources)

- Build the publish target on the ubuntu runner and assert a Linux artifact
  (`dist/*.zip` at minimum, then tar.gz with ELF, then AppImage).
- Assert the packaged tree contains the modular `extraResources` for the target
  OS only and that the Windows redistributables are not required to start.

## Filesystem / deployment (Linux integration)

- Mixed-case mod targets land in existing case directories (Windows semantics
  on case-sensitive FS).
- `Data` vs `data` conflicts are surfaced and resolvable, not silently chosen.
- Native Linux games keep their case; case-insensitivity is per-target-game.
- Hardlink success path, EXDEV fallback, rollback/backup, redeploy/purge,
  profiles and external-change detection compared by content/hashes, not just
  exit codes.

## Packaged smoke / E2E

- Fresh test user-data dir; UI ready; import a fake game fixture;
  install/enable/deploy/disable/purge/restart.
- Cold and warm `nxm://` launch (URL + args preserved incl. spaces).
- Native APIs are invoked, not all mocked.

## Real games (manual-game, outside CI)

- Dragon Age: Origins (GOG) + manual Wine/Proton prefix: `bin_ship/DAOrigins.exe`
  discovery, override mods, DAZIP/AddIns.xml, BioWare/Bioware, prefix Documents.
- Skyrim SE / Fallout 4 via Steam Proton: Data deploy, plugins.txt /
  loadorder.txt / INI in prefix, FOMOD, LOOT, profiles, external tool.
- Native Linux game (e.g. Stardew Valley): platform EXE/SMAPI path, case/perms.
- Non-Steam EXE tool outside the game folder with a manually chosen
  runner/prefix.