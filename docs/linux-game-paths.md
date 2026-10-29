# Windows Game Paths on Native Linux

Native Vortex keeps its own data in the host's Linux directories. Windows games
use the Documents, AppData and user-profile locations belonging to their own
Wine/Proton prefix. The host's XDG directories are not a substitute for a game's
Windows known folders.

## Prefix selection

Game path requests use the game's discovery information and definition, not the
currently active game's prefix. Resolution checks:

1. The game's `WINEPREFIX` or `STEAM_COMPAT_DATA_PATH` environment override.
2. A prefix containing a game installed under `drive_c`.
3. The Steam snapshot entry matching the actual installation path, including its
   `compatDataPath`. Before Steam's scan completes, the matching appmanifest is
   used instead. This handles different editions/appids and external libraries.
4. An explicitly supplied process-level `WINEPREFIX` as a fallback.

Windows executables use the prefix's Windows user profile. Wine's `user.reg`
`User Shell Folders` / `Shell Folders` settings select Documents, roaming AppData,
local AppData and Desktop. Drive-letter mappings and existing folder case are
preserved. The profile is not assumed to have the Linux account's name.

For classic Steam Oblivion the usual INI path is:

```text
<library>/steamapps/compatdata/<installed appid>/pfx/drive_c/users/steamuser/Documents/My Games/Oblivion/Oblivion.ini
```

The installed appid can differ between editions. A Wine registry override or a
Documents symlink can intentionally redirect the final physical location to a
host directory; those mappings are honoured.

A missing prefix/user profile produces an actionable error. Vortex does not
silently create Windows game configuration in host XDG directories. Launch the
game once through its launcher to initialise Proton, or set that game's
`WINEPREFIX` in its Vortex environment settings for an external Wine prefix.

## Extension API

A game-specific request supplies the game object:

```ts
const game = util.getGame(gameId);
const documents = util.getVortexPath("documents", game);
```

A caller activating/moving an install can also pass its current discovery as the
third argument. Requests without a game remain application/host paths in core
Vortex code, including Vortex's `userData`, startup settings and browser data.
Native Linux executables retain their Linux locations.

Legacy `util.getVortexPath("documents" | "appData" | "localAppData")` calls from
registered game extensions are bound to their owner at call time. Extensions
supporting several games should pass the game explicitly, especially before
activation. General multi-game extensions also need that explicit game context.
A path must be computed when used, not stored in a module-level constant before
game discovery. The bundled game/save/config extensions follow this rule.

## Validation

Regression tests cover Oblivion INI lookup, different libraries/appids, multiple
games, external Wine prefixes, Windows registry redirects, registry updates,
case-sensitive Linux access, extension-owned path calls and unchanged host / native
Windows / native Linux behaviour. They use temporary prefixes and an actual INI
fixture. They do not replace testing the GUI against a real game installation.

## Key Files

- `src/renderer/src/util/linux/gameUserPaths.ts` — prefix and known-folder resolution.
- `src/renderer/src/util/getVortexPath.ts` — application/game path boundary.
- `src/renderer/src/util/extensionRequire.ts` — game-owner context for legacy extensions.
- `src/renderer/src/extensions/gamemode_management/index.ts` — discovery/Steam snapshot provider.
- `src/renderer/src/extensions/ini_prep/gameSupport.ts` — INI paths, including classic Oblivion.
