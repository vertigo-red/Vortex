import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const source = await readFile(
  new URL("../src/renderer/src/util/linux/wineUserFolders.ts", import.meta.url),
  "utf8",
);
const { getWineUserFolder } = await import(
  `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`
);
const execute = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "vortex-wine-folders-"));
const prefix = path.join(root, "Prefix 日本語");
const user = path.join(prefix, "drive_c", "users", "steamuser");
const capture = path.join(user, "folders.txt");
const wine = process.env.VORTEX_TEST_WINE ?? "/usr/lib/wine/wine64";
const server = process.env.VORTEX_TEST_WINESERVER ?? "/usr/lib/wine/wineserver64";
const env = { ...process.env, WINEPREFIX: prefix, WINEARCH: "win64", WINEDEBUG: "-all" };
const folderKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";
const receiver = path.join(root, "folders.exe");

async function run(executable, args) {
  return execute(executable, args, { env, cwd: root, timeout: 45000, maxBuffer: 1024 * 1024 });
}

async function flush() {
  await run(server, ["-k"]).catch((error) => {
    // An idle server can exit before the kill request; -w still verifies shutdown.
    if (error.code !== 1 || error.stdout || error.stderr) throw error;
  });
  await run(server, ["-w"]);
}

async function setFolder(name, value, type, hive = "HKCU", key = folderKey) {
  await run(wine, ["reg.exe", "add", `${hive}\\${key}`, "/v", name, "/t", type, "/d", value, "/f"]);
}

const receiverSource = `
#include <windows.h>
#include <shlobj.h>
#include <wchar.h>
#include <string.h>
static HANDLE output;
static int folder(int csidl, const char *identity) {
  wchar_t directory[32768], marker[32768];
  DWORD written;
  HRESULT result = SHGetFolderPathW(NULL, csidl, NULL, SHGFP_TYPE_CURRENT, directory);
  if (FAILED(result)) return 93;
  WriteFile(output, directory, (DWORD)(wcslen(directory) * sizeof(wchar_t)), &written, NULL);
  WriteFile(output, L"\\r\\n", 4, &written, NULL);
  _snwprintf(marker, 32768, L"%ls\\\\vortex-path-probe.txt", directory);
  HANDLE file = CreateFileW(marker, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                          FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return 94;
  WriteFile(file, identity, (DWORD)strlen(identity), &written, NULL);
  CloseHandle(file);
  return 0;
}
int wmain(void) {
  // Proton's supported profile uses steamuser, unlike standalone Wine's host username.
  SetEnvironmentVariableW(L"WINEUSERNAME", L"steamuser");
  output = CreateFileW(L"C:\\\\users\\\\steamuser\\\\folders.txt", GENERIC_WRITE,
                       0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (output == INVALID_HANDLE_VALUE) return 92;
  DWORD written;
  WriteFile(output, L"\\ufeff", 2, &written, NULL);
  int result = folder(CSIDL_PERSONAL, "documents");
  if (!result) result = folder(CSIDL_LOCAL_APPDATA, "localAppData");
  CloseHandle(output);
  return result;
}
`;

