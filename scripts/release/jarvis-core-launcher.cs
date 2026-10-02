// M10 Phase 6 — Windows sidecar launcher (REAL .exe, compiled with csc at packaging).
// A batch script renamed .exe cannot be spawned by CreateProcess
// (ERROR_BAD_EXE_FORMAT) — confirmed by the Windows clean-machine E2E (M10):
// the app's sidecar spawn failed and the core never started.
//
// Responsibilities (mirrors packages/core/scripts/build-core-runtime.mts's .cmd):
//   - locate node (PATH, then Program Files, then LocalAppData\Programs)
//   - run core-runtime/server.js with NODE_PATH=core-runtime/node_modules
//   - orphan safety: the launcher puts node in a Job Object with
//     KILL_ON_JOB_CLOSE — when the app force-kills this launcher, the job
//     closes and node + every task process it spawned is terminated.
//     (No app-side changes needed: lib.rs already child.kill()s the launcher.)
//
// Targets .NET Framework 4.x (present on all supported Windows versions).
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

class JarvisCoreLauncher
{
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr a, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr hJob, int infoType, IntPtr lpInfo, int cbInfo);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    static int Main(string[] args)
    {
        string exe = Process.GetCurrentProcess().MainModule.FileName;
        string dir = Path.GetDirectoryName(exe);
        string serverJs = Path.Combine(dir, "core-runtime", "server.js");
        if (!File.Exists(serverJs))
        {
            Console.Error.WriteLine("JARVIS core runtime not found next to the sidecar");
            return 1;
        }
        string node = FindNode();
        if (node == null)
        {
            Console.Error.WriteLine("node not found — install Node.js");
            return 1;
        }

        // Job object: kill-on-close so the whole node tree dies with this launcher.
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        var basic = new JOBOBJECT_BASIC_LIMIT_INFORMATION { LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE };
        var ext = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION { BasicLimitInformation = basic };
        IntPtr ptr = Marshal.AllocHGlobal(Marshal.SizeOf(ext));
        Marshal.StructureToPtr(ext, ptr, false);
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, Marshal.SizeOf(ext));
        Marshal.FreeHGlobal(ptr);

        var psi = new ProcessStartInfo
        {
            FileName = node,
            Arguments = "\"" + serverJs + "\"" + (args.Length > 0 ? " " + string.Join(" ", args) : ""),
            UseShellExecute = false,
        };
        string nm = Path.Combine(dir, "core-runtime", "node_modules");
        string existing = Environment.GetEnvironmentVariable("NODE_PATH") ?? "";
        psi.EnvironmentVariables["NODE_PATH"] = existing.Length > 0 ? nm + ";" + existing : nm;

        var p = Process.Start(psi);
        if (p == null)
        {
            Console.Error.WriteLine("node spawn failed");
            return 1;
        }
        AssignProcessToJobObject(job, p.Handle);
        p.WaitForExit();
        return p.ExitCode;
    }

    static string FindNode()
    {
        foreach (var d in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            if (string.IsNullOrWhiteSpace(d)) continue;
            string c = Path.Combine(d.Trim(), "node.exe");
            if (File.Exists(c)) return c;
        }
        string pf = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        if (File.Exists(pf)) return pf;
        string lf = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Programs", "nodejs", "node.exe");
        return File.Exists(lf) ? lf : null;
    }
}
