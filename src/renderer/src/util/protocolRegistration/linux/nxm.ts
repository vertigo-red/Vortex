/**
 * Linux-specific nxm:// registration for Vortex.
 */

import * as path from "path";

import * as fs from "fs-extra";

import { log } from "../../log";
import {
  applicationsDirectory,
  getDefaultUrlSchemeHandler,
  refreshDesktopDatabase,
  setDefaultUrlSchemeHandler,
} from "./common";
import { escapeDesktopExecFilePath, escapeDesktopFilePath } from "./desktopFileEscaping";

const NXM_PROTOCOL = "nxm";
const PACKAGE_DESKTOP_ID = "vortex.desktop";
const FLATPAK_DESKTOP_ID = "com.nexusmods.vortex.desktop";
const DEV_DESKTOP_ID = "com.nexusmods.vortex.dev.desktop";
const DEV_WRAPPER_FILE_NAME = "com.nexusmods.vortex.dev.sh";
const PORTABLE_DESKTOP_ID = "com.nexusmods.vortex.portable.desktop";
const PORTABLE_WRAPPER_FILE_NAME = "com.nexusmods.vortex.portable.sh";

type BuildKind = "flatpak" | "development" | "appimage" | "package" | "portable";

export interface ILinuxNxmProtocolRegistrationOptions {
  setAsDefault: boolean;
  executablePath: string;
  appPath: string;
}

export function registerLinuxNxmProtocolHandler(
  options: ILinuxNxmProtocolRegistrationOptions,
): boolean {
  if (process.platform !== "linux") {
    return false;
  }

  const applicationsDir = applicationsDirectory();
  const buildKind = buildKindForCurrentBuild();
  const desktopId = desktopIdForBuild(buildKind);

  let didChangeDesktopFiles = false;
  if (buildKind === "development") {
    didChangeDesktopFiles = ensureDesktopEntry(
      applicationsDir,
      options.executablePath,
      options.appPath,
      DEV_DESKTOP_ID,
    );
  } else if (buildKind === "appimage") {
    // Electron's process executable is inside AppImage's transient mount. APPIMAGE is the
    // persistent path the user launched and is therefore the only safe value for a handler.
    didChangeDesktopFiles = ensureDesktopEntry(
      applicationsDir,
      process.env.APPIMAGE!,
      undefined,
      PORTABLE_DESKTOP_ID,
    );
  } else if (buildKind === "portable") {
    didChangeDesktopFiles = ensureDesktopEntry(
      applicationsDir,
      options.executablePath,
      undefined,
      PORTABLE_DESKTOP_ID,
    );
  } else if (buildKind === "package") {
    // RPM/DEB own vortex.desktop. Remove only legacy files that match the Vortex-generated
    // signatures from older Linux builds; never touch package-managed desktop files.
    didChangeDesktopFiles = removeLegacyPortableEntry(applicationsDir);
  }

  if (didChangeDesktopFiles) {
    refreshDesktopDatabase(applicationsDir);
  }

  if (!options.setAsDefault) {
    return false;
  }

  const previousHandler = getDefaultUrlSchemeHandler(NXM_PROTOCOL);
  const haveToRegister = previousHandler !== desktopId;
  setDefaultUrlSchemeHandler(NXM_PROTOCOL, desktopId);

  return haveToRegister;
}

export function deregisterLinuxNxmProtocolHandler(): void {
  if (process.platform === "linux") {
    log("debug", "linux protocol deregistration is handled externally", {
      protocol: NXM_PROTOCOL,
    });
  }
}

function isDevelopmentBuild(): boolean {
  return process.defaultApp === true || process.env.NODE_ENV === "development";
}

