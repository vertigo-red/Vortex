import { method as toBluebird } from "bluebird";

import type { IExtensionContext } from "../../types/IExtensionContext";
import type { IInstallationDetails } from "../mod_management/types/InstallFunc";
import type { ITestSupportedDetails } from "../mod_management/types/TestSupported";
import { install } from "./installer";
import { testSupported } from "./tester";
import { VortexModInstallerLogger } from "./utils/VortexModInstallerLogger";

let logger: VortexModInstallerLogger | null = null;

const main = (context: IExtensionContext): boolean => {
  context.registerInstaller(
    /*id:*/ `fomod`,
    /*priority:*/ 10,
    /*testSupported:*/ toBluebird(
      async (
        files: string[],
        _gameId: string,
        _archivePath: string,
        details?: ITestSupportedDetails,
      ) => {
        return await testSupported(files, details, false);
      },
    ),
    /*install:*/ toBluebird(
      async (
        files: string[],
        destinationPath: string,
        gameId: string,
        _progressDelegate: unknown,
        choices?: unknown,
        unattended?: boolean,
        _archivePath?: string,
        details?: IInstallationDetails,
      ) => {
        return await install(
          context.api,
          files,
          destinationPath,
          gameId,
          choices,
          unattended,
          details,
        );
      },
    ),
  );

  context.registerInstaller(
    /*id:*/ `fomod`,
    /*priority:*/ 100,
    /*testSupported:*/ toBluebird(
      async (
        files: string[],
        _gameId: string,
        _archivePath: string,
        details?: ITestSupportedDetails,
      ) => {
        return await testSupported(files, details, true);
      },
    ),
    /*install:*/ toBluebird(
      async (
        files: string[],
        destinationPath: string,
        gameId: string,
        _progressDelegate: unknown,
        choices?: unknown,
        unattended?: boolean,
        _archivePath?: string,
        details?: IInstallationDetails,
      ) => {
        return await install(
          context.api,
          files,
          destinationPath,
          gameId,
          choices,
          unattended,
          details,
        );
      },
    ),
  );

  context.once(() => {
    context.api.onAsync(
      "will-install-mod",
      async (_gameId: string, _archiveId: string, _modId: string) => {
        if (process.platform === "linux" && logger === null) {
          // The library's default logger uses APPDATA and Windows separators.
          // Keep the callback owner alive for all subsequent native installations.
          const nativeLogger = new VortexModInstallerLogger();
          nativeLogger.useVortexFunctions();
          logger = nativeLogger;
        }
      },
    );
  });

  return true;
};

export default main;
