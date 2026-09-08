import { beforeEach, describe, expect, it, vi } from "vitest";

import { uploadS3Multipart, type S3MultipartLayout } from "./s3Multipart";
import type { UploadOptions, UploadSession } from "./transport";

type Range = { start: number; end: number };
type PutFileResult = { headers: { etag?: string } };
type PostBodyResult = { body: string };
type PutFileFn = (
  session: UploadSession,
  url: string,
  filePath: string,
  size: number,
  label: string,
  range: Range | undefined,
  onProgress: ((transferred: number) => void) | undefined,
) => Promise<PutFileResult>;
type PostBodyFn = (
  session: UploadSession,
  url: string,
  body: string,
  contentType: string,
) => Promise<PostBodyResult>;
type CreateSessionFn = () => UploadSession;

const transportMock = vi.hoisted(() => ({
  createSession: vi.fn<CreateSessionFn>(),
  putFile: vi.fn<PutFileFn>(),
  postBody: vi.fn<PostBodyFn>(),
}));
const errorsMock = vi.hoisted(() => ({
  redactUrl: vi.fn<(url: string) => string>(),
}));
const logMock = vi.hoisted(() => ({
  log: vi.fn<(level: string, message: string) => void>(),
}));

vi.mock("./transport", () => ({
  createSession: transportMock.createSession,
  putFile: transportMock.putFile,
  postBody: transportMock.postBody,
}));

vi.mock("./errors", () => ({
  redactUrl: errorsMock.redactUrl,
}));

vi.mock("../logging", () => ({
  log: logMock.log,
}));

const session = {} as UploadSession;

function layout(
  urls: readonly string[],
  completeUrl = "https://s3.example.com/complete",
): S3MultipartLayout {
  return {
    partSizeBytes: 40,
    partPresignedUrls: urls,
    completePresignedUrl: completeUrl,
  };
}

const THREE_PART_LAYOUT = layout([
  "https://s3.example.com/1",
  "https://s3.example.com/2",
  "https://s3.example.com/3",
]);

const completionXml = `<CompleteMultipartUpload>
  <Part>
    <PartNumber>1</PartNumber>
    <ETag>etag-1</ETag>
  </Part>
  <Part>
    <PartNumber>2</PartNumber>
    <ETag>etag-2</ETag>
  </Part>
  <Part>
    <PartNumber>3</PartNumber>
    <ETag>etag-3</ETag>
  </Part>
</CompleteMultipartUpload>`;

function uploadPartShim(): void {
  const puts: Array<{ url: string; size: number; label: string; range: Range | undefined }> = [];
  transportMock.putFile.mockImplementation(
    (_session, url, _filePath, size, label, range, onProgress) => {
      puts.push({ url, size, label, range });
      if (onProgress !== undefined) {
        onProgress(size);
      }
      return Promise.resolve({ headers: { etag: `etag-${puts.length}` } });
    },
  );
}

beforeEach(() => {
  transportMock.createSession.mockClear();
  transportMock.putFile.mockClear();
  transportMock.postBody.mockClear();
  errorsMock.redactUrl.mockClear();
  logMock.log.mockClear();
  transportMock.createSession.mockReturnValue(session);
  errorsMock.redactUrl.mockImplementation((url) => url);
  transportMock.postBody.mockResolvedValue({ body: "<CompleteMultipartUpload/>" });
});

describe("uploadS3Multipart", () => {
  it("rejects a layout whose preset parts cannot cover the file size", async () => {
    // 130 bytes at 40 bytes/part need 4 parts but only 3 URLs were issued.
    const p = uploadS3Multipart(THREE_PART_LAYOUT, "/file.bin", 130);
    const message =
      "Multipart layout mismatch: server returned 3 presigned URLs but 130 bytes at 40 bytes/part needs 4";

    await expect(p).rejects.toMatchObject({
      message,
      data: { kind: "http:protocol-violation", url: "https://s3.example.com/complete" },
    });
    expect(transportMock.putFile).not.toHaveBeenCalled();
  });

  it("PUTs each part with its byte range and completes with the ETags in order", async () => {
    uploadPartShim();

    await uploadS3Multipart(THREE_PART_LAYOUT, "/file.bin", 100);

    expect(
      transportMock.putFile.mock.calls.map((call) => [call[1], call[3], call[4], call[5]] as const),
    ).toEqual([
      ["https://s3.example.com/1", 40, "part 1/3", { start: 0, end: 40 }],
      ["https://s3.example.com/2", 40, "part 2/3", { start: 40, end: 80 }],
      ["https://s3.example.com/3", 20, "part 3/3", { start: 80, end: 100 }],
    ]);
    expect(transportMock.createSession).toHaveBeenCalledTimes(1);
    expect(transportMock.postBody.mock.calls).toEqual([
      [session, "https://s3.example.com/complete", completionXml, "application/xml" as const],
    ]);
  });

  it("accumulates progress across parts through the shared handler", async () => {
    const onProgress = vi.fn<(transferred: number) => void>();
    uploadPartShim();

    await uploadS3Multipart(THREE_PART_LAYOUT, "/file.bin", 100, { onProgress });

    expect(onProgress.mock.calls.map((call) => call[0])).toEqual([40, 80, 100]);
  });

  it("stops at the first part that is answered without an ETag", async () => {
    transportMock.putFile.mockImplementation((_session, url) => {
      const etag = url.endsWith("/2") ? undefined : "etag";
      return Promise.resolve({ headers: { etag } });
    });

    const p = uploadS3Multipart(THREE_PART_LAYOUT, "/file.bin", 100);

    await expect(p).rejects.toMatchObject({
      message: "Server did not return an ETag for part 2 of multipart upload",
      data: { kind: "http:protocol-violation", url: "https://s3.example.com/2" },
    });
    // Parts 1 and 2 were attempted but the completion never ran.
    expect(transportMock.putFile).toHaveBeenCalledTimes(2);
    expect(transportMock.postBody).not.toHaveBeenCalled();
  });

  it("throws when the completion response carries an S3 error document", async () => {
    uploadPartShim();
    transportMock.postBody.mockResolvedValue({
      body: "<Error><Code>InternalError</Code><Message>boom</Message></Error>",
    });

    const p = uploadS3Multipart(THREE_PART_LAYOUT, "/file.bin", 100);

    await expect(p).rejects.toMatchObject({
      message: "Multipart completion reported an error: InternalError",
      data: { kind: "http:protocol-violation", url: "https://s3.example.com/complete" },
    });
  });

  it("names an unknown error code when the S3 error document omits one", async () => {
    uploadPartShim();
    transportMock.postBody.mockResolvedValue({ body: "<Error><Message>boom</Message></Error>" });

    const p = uploadS3Multipart(THREE_PART_LAYOUT, "/file.bin", 100);

    await expect(p).rejects.toMatchObject({
      message: "Multipart completion reported an error: unknown",
      data: { kind: "http:protocol-violation" },
    });
  });

  it("passes upload options to the session it creates", async () => {
    uploadPartShim();
    const options: UploadOptions = { userAgent: "test-agent" };

    await uploadS3Multipart(THREE_PART_LAYOUT, "/file.bin", 100, options);

    expect(transportMock.createSession).toHaveBeenCalledWith(options);
  });
});
