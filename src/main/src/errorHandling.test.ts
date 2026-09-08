import { UserCanceled } from "@vortex/shared/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { terminate, terminateAsync } from "./errorHandling";

const {
  logMock,
  getErrorMessageMock,
  getErrorMessageOrDefaultMock,
  UserCanceledMock,
  reportCrashMock,
  errorToReportableErrorMock,
  disableErrorReportingMock,
  isErrorReportingDisabledMock,
  isTelemetryEnabledMock,
  appIsReadyMock,
  appExitMock,
  dialogShowErrorBoxMock,
  dialogShowMessageBoxMock,
} = vi.hoisted(() => ({
  logMock: vi.fn<(level: string, message: string, details?: unknown) => void>(),
  getErrorMessageMock: vi.fn<(err: unknown) => string | null>(),
  getErrorMessageOrDefaultMock: vi.fn<(err: unknown) => string>(),
  UserCanceledMock: class UserCanceledMock extends Error {
    public skipped: boolean;
    constructor(skipped: boolean = false) {
      super("canceled by user");
      this.skipped = skipped;
    }
  },
  reportCrashMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(() => Promise.resolve()),
  errorToReportableErrorMock: vi.fn<(err: Error) => unknown>(() => undefined),
  disableErrorReportingMock: vi.fn<() => void>(() => {}),
  isErrorReportingDisabledMock: vi.fn<() => boolean>(() => false),
  isTelemetryEnabledMock: vi.fn<() => boolean>(() => false),
  appIsReadyMock: vi.fn<() => boolean>(() => true),
  appExitMock: vi.fn<(code: number) => void>(() => {}),
  dialogShowErrorBoxMock: vi.fn<(title: string, content: string) => void>(() => {}),
  dialogShowMessageBoxMock: vi.fn<(options: unknown) => Promise<{ response: number }>>(() =>
    Promise.resolve({ response: 0 }),
  ),
}));

vi.mock("@vortex/shared", () => ({
  getErrorMessage: getErrorMessageMock,
  getErrorMessageOrDefault: getErrorMessageOrDefaultMock,
}));

vi.mock("@vortex/shared/errors", () => ({
  UserCanceled: UserCanceledMock,
}));

vi.mock("electron", () => ({
  app: { isReady: appIsReadyMock, exit: appExitMock },
  dialog: {
    showErrorBox: dialogShowErrorBoxMock,
    showMessageBox: dialogShowMessageBoxMock,
  },
}));

vi.mock("./errorReporting", () => ({
  reportCrash: reportCrashMock,
  errorToReportableError: errorToReportableErrorMock,
  disableErrorReporting: disableErrorReportingMock,
  isErrorReportingDisabled: isErrorReportingDisabledMock,
}));

vi.mock("./logging", () => ({
  log: logMock,
}));

