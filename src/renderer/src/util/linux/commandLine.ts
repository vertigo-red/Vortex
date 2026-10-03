interface ICommandLineToken {
  source: string;
  value: string;
}

/** Parse quoting and escapes without performing shell expansions. */
export function parseCommandLine(input: string): ICommandLineToken[] {
  const result: ICommandLineToken[] = [];
  let start = -1;
  let value = "";
  let quote: "'" | '"' | undefined;

  const complete = (end: number) => {
    if (start !== -1) {
      result.push({ source: input.slice(start, end), value });
      start = -1;
      value = "";
    }
  };

  for (let index = 0; index < input.length; ++index) {
    const char = input[index];
    if (quote === undefined && /[ \t\r\n]/.test(char)) {
      complete(index);
      continue;
    }
    if (quote === undefined && start === -1 && char === "\\" && input[index + 1] === "\n") {
      ++index;
      continue;
    }
    if (start === -1) start = index;
    if (char === quote) {
      quote = undefined;
    } else if (quote === undefined && (char === "'" || char === '"')) {
      quote = char;
    } else if (char === "\\" && quote !== "'" && index + 1 < input.length) {
      const next = input[index + 1];
      if (quote === undefined || /["\\$`\n]/.test(next)) {
        if (next !== "\n") value += next;
        ++index;
      } else {
        value += char;
      }
    } else {
      value += char;
    }
  }
  // Keep an unfinished quoted argument editable, as in the existing tool editor.
  complete(input.length);
  return result;
}

/** Quote one literal argument for a POSIX shell or the Linux tool editor. */
export function quoteArgument(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function formatCommandLine(args: string[]): string {
  return args
    .map((arg) => (/^[a-zA-Z0-9_./:=+-]+$/.test(arg) ? arg : quoteArgument(arg)))
    .join(" ");
}