try {
  const version = await run(wine, ["--version"]);
  if (process.env.VORTEX_TEST_WINE_MAJOR) {
    assert.match(version.stdout, new RegExp(`^wine-${process.env.VORTEX_TEST_WINE_MAJOR}\\.`));
  }
  await run(wine, ["cmd.exe", "/c", "ver"]);
  await flush();
  await mkdir(user, { recursive: true });
  const drive = path.join(root, "Redirected '日本語' 🚀");
  const linked = path.join(root, "Host Documents");
  await mkdir(drive);
  await mkdir(linked);
  await symlink(drive, path.join(prefix, "dosdevices", "d:"));
  await symlink(linked, path.join(user, "Linked"));
  const cSource = path.join(root, "folders.c");
  await writeFile(cSource, receiverSource);
  await run("x86_64-w64-mingw32-gcc", [
    "-municode",
    "-mconsole",
    "-static",
    "-O2",
    "-s",
    cSource,
    "-o",
    receiver,
    "-lshell32",
  ]);
  console.log(`Real Wine user folder runtime ready: ${version.stdout.trim()}`);
  const cases = [
    {
      name: "literal Unicode and quotes",
      type: "REG_SZ",
      documents: String.raw`C:\users\steamuser\Documents 日本語 🚀 'quoted'`,
      localAppData: String.raw`C:\users\steamuser\AppData\Local 日本語`,
      expected: [
        path.join(user, "Documents 日本語 🚀 'quoted'"),
        path.join(user, "AppData", "Local 日本語"),
      ],
    },
    {
      name: "standard Proton profile expansion",
      type: "REG_EXPAND_SZ",
      documents: String.raw`%USERPROFILE%\Redirected Documents`,
      localAppData: String.raw`%SystemDrive%\users\steamuser\Redirected AppData`,
      expected: [path.join(user, "Redirected Documents"), path.join(user, "Redirected AppData")],
    },
    {
      name: "leading expansion in REG_SZ",
      type: "REG_SZ",
      documents: String.raw`%USERPROFILE%\REG_SZ Documents`,
      localAppData: String.raw`%SystemDrive%\users\steamuser\REG_SZ AppData`,
      expected: [path.join(user, "REG_SZ Documents"), path.join(user, "REG_SZ AppData")],
    },
    {
      name: "literal percent text after drive path",
      type: "REG_EXPAND_SZ",
      documents: String.raw`C:\users\steamuser\%USERPROFILE% literal`,
      localAppData: String.raw`C:\users\steamuser\%SystemDrive% literal`,
      expected: [
        path.join(user, "%USERPROFILE% literal"),
        path.join(user, "%SystemDrive% literal"),
      ],
    },
    {
      name: "separate mapped drive",
      type: "REG_SZ",
      documents: String.raw`D:\Game Documents`,
      localAppData: String.raw`D:\Game AppData`,
      expected: [path.join(drive, "Game Documents"), path.join(drive, "Game AppData")],
    },
    {
      name: "unique case-insensitive lookup",
      type: "REG_SZ",
      documents: String.raw`d:\game documents`,
      localAppData: String.raw`d:\game appdata`,
      expected: [path.join(drive, "Game Documents"), path.join(drive, "Game AppData")],
    },
    {
      name: "host Documents symlink",
      type: "REG_SZ",
      documents: String.raw`C:\users\steamuser\Linked\Documents`,
      localAppData: String.raw`C:\users\steamuser\Linked\AppData`,
      expected: [path.join(user, "Linked", "Documents"), path.join(user, "Linked", "AppData")],
    },
    {
      name: "custom Z mapping",
      type: "REG_SZ",
      documents: String.raw`Z:\Z Documents`,
      localAppData: String.raw`Z:\Z AppData`,
      expected: [path.join(root, "Z Documents"), path.join(root, "Z AppData")],
    },
  ];
  for (const fixture of cases) {
    if (fixture.name === "custom Z mapping") {
      await flush();
      await rm(path.join(prefix, "dosdevices", "z:"));
      await symlink(root, path.join(prefix, "dosdevices", "z:"));
    }
    await Promise.all(fixture.expected.map((directory) => mkdir(directory, { recursive: true })));
    await setFolder("Personal", fixture.documents, fixture.type);
    await setFolder("Local AppData", fixture.localAppData, fixture.type);
    await setFolder(
      "Personal",
      String.raw`C:\Stale cache`,
      "REG_SZ",
      "HKCU",
      folderKey.replace("User Shell", "Shell"),
    );
    await flush();
    const resolved = [
      getWineUserFolder(prefix, "documents"),
      getWineUserFolder(prefix, "localAppData"),
    ];
    assert.deepEqual(resolved, fixture.expected, fixture.name);
    for (const directory of resolved)
      await rm(path.join(directory, "vortex-path-probe.txt"), { force: true });
    await run(wine, [receiver]);
    await flush();
    assert.equal(
      await readFile(path.join(resolved[0], "vortex-path-probe.txt"), "utf8"),
      "documents",
    );
    assert.equal(
      await readFile(path.join(resolved[1], "vortex-path-probe.txt"), "utf8"),
      "localAppData",
    );
    const windowsPaths = (await readFile(capture))
      .toString("utf16le")
      .replace(/^\uFEFF/, "")
      .trim()
      .split(/\r?\n/);
    assert.equal(windowsPaths.length, 2);
    assert.deepEqual(
      [getWineUserFolder(prefix, "documents"), getWineUserFolder(prefix, "localAppData")],
      resolved,
    );
    console.log(`Verified real Wine folders: ${fixture.name}; ${JSON.stringify(windowsPaths)}`);
  }
  console.log(
    "Verified 16 real Wine user folders: Registry, Shell API and shared file destinations",
  );
} finally {
  await flush().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