vi.mock("./telemetry/state", () => ({
  isTelemetryEnabled: isTelemetryEnabledMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  appIsReadyMock.mockReturnValue(true);
  isErrorReportingDisabledMock.mockReturnValue(false);
  isTelemetryEnabledMock.mockReturnValue(false);
  getErrorMessageMock.mockReturnValue("message");
  getErrorMessageOrDefaultMock.mockReturnValue("default-message");
  errorToReportableErrorMock.mockReturnValue(undefined);
  reportCrashMock.mockResolvedValue(undefined);
  dialogShowMessageBoxMock.mockResolvedValue({ response: 0 });
});

describe("terminate", () => {
  it("logs the error and throws a UserCanceled to interrupt the current flow", async () => {
    const err = new Error("kaput");
    let thrown: unknown;
    try {
      terminate(err);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UserCanceled);
    expect(thrown).toBeInstanceOf(UserCanceledMock);
    expect(logMock).toHaveBeenCalledWith("error", "unrecoverable error", err);
    await vi.waitFor(() => expect(appExitMock).toHaveBeenCalled());
  });
});

describe("terminateAsync", () => {
  it("shows a synchronous error box when the app is not ready yet", async () => {
    appIsReadyMock.mockReturnValue(false);
    const err = new Error("kaput");
    await terminateAsync(err);
    expect(dialogShowErrorBoxMock).toHaveBeenCalledWith(
      "An unrecoverable error occurred",
      "message\n\n" + (err.stack ?? ""),
    );
    expect(reportCrashMock).toHaveBeenCalledWith("Crash", undefined, undefined, undefined, false);
    expect(appExitMock).toHaveBeenCalledWith(1);
  });

  it("skips the crash report when reporting is disabled", async () => {
    appIsReadyMock.mockReturnValue(false);
    isErrorReportingDisabledMock.mockReturnValue(true);
    await terminateAsync(new Error("kaput"));
    expect(reportCrashMock).not.toHaveBeenCalled();
    expect(appExitMock).toHaveBeenCalledWith(1);
  });

  it("survives a failing crash report", async () => {
    appIsReadyMock.mockReturnValue(false);
    reportCrashMock.mockRejectedValue(new Error("report-fail"));
    await expect(terminateAsync(new Error("kaput"))).resolves.toBeUndefined();
    expect(appExitMock).toHaveBeenCalledWith(1);
  });

  it("quits when the user selects Quit", async () => {
    dialogShowMessageBoxMock.mockResolvedValue({ response: 2 });
    await terminateAsync(new Error("kaput"));
    expect(dialogShowMessageBoxMock).toHaveBeenCalledWith({
      type: "error",
      title: "An unrecoverable error occurred",
      message: "default-message",
      detail: "",
      buttons: ["Show Details", "Ignore", "Quit", "Report and Quit"],
      defaultId: 3,
      noLink: true,
    });
    expect(reportCrashMock).not.toHaveBeenCalled();
    expect(appExitMock).toHaveBeenCalledWith(1);
  });

  it("reports and quits when the user selects the report button", async () => {
    dialogShowMessageBoxMock.mockResolvedValue({ response: 3 });
    await terminateAsync(new Error("kaput"));
    expect(reportCrashMock).toHaveBeenCalledWith("Crash", undefined, undefined, undefined, false);
    expect(appExitMock).toHaveBeenCalledWith(1);
  });

  it("omits the report button when reporting is disabled", async () => {
    isErrorReportingDisabledMock.mockReturnValue(true);
    dialogShowMessageBoxMock.mockResolvedValueOnce({ response: 1 });
    await terminateAsync(new Error("kaput"));
    expect(dialogShowMessageBoxMock).toHaveBeenCalledWith({
      type: "error",
      title: "An unrecoverable error occurred",
      message: "default-message",
      detail: "",
      buttons: ["Show Details", "Ignore", "Quit"],
      defaultId: 2,
      noLink: true,
    });
    expect(reportCrashMock).not.toHaveBeenCalled();
    expect(appExitMock).toHaveBeenCalledWith(1);
  });

  it("shows details recursively before quitting", async () => {
    const err = new Error("kaput");
    const detail = "\n" + err.stack;
    dialogShowMessageBoxMock.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({
      response: 1,
    });
    await terminateAsync(err);
    expect(dialogShowMessageBoxMock).toHaveBeenNthCalledWith(1, {
      type: "error",
      title: "An unrecoverable error occurred",
      message: "default-message",
      detail: "",
      buttons: ["Show Details", "Ignore", "Quit", "Report and Quit"],
      defaultId: 3,
      noLink: true,
    });
    expect(dialogShowMessageBoxMock).toHaveBeenNthCalledWith(2, {
      type: "error",
      title: "An unrecoverable error occurred",
      message: "default-message",
      detail,
      buttons: ["Ignore", "Quit", "Report and Quit"],
      defaultId: 2,
      noLink: true,
    });
    expect(appExitMock).toHaveBeenCalledWith(1);
  });

  it("assembles code, path and details into the details view", async () => {
    const err = new Error("kaput");
    Object.assign(err, {
      stack: "CUSTOM_STACK",
      path: "/data/db",
      code: "ENOENT",
      details: "extra info",
    });
    dialogShowMessageBoxMock.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({
      response: 1,
    });
    await terminateAsync(err);
    expect(dialogShowMessageBoxMock).toHaveBeenNthCalledWith(2, {
      type: "error",
      title: "An unrecoverable error occurred",
      message: "default-message",
      detail: "extra info\nENOENT\nFile: /data/db\n\nCUSTOM_STACK",
      buttons: ["Ignore", "Quit", "Report and Quit"],
      defaultId: 2,
      noLink: true,
    });
  });

  it("disables reporting only after explicit confirmation", async () => {
    dialogShowMessageBoxMock.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({
      response: 1,
    });
    await terminateAsync(new Error("kaput"));
    expect(dialogShowMessageBoxMock).toHaveBeenNthCalledWith(2, {
      type: "error",
      title: "Are you sure?",
      message:
        "The error was unhandled which may lead to unforeseen consequences including data loss. " +
        "Continue at your own risk. Please do not report any issues that arise from here on out, as they are very likely to be caused by the unhandled error. ",
      buttons: ["Quit", "I understand"],
      noLink: true,
    });
    expect(disableErrorReportingMock).toHaveBeenCalledOnce();
    expect(logMock).toHaveBeenCalledWith(
      "info",
      "user ignored unrecoverable error, disabling reporting",
    );
    expect(appExitMock).not.toHaveBeenCalled();
  });

  it("quits when the user backs out of the ignore confirmation", async () => {
    dialogShowMessageBoxMock.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({
      response: 0,
    });
    await terminateAsync(new Error("kaput"));
    expect(disableErrorReportingMock).not.toHaveBeenCalled();
    expect(appExitMock).toHaveBeenCalledWith(1);
  });

  it("logs a message box failure and still exits", async () => {
    const failure = new Error("dlg-fail");
    dialogShowMessageBoxMock.mockRejectedValue(failure);
    await terminateAsync(new Error("kaput"));
    expect(logMock).toHaveBeenCalledWith(
      "error",
      "error while handling unrecoverable error",
      failure,
    );
    expect(appExitMock).toHaveBeenCalledWith(1);
  });
});
