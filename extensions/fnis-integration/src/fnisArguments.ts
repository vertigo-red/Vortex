/** FNIS options are individual argv values, not shell command fragments. */
export function fnisArguments(outputDirectory: string, interactive: boolean): string[] {
  return [`RedirectFiles=${outputDirectory}`, ...(interactive ? [] : ["InstantExecute=1"])];
}
