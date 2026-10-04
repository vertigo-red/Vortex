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

int wmain(int count, wchar_t **args) {
    if (count < 2) return 87;
    if (!SetConsoleOutputCP(CP_UTF8)) return fail(L"SetConsoleOutputCP");
    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (!job) return fail(L"CreateJobObject");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        CloseHandle(job);
        return fail(L"SetInformationJobObject");
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
    if (!created) { CloseHandle(job); return fail(L"CreateProcess"); }
    if (!AssignProcessToJobObject(job, child.hProcess)) {
        int result = fail(L"AssignProcessToJobObject");
        TerminateProcess(child.hProcess, 1);
        CloseHandle(child.hThread);
        CloseHandle(child.hProcess);
        CloseHandle(job);
        return result;
    }
    ResumeThread(child.hThread);
    CloseHandle(child.hThread);
    DWORD result = 1;
    if (WaitForSingleObject(child.hProcess, INFINITE) == WAIT_OBJECT_0) {
        GetExitCodeProcess(child.hProcess, &result);
    }
    CloseHandle(child.hProcess);
    CloseHandle(job);
    return (int)result;
}
