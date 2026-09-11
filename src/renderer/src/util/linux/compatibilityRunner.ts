import type { IRunParameters } from "../../types/IExtensionContext";
import { isWindowsExecutable } from "./proton";

/**
 * Optional per-game/per-tool environment variable selecting the compatibility runner used for a
 * Windows executable on native Linux. The existing Environment Variables editor persists this in
 * discovery state, so non-Steam games do not need a launcher-specific integration just to start.
 */
export const COMPATIBILITY_RUNNER_ENV = "VORTEX_COMPAT_RUNNER";

/**
 * Wrap a Windows target in an explicitly configured Linux compatibility runner.
 *
 * - An explicit VORTEX_COMPAT_RUNNER always wins (for example `umu-run` or an absolute Wine path).
 * - WINEPREFIX without an explicit runner opts into the system `wine` command.
 * - A runner whose basename is `proton` receives Proton's required `run` verb.
 * - Steam Proton calls are already transformed to the Proton script before start hooks execute, so
 *   they are not Windows executables here and therefore cannot be double-wrapped.
 */
export function applyCompatibilityRunner(
  input: IRunParameters,
  platform: NodeJS.Platform = process.platform,
): IRunParameters {
  if (platform !== "linux" || !isWindowsExecutable(input.executable)) {
    return input;
  }

  const environment = input.options.env ?? {};
  const configuredRunner = environment[COMPATIBILITY_RUNNER_ENV]?.trim();
  const prefix = environment.WINEPREFIX?.trim();
  const runner = configuredRunner || (prefix ? "wine" : undefined);
  if (runner === undefined) {
    return input;
  }

  const runnerName = runner.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  const runnerArgs =
    runnerName === "proton"
      ? ["run", input.executable, ...input.args]
      : [input.executable, ...input.args];

  return {
    ...input,
    executable: runner,
    args: runnerArgs,
    options: {
      ...input.options,
      // A shell would reinterpret Windows paths/arguments and is unnecessary for Wine/UMU/Proton.
      shell: false,
    },
  };
}
