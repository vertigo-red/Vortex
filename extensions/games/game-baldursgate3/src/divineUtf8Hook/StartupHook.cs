using System;
using System.IO;
using System.Text;

internal static class StartupHook
{
    public static void Initialize()
    {
        // Setting Console.OutputEncoding calls SetConsoleOutputCP, which can fail
        // for Wine's headless console. Write UTF-8 directly to the inherited pipes.
        var encoding = new UTF8Encoding(false);
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), encoding) { AutoFlush = true });
        Console.SetError(new StreamWriter(Console.OpenStandardError(), encoding) { AutoFlush = true });
    }
}
