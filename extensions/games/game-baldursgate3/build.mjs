import * as path from "node:path";

import { createConfig, bundle } from "../../../scripts/extensions-rolldown.mjs";

const extensionPath = path.resolve(import.meta.dirname);
const entryPoint = path.resolve(extensionPath, "src", "index.tsx");
const output = path.resolve(extensionPath, "dist", "index.cjs");

if (process.platform === "linux") {
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
      path.join(extensionPath, "tools", "vortex-divine-launcher.exe"),
    ],
    { stdio: "inherit" },
  );
}

const config = createConfig(entryPoint, output);
await bundle(config);
import { execFileSync } from "node:child_process";
