import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getWineUserFolder } from "./wineUserFolders";

const SECTION = String.raw`[Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders] 1234`;
let root: string;
let prefix: string;
let user: string;

async function registry(values: string, filename = "user.reg", section = SECTION) {
  await writeFile(
    path.join(prefix, filename),
    `WINE REGISTRY Version 2\n\n${section}\n${values}\n`,
  );
}

describe.skipIf(process.platform !== "linux")("persisted Wine user folders", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "vortex-wine-folders-"));
    prefix = path.join(root, "Prefix 日本語");
    user = path.join(prefix, "drive_c", "users", "steamuser");
    await mkdir(path.join(user, "Documents"), { recursive: true });
    await mkdir(path.join(prefix, "dosdevices"));
    await symlink("../drive_c", path.join(prefix, "dosdevices", "c:"));
    await symlink(root, path.join(prefix, "dosdevices", "z:"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("allows existing prefixes without persisted folder values to use defaults", async () => {
    expect(getWineUserFolder(prefix, "documents")).toBeUndefined();
    await registry('"Unrelated"="C:\\\\Unrelated"');
    expect(getWineUserFolder(prefix, "documents")).toBeUndefined();
  });

  it("expands the standard Proton profile and resolves case while allowing a new leaf directory", async () => {
    await registry(String.raw`"Personal"=str(2):"%UsErPrOfIlE%\\documents\\New 日本語"`);
    expect(getWineUserFolder(prefix, "documents")).toBe(path.join(user, "Documents", "New 日本語"));
  });

  it("uses the selected prefix's Z: mapping instead of the host root", async () => {
    await registry(String.raw`"Personal"="Z:\\Redirected\\Documents"`);
    expect(getWineUserFolder(prefix, "documents")).toBe(path.join(root, "Redirected", "Documents"));
  });

  it("decodes Wine Unicode escapes, surrogate pairs, quotes and backslashes", async () => {
    await registry(
      String.raw`"Personal"="C:\\users\\steamuser\\\x65e5\x672c\x8a9e \xd83d\xde80 \"quoted\""`,
    );
    expect(getWineUserFolder(prefix, "documents")).toBe(path.join(user, '日本語 🚀 "quoted"'));
  });

  it("respects directory symlinks and permits writing to a missing redirected subdirectory", async () => {
    const target = path.join(root, "Host documents");
    await mkdir(target);
    await symlink(target, path.join(user, "Redirected"));
    await registry(String.raw`"Personal"="C:\\users\\steamuser\\Redirected\\Game settings"`);
    const folder = getWineUserFolder(prefix, "documents");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "test.ini"), "settings");
    expect(await readFile(path.join(target, "Game settings", "test.ini"), "utf8")).toBe("settings");
  });

  it("prefers the exact filename when case-insensitive alternatives exist", async () => {
    await mkdir(path.join(user, "documents"));
    await registry(String.raw`"Personal"="C:\\users\\steamuser\\Documents"`);
    expect(getWineUserFolder(prefix, "documents")).toBe(path.join(user, "Documents"));
    await registry(String.raw`"Personal"="C:\\users\\steamuser\\DOCUMENTS"`);
    expect(() => getWineUserFolder(prefix, "documents")).toThrow("Ambiguous Wine folder component");
  });

  it("ignores Shell Folders caches and unrelated keys", async () => {
    await registry(
      String.raw`"Personal"="Z:\\Stale cache"`,
      "user.reg",
      String.raw`[Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders]`,
    );
    expect(getWineUserFolder(prefix, "documents")).toBeUndefined();
  });

  it("falls back to the machine folder value only when the user value is absent", async () => {
    await registry(String.raw`"Personal"="Z:\\Machine documents"`, "system.reg");
    expect(getWineUserFolder(prefix, "documents")).toBe(path.join(root, "Machine documents"));
    await registry(String.raw`"Personal"="Z:\\User documents"`);
    expect(getWineUserFolder(prefix, "documents")).toBe(path.join(root, "User documents"));
  });

  it("matches registry keys and value names without case sensitivity", async () => {
    await registry(
      String.raw`"LOCAL APPDATA"=str(2):"%SystemDrive%\\users\\steamuser\\AppData\\Local"`,
      "user.reg",
      SECTION.toUpperCase(),
    );
    expect(getWineUserFolder(prefix, "localAppData")).toBe(path.join(user, "AppData", "Local"));
  });

  it.each(["dword:00000001", "hex:01,02", 'str(7):"not a folder"'])(
    "uses the machine fallback for a non-string user value: %s",
    async (value) => {
      await registry(`"Personal"=${value}`);
      await registry(String.raw`"Personal"="Z:\\Machine documents"`, "system.reg");
      expect(getWineUserFolder(prefix, "documents")).toBe(path.join(root, "Machine documents"));
    },
  );

  it.each(["", "str(2):"])(
    "keeps percent text after an absolute drive path, type=%s",
    async (type) => {
      await registry(String.raw`"Personal"=${type}"C:\\users\\steamuser\\%USERPROFILE% literal"`);
      expect(getWineUserFolder(prefix, "documents")).toBe(path.join(user, "%USERPROFILE% literal"));
    },
  );

  it.each(["", "str(2):"])(
    "expands only a leading standard profile variable, type=%s",
    async (type) => {
      await registry(String.raw`"Personal"=${type}"%USERPROFILE%\\%UNKNOWN% literal"`);
      expect(getWineUserFolder(prefix, "documents")).toBe(path.join(user, "%UNKNOWN% literal"));
    },
  );

  it("refreshes a Registry redirection on the next call", async () => {
    await registry(String.raw`"Personal"="Z:\\Before"`);
    expect(getWineUserFolder(prefix, "documents")).toBe(path.join(root, "Before"));
    await registry(String.raw`"Personal"="Z:\\After"`);
    expect(getWineUserFolder(prefix, "documents")).toBe(path.join(root, "After"));
  });

  it.each([
    String.raw`"Q:\\Missing"`,
    String.raw`"C:relative"`,
    String.raw`"\\\\server\\share"`,
    String.raw`str(2):"%UNKNOWN%\\Documents"`,
    String.raw`str(2):"%constructor%\\Documents"`,
    String.raw`"C:\\users\\steamuser\\Bad\nFolder"`,
    String.raw`"C:\\users\\steamuser\\Bad\000Folder"`,
    String.raw`"C:\\Truncated`,
  ])("rejects unresolvable redirections instead of choosing a default: %s", async (value) => {
    await registry(`"Personal"=${value}`);
    expect(() => getWineUserFolder(prefix, "documents")).toThrow();
  });

  it("rejects a file or dangling symlink in place of a folder", async () => {
    await writeFile(path.join(user, "File"), "not a directory");
    await registry(String.raw`"Personal"="C:\\users\\steamuser\\File"`);
    expect(() => getWineUserFolder(prefix, "documents")).toThrow();
    await symlink(path.join(root, "Missing"), path.join(user, "Dangling"));
    await registry(String.raw`"Personal"="C:\\users\\steamuser\\Dangling"`);
    expect(() => getWineUserFolder(prefix, "documents")).toThrow();
  });

  it("rejects an invalid Registry file instead of treating its values as absent", async () => {
    await writeFile(path.join(prefix, "user.reg"), "truncated");
    expect(() => getWineUserFolder(prefix, "documents")).toThrow("Invalid Wine Registry file");
  });
});
