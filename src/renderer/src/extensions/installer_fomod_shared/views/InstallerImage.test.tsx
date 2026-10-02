import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type * as fomodT from "@nexusmods/fomod-installer-native";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { log } from "../../../util/log";
import InstallerImage from "./InstallerImage";

vi.mock("../../../util/log", () => ({ log: vi.fn() }));

describe.skipIf(process.platform !== "linux")("Linux FOMOD images", () => {
  let fixture: string;
  let archive: string;
  let images: string;

  beforeEach(async () => {
    fixture = await mkdtemp(path.join(os.tmpdir(), "vortex-fomod-images-"));
    archive = path.join(fixture, "archive");
    images = path.join(archive, "fomod", "images");
    await mkdir(images, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await rm(fixture, { recursive: true, force: true });
  });

  const expectImage = async (filePath: string) => {
    await waitFor(() => {
      expect(screen.getByRole("img")).toHaveAttribute("src", pathToFileURL(filePath).href);
    });
  };

  const expectRejectedImage = async () => {
    await waitFor(() => {
      expect(log).toHaveBeenCalledWith(
        "warn",
        "Failed to load FOMOD image",
        expect.objectContaining({ dataPath: archive, error: expect.any(String) }),
      );
    });
    expect(screen.queryByRole("img")).toBeNull();
  };

  it("loads Windows separators, mixed casing and URL-special characters from a real archive", async () => {
    const actual = path.join(images, "Preview #1+%.PNG");
    await writeFile(actual, "image");
    render(<InstallerImage dataPath={archive} image="FOMOD\\Images\\preview #1+%.png" />);

    await expectImage(actual);
    expect(log).not.toHaveBeenCalled();
  });

  it("prefers an exact filename when case-distinct images exist", async () => {
    await writeFile(path.join(images, "Banner.png"), "upper");
    const actual = path.join(images, "banner.png");
    await writeFile(actual, "lower");
    render(<InstallerImage dataPath={archive} image="fomod/images/banner.png" />);

    await expectImage(actual);
    expect(log).not.toHaveBeenCalled();
  });

  it("reports ambiguous image filenames without showing a different image", async () => {
    await writeFile(path.join(images, "Banner.png"), "upper");
    await writeFile(path.join(images, "banner.png"), "lower");
    render(<InstallerImage dataPath={archive} image="fomod/images/BANNER.PNG" />);

    await expectRejectedImage();
    expect(vi.mocked(log).mock.calls[0][2]).toMatchObject({
      error: expect.stringContaining("ambiguous filename casing"),
    });
  });

  it("reports ambiguous directory names", async () => {
    await writeFile(path.join(images, "banner.png"), "lower");
    await mkdir(path.join(archive, "FOMOD", "images"), { recursive: true });
    await writeFile(path.join(archive, "FOMOD", "images", "banner.png"), "upper");
    render(<InstallerImage dataPath={archive} image="FoMoD/images/banner.png" />);

    await expectRejectedImage();
  });

  it("does not read an image outside the extracted archive", async () => {
    await writeFile(path.join(fixture, "outside.png"), "outside");
    render(<InstallerImage dataPath={archive} image="..\\outside.png" />);

    await expectRejectedImage();
    expect(vi.mocked(log).mock.calls[0][2]).toMatchObject({
      error: expect.stringContaining("outside the archive"),
    });
  });

  it.each(["fomod/images/missing.png", "fomod/images"])(
    "reports a missing or non-file image: %s",
    async (image) => {
      render(<InstallerImage dataPath={archive} image={image} />);

      await expectRejectedImage();
    },
  );

  it("hides the old image while a newly selected option is being resolved", async () => {
    const banner = path.join(images, "banner.png");
    const option = path.join(images, "option.png");
    await writeFile(banner, "banner");
    await writeFile(option, "option");
    const { rerender } = render(
      <InstallerImage dataPath={archive} image="FOMOD\\images\\BANNER.PNG" />,
    );
    await expectImage(banner);

    rerender(<InstallerImage dataPath={archive} image="FOMOD\\images\\OPTION.PNG" />);
    expect(screen.queryByRole("img")).toBeNull();
    await expectImage(option);
  });

  it("resolves a new archive when the next installer uses the same image name", async () => {
    const first = path.join(archive, "fomod", "banner.png");
    await writeFile(first, "first");
    const secondArchive = path.join(fixture, "second");
    const second = path.join(secondArchive, "Fomod", "Banner.PNG");
    await mkdir(path.dirname(second), { recursive: true });
    await writeFile(second, "second");
    const { rerender } = render(<InstallerImage dataPath={archive} image="fomod/banner.png" />);
    await expectImage(first);

    rerender(<InstallerImage dataPath={secondArchive} image="fomod/banner.png" />);
    await expectImage(second);
  });

  it("loads header and option paths returned by the real native XML FOMOD engine", async () => {
    const banner = path.join(images, "Banner #1.PNG");
    const option = path.join(images, "Option+%.png");
    await writeFile(banner, "banner");
    await writeFile(option, "option");
    const configPath = "fomod/moduleconfig.XML";
    await writeFile(
      path.join(archive, configPath),
      '<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
        'xsi:noNamespaceSchemaLocation="http://qconsulting.ca/fo3/ModConfig5.0.xsd">' +
        "<moduleName>Linux fixture</moduleName>" +
        '<moduleImage path="FOMOD\\Images\\banner #1.png" />' +
        '<installSteps order="Explicit"><installStep name="Choose">' +
        '<optionalFileGroups order="Explicit"><group name="Group" type="SelectExactlyOne">' +
        '<plugins order="Explicit"><plugin name="One"><description>One</description>' +
        '<image path="FOMOD\\Images\\OPTION+%.PNG" />' +
        '<typeDescriptor><type name="Required" /></typeDescriptor>' +
        "</plugin></plugins></group></optionalFileGroups></installStep></installSteps></config>",
    );
    const { NativeLogger, NativeModInstaller } =
      require("@nexusmods/fomod-installer-native") as typeof fomodT;
    const logger = new NativeLogger(() => undefined);
    logger.setCallbacks();
    let header: fomodT.types.IHeaderImage;
    let steps: fomodT.types.IInstallStep[];
    let continueInstall: fomodT.types.ContinueCallback;
    const installer = new NativeModInstaller(
      () => [],
      () => "1.0.0",
      () => "1.0.0",
      () => "1.0.0",
      (_name, image, _select, cont) => {
        header = image;
        continueInstall = cont;
      },
      () => undefined,
      (state, current) => {
        steps = state;
        setImmediate(() => continueInstall(true, current));
      },
    );
    const result = await installer.install(
      [configPath, "fomod/images/Banner #1.PNG", "fomod/images/Option+%.png"],
      [],
      null,
      archive,
      null,
      false,
      true,
    );
    expect(result.message).toBe("Installation successful");
    const { rerender } = render(<InstallerImage dataPath={archive} image={header.path} />);
    await expectImage(banner);

    rerender(
      <InstallerImage
        dataPath={archive}
        image={steps[0].optionalFileGroups.group[0].options[0].image}
      />,
    );
    await expectImage(option);
  });
});
