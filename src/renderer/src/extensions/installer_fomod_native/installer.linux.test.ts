import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type * as fomodT from "@nexusmods/fomod-installer-native";
import { createStore } from "redux";
import { createReducer } from "redux-act";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";

import { makeDeploymentHarness, type IDeploymentHarness } from "../../test-utils/deploymentTest";
import { test } from "../../test-utils/harnessTest";
import type { IState } from "../../types/IState";
import { UserCanceled } from "../../util/CustomErrors";
import { installerUIReducer } from "../installer_fomod_shared/reducers/installerUI";
import { DialogQueue } from "../installer_fomod_shared/utils/DialogQueue";
import { hasSessionFOMOD } from "../installer_fomod_shared/utils/guards";
import { install } from "./installer";

vi.mock("../../util/log", () => ({ log: vi.fn() }));

describe.skipIf(process.platform !== "linux")(
  "Native FOMOD dependencies and dialog lifecycle",
  () => {
    let root: string;
    let deployment: IDeploymentHarness & { cleanup: () => void };

    beforeEach(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), "vortex-native-fomod-"));
      deployment = makeDeploymentHarness({ gameId: "skyrim", files: {} });
      deployment.setState((state) => {
        state.settings.gameMode.discovered.skyrim = { path: path.dirname(deployment.gameDir) };
      });
      const reduceDialog = createReducer(installerUIReducer.reducers, installerUIReducer.defaults);
      const initialState = deployment.getState();
      const store = createStore((state: IState = initialState, action) => ({
        ...state,
        session: {
          ...state.session,
          fomod: {
            installer: {
              dialog: reduceDialog(
                hasSessionFOMOD(state.session) ? state.session.fomod.installer.dialog : undefined,
                action,
              ),
            },
          },
        },
      }));
      deployment.api.store = store;
      deployment.api.getState = <T extends IState = IState>() => store.getState() as T;
      // The shared queue outlives each temporary deployment harness.
      DialogQueue.getInstance({
        ...deployment.api,
        getState: <T extends IState = IState>() => deployment.api.store.getState() as T,
      });
      const { NativeLogger } = require("@nexusmods/fomod-installer-native") as typeof fomodT;
      new NativeLogger(() => undefined).setCallbacks();
      await mkdir(path.join(root, "fomod"));
      await writeFile(path.join(root, "Fixture.esp"), "mod fixture");
      await writeFile(path.join(root, "Base.esp"), "available mod fixture");
    });

    afterEach(async () => {
      const queue = DialogQueue.getInstance(deployment.api);
      queue.clear();
      queue.destroy();
      vi.restoreAllMocks();
      deployment.cleanup();
      await rm(root, { recursive: true, force: true });
    });

    const config = (typeDescriptor: string, groupType = "SelectAny", alternative = false) =>
      '<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xsi:noNamespaceSchemaLocation="http://qconsulting.ca/fo3/ModConfig5.0.xsd">' +
      '<moduleName>Native dialog fixture</moduleName><installSteps order="Explicit">' +
      '<installStep name="Files"><optionalFileGroups order="Explicit">' +
      `<group name="Mod" type="${groupType}"><plugins order="Explicit">` +
      '<plugin name="Fixture"><description>Test mod</description>' +
      '<files><file source="Fixture.esp" destination="Fixture.esp" /></files>' +
      `<typeDescriptor>${typeDescriptor}</typeDescriptor>` +
      "</plugin>" +
      (alternative
        ? '<plugin name="Base"><description>Available mod</description>' +
          '<files><file source="Base.esp" destination="Base.esp" /></files>' +
          '<typeDescriptor><type name="Required" /></typeDescriptor></plugin>'
        : "") +
      "</plugins></group></optionalFileGroups></installStep></installSteps></config>";

    const extenderType = (minimum = "1.7.3") =>
      '<dependencyType><defaultType name="NotUsable" /><patterns><pattern>' +
      `<dependencies operator="And"><skseDependency version="${minimum}" /></dependencies>` +
      '<type name="Optional" /></pattern></patterns></dependencyType>';

    const writeLoader = async (installed: "valid" | "unreadable") => {
      const fixture = JSON.parse(
        await readFile(
          path.resolve(
            __dirname,
            "../../../../../packages/exe-version/test-fixtures/skse-loader.json",
          ),
          "utf8",
        ),
      );
      await writeFile(
        path.join(path.dirname(deployment.gameDir), "SKSE_LOADER.EXE"),
        installed === "valid" ? Buffer.from(fixture.data, "base64") : "unreadable loader",
      );
    };

    const invoke = (choices?: unknown, unattended = choices !== undefined) =>
      install(
        deployment.api,
        ["fomod/ModuleConfig.xml", "Fixture.esp", "Base.esp"],
        root,
        "skyrim",
        choices,
        unattended,
        { hasXmlConfigXML: true },
      );

    const activeDialog = (): string | null => {
      const state = deployment.api.getState();
      return hasSessionFOMOD(state.session)
        ? state.session.fomod.installer.dialog.activeInstanceId
        : null;
    };

    const expectReleased = () => {
      expect(activeDialog()).toBeNull();
      const state = deployment.api.getState();
      expect(
        hasSessionFOMOD(state.session) && state.session.fomod.installer.dialog.instances,
      ).toEqual({});
      expect(
        deployment.api.events
          .eventNames()
          .filter((event) => String(event).startsWith("fomod-installer-")),
      ).toEqual([]);
      expect(DialogQueue.getInstance(deployment.api).getStatus().queueLength).toBe(0);
    };

    const options = () => {
      const state = deployment.api.getState();
      if (!hasSessionFOMOD(state.session)) throw new Error("FOMOD session missing");
      const dialog = state.session.fomod.installer.dialog;
      return dialog.instances[dialog.activeInstanceId]?.state?.installSteps[0].optionalFileGroups
        ?.group[0].options;
    };

    const expectBaseOnly = (result: Awaited<ReturnType<typeof invoke>>) => {
      expect(result.instructions.filter((instruction) => instruction.type === "copy")).toEqual([
        expect.objectContaining({ source: "Base.esp", destination: "Base.esp" }),
      ]);
      expect(result.instructions.some((instruction) => instruction.type === "error")).toBe(false);
    };

    test("cancels a real native dialog and can install again without stale listeners", async () => {
      await writeFile(
        path.join(root, "fomod", "ModuleConfig.xml"),
        config('<type name="Required" />'),
      );
      const canceled = invoke();
      const cancellation = expect(canceled).rejects.toBeInstanceOf(UserCanceled);
      await vi.waitFor(() => expect(activeDialog()).toBeTruthy());
      deployment.api.events.emit(`fomod-installer-cancel-${activeDialog()}`);
      await cancellation;
      expectReleased();

      const retry = invoke();
      await vi.waitFor(() => expect(activeDialog()).toBeTruthy());
      deployment.api.events.emit(`fomod-installer-continue-${activeDialog()}`, "forward", 0);
      const result = await retry;
      expect(result.instructions).toContainEqual(
        expect.objectContaining({
          type: "copy",
          source: "Fixture.esp",
          destination: "Fixture.esp",
        }),
      );
      expectReleased();
    });

    for (const scenario of [
      { name: "missing SKSE", minimum: "1.7.3" },
      { name: "missing SKSE with a zero minimum", minimum: "0.0.0" },
      { name: "unreadable SKSE", minimum: "1.7.3", installed: "unreadable" as const },
      { name: "older installed SKSE", minimum: "2.0.0", installed: "valid" as const },
      { name: "missing SKSE in SelectAll", minimum: "1.7.3", groupType: "SelectAll" },
    ]) {
      test(`disables an option with ${scenario.name} and installs available files`, async () => {
        if (scenario.installed) await writeLoader(scenario.installed);
        await writeFile(
          path.join(root, "fomod", "ModuleConfig.xml"),
          config(extenderType(scenario.minimum), scenario.groupType, true),
        );
        const installation = invoke();
        await vi.waitFor(() => expect(options()).toHaveLength(2));
        expect(options()[0]).toMatchObject({
          type: "NotUsable",
          selected: false,
          conditionMsg: expect.stringContaining(`skse v${scenario.minimum}`),
        });
        expect(options()[0].conditionMsg).not.toContain("Passed");
        expect(options()[1]).toMatchObject({ type: "Required", selected: true });
        // Even a stale selection cannot enable a currently unavailable option.
        const previousOptions = options();
        deployment.api.events.emit(`fomod-installer-select-${activeDialog()}`, "0", "0", [
          "0",
          "1",
        ]);
        await vi.waitFor(() => expect(options()).not.toBe(previousOptions));
        expect(options()[0].selected).toBe(false);
        deployment.api.events.emit(`fomod-installer-continue-${activeDialog()}`, "forward", 0);
        expectBaseOnly(await installation);
        expectReleased();
      });
    }

    test("enables the SKSE option after installing a loader and keeps the user's selection", async () => {
      await writeLoader("valid");
      await writeFile(
        path.join(root, "fomod", "ModuleConfig.xml"),
        config(extenderType(), "SelectAny", true),
      );
      const installation = invoke();
      await vi.waitFor(() => expect(options()).toHaveLength(2));
      expect(options()[0]).toMatchObject({ type: "Optional", selected: false });
      deployment.api.events.emit(`fomod-installer-select-${activeDialog()}`, "0", "0", ["0", "1"]);
      await vi.waitFor(() => expect(options()[0].selected).toBe(true));
      deployment.api.events.emit(`fomod-installer-continue-${activeDialog()}`, "forward", 0);
      expect(
        (await installation).instructions.filter((instruction) => instruction.type === "copy"),
      ).toEqual([
        expect.objectContaining({ source: "Fixture.esp", destination: "Fixture.esp" }),
        expect.objectContaining({ source: "Base.esp", destination: "Base.esp" }),
      ]);
      expectReleased();
    });

    test("omits an unavailable option when installing with empty saved choices", async () => {
      await writeFile(
        path.join(root, "fomod", "ModuleConfig.xml"),
        config(extenderType(), "SelectAll", true),
      );
      expectBaseOnly(await invoke({ type: "fomod", options: [] }));
      expectReleased();
    });

    for (const unattended of [false, true]) {
      test(`does not revive an unavailable option from saved choices (unattended=${unattended})`, async () => {
        await writeFile(
          path.join(root, "fomod", "ModuleConfig.xml"),
          config(extenderType(), "SelectAny", true),
        );
        const installation = invoke(
          {
            type: "fomod",
            options: [
              { name: "Files", groups: [{ name: "Mod", choices: [{ name: "Fixture", idx: 0 }] }] },
            ],
          },
          unattended,
        );
        if (!unattended) {
          await vi.waitFor(() => expect(options()).toHaveLength(2));
          expect(options()[0]).toMatchObject({ type: "NotUsable", selected: false });
          deployment.api.events.emit(`fomod-installer-continue-${activeDialog()}`, "forward", 0);
        }
        expectBaseOnly(await installation);
        expectReleased();
      });
    }

    test("queues an installer with an unavailable SKSE option behind the active dialog", async () => {
      await writeFile(
        path.join(root, "fomod", "ModuleConfig.xml"),
        config('<type name="Required" />'),
      );
      const first = invoke();
      await vi.waitFor(() => expect(activeDialog()).toBeTruthy());
      const firstId = activeDialog();
      try {
        await writeFile(
          path.join(root, "fomod", "ModuleConfig.xml"),
          config(extenderType(), "SelectAny", true),
        );
        const second = invoke();
        await vi.waitFor(() =>
          expect(DialogQueue.getInstance(deployment.api).getStatus().queueLength).toBe(1),
        );
        expect(activeDialog()).toBe(firstId);
        expect(deployment.api.events.listenerCount(`fomod-installer-continue-${firstId}`)).toBe(1);
        deployment.api.events.emit(`fomod-installer-continue-${firstId}`, "forward", 0);
        expect((await first).instructions.some((instruction) => instruction.type === "copy")).toBe(
          true,
        );
        await vi.waitFor(() => {
          expect(activeDialog()).toBeTruthy();
          expect(activeDialog()).not.toBe(firstId);
        });
        expect(options()[0]).toMatchObject({ type: "NotUsable", selected: false });
        deployment.api.events.emit(`fomod-installer-continue-${activeDialog()}`, "forward", 0);
        expectBaseOnly(await second);
        expectReleased();
      } finally {
        deployment.api.events.emit(`fomod-installer-cancel-${firstId}`);
        await first.catch(() => undefined);
      }
    });

    for (const message of [
      "Filesystem read failed",
      "System.Threading.Tasks.TaskCanceledException",
    ]) {
      test(`preserves an unrelated native error: ${message}`, async () => {
        const { NativeModInstaller } =
          require("@nexusmods/fomod-installer-native") as typeof fomodT;
        const error = new Error(message);
        vi.spyOn(NativeModInstaller.prototype, "install").mockRejectedValueOnce(error);
        await expect(invoke()).rejects.toBe(error);
        expectReleased();
      });
    }
  },
);
