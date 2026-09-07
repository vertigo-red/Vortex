# Linux native readiness — STATUS

Last updated: 2026-09-08 (initial bootstrap).

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

## Done

- Pre-flight access checks (read/write/rename/delete in P and T; gh auth;
  fork/upstream metadata; Actions enabled).
- Initial docs skeleton (`AUDIT.md`, `COMPATIBILITY.md`, `TESTING.md`).
- Bootstrap workflow `.github/workflows/linux-readiness.yml`.
- Pushed bootstrap commit; CI run #TBD; artifact downloaded to TBD.

## Next concrete step

Baseline build/test on the fixed base SHA (upstream master) via the extended
`linux-readiness.yml` (ubuntu build + test), recorded here with the run id.
Then Linux unpacked package -> tar.gz -> AppImage, then RPM/DEB.

## CI runs

| Purpose | Run id | Result | Notes |
|---|---|---|---|
| bootstrap | TBD | TBD | |

## External blockers

None so far.