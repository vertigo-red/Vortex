#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

static wchar_t *command_tail(void) {
    wchar_t *cursor = GetCommandLineW();
    if (*cursor == L'"') {
        ++cursor;
        while (*cursor && *cursor != L'"') ++cursor;
        if (*cursor) ++cursor;
    } else {
        while (*cursor && *cursor != L' ' && *cursor != L'\t') ++cursor;
    }
    while (*cursor == L' ' || *cursor == L'\t') ++cursor;
    return _wcsdup(cursor);
}

static int fail(const wchar_t *operation) {
    fwprintf(stderr, L"Vortex BG3 launcher: %ls failed (Windows error %lu)\n",
             operation, GetLastError());
    return 1;
}

static int configure_output_hook(void) {
    wchar_t hook[32768];
    const wchar_t *name = L"vortex-divine-utf8.dll";
    DWORD length = GetModuleFileNameW(NULL, hook, 32768);
    if (!length || length >= 32768) return fail(L"GetModuleFileName");
    wchar_t *filename = wcsrchr(hook, L'\\');
    if (!filename || (size_t)(filename - hook) + 1 + wcslen(name) >= 32768) {
        SetLastError(ERROR_INVALID_NAME);
        return fail(L"Locate output hook");
    }
    wcscpy(filename + 1, name);
    DWORD attributes = GetFileAttributesW(hook);
    if (attributes == INVALID_FILE_ATTRIBUTES) return fail(L"Find output hook");
    if (attributes & FILE_ATTRIBUTE_DIRECTORY) {
        SetLastError(ERROR_DIRECTORY);
        return fail(L"Find output hook");
    }
    return SetEnvironmentVariableW(L"DOTNET_STARTUP_HOOKS", hook)
        ? 0 : fail(L"Set output hook");
}

int wmain(int count, wchar_t **args) {
    if (count < 2) return 87;
    // CoreCLR expands DOS short names before building its semicolon-delimited
    // assembly paths. Reject this unsupported tool location before startup.
    if (wcschr(args[1], L';')) {
        fputs("VORTEX_BG3_UNSUPPORTED_TOOL_PATH: Divine's tools directory contains a semicolon.\n",
              stderr);
        return 87;
    }
    if (configure_output_hook()) return 1;
    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (!job) return fail(L"CreateJobObject");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        int result = fail(L"SetInformationJobObject");
        CloseHandle(job);
        return result;
    }
    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION child = {0};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    wchar_t *command = command_tail();
    if (!command) { CloseHandle(job); return 8; }
    // Preserve the caller's Windows argv quoting verbatim; no cmd.exe expansion.
    BOOL created = CreateProcessW(args[1], command, NULL, NULL, TRUE, CREATE_SUSPENDED,
                                 NULL, NULL, &startup, &child);
    free(command);
    if (!created) {
        int result = fail(L"CreateProcess");
        CloseHandle(job);
        return result;
    }
    if (!AssignProcessToJobObject(job, child.hProcess)) {
        int result = fail(L"AssignProcessToJobObject");
        TerminateProcess(child.hProcess, 1);
        CloseHandle(child.hThread);
        CloseHandle(child.hProcess);
        CloseHandle(job);
        return result;
    }
    if (ResumeThread(child.hThread) == (DWORD)-1) {
        int result = fail(L"ResumeThread");
        CloseHandle(child.hThread);
        CloseHandle(child.hProcess);
        CloseHandle(job);
        return result;
    }
    CloseHandle(child.hThread);
    DWORD result = 1;
    if (WaitForSingleObject(child.hProcess, INFINITE) == WAIT_OBJECT_0) {
        GetExitCodeProcess(child.hProcess, &result);
    }
    CloseHandle(child.hProcess);
    CloseHandle(job);
    return (int)result;
}
