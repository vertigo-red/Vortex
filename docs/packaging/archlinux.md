# Arch Linux and CachyOS Packages

The `linux-native` branch develops and packages native Linux Vortex for Arch
Linux and CachyOS x86_64. It incorporates upstream `master` and local Linux fixes.
`build/cachyos` retains the earlier stable-release packaging snapshot.

## Install

Download the artifact from a successful **Linux native Vortex / CachyOS** workflow
and extract its ZIP. In the extracted directory:

```bash
sha256sum -c SHA256SUMS && sudo pacman -U ./vortex-*.pkg.tar.zst
```

Pacman needs the `.pkg.tar.zst` inside the artifact ZIP. Start `vortex` or select
Vortex from the application menu. The package includes its pinned Electron;
pacman installs Linux libraries and .NET 9. It conflicts with `vortex-git` and
`vortex-bin`. Its internal updater is disabled: update by installing a new package.

The launcher handles bare `nxm://` URLs with `--download` and preserves other
arguments. The desktop ID matches Vortex's own registration:

```bash
xdg-mime default com.nexusmods.vortex.desktop x-scheme-handler/nxm
```

## Source and development workflow

Every push to `linux-native` builds the branch checkout, including its Linux/UX
fixes. A newer push cancels an older build on the same branch. Re-run a previous
Actions run to rebuild the same commit. `workflow_dispatch` is declared too;
GitHub may require a workflow on the default branch before displaying that control.

`packaging/arch/upstream.json` records the integrated upstream commit. CI checks
that it is an ancestor of the branch. When synchronising again, merge the new
upstream master into this branch, resolve conflicts while retaining Linux fixes,
and update the recorded upstream commit. CI never overwrites local fixes with a
fresh upstream checkout.

These are development builds, not packages of an unmodified stable tag. The
version label uses the latest stable base plus the source commit's UTC timestamp
and abbreviated SHA: pacman `1:2.9.1.rYYYYMMDDhhmmss.g<sha>-<run number>`;
application `2.9.1-linux.YYYYMMDDhhmmss.g<sha>`. The commit timestamp makes reruns
of the same source reproducible at the version-label level. Portable artifact
filenames omit the epoch's colon; the epoch stays in pacman metadata.

`BUILD-INFO.json`, also installed at `/usr/share/doc/vortex/BUILD-INFO.json`, records
the source commit/tree, upstream baseline, runtime versions and workflow URL.
Include it when reporting a UX issue. Current Wine/Proton directory behaviour is
described in [linux-game-paths.md](../linux-game-paths.md).

## Build checks

One Ubuntu 24.04 runner uses pinned Node.js, pnpm and Electron, .NET SDK 9 and Nx
parallelism two. Full `pnpm run verify` covers formatting, build, lint, typechecks,
unit and integration tests; it excludes game-dependent E2E. Verification uses
`NODE_ENV=test`. Production application generation runs afterwards. A successful
verification is cached only for the same committed application/workflow tree;
packaging/runtime checks always repeat.

After deployment, native modules are rebuilt for Electron. FOMOD gets an
`$ORIGIN`-relative library path, and Linux shared libraries are unpacked from
ASAR. Electron-builder uses regular copying from `src/main/dist` to avoid hoisted
dependency hardlink collisions. Packaged dependency versions are checked against
the deploy tree.

The pinned `font-scanner@0.2.1` patch pairs its `new char[]` allocations with
`delete[]`. The original scalar deletes crash during font enumeration in
Electron 45. Both synchronous and asynchronous scans are exercised in the
installed package. On a native failure, CI also logs an isolated font probe and
a native stack before rejecting the package.

A clean Arch container runs `makepkg`, installs the package and checks the desktop
entry, sandbox ownership/mode, .NET, FOMOD, LOOT, font scanning, DuckDB with bundled
`level_pivot`, and LevelDB reads/writes. The build user has the runner's UID so
artifact checksums remain writable. Source and final-package SHA-256 checksums
are generated. Artifacts are kept for 30 days. The GUI, real games, Nexus login
and browser handoff still require target-system testing.

## Key Files

- `.github/workflows/package-cachyos.yml` — branch build, checks and artifact upload.
- `packaging/arch/upstream.json` — integrated upstream revision and version-label base.
- `packaging/arch/PKGBUILD` — package metadata, dependencies and installed files.
- `packaging/arch/electron-builder.cjs` — Linux packaging configuration.
- `packaging/arch/vortex` and `vortex.desktop` — launcher and desktop integration.
- `packaging/arch/check-launcher.mjs` — launcher regression checks.
- `packaging/arch/smoke-test.cjs` — installed runtime checks.
- `scripts/prepare-arch-package.mjs` — baseline validation, checksums and metadata.
