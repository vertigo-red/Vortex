# Native Linux

This fork runs Vortex itself as a native Electron application on Linux x86-64.
Windows games and their Windows tools still need Steam/Proton. This does not
establish compatibility with every bundled or third-party game extension.

## Build and package

Install the distribution prerequisites and follow [shared setup](../install-instructions/shared.md).
Builds need the .NET 9 SDK and fontconfig development headers, as the existing
FOMOD, font-scanner and dotnetprobe components depend on them. Building an RPM on
Debian/Ubuntu also needs `rpm` (`sudo apt install rpm`).

```bash
pnpm install --frozen-lockfile
pnpm run verify
pnpm run package:linux
```

The root packaging command builds the workspace, deploys the runtime dependencies,
and invokes electron-builder for Linux x86-64. Outputs land in `dist/`:

- `vortex-<version>-<arch>.deb` for Debian/Ubuntu package installation and removal.
- `vortex-<version>-<arch>.rpm` for RPM distributions.
- `vortex-<version>-<arch>.AppImage` for running without a package installation.
- `vortex-<version>-<arch>.tar.gz` for manual extraction.

The version is the `src/main/package.json` placeholder until it is changed for
packaging, as described in [Windows packaging](windows.md). Linux packages exclude
Windows redistributable installers and include the Linux LOOT library. Archive
names use the target's architecture spelling (for example, `x86_64` for AppImage
and `x64` for tar.gz). The Linux command disables electron-builder's CI hardlink
optimization, which otherwise collides on hoisted native module paths, and uses
compression level 5 for archives. The Windows
release updater is disabled on Linux because its resolver selects `.exe` installers;
update these packages through the installation method used to install them.

Run a source build with `pnpm run start`. AppImage files need execute permission;
on systems without FUSE, Electron AppImages can be run with `--appimage-extract-and-run`.
The existing Flatpak build is separate and still has the limitations documented in
[Flatpak packaging](flatpak.md).

## Steam and Proton

Steam discovery covers native, Flatpak and Snap installations, an absolute
`XDG_DATA_HOME`, and legacy `.steam` aliases. Libraries are read from
`steamapps/libraryfolders.vdf`, with the older `config` location as a fallback.
Sparse indices, older string entries and paths with spaces are supported.

Game launches use Steam's desktop URI handler on Linux, allowing Steam to select
its runtime. Windows tools started from the dashboard use the associated game's
initialized prefix. Launch that game once in Steam before using such tools.

The configured compatibility tool is resolved by its `compatibilitytool.vdf`,
including custom tools and Proton installations in secondary libraries. If Steam
has no explicit mapping, the build recorded by the prefix is used. A missing
selected build produces an error; Vortex does not replace it with an arbitrary
newer build. Arguments are passed as separate process arguments, with shell
execution disabled. Batch scripts are routed through `cmd.exe` inside Proton.

Tool matching uses path boundaries and the game's discovery path, so a tool stored
outside the game directory uses the intended prefix and `Game2` does not match
`Game`. Proton receives the game's app ID, installation path and existing tool
environment; Vortex no longer injects Steam overlay libraries into tool processes.

## Nexus links and desktop integration

Enable **Handle Nexus Links** in Vortex. Native builds create a per-user desktop
handler in `$XDG_DATA_HOME/applications` (default `~/.local/share/applications`).
AppImages register their persistent file path, rather than the temporary mount
location. Development builds include the Electron application argument; packaged
builds launch the binary directly. Flatpak retains its own desktop identifier.

The handler needs `xdg-settings` from `xdg-utils`; `update-desktop-database` from
`desktop-file-utils` refreshes the MIME cache. Registration failures are reported
as failures instead of successful changes. Package-generated launchers can also
pass a positional `nxm://` URI directly to Vortex. Protocol links are removed from
relaunch arguments so restarting does not repeat the download.

XDG variables must be absolute. Relative values are ignored according to the
[XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/0.8/).

## Verification and remaining limits

Unit tests cover library discovery, Proton selection and invocation, tool-prefix
matching, executable wrapper argument handling, AppImage registration, positional
Nexus links, XDG paths and the updater platform gate. Tests of shell wrappers run
real local processes; they do not start a game or migrate an existing Wine prefix.

CI also verifies the packaged dependency versions and starts the unpacked Linux
binary under Xvfb with isolated XDG directories. The startup check reads the
rendered navigation and saves `dist/linux-startup.png`. Chromium's sandbox is
disabled for that isolated CI process; this is not a default application flag.

Passing those checks does not prove a complete modding session works. In particular:

- Game-specific Registry discovery, Windows configuration/save paths, script
  extenders and executable dependencies require per-game validation. Windows-only
  stores do not acquire Linux support from the Steam changes.
- Running a Windows tool directly through Proton may require the tool's matching
  Steam runtime and installed Linux libraries; GE/custom builds may differ.
- Hardlink deployment requires staging and game files on the same filesystem.
  Case-sensitive game/mod filenames and filesystems such as NTFS need game-specific
  testing. Flatpak filesystem and host-launch permissions remain separate.
- Native startup and mod deployment should be checked on a real KDE or GNOME
  session. The existing E2E suite additionally requires a packaged application and
  a real supported game installation; unit tests do not substitute for it.

## Key files

- `src/main/electron-builder.config.json` - Linux package formats and platform resources.
- `src/main/prepare-dist-package.mjs` - Deployed package metadata and LOOT checks.
- `src/renderer/src/util/linux/steamPaths.ts` - Linux Steam installation candidates.
- `src/renderer/src/util/linux/steamLibraries.ts` - Current and legacy Steam libraries.
- `src/renderer/src/util/linux/proton.ts` - Compatibility tool and prefix resolution.
- `src/renderer/src/util/linux/gameEntry.ts` - External-tool game matching.
- `src/renderer/src/util/protocolRegistration/linux/nxm.ts` - Native desktop handlers.
- `src/main/src/cli.ts` - Protocol launch and restart arguments.