function packageDesktopEntryExists(): boolean {
  const dataDirs = (process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share")
    .split(path.delimiter)
    .filter((entry) => entry.length > 0);
  return dataDirs.some((dataDir) => fs.existsSync(path.join(dataDir, "applications", PACKAGE_DESKTOP_ID)));
}

function buildKindForCurrentBuild(): BuildKind {
  if (process.env.IS_FLATPAK === "true") return "flatpak";
  if (isDevelopmentBuild()) return "development";
  if (process.env.APPIMAGE) return "appimage";
  if (packageDesktopEntryExists()) return "package";
  return "portable";
}

function desktopIdForBuild(kind: BuildKind): string {
  if (kind === "flatpak") return FLATPAK_DESKTOP_ID;
  if (kind === "development") return DEV_DESKTOP_ID;
  if (kind === "package") return PACKAGE_DESKTOP_ID;
  return PORTABLE_DESKTOP_ID;
}

function escapeShellScriptArgument(input: string): string {
  return input.replace(/(["\\$`])/g, "\\$1");
}

function generateWrapperScript(executablePath: string, appPath?: string): string {
  const command =
    `"${escapeShellScriptArgument(executablePath)}"` +
    (appPath ? ` "${escapeShellScriptArgument(appPath)}"` : "");
  const electronEnvVars = [
    "XDG_DATA_DIRS",
    "GIO_EXTRA_MODULES",
    "GDK_PIXBUF_MODULE_FILE",
    "CHROME_DEVEL_SANDBOX",
    "ELECTRON_OVERRIDE_DIST_PATH",
    "NODE_ENV",
  ];

  const electronEnvExports = electronEnvVars
    .map((varName) => {
      const value = process.env[varName];
      return value ? `export ${varName}="${escapeShellScriptArgument(value)}"` : null;
    })
    .filter((line): line is string => line !== null)
    .join("\n");

  return (
    "#!/bin/sh\n" +
    "unset LD_LIBRARY_PATH\n" +
    "unset LD_PRELOAD\n" +
    (electronEnvExports ? electronEnvExports + "\n" : "") +
    `if [ -n "$1" ]; then\n` +
    `  exec ${command} --download "$@"\n` +
    `else\n` +
    `  exec ${command}\n` +
    `fi\n`
  );
}

function writeFileIfChanged(filePath: string, content: string, mode?: number): boolean {
  let changed = true;
  try {
    changed = fs.readFileSync(filePath, { encoding: "utf8" }) !== content;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (changed) fs.outputFileSync(filePath, content, { encoding: "utf8" });
  if (mode !== undefined) fs.chmodSync(filePath, mode);
  return changed;
}

function warnIfApplicationsPathNeedsEscaping(applicationsDir: string): void {
  if (escapeDesktopExecFilePath(applicationsDir) !== applicationsDir) {
    log("warn", "linux applications directory path requires escaping", { applicationsDir });
  }
}

function ensureDesktopEntry(
  applicationsDir: string,
  executablePath: string,
  appPath: string | undefined,
  desktopId: string,
): boolean {
  const wrapperFileName =
    desktopId === DEV_DESKTOP_ID ? DEV_WRAPPER_FILE_NAME : PORTABLE_WRAPPER_FILE_NAME;
  const wrapperPath = path.join(applicationsDir, wrapperFileName);
  const desktopFilePath = path.join(applicationsDir, desktopId);

  warnIfApplicationsPathNeedsEscaping(applicationsDir);

  const escapedWrapperPathExec = escapeDesktopExecFilePath(wrapperPath);
  const escapedWrapperPathTryExec = escapeDesktopFilePath(wrapperPath);
  const wrapperContent = generateWrapperScript(executablePath, appPath);
  const wrapperChanged = writeFileIfChanged(wrapperPath, wrapperContent, 0o755);

  const desktopFileContent =
    "[Desktop Entry]\n" +
    "Type=Application\n" +
    (appPath ? "Name=Vortex (dev build)\n" : "Name=Vortex\n") +
    "GenericName=Mod Manager\n" +
    "Comment=Mod manager for PC games from Nexus Mods\n" +
    "NoDisplay=true\n" +
    `Exec=${escapedWrapperPathExec} %u\n` +
    `TryExec=${escapedWrapperPathTryExec}\n` +
    "Icon=vortex\n" +
    "Terminal=false\n" +
    "Categories=Game;Utility;\n" +
    "MimeType=x-scheme-handler/nxm;\n" +
    "StartupWMClass=Vortex\n" +
    "StartupNotify=true\n" +
    "Keywords=mod;mods;modding;nexus;games;skyrim;fallout;\n";

  const desktopChanged = writeFileIfChanged(desktopFilePath, desktopFileContent, 0o755);
  return wrapperChanged || desktopChanged;
}

function removeLegacyPortableEntry(applicationsDir: string): boolean {
  const desktopPath = path.join(applicationsDir, PORTABLE_DESKTOP_ID);
  const wrapperPath = path.join(applicationsDir, PORTABLE_WRAPPER_FILE_NAME);
  let desktop: string;
  let wrapper: string;
  try {
    desktop = fs.readFileSync(desktopPath, "utf8");
    wrapper = fs.readFileSync(wrapperPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }

  const expectedDesktopSignature =
    desktop.includes("Name=Vortex\n") &&
    desktop.includes("MimeType=x-scheme-handler/nxm;\n") &&
    desktop.includes(PORTABLE_WRAPPER_FILE_NAME);
  const expectedWrapperSignature =
    wrapper.startsWith("#!/bin/sh\n") &&
    wrapper.includes("unset LD_LIBRARY_PATH\n") &&
    wrapper.includes("--download \"$@\"");
  if (!expectedDesktopSignature || !expectedWrapperSignature) {
    log("warn", "not removing unrecognized legacy portable nxm handler", {
      desktopPath,
      wrapperPath,
    });
    return false;
  }

  fs.removeSync(desktopPath);
  fs.removeSync(wrapperPath);
  return true;
}
