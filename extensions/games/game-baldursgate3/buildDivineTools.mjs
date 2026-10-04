import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

export function buildDivineTools(outputDirectory) {
  const temporary = mkdtempSync(path.join(tmpdir(), "vortex-bg3-tools-"));
  const extensionPath = import.meta.dirname;
  try {
    execFileSync(
      "dotnet",
      [
        "build",
        path.join(extensionPath, "src", "divineUtf8Hook", "divineUtf8Hook.csproj"),
        "--configuration",
        "Release",
        "--artifacts-path",
        path.join(temporary, "artifacts"),
        "--output",
        temporary,
        "--nologo",
      ],
      { stdio: "inherit" },
    );
    execFileSync(
      "x86_64-w64-mingw32-gcc",
      [
        "-municode",
        "-mconsole",
        "-static",
        "-Os",
        "-s",
        "-Wall",
        "-Wextra",
        "-Werror",
        path.join(extensionPath, "src", "divineLauncher.c"),
        "-o",
        path.join(temporary, "vortex-divine-launcher.exe"),
      ],
      { stdio: "inherit" },
    );
    mkdirSync(outputDirectory, { recursive: true });
    for (const name of ["vortex-divine-launcher.exe", "vortex-divine-utf8.dll"]) {
      copyFileSync(path.join(temporary, name), path.join(outputDirectory, name));
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
