import * as path from "path";

import { unghost } from "./ghost";

function toPluginId(fileName: string) {
  // Bethesda plugins can be referenced by Windows paths even when Vortex runs on Linux.
  return path.win32.basename(unghost(fileName)).toLowerCase();
}

export default toPluginId;
