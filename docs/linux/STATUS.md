# Linux native readiness — STATUS

Last updated: 2026-09-08 (port of the fork's Linux commits landed; first
baseline verify + first package attempt recorded).

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
(verify always; package gated by `docs/linux/PACKAGING-MARKER`).

## CI runs

| Purpose | Run id | Result | Notes |
|---|---|---|---|
| bootstrap (ub) | 34162811823 | FAIL | Install: missing fontconfig headers, Node 22 (default) |
| bootstrap (fixed) | 34162915894 | SUCCESS | full install OK; artifact saved to T\artifacts\bootstrap |
| baseline verify | 34163391340 | verify SUCCESS | upstream source verifies green on ubuntu-24.04 |
| baseline package | 34163391340 | FAIL (Package Linux) | EEXIST hardlink on winapi.node → B-03; loot install dead-link → B-04 |

## Next concrete step

Push the current tree (B-03/B-04 fixes, B-01 OS-split, marker gate) and get the
first full LINUX ARTIFACT (zip + rpm) + SHA256SUMS + metadata from the
`package` job for the ported branch. Then download, unpack on a Linux host and
run the manual checks in TESTING.md / the packaged smoke list. While that CI
runs: continue evaluating the remaining SUSPECTED audit items (R-03 non-Steam
launchers, R-04 game-scoped paths) with new tests/fixtures.

## External blockers

None so far.