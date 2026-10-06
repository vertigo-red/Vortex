# Native Linux

This fork runs Vortex itself as a native Electron application on Linux x86-64.
Windows games and their Windows tools still need Steam/Proton. This does not
establish compatibility with every bundled or third-party game extension.

## Build and package

Install the distribution prerequisites and follow [shared setup](../install-instructions/shared.md).
Builds need the .NET 9 SDK, fontconfig development headers and the MinGW x64 C
compiler (`gcc-mingw-w64-x86-64` on Debian/Ubuntu). MinGW builds BG3's small Windows
CLI launcher; the SDK builds its dependency-free UTF-8 startup hook targeting
netstandard2.1 for Divine's .NET 8 runtime. FOMOD, font-scanner and dotnetprobe need
the other prerequisites. Building an RPM on
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
newer build. Arguments are passed as separate process arguments, with host shell
execution disabled. Batch scripts use `cmd.exe /d /v:off /c @ <script>` inside
Proton. The echo prefix keeps cmd from stripping the script's first quote and the
last argument's closing quote when both need quoting. AutoRun is disabled, and
delayed expansion is disabled so `!` remains literal. The configured working
directory and the script's exit status are retained.

Batch parameters still follow Windows cmd syntax: `%NAME%` expands environment
variables, and unquoted command-control characters are interpreted by cmd. A Unix
path containing such expansions can change before the script is opened. Data with
both embedded quotes and command-control characters needs escaping appropriate to
the batch file; separate Linux argv elements alone cannot make it literal.

Game and tool matching uses path boundaries and resolves existing Linux directory
symlinks while preserving case. The game's discovery path selects its prefix, so
an unmatched discovery cannot fall back to another game's tool directory. A tool
stored outside the game directory uses the intended prefix and `Game2` does not
match `Game`. Nested installations select the deepest matching directory.
Proton receives the game's app ID, installation path and existing tool
environment; Vortex no longer injects Steam overlay libraries into tool processes.

Relative executable and required-file paths declared by extensions accept Windows
separators on Linux. Directory validation, disk searches, relative tool discovery,
version queries and dashboard game launch paths use the same conversion while
preserving filename casing. Selecting a nested executable directory also searches
the necessary parents when the declaration uses Windows separators. Previously
discovered games use this conversion when their required files are checked again.
Absolute tool paths selected by users remain Linux paths.

Stardew Valley uses its shared `Stardew Valley.dll` assembly for Linux scanning
and manual folder selection, accepting native installations and Windows GOG
installations inside Faugus prefixes. Its launcher and SMAPI payload follow the
selected installation, rather than the Vortex host platform. For Faugus/GOG,
start `StardewModdingAPI.exe` through the existing Faugus game entry and prefix;
automatic dashboard routing to Faugus is not implemented. See the
[game extension notes](../../extensions/games/game-stardewvalley/README.md) for
runtime selection and legacy-version limits.

Process monitoring reads Linux procfs directly, preserving argument boundaries and
using the full launch path instead of the truncated process name. Native binaries,
Python scripts, shell scripts and Java archives launched with `-jar` are identified
by their own paths. Relative script paths resolve in the process's working directory;
quotes and Unicode remain literal. Shell command strings, Python `-c`/`-m` and
ordinary data arguments do not identify a script. Existing installation and
executable symlinks resolve to their targets, and Linux path comparisons preserve
case. A cached PID is retained only while its path still matches. An unlinked native
binary remains tracked while its process runs, including when a replacement file
appears at the same path or another hardlink keeps the running inode linked.
The deleted-path check compares full-width device/inode IDs, so a literal
` (deleted)` filename suffix remains intact.

Wine processes identify the executable rather than the Wine loader. Absolute Unix
paths and relative paths in the process's working directory are supported. Windows
drive paths use that process's `WINEPREFIX/dosdevices` links, with
`STEAM_COMPAT_DATA_PATH/pfx` used only when `WINEPREFIX` is absent. There is no
assumption that `Z:` maps to the host root or that another prefix can substitute
for the selected one. Windows path components prefer exact spelling, otherwise a
unique case-insensitive match; ambiguous names are not guessed. The loader/argv
handling follows Wine's `rebuild_argv` in
[Wine 10.0](https://github.com/wine-mirror/wine/blob/wine-10.0/dlls/ntdll/unix/env.c).
This is process detection, not support for launching arbitrary Wine prefixes.

Direct `cmd.exe /c <script.bat|script.cmd>` tool launches identify the batch script
instead of `cmd.exe`. The script uses the same per-process drive mappings and
working-directory resolution, so identical commands in separate prefixes remain
distinct. The monitor keeps that tool's running status while the identified command
process exists and revalidates its command on each poll. Only a separate script
argument is accepted, with optional `/d`, `/q`, `/a`, `/u` or `/v:off` switches before
`/c`. Vortex's separate `@` echo prefix is also supported. With that prefix and
`/v:off`, ordinary JSON quotes and literal exclamation marks in data do not prevent
the script from being identified.
Interactive `/k`, `/s`, `call`, command strings, expansions and command-control
characters do not identify a batch script; later data arguments are never scanned
for a candidate. Script names containing comma, equals or semicolon are also
excluded rather than guessing cmd's quoting mode. This follows the command lifetime in
[Wine's cmd implementation](https://github.com/wine-mirror/wine/blob/wine-10.0/programs/cmd/wcmdmain.c),
and does not infer the lifetime of detached programs started by a batch file.

The Linux CI runs the production command builder against real Wine 9 and Wine 10
with a compiled Windows Unicode console receiver. Each runtime checks 28 batch
launches across `.cmd` and `.BAT`: spaces, empty values, JSON, Unicode, quotes,
backslashes, tabs, literal `!`, quoted control characters and percent expansion,
with both successful and nonzero exit status. It checks the receiver's actual
arguments and working directory. These are CLI integration checks; they do not
exercise Steam's Proton wrapper or an installed game.

Each procfs snapshot reads at most 16 processes concurrently and checks process
start times before and after collecting identity data. Exited, zombie, malformed
and inaccessible entries do not abort the entire poll; readable ancestors still
allow Vortex to identify its own tool children. Missing path information never
falls back to a basename match on Linux. Windows retains its existing name fallback
and case-insensitive comparisons. Environment and command-line contents are not
retained in the returned Linux process records.

Detection requires a procfs mount that exposes the application's PID namespace and
readable process paths. Custom renamed interpreters/loaders, Java argument files,
UNC paths and an unavailable Wine prefix can prevent identification. The tests
cover synthetic Wine/procfs layouts and real native/Python processes; real Proton
game launches and desktop sessions still need the game-level checks below.

## Bethesda settings and saves

For discovered Steam/Proton games, Bethesda plugin lists use
`steamapps/compatdata/<app-id>/pfx/drive_c/users/steamuser/AppData/Local` in the
game's own library. INI tweaks, local profile settings and savegame management use
that user's `Documents/My Games` directory by default. Persisted `User Shell Folders`
values for `Personal` and `Local AppData` override those defaults, including
redirections made only in the Registry. The game's `user.reg` takes precedence over
`system.reg`; the expanded `Shell Folders` cache does not override either. Wine
Version 2 string/Unicode escapes and leading `%USERPROFILE%`/`%SystemDrive%`
expansion are supported. Leading variables expand in `REG_SZ` as well as
`REG_EXPAND_SZ`, matching Wine's Shell API; percent text after a drive path remains
literal. Registry and drive mappings are reread when resolving a
folder. The selected prefix's `dosdevices` links resolve Windows drive paths,
including custom `Z:` mappings. Existing components prefer exact spelling,
otherwise a unique case-insensitive match; new subdirectories retain their declared
spelling. A configured path with an unavailable drive, ambiguous component,
unsupported environment variable or invalid Registry value stops the operation
instead of writing to a default folder.

Existing Wine directory symlinks and the older `My Documents` name are respected
when no Registry value applies. Skyrim, Enderal, Fallout New Vegas
and Oblivion folder names retain their Windows spelling on case-sensitive disks.

Initialize the game's prefix using the chosen external launcher before managing
these files. Steam discovery selects the standard `steamuser` profile. A manually
selected installation inside an initialized prefix's `drive_c` also identifies
its enclosing prefix, including a game directory symlink pointing into it.
For games stored elsewhere, or a Steam game managed through another prefix, use
**Games → Set Game Settings Prefix** and select the folder containing `drive_c`
and `user.reg`. This selection takes precedence over Steam discovery and is
persisted per game as `modSettingsPrefix`. **Use Automatic Settings Prefix**
restores discovery-based routing when the automatic location is available.

Custom prefixes must contain one non-shared user directory under `drive_c/users`;
ambiguous profiles are rejected instead of using the host's username or another
prefix. `%USERPROFILE%` uses that selected user's directory. The selection is
validated for both Documents and Local AppData before changing the game setting.
For an active game, the plugin persistor finishes its old writes before the path
changes, and plugin synchronization and LOOT then reload for the new location.
The selection is unavailable during deployment, mod installation or plugin sorting.
It does not start Wine, select a launcher or change how the game is launched.

An unavailable discovery or prefix stops Bethesda INI/plugin operations instead
of writing into the host's Documents/AppData directories. Changes not yet saved
by wineserver are not visible to this filesystem resolver. Bundled extensions use
`util.getGameUserPath(id, discovery, true)` to require an identified prefix, and
`util.resolveWindowsGamePath` to reuse existing directory and INI filename spelling.
Other environment-variable expansions and custom layouts with multiple user
profiles still require separate support.

Skyrim Legendary Edition uses game ID `skyrim`, Steam app ID `72850`, `TESV.exe`,
`Data`, `AppData/Local/Skyrim`, and `Documents/My Games/Skyrim`. It keeps the original
plugin list format with enabled filenames without the Special Edition `*` prefix.
Game and script extender versions are read from PE resources on Linux without
executing the files. FOMOD script extender dependencies read the installed loader
(for LE, `skse_loader.exe`) rather than substituting the game's version, and report
no installed version if the loader is missing or unreadable.
The script extender installer accepts Windows archive separators and loader
filename casing, removes only the loader's enclosing archive directory, and
keeps root-level loader/DLL files and `Data/Scripts` in one `dinput` mod. On Linux,
destinations reuse existing Windows directory and filename spelling, including
`data/scripts`; archives with multiple matching loaders or an unreadable loader
version fail before producing installation instructions. The PE test fixture is
synthetic and contains version resources without executable code.
The Linux installation test uses the native Basic FOMOD handler on a wrapped LE
archive with a real ESP from the corpus, then checks hardlink deployment, enabled
and disabled plugin lists, and removal of its links without deleting unrelated
game files. The packaged LOOT probe also sorts dependent form-version-43 plugins
for `skyrim`, in addition to the existing Special Edition scenario. These checks
do not replace testing a complete mod list in an actual Skyrim LE installation.
Additional filesystem tests install and hardlink a complete synthetic SKSE LE
package into the game root, then remove its links and restore an overwritten
script. Native XML FOMOD checks cover an absent loader, installed SKSE 1.7.3, and
a higher required version using the production version delegate and PE reader.

The Open menu's Bethesda settings and application-data actions use this same
resolver, including Registry redirections and secondary Steam libraries. They
reread discovery when clicked. An unavailable discovery or prefix is reported
without opening a host directory, and action visibility does not access the prefix
or Registry. Windows store-specific folder names and other extensions' custom
folder callbacks are retained.

The Wine 9/10 CI also checks 16 real user folder resolutions per runtime. A Windows
receiver obtains Documents and Local AppData through `SHGetFolderPathW` and writes
marker files there; the production resolver must read those same files. The checks
cover Unicode and quotes, profile expansion, redirected drives, filename casing,
directory symlinks and a custom `Z:` mapping. These do not establish game-level
compatibility.

Bethesda plugin IDs and file overrides use Windows path separators and
case-insensitive names on Linux, while the scanned paths and the names written to
plugin lists retain their spelling on disk. A staged `Mod.ESP` remains associated
with its mod when the deployed file is named `mod.esp`. If a staging or game data
directory contains two plugin files differing only by case, Vortex reports both
names and the directory and keeps the previous plugin list. Resolve those files
before refreshing; the scan does not rename or delete them.

The plugin-list persistor also reuses existing `plugins.txt` and `loadorder.txt`
filenames: exact canonical spelling wins, otherwise a unique case-insensitive
match is used. Both names are resolved before either file is written; ambiguous
variants stop the operation without replacing a list. Missing files are created
with their canonical names, and existing file symlinks retain their targets.
Directory watch events recognize either spelling and detect atomic file
replacement even when the replacement retains an older modification time. The
existing choice to keep or revert a foreign load order still applies.

## External tools and arguments

ARCtool and QuickBMS use the archive operation's requested game discovery to select
its Steam Proton build and initialized prefix. Archive merging passes that game ID
for each source as well as the base and final archive. Tool, script, archive, output
and filter paths are mapped through the prefix's DOS drive links; flags and paths
are separate literal arguments. The bundled Windows job launcher terminates only
its own tool and descendants on timeout or cancellation. It does not stop the
shared game wineserver. After the one-second kill escalation, cancellation closes
only the caller's pipes so inherited handles held by another Wine process cannot
delay completion. QuickBMS retains the tool directory as its working folder
for scripts using Windows DLLs.

ARC operations use private copies instead of temporarily renaming the original
archive in the system temporary directory. Extraction retains the file-order sidecar used by Dragon's Dogma. Creation
copies the source and publishes a completed, header-checked archive by renaming a
sibling temporary file. A failed tool cannot replace the original archive. This
requires additional temporary disk space. ARC listings enumerate a private extraction: the tool's `-l` report
uses raw type hashes even when actual extraction applies the game's filename
extensions. Directory listings therefore keep the actual extensions, all entries,
equals signs and Linux separators. Listing also needs temporary decompression
space and time.
ARCtool's legacy internal
filename encoding still needs validation with non-ASCII names stored inside game
archives; copying does support non-ASCII host archive and output paths.

QuickBMS operations have independent filter files and parse their own captured
stdout, so concurrent lists do not exchange data through a shared log. Filenames
with spaces and repeated wildcard matches remain in the list. Output is bounded
to 16 MiB per stream. The existing 15-second idle deadline and 5-second stdin
keepalive remain, with a 30-minute overall deadline and timer cleanup. Failed
operations reject promise callers or deliver the error to callback callers.
QuickBMS write and reimport still modify the selected archive in place; use a
backup as required by the calling game extension.

Builds pin official ARCtool 0.9.713 and QuickBMS 0.12.0 archive and executable
SHA-256 hashes and await extraction. Changed or incomplete downloads fail the
build. Both tools, their author documentation and the x64 job launchers are checked
in the unpacked package and installed DEB. Wine 9/10 CI runs real create/list/extract,
file-order preservation, corrupt-ARC handling, concurrent filters, reimport1,
reimport2 and write operations, plus literal argv and Windows process cancellation while an unrelated Windows
process continues in the same prefix. The same cancellation check covers the
Divine process runner.
These tests use a receiver for the Proton command shape, rather than an installed
Steam Proton distribution or actual Dragon's Dogma/game-specific BMS scripts.

BepInEx package selection uses the requested game's executable on Linux: MZ
selects Windows packages for Proton, while ELF and shebang scripts select native
Linux packages. The game extension still supplies x86/x64 architecture and
Mono/IL2CPP backend; a script wrapping a Windows game can explicitly set
targetPlatform. Unknown or missing executables fail before selecting a default
package. Native games use GitHub because the bundled Nexus catalog contains
Windows archives. Release matching covers the legacy Unix/Windows packages,
5.4.23 platform names and both Unity naming schemes in BepInEx 6 prereleases.
Explicit prerelease/four-component pins remain exact, and an absent matching
asset does not fall back to another platform or architecture.

Injector installation preserves extensionless Unix Doorstop libraries and script
files, accepts both archive separator styles, strips a package wrapper and applies
the mod type's installRelPath only once. When Vortex launches the discovered game
through Proton and its local Doorstop DLL is deployed, a start hook adds
WINEDLLOVERRIDES=winhttp=n,b (version=n,b for unity3) to that launch. Existing DLL
overrides are retained, including an explicit override for the same DLL. The hook
does not modify a prefix registry or Steam launch settings and skips other tools,
native launches and removed loaders. Starting the game outside Vortex still needs
the [BepInEx Proton configuration](https://docs.bepinex.dev/articles/advanced/proton_wine.html).
Native Unix packages retain run_bepinex.sh; its game-specific configuration and
Steam launch settings still need the
[native BepInEx setup](https://docs.bepinex.dev/articles/user_guide/installation/index.html).
Tests cover real temporary executable headers, symlinked discoveries, download
routing, installer instructions, launch environments and asset metadata from the
official 5.4.22, 5.4.23.3 and 6.0.0-pre.1/pre.2 releases. They do not start Unity
or prove that BepInEx injects into an installed game.

FNIS automation uses the discovered Skyrim/Enderal game's selected Proton build
and initialized prefix. Its generated-data staging directory is mapped through
that prefix's actual DOS drive links and passed as one literal `RedirectFiles`
argument. Preparation failures leave the patch list and FNIS mod metadata intact;
an unsuccessful or canceled launch cannot enable and deploy stale generated data.
Animation checksums use the game's declared mod directory (normally `Data`) and
accept both separator styles in deployment records. Changes to animation contents,
skeletons and FNIS lists therefore remain detectable on case-sensitive Linux disks.
The Wine CLI fixture additionally checks four FNIS argument contracts per runtime,
including a custom staging drive, Unicode, literal percent/control characters and
a Windows receiver writing back into that mapped directory. These checks do not
run FNIS itself or generate animations for an installed game.

On Linux, direct tool launches pass each argument literally, preserving spaces,
quotes, JSON, empty arguments and Windows paths passed to Proton. The tool editor
accepts single/double quotes and backslash escapes for grouping arguments, without
expanding variables or wildcards. Editing and saving a tool preserves these
argument boundaries. Existing settings retain their legacy quote handling until
saved again; new direct-launch settings mark their arguments as literal values.

Executable `.sh` and `.bash` scripts run through their shebang without enabling
**Run in shell** automatically. Enable that option for shell expansion or
redirection; shell arguments remain command text. The executable path itself is
quoted literally in shell mode. Scripts must have execute permission.
Proton tool launches always pass literal arguments: shell-mode grouping is decoded
without evaluating the command through the host shell.

Start hooks can replace the executable, working directory and environment before
launch. Running-state notifications and the configured hide/close action happen
after the child process has actually spawned, rather than after a failed launch
attempt.

The bundled common interpreters resolve their runtimes on each launch. Python
scripts prefer `python3`, falling back to `python` if needed. Java archives prefer
an executable `JAVA_HOME/bin/java`, then `java` on `PATH`; a stale or
non-executable Java home can fall back to the installed runtime. Both searches
use the tool's `PATH` override, otherwise Vortex's original launch path. Java
also honors the tool's `JAVA_HOME` override. Relative and empty `PATH` entries
and relative Java homes resolve in the tool's working directory, which defaults
to the script's directory. Installing a runtime or changing the tool environment
does not require restarting Vortex.

Python and Java script paths retain spaces, quotes and Unicode in direct and
shell launches. In shell mode the interpreter's script argument is quoted
literally while user arguments retain their shell expansion. Missing runtimes
produce the interpreter error shown by the launcher. VBScript reports that
Windows Script Host is required; it does not run natively on Linux.

## Deployment and purge

On Linux, a selected game whose extension declares an `.exe` executable uses
case-insensitive conflict keys, including file overrides and merger exclusions.
This follows the selected installation's executable, so native Linux
installations retain the filesystem's case sensitivity. This rule does not scan
Wine prefixes or launch games.

Linking deployment reuses the spelling of existing game files and directories.
New directories share one spelling even when several mods name them differently.
The manifest's `relPath` records the deployed spelling; optional `sourceRelPath`
preserves a different spelling in staging. Backups keep the original game path
through changes in mod priority, mod updates, external-file import/restore and
purge. A path with multiple existing case-insensitive matches interrupts deployment
before any links are changed. Existing ambiguous directories require correction
before retrying.

`src/renderer/src/extensions/mod_management/LinkingDeployment.linux.test.ts`
exercises the production deployment entry point on temporary Linux filesystems,
including Skyrim LE conflict winners and vanilla-file restoration. Direct symlink
method tests cover the shared implementation; Skyrim's existing restriction on
selecting symlink deployment still applies.

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
Nexus links, XDG paths and the updater platform gate.

BG3 routes Mods, PlayerProfiles and Script Extender configuration through the
discovered game's Proton Local AppData. It refreshes profile directories on each
read and shares the existing `PlayerProfiles/Public/modsettings.lsx` across setup,
import and export. Divine uses the selected Proton build, resolves its actual
filename casing and converts path arguments using that prefix's DOS drive
mappings. The Proton launcher starts in Divine's tools directory so its working
folder is visible through those mappings. CLI arguments bypass the host shell;
timeout and cancellation terminate
the launch's own Linux process group. A bundled Windows launcher owns Divine's
Windows Job Object, terminating its children when it exits. It selects a .NET
startup hook that writes stdout and stderr directly in UTF-8 without requiring a
Wine console code-page change. Both helpers are staged atomically beside LSLib
without changing the prefix's Registry or other consoles. A missing Windows .NET runtime or unresolved
Proton environment stops scanning before the saved load order is replaced.

CI downloads checksum-pinned official Divine 1.20.4 and Windows .NET 8.0.31 into
isolated test prefixes. Wine 9 and 10 run real create/list/extract/glob operations
with Unicode, shell characters and a custom Z mapping, plus missing-runtime,
corrupt-PAK, deadline and cancellation checks. Native receivers additionally verify
literal Windows argv and termination of a running Windows child. Package lists
must preserve their Unicode filenames. A semicolon in Divine's tool directory is
rejected as a configuration error before scanning; CoreCLR cannot load its assemblies
from that location. PAK source and destination paths can still contain semicolons.
These CLI integration checks use a
test receiver for Proton's command shape; they do not run a Steam Proton build or
a real BG3 installation. BG3 on Linux currently supports Steam/Proton; its Windows
.NET runtime must be installed in the game's prefix.

Game discovery tests search real Linux directories using nested Windows and mixed
separator declarations, verify manual root selection and build usable dashboard
paths. Missing files and incorrect casing still fail validation. Process tests
check nested game paths, distinct case-sensitive directories and cached PID reuse.
Tool-launch tests run actual Linux child processes to verify literal arguments,
start-hook directories/environments, shebang scripts with special-character paths,
spawn/exit notifications and missing or non-executable tools. Dashboard tests
cover argument editing, settings round trips and legacy quote compatibility.
Common-interpreter tests run real Python 3 scripts and executable capture
wrappers in isolated paths to verify runtime selection, tool environments,
working directories, argument preservation and shell expansion. They also check
missing runtimes, unsupported VBScript and the Windows interpreter contracts.

Filesystem tests also deploy and purge real temporary hardlinks, verify timestamps, keep staged and unrelated
files intact, and check Bethesda INI/plugin paths in secondary-library prefixes.
Plugin scan tests use real temporary directories to cover Windows override paths,
deployed-file casing, mod attribution, conflicting names and recovery after the
conflict is resolved without replacing the prior list during the failed scan.
Plugin-list tests use actual Linux directory watchers and files to verify casing,
symlink writes, ambiguity, fresh directories, external renames and replacements
with preserved timestamps in both plugin-list formats. Pending conflict choices
must keep the foreign files unchanged until the choice is resolved.
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

- Game-specific Registry discovery, configuration/save paths outside the Bethesda and BG3
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
- `src/renderer/src/extensions/gamemode_management/util/linuxProcessProvider.ts` - Native, interpreted and Wine process identities.
- `src/renderer/src/extensions/gamemode_management/util/ProcessMonitor.ts` - Game/tool matching and cached PID validation.
- `src/renderer/src/util/getGameUserPath.ts` - Steam/Proton user settings paths.
- `extensions/common-interpreters/src/index.ts` - Python, Java and Windows script runtimes.
- `src/renderer/src/extensions/mod_management/util/installerPaths.ts` - Installer separators and archive source lookup.
- `patches/turbowalk@3.1.1.patch` - Linux directory metadata and traversal behavior.
- `src/renderer/src/util/protocolRegistration/linux/nxm.ts` - Native desktop handlers.
- `src/main/src/cli.ts` - Protocol launch and restart arguments.
