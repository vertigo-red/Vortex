# Native Linux

This fork runs Vortex itself as a native Electron application on Linux x86-64.
Windows games and their Windows tools still need Steam/Proton. This does not
establish compatibility with every bundled or third-party game extension.

## Build and package

Install the distribution prerequisites and follow [shared setup](../install-instructions/shared.md).
Builds need the .NET 9 SDK and fontconfig development headers, as the existing
FOMOD, font-scanner and dotnetprobe components depend on them. Building an RPM on
Debian/Ubuntu also needs `rpm`. Linux packaging uses `patchelf` to make the
native FOMOD library lookup relative to the installed module
(`sudo apt install patchelf rpm`).

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

Game and tool matching uses path boundaries and resolves existing Linux directory
symlinks while preserving case. The game's discovery path selects its prefix, so
an unmatched discovery cannot fall back to another game's tool directory. A tool
stored outside the game directory uses the intended prefix and `Game2` does not
match `Game`. Nested installations select the deepest matching directory.
Proton receives the game's app ID, installation path and existing tool
environment; Vortex no longer injects Steam overlay libraries into tool processes.

## Bethesda settings and saves

For discovered Steam/Proton games, Bethesda plugin lists use
`steamapps/compatdata/<app-id>/pfx/drive_c/users/steamuser/AppData/Local` in the
game's own library. INI tweaks, local profile settings and savegame management use
that user's `Documents/My Games` directory. Existing Wine directory symlinks and
the older `My Documents` name are respected. Skyrim, Enderal, Fallout New Vegas
and Oblivion folder names retain their Windows spelling on case-sensitive disks.

Launch the game once in Steam and refresh discovery before managing these files.
An unavailable Steam prefix produces an error rather than writing into the host's
Documents/AppData directories. This routing applies to the standard Steam user;
custom Wine users, Registry-only redirections and non-Steam prefixes still require
separate support. Bundled extensions can use `util.getGameUserPath` for these paths.

## Deployment and purge

The pinned `turbowalk` dependency has a repository patch for its non-Windows
walker. It supplies modification times in seconds, full-width device/inode IDs
and hardlink counts, and honors hidden-file, recursion, symlink and batch options.
Hardlink purge uses those IDs to remove deployed links while keeping the staged
source files and unrelated game files. Directory symlinks are not traversed by
default. Existing-link checks also compare filesystem devices as well as inodes.

Symlink deployment recognizes both absolute targets and targets relative to the
link's own directory. Purge removes links into the staging directory and keeps
links to other locations, including when mod folder names start with two dots.
Game-specific restrictions on symlink deployment still apply.

## Mod installation

On Linux, copy, directory creation, generated-file and INI instructions accept
Windows path separators. Copy sources are resolved against the extracted archive,
preferring exact filenames and using case-insensitive matches only when unique.
For example, a FOMOD source `textures\example.dds` can read an archive entry named
`Textures/Example.dds`. Ambiguous filenames or directory names stop installation;
destination spelling is preserved. Relative sources and file-writing destinations
that leave the archive or staging directory are rejected.

Copying remains the fallback when hardlinks cannot cross filesystem boundaries.
Permission, disk-space and other copy failures now fail the installation instead
of being silently treated as success. XML FOMOD scripts run through the native
installer; this does not add Windows C# script support on Linux.

FOMOD header and option images use the same exact-first, unique case-insensitive
archive lookup on Linux and accept Windows separators. Images are resolved
asynchronously; changing the selected option or installer cannot display the
previous image while a new path is pending. Missing, non-file, ambiguous and
out-of-archive image paths produce a warning in the Vortex log without aborting
installation. Native FOMOD messages also go to the Vortex log on Linux rather than
the library's default Windows `APPDATA` path. The native library retains its own
filesystem callbacks.

Packaging replaces the native FOMOD binding's absolute build-machine library
search path with `$ORIGIN:$ORIGIN/../..`. It modifies a separate copy in the
deploy tree, so pnpm hardlinks do not change the source or cached binary.

## LOOT sorting

LOOT runs in a separate Electron process with `ELECTRON_RUN_AS_NODE=1` and uses a
Unix socket on Linux. Vortex returns its process-lifetime promise to the patched,
pinned LOOT transport so a failed launch or an exit before connection rejects
initialization. Readiness and native initialization have a 30-second deadline.
Failures close the endpoint and reject pending calls; each failed call retains
its own name. The worker explicitly exits when the parent disconnects, because
the native log callback would otherwise keep Node alive. An unexpected connection
loss exits with a failure code so Vortex's existing recovery initializes a fresh
handle; the normal terminate command still exits successfully.

## Nexus links and desktop integration

