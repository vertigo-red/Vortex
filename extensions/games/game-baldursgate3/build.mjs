import * as path from "node:path";

import { createConfig, bundle } from "../../../scripts/extensions-rolldown.mjs";
import { buildDivineTools } from "./buildDivineTools.mjs";

const extensionPath = path.resolve(import.meta.dirname);
const entryPoint = path.resolve(extensionPath, "src", "index.tsx");
const output = path.resolve(extensionPath, "dist", "index.cjs");

if (process.platform === "linux") {
  buildDivineTools(path.join(extensionPath, "tools"));
}

const config = createConfig(entryPoint, output);
await bundle(config);
