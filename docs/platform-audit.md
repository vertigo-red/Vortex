# Platform audit and manual testing

This fork's Windows and Linux branches start at upstream commit
`5bf1ae71a9b62ace7f43b12bd844d2fd83bb6489` (3 September 2026).
The fork's existing `master` commits were not merged into these branches.

## Branches and implemented fixes

| Area                     | Windows                                                                                                                                                              | Linux                                                                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Steam discovery          | Read current and legacy library locations; accept non-contiguous library indices; isolate unreadable manifests; recover the primary library when metadata is missing | Same fixes, plus XDG data home and additional Steam paths                                                                                                                                                                         |
| Steam launch             | Pass the discovered AppID when a caller supplies a game directory; reject sibling directory prefix matches                                                           | Same fixes                                                                                                                                                                                                                        |
| Deployment queue         | Preserve the work queue when an unlink fails; retain failed files in the manifest                                                                                    | Same fixes                                                                                                                                                                                                                        |
| Proton                   | Not applicable                                                                                                                                                       | Honor case-insensitive config keys and the global tool selection; search external libraries; compare major versions numerically; reject incomplete tools; do not replace an unavailable configured tool with an arbitrary version |
| Tool environment         | Unchanged                                                                                                                                                            | Preserve caller LD_PRELOAD instead of injecting both Steam overlay architectures                                                                                                                                                  |
| Game/tool paths          | Unchanged                                                                                                                                                            | Resolve Windows path separators and filename case; find an external tool's prefix through its owning game                                                                                                                         |
| Deployment filename case | Native filesystem behavior                                                                                                                                           | Windows games share one logical destination for differently cased mod paths; preserve source names and record actual destination spelling for replacements and restoration                                                        |
| Nexus links              | Existing registration                                                                                                                                                | Portable builds create a local desktop handler; Flatpak retains package-managed registration                                                                                                                                      |
| Packaging                | Unsigned NSIS installer                                                                                                                                              | ZIP and RPM targets; rebuild native modules in the deployed tree; verify packaged dependency versions                                                                                                                             |

The changes are in focused commits. Common Steam and deployment fixes are shared
by both branches; Linux behavior is added only on `improvements/linux`.

## Validation

The mandatory command is `pnpm run verify`: format, build, lint, typecheck,
unit tests and integration tests. It excludes the game-dependent E2E suite.

Windows passed this gate and created its installer in
[run 34064150729](https://github.com/vertigo-red/Vortex/actions/runs/34064150729).
Linux passed the same gate at commit `c7c7ef4`; that run then exposed a packaging
problem: `pnpm exec` in the deployed tree attempted to reinstall using the parent
workspace catalogs. Packaging now invokes the installed binaries with
`npx --no-install`, preserving the prepared dependency tree.

Local targeted tests covered 8 common regressions and 45 Linux checks (including
existing desktop escaping tests). A disk-backed deployment test installs a mod,
replaces it with a differently cased source, and restores the original game file.
The full local build is not a substitute for CI: this container lacks the .NET SDK
and cannot perform some native build filesystem operations.

The [Platform test artifacts workflow](../.github/workflows/platform-artifacts.yml)
only runs packaging jobs in `vertigo-red/Vortex`. It uploads artifacts for 30 days,
uses read-only repository permissions, does not sign, publish releases, publish
NPM packages, or use upstream release secrets.

## Manual checks

1. Download the artifact for the desired branch from the latest successful
   workflow run. The artifact name contains the exact source commit SHA.
2. Use a separate test game installation and staging folder. A separate Vortex
   settings directory alone does not isolate deployment into a shared game folder.
   The application accepts `--user-data <absolute-path>` for isolated settings.
3. On Windows, discover Steam games from the primary and a second library. Launch
   one discovered by directory. Deploy more than 50 changed files while a few are
   held open; the unlocked files must still deploy and locked files remain tracked.
4. On Linux, start the ZIP's executable or install the RPM. Launch a Steam Proton
   game once through Steam before running a tool. Check a game and Proton installed
   in different Steam libraries, then a tool stored outside the game's directory.
5. On Linux, deploy two mods whose destination directories differ only by case.
   Verify the intended winner, then disable the mods and confirm that the original
   files are restored. Do not use an already ambiguous tree containing both `Data`
   and `data`: the resolver rejects ambiguity rather than choosing a file to overwrite.
6. Enable Nexus link handling and open a real download link from the browser.
   Check both a running app and a cold start. A portable build's path must remain
   stable; launch it and re-register after moving the extracted directory.

## Remaining Linux product work

This is a tested foundation, not evidence of Windows feature parity for every game.
The audit identified larger gaps that require separate implementation and real
installations to validate:

- `gamebryo-plugin-management`, `gamebryo-bsa-support`, and
  `gamebryo-archive-support` explicitly skip their builds off Windows. Native
  LOOT/BSA bindings, dependency packaging and platform-specific plugin paths need
  porting before Bethesda plugin and archive support can be claimed.
- General Wine/Proton registry and known-folder mapping is missing. Many game
  extensions use registry discovery or Windows Documents/AppData paths. The common
  path resolver does not replace these game-specific integrations.
- Non-Steam launchers and arbitrary prefixes (Heroic, Lutris, Faugus, Bottles/UMU)
  need explicit prefix/runner selection and discovery integration. These changes
  do not claim automatic discovery or execution for those stores.
- Steam Flatpak/Snap launches and Steam Linux Runtime requirements need validation
  on their host environments. The direct Proton tool runner is not a replacement
  for the launcher runtime or a general guarantee that every Proton build can be
  run outside Steam.
- Conflict presentation and extension
  consumers of deployment manifests need broader game-level coverage of the new
  optional `deployedPath` field. Core link replacement/restoration and external-change destination selection are tested, but
  this does not establish correctness of every external extension's file handling.

A successful package build establishes that the artifact was produced and passed
the configured verification gate. It does not establish successful game launches,
Nexus authentication, every installer format, all extensions, or all distributions.
