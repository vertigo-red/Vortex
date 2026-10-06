import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

describe.skipIf(process.platform !== "linux")("Native FOMOD failure and cancellation", () => {
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
    const { NativeLogger } = require("@nexusmods/fomod-installer-native") as typeof fomodT;
    new NativeLogger(() => undefined).setCallbacks();
    await mkdir(path.join(root, "fomod"));
    await writeFile(path.join(root, "Fixture.esp"), "mod fixture");
  });

  afterEach(async () => {
    const queue = DialogQueue.getInstance(deployment.api);
    queue.clear();
    queue.destroy();
    vi.restoreAllMocks();
    deployment.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  const config = (typeDescriptor: string) =>
    '<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xsi:noNamespaceSchemaLocation="http://qconsulting.ca/fo3/ModConfig5.0.xsd">' +
    '<moduleName>Native dialog fixture</moduleName><installSteps order="Explicit">' +
    '<installStep name="Files"><optionalFileGroups order="Explicit">' +
    '<group name="Mod" type="SelectAll"><plugins order="Explicit">' +
    '<plugin name="Fixture"><description>Test mod</description>' +
    '<files><file source="Fixture.esp" destination="Fixture.esp" /></files>' +
    `<typeDescriptor>${typeDescriptor}</typeDescriptor>` +
    "</plugin></plugins></group></optionalFileGroups></installStep></installSteps></config>";

  const invoke = (choices?: unknown) =>
    install(
      deployment.api,
      ["fomod/ModuleConfig.xml", "Fixture.esp"],
      root,
      "skyrim",
      choices,
      choices !== undefined,
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

  test("releases a queued native dialog when an unavailable SKSE option fails before display", async () => {
    await writeFile(
      path.join(root, "fomod", "ModuleConfig.xml"),
      config(
        '<dependencyType><defaultType name="NotUsable" /><patterns><pattern>' +
          '<dependencies operator="And"><skseDependency version="1.7.3" /></dependencies>' +
          '<type name="Optional" /></pattern></patterns></dependencyType>',
      ),
    );
    const result = await invoke();
    expect(result.instructions).toContainEqual(
      expect.objectContaining({
        type: "error",
        value: "fatal",
        source: expect.stringMatching(/could not read.*SKSE/),
      }),
    );
    expectReleased();
    await writeFile(
      path.join(root, "fomod", "ModuleConfig.xml"),
      config('<type name="Required" />'),
    );
    const retry = await invoke({ type: "fomod", options: [] });
    expect(retry.instructions.some((instruction) => instruction.type === "copy")).toBe(true);
    expectReleased();
  });

  test("keeps another native installer active when a queued SKSE option fails", async () => {
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
        config(
          '<dependencyType><defaultType name="NotUsable" /><patterns><pattern>' +
            '<dependencies operator="And"><skseDependency version="1.7.3" /></dependencies>' +
            '<type name="Optional" /></pattern></patterns></dependencyType>',
        ),
      );
      const result = await invoke();
      expect(result.instructions).toContainEqual(
        expect.objectContaining({ type: "error", value: "fatal" }),
      );
      expect(activeDialog()).toBe(firstId);
      expect(DialogQueue.getInstance(deployment.api).getStatus().queueLength).toBe(0);
      expect(deployment.api.events.listenerCount(`fomod-installer-continue-${firstId}`)).toBe(1);
      deployment.api.events.emit(`fomod-installer-continue-${firstId}`, "forward", 0);
      expect((await first).instructions.some((instruction) => instruction.type === "copy")).toBe(
        true,
      );
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
      const { NativeModInstaller } = require("@nexusmods/fomod-installer-native") as typeof fomodT;
      const error = new Error(message);
      vi.spyOn(NativeModInstaller.prototype, "install").mockRejectedValueOnce(error);
      await expect(invoke()).rejects.toBe(error);
      expectReleased();
    });
  }
});