Enable **Handle Nexus Links** in Vortex. DEB/RPM installations use the package's
`vortex.desktop` launcher without creating an additional user wrapper. AppImages
and manually extracted builds create a per-user desktop handler in
`$XDG_DATA_HOME/applications` (default `~/.local/share/applications`). AppImages
register their persistent file path, rather than the temporary mount location,
even if a DEB/RPM is also installed. Development builds include the Electron
application argument; packaged builds launch the binary directly. Flatpak retains
its own desktop identifier.

The handler needs `xdg-settings` from `xdg-utils`; `update-desktop-database` from
`desktop-file-utils` refreshes the MIME cache. Registration failures are reported
as failures instead of successful changes. Package-generated launchers can also
pass a positional `nxm://` URI directly to Vortex. Protocol links are removed from
relaunch arguments so restarting does not repeat the download.

XDG variables must be absolute. Relative values are ignored according to the
[XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/0.8/).

## Verification and remaining limits

Unit tests cover library discovery and aliases, Proton selection and invocation, tool-prefix
matching, executable wrapper argument handling, AppImage registration, positional
Nexus links, XDG paths and the updater platform gate. Filesystem tests also deploy
and purge real temporary hardlinks, verify timestamps, keep staged and unrelated
files intact, and check Bethesda INI/plugin paths in secondary-library prefixes.
Tests of shell wrappers run
real local processes; they do not start a game or migrate an existing Wine prefix.
Installation tests process a real native XML FOMOD result into a temporary staging
directory and cover separator conversion, source casing, exact and ambiguous
matches, instruction overrides, generated files and copy-failure propagation.
Image tests run a real interactive native XML installer and check both its header
and option paths, URL encoding, exact and ambiguous names, invalid images and
switching options or archives. A native callback test checks that FOMOD logging is
connected once to Vortex while the library filesystem remains in use.
LOOT transport tests execute the dependency's JavaScript with simulated sockets
and cover process launch failures, early exits, deadlines, queued-call rejection,
Unicode framing, cleanup and the unchanged Windows named-pipe endpoint format.
Vortex lifecycle tests also cover the returned worker promise and EBUSY retries.

CI verifies the packaged dependency versions and starts the unpacked Linux binary
under Xvfb with isolated XDG directories. It also installs the DEB through APT,
checks dpkg ownership, the desktop launcher, Nexus MIME declaration and the
root-owned setuid sandbox helper, then starts the installed binary with Chromium's
sandbox enabled. Removing the DEB must remove the application directory, system
launcher and desktop entry.

Both unpacked and installed packages must also load the native FOMOD binding from
a temporary relocated directory with `LD_LIBRARY_PATH` and `LD_PRELOAD` removed.
The probe calls the native XML detection function and checks that the library
search path is relative, avoiding a successful test caused by build-machine files.
They also start relocated native LOOT workers with the packaged Electron binary,
with those library environment variables removed. The probe loads synthetic TES4
plugins from a path with spaces and Unicode, sorts a dependent Unicode plugin
after its master, transfers a Unicode group response larger than 64 KiB, and
checks worker exit and Unix socket removal after normal closure, a lost parent
connection and a process exit before connection. This uses temporary fixtures;
it does not run the real-game E2E suite.

The startup checks read the rendered navigation and save `dist/linux-startup.png`
and `dist/linux-installed-startup.png`. The unpacked CI process explicitly disables
the sandbox because it has no installation step to set up the helper. This is not
a default application flag; the installed package check uses the normal sandbox.

Passing those checks does not prove a complete modding session works. In particular:

- Game-specific Registry discovery, configuration/save paths outside the Bethesda
  routing above, script extenders and executable dependencies require per-game
  validation. Windows-only
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
- `scripts/verify-linux-installation.mjs` - DEB integration, sandbox helper and removal checks.
- `scripts/verify-linux-fomod.mjs` - Relocated native FOMOD loading without build-machine paths.
- `scripts/verify-linux-loot.mjs` - Native plugin sorting and worker/socket lifecycle through packaged Electron.
- `patches/loot@7.0.0.patch` - LOOT worker startup observation, deadline and cleanup.
- `scripts/smoke-linux-package.mjs` - Packaged and installed renderer startup checks.
- `src/renderer/src/util/linux/steamPaths.ts` - Linux Steam installation candidates.
- `src/renderer/src/util/linux/steamLibraries.ts` - Current and legacy Steam libraries.
- `src/renderer/src/util/linux/proton.ts` - Compatibility tool and prefix resolution.
- `src/renderer/src/util/linux/gameEntry.ts` - External-tool game matching.
- `src/renderer/src/util/getGameUserPath.ts` - Steam/Proton user settings paths.
- `src/renderer/src/extensions/mod_management/util/installerPaths.ts` - Installer separators and archive source lookup.
- `patches/turbowalk@3.1.1.patch` - Linux directory metadata and traversal behavior.
- `src/renderer/src/util/protocolRegistration/linux/nxm.ts` - Native desktop handlers.
- `src/main/src/cli.ts` - Protocol launch and restart arguments.
