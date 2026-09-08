# Linux native readiness — STATUS

Last updated: 2026-09-08 (port of the fork's Linux commits landed; baseline
verify + first full Linux artifact produced and its payload checked).

## Fixed baseline

- Upstream master (base): `9c641bd78f7f551df3645a0f5b2bf08fe656e78f`
  (Nexus-Mods/Vortex, fetched fresh on 2026-09-08).
- Branch: `linux/native-readiness-20260908-0017` in `vertigo-red/Vortex`, created
  exactly at the base SHA above. Nothing merged from `origin/master` (fork
  master) into this branch.
- The branch is where ALL Linux-port changes land. Other refs are untouched.

## Environment (Windows dev host)

- Git 2.55.0.windows.5, Node v24.20.0, Python 3.14.7.
- `corepack pnpm` resolves the repository-pinned `pnpm@11.10.0`.
- `gh` 2.100.0 (`C:\Program Files\GitHub CLI\gh.exe`), authenticated as
  `vertigo-red`, scopes include `repo` + `workflow`.
- Repo: fork true; parent/source = Nexus-Mods/Vortex; push/admin permissions ok.
- Actions: enabled, `allowed_actions: all`.
- Local opencode project config `/.opencode/opencode.json` grants P and
  `T = %TEMP%\vortex-linux-20260907-w1` (and children) for external_directory;
  everything else external denied. Backups of global+project config in
  `T\config-backup\`.
- Local `pnpm install` is not possible on this host (node-gyp needs Visual
  Studio Build Tools the machine does not have); all verification runs in CI.

## Landed on the branch (port, base 9c641bd78)

Everything below is cherry-picked from `vertigo-red/Vortex` branch
`improvements/linux` with `-x` attribution, resolved against the newer
upstream base. Only source + tests were taken; the fork's own
`platform-artifacts.yml` workflow is superseded by `linux-readiness.yml` here.

- `b28c21dc8` 0002 Steam: library discovery + launch matched app IDs (+tests)
- `e31cad850` 0003 LinkingDeployment: stable unlink queues on locked files (+tests)
- `115b1ea39` 0004 proton: pfx/drive_c detection, numeric version sort, global
  default, cross-library search, no unconditional LD_PRELOAD (+tests)
- `d1bd5e9bd` 0005 case-insensitive paths resolver + deployedPath + StarterInfo
  component-boundary matching (+tests)
- `81825a567` 0006 portable nxm handler + RPM linux.target (+tests)
- `3312f9ff6` 0007 external changes / fallback purge destination casing (+tests)
- `71e15aad4` 0009 BSA/BA2 archives with portable extraction paths (+tests)

Skipped from the fork, deliberately: 0001 and the 0008-workflow part — the fork
branch workflows are replaced by `.github/workflows/linux-readiness.yml`
(verify always; package's heavy steps gated by the committed marker
`docs/linux/PACKAGING-MARKER`, which is now deleted — see CI runs below).

Additional fixes landed on the branch (not in the fork):

- `52af44821` B-03 fix `USE_HARD_LINKS: "false"` so electron-builder's builder-util
  copies unpacked modules instead of hard-linking them (EEXIST), plus the
  deploy-tree native-module gate and the OS-split `extraResources` (B-01).
- `33c3f770b` move the package gate to step-level `if` (works with the
  validator), `c48de5070` treat loot as a warning (N-03 open, not a blocker),
  `d3be75403` add `homepage` so electron-builder can build the rpm target.

## CI runs

| Purpose | Run id | Result | Notes |
|---|---|---|---|
| bootstrap (ub) | 34162811823 | FAIL | Install: missing fontconfig headers, Node 22 (default) |
| bootstrap (fixed) | 34162915894 | SUCCESS | full install OK; artifact saved to T\artifacts\bootstrap |
| baseline verify | 34163391340 | verify SUCCESS | upstream source verifies green on ubuntu-24.04 |
| baseline package | 34163391340 | FAIL (Package Linux) | EEXIST hardlink on winapi.node → B-03; loot install dead-link → B-04 |
| ported verify | 34165291581 | verify SUCCESS | all 7 ported commits + tests green on base 9c641bd78 |
| ported package | 34165291581 | FAIL (gate) | native-module gate tripped on loot (N-03 open, no Linux build path); EEXIST had been the earlier blocker |
| homepage fix | 34167843426 | SUCCESS (full) | verify + package green: zip (251 MB) + rpm (164 MB) + SHA256SUMS + build-metadata.json; artifact saved to T\artifacts\vortex-linux-d3be75403 |
| marker removed, docs | 34189211483 | SUCCESS (verify) | verify-only run on f71b7144b; package steps skipped (monitoring) |

## Current state

First full Linux artifact produced (run 34167843426):

- `Vortex-1.0.0-linux.7.zip` (251 MB) + `Vortex-1.0.0-linux.7.x86_64.rpm`
  (164 MB), `SHA256SUMS`, `build-metadata.json` (source_sha d3be75403,
  upstream_base 9c641bd78, ubuntu-24.04, node 24.17.0, pnpm 11.10.0, CI URL).
  Copies in `T\artifacts\vortex-linux-d3be754036f8b9e897c0262e1e584de7684824db\`.
- Payload inspected from the zip: 55 locale packs at top level (B-01 verified),
  `resources/app.asar` (224 MB, layout verified by
  `scripts/verify-packaged-asar.mjs` in the package job), and in
  `app.asar.unpacked` every required native module for linux-x64 —
  winapi-bindings (`winapi.node`, the EEXIST victim), leveldown, drivelist,
  @parcel/watcher, xxhash-addon, @nexusmods/fomod-installer-native,
  @duckdb/node-api — all present as ELF .node binaries; `loot` correctly absent
  (N-03, gated as a warning).
- The package's heavy steps are now skipped by default (marker deleted).
  `workflow_dispatch` re-runs them if a new artifact is ever wanted.

## Remaining verification (needs a Linux host)

These CANNOT be proven inside CI and must be run on a real Linux box with the
extracted package (see TESTING.md / LINUX-TESTING-RU.md): app boot and window,
game discovery/launch with Proton, FOMOD installer UI, BSA/BA2 install, nxm
cold/warm protocol handling, tool (FNVEdit/loot) invocation — LOOT is
unavailable until N-03 is ported.

## Next concrete step

On a Linux host: extract the zip, run `vortex` (chromium-sandbox needs
`chrome-sandbox` to be root-owned mode 4755 after extraction, or start with
`--no-sandbox` for a smoke test), step through the packaged smoke list, and
record results. Parallel product work: N-03 (loot on Linux), R-03 (GOG/Heroic/
Faugus/Bottles attach), R-04 (game-scoped prefix paths) — details in AUDIT.md.

## External blockers

None so far.