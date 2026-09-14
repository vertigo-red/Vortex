import type { IParameters } from "@vortex/shared/cli";

const NXM_PROTOCOL = /^nxm:\/\//i;

/**
 * Linux desktop environments pass x-scheme-handler URLs as positional arguments
 * (for example: `vortex nxm://...`). Commander only exposes the explicit
 * --download/--install options, so preserve those when present and otherwise
 * promote a bare nxm:// argument to a download request.
 */
export function applyNxmProtocolArgument(
  commandLine: IParameters,
  argv: readonly string[],
): IParameters {
  if (
    commandLine.download !== undefined ||
    commandLine.install !== undefined ||
    commandLine.installArchive !== undefined
  ) {
    return commandLine;
  }

  const nxmUrl = argv.find((arg) => NXM_PROTOCOL.test(arg));
  if (nxmUrl === undefined) return commandLine;

  return {
    ...commandLine,
    download: nxmUrl,
  };
}
