import { mergeConfig, defineConfig } from "vitest/config";

import baseConfig from "../../../vitest.base.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: {
        "@nexusmods/vortex-api": path.resolve(import.meta.dirname, "__mocks__/vortex-api.ts"),
      },
    },
    test: {
      environment: "node",
      include: ["src/**/*.test.ts"],
      // divine.exe invocations can be slow on cold caches.
      testTimeout: 30000,
      hookTimeout: 30000,
    },
  }),
);
import * as path from "node:path";
