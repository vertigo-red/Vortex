# Arch Linux and CachyOS Packages

The `build/cachyos` branch builds native Vortex packages for Arch Linux and
CachyOS x86_64. It starts at the official stable release `v2.9.1`, commit
`c80326367cbe6d96621ad6cf4a5488ef49bac110`, published on 27 October 2026.
The Linux GUI and game workflows still need testing on the target system.

## Install

Open this branch's **Package Arch Linux / CachyOS** run in GitHub Actions.
Download its artifact and extract the ZIP. In the extracted directory:

```bash
sha256sum -c SHA256SUMS
sudo pacman -U ./vortex-*.pkg.tar.zst
```

Pacman installs the `.pkg.tar.zst` inside the ZIP. The artifact ZIP itself is
not a pacman package. Start **Vortex** from the application menu or run `vortex`.

The package includes its pinned Electron runtime, so system Node.js and Electron
are not runtime dependencies. Pacman resolves the Linux libraries and .NET 9
runtime. The package conflicts with `vortex-git` and `vortex-bin`.

Select Vortex for Nexus links in its settings, or explicitly run:

```bash
xdg-mime default com.nexusmods.vortex.desktop x-scheme-handler/nxm
xdg-mime query default x-scheme-handler/nxm
```

The desktop ID matches the app's Linux protocol registration. The launcher adds
`--download` only for a bare `nxm://` URL; ordinary flags and paths are preserved.
Pacman's standard desktop/icon hooks maintain system caches; package installation
does not overwrite the user's default protocol handler.

The launcher disables Vortex's internal updater. Updates come from new pacman
packages. Remove with `sudo pacman -Rns vortex`; user data stays in the user's
home directory.

## Build source and future UX changes

`packaging/arch/upstream.json` records the stable release tag and exact baseline
commit. Every run checks that this commit is an ancestor of the branch checkout.
It builds the branch itself, including subsequent UX fixes. It never checks out
`master` or downloads a new release over those changes.

Push fixes to `build/cachyos` to build them. Every push triggers the workflow;
there is no packaging-only path filter. A new push cancels an older run on the
same branch. Re-run an existing workflow in Actions to rebuild an unchanged
commit. `workflow_dispatch` is also declared, but GitHub may require a workflow
on the default branch before showing its manual-run control.

The version inside Vortex is `2.9.1`. Pacman uses `1:2.9.1-<workflow run number>`,
so each subsequent run produces an increasing package release. The artifact's
`BUILD-INFO.json`, also installed at `/usr/share/doc/vortex/BUILD-INFO.json`,
records the actual source commit, source tree, release baseline, Electron, Node,
pnpm and workflow URL. Keep this file with UX bug reports.

To update the baseline later, verify the latest non-prerelease in the official
repository, merge its exact tag into this branch and update `upstream.json` and
the PKGBUILD version. Preserve the packaging files and local UX fixes. Automatic
upstream updates are intentionally absent so a test run has a known base.

## Validation and packaging

One Ubuntu 24.04 runner builds with the repository's pinned pnpm, Node.js and
Electron versions, .NET SDK 9 and Nx parallelism limited to two tasks.
`pnpm run verify` runs formatting, build, lint, typechecks, unit tests and
integration tests. It excludes E2E, which needs real games. Verification uses
`NODE_ENV=test`; production mode applies to application packaging afterwards.

A completed verification may be reused for an identical committed application
and workflow tree. The fingerprint excludes only `packaging/arch/`, this metadata
helper, root Markdown files and `docs/`. Application changes invalidate it.
Packaging and installed runtime checks always run. Nx and dependency caches
reduce repeated work; there are no hard-coded successful commits or skipped
tests based on old runs from a deleted fork.

After `pnpm deploy`, native modules are rebuilt for Electron. The FOMOD addon
uses `$ORIGIN`-relative RPATH, and shared libraries are unpacked from ASAR so the
ELF loader can find them. `winapi-bindings` remains installed because application
code imports it; on Linux it exports a shim, not Windows API functionality.
Electron-builder runs in `src/main/dist` with normal copying to avoid duplicate
hardlink `EEXIST` errors. The ASAR dependency-version check is mandatory.

A clean Arch Linux container creates the pacman package with `makepkg`, installs
it and checks desktop metadata, the `root:root` / `4755` sandbox helper, .NET,
FOMOD, LOOT, font scanning, DuckDB with bundled `level_pivot`, and LevelDB
read/write. It uses the runner's UID for the build user so the runner can write
checksums and upload the result. Source checksums are generated before `makepkg`;
`SHA256SUMS` covers the final package. Artifacts are retained for 30 days.

These checks do not exercise the GUI, Nexus login, `nxm://` browser handoff or
deployment into a real Steam/Proton game. Test those on CachyOS and commit fixes
to this branch.

## Key Files

- `.github/workflows/package-cachyos.yml` — branch build, checks and artifacts.
- `packaging/arch/upstream.json` — official stable release and baseline commit.
- `packaging/arch/PKGBUILD` — pacman metadata, dependencies and installed files.
- `packaging/arch/electron-builder.cjs` — Linux packaging configuration.
- `packaging/arch/vortex` and `vortex.desktop` — launcher and desktop integration.
- `packaging/arch/check-launcher.mjs` — launcher argument regression checks.
- `packaging/arch/smoke-test.cjs` — installed native runtime checks.
- `scripts/prepare-arch-package.mjs` — baseline validation, checksums and metadata.
