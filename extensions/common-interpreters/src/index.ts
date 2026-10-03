import * as path from "path";
import * as process from "process";

import { log, types, util } from "@nexusmods/vortex-api";
import * as which from "which";

function findInterpreter(commands: string[], input: types.IRunParameters): string | undefined {
  let searchPath: string;
  if (process.platform === "linux") {
    const cwd = path.resolve(input.options.cwd || path.dirname(input.executable));
    const toolPath = input.options.env?.PATH ?? (process.env.PATH_ORIG || process.env.PATH) ?? "";
    // Relative and empty PATH entries belong to the tool's working directory.
    // Resolve them before which searches, including an explicitly empty PATH.
    searchPath = toolPath
      .split(path.delimiter)
      .map((entry) => path.resolve(cwd, entry))
      .join(path.delimiter);
  }
  for (const command of commands) {
    const executable = which.sync(command, { path: searchPath, nothrow: true });
    if (executable !== null) return executable;
  }
  log("info", "interpreter not found", { commands });
  return undefined;
}

function findJava(input: types.IRunParameters): string | undefined {
  if (process.platform !== "linux") {
    if (process.env.JAVA_HOME === undefined) return undefined;
    const fileName = process.platform === "win32" ? "java.exe" : "java";
    return path.join(process.env.JAVA_HOME, "bin", fileName);
  }
  const javaHome = input.options.env?.JAVA_HOME ?? process.env.JAVA_HOME;
  const candidates = javaHome
    ? [
        path.resolve(input.options.cwd || path.dirname(input.executable), javaHome, "bin", "java"),
        "java",
      ]
    : ["java"];
  return findInterpreter(candidates, input);
}

function scriptArgument(input: types.IRunParameters): string {
  // Only this newly inserted argument is literal in shell mode. The user's
  // arguments remain shell text, as with other Linux tool launches.
  return process.platform === "linux" && input.options.shell
    ? `'${input.executable.replace(/'/g, `'"'"'`)}'`
    : input.executable;
}

function interpreterOptions(input: types.IRunParameters): types.IRunOptions {
  return process.platform === "linux"
    ? { ...input.options, cwd: input.options.cwd || path.dirname(input.executable) }
    : input.options;
}

function init(context: Pick<types.IExtensionContext, "registerInterpreter">): boolean {
  context.registerInterpreter(".jar", (input: types.IRunParameters) => {
    const javaPath = findJava(input);
    if (javaPath === undefined) {
      throw new util.MissingInterpreter(
        process.platform === "linux"
          ? "Java was not found. Install a Java runtime with your package manager or configure the tool's PATH or JAVA_HOME."
          : "Java isn't installed",
        process.platform === "linux" ? undefined : "https://www.java.com/de/download/",
      );
    }
    return {
      executable: javaPath,
      args: ["-jar", scriptArgument(input), ...input.args],
      options: interpreterOptions(input),
    };
  });

  context.registerInterpreter(".vbs", (input: types.IRunParameters) => {
    if (process.platform === "linux") {
      throw new util.MissingInterpreter(
        "VBScript requires Windows Script Host and cannot run natively on Linux.",
      );
    }
    return {
      executable: path.join(process.env.windir, "system32", "cscript.exe"),
      args: [input.executable].concat(input.args),
      options: input.options,
    };
  });

  context.registerInterpreter(".py", (input: types.IRunParameters) => {
    const pythonPath = findInterpreter(
      process.platform === "linux" ? ["python3", "python"] : ["python"],
      input,
    );
    if (pythonPath === undefined) {
      throw new util.MissingInterpreter(
        process.platform === "linux"
          ? "Python was not found. Install Python 3 with your package manager or configure the tool's PATH."
          : "Python isn't installed",
        process.platform === "linux" ? undefined : "https://www.python.org/downloads/",
      );
    }
    return {
      executable: pythonPath,
      args: [scriptArgument(input), ...input.args],
      options: interpreterOptions(input),
    };
  });

  if (process.platform === "win32") {
    context.registerInterpreter(".cmd", (input: types.IRunParameters) => {
      return {
        executable: "cmd.exe",
        args: ["/K", `"${input.executable}"`].concat(input.args),
        options: input.options,
      };
    });

    context.registerInterpreter(".bat", (input: types.IRunParameters) => {
      return {
        executable: "cmd.exe",
        args: ["/K", `"${input.executable}"`].concat(input.args),
        options: {
          ...input.options,
          shell: true,
        },
      };
    });
  }
  return true;
}

export default init;
