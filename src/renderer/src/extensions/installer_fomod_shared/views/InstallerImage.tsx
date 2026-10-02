import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getErrorMessageOrDefault } from "@vortex/shared";
import React, { useEffect, useMemo, useState } from "react";

import ZoomableImage from "../../../controls/ZoomableImage";
import { log } from "../../../util/log";
import { createArchiveSourceResolver } from "../../mod_management/util/installerPaths";

interface IProps {
  dataPath: string;
  image: string;
}

interface IResolvedImage extends IProps {
  url: string;
}

export default function InstallerImage({ dataPath, image }: IProps) {
  const resolveSource = useMemo(() => createArchiveSourceResolver(dataPath), [dataPath]);
  const [resolved, setResolved] = useState<IResolvedImage>();

  useEffect(() => {
    let active = true;
    const resolveImage = async () => {
      const filePath =
        process.platform === "linux"
          ? await resolveSource(image.replace(/\\/g, "/"))
          : path.join(dataPath, image);
      if (process.platform === "linux" && !(await stat(filePath)).isFile()) {
        throw new Error("FOMOD image is not a file");
      }
      return pathToFileURL(filePath).href;
    };
    void resolveImage().then(
      (url) => {
        if (active) {
          setResolved({ dataPath, image, url });
        }
      },
      (err) => {
        if (active) {
          log("warn", "Failed to load FOMOD image", {
            dataPath,
            image,
            error: getErrorMessageOrDefault(err),
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [dataPath, image, resolveSource]);

  if (resolved?.dataPath !== dataPath || resolved?.image !== image) {
    return null;
  }
  return (
    <ZoomableImage
      url={resolved.url}
      className="installer-image"
      overlayClass="installer-zoom"
      container={undefined}
    />
  );
}
