import * as path from "node:path";

export function buildProtonCommand(
  protonPath: string,
  exePath: string,
  args: string[],
): { executable: string; args: string[] } {
  const script = [".bat", ".cmd"].includes(path.extname(exePath).toLowerCase());
  return {
    executable: path.join(protonPath, "proton"),
    // Wine constructs a Windows command line from argv. A bare quoted script followed
    // by quoted data triggers cmd's first/last quote stripping. The echo prefix avoids
    // that mode without CALL's additional expansion or START's directory change.
    args: script
      ? ["run", "cmd.exe", "/d", "/v:off", "/c", "@", exePath, ...args]
      : ["run", exePath, ...args],
  };
}
