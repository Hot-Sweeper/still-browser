using System.Diagnostics;
using System.Runtime.InteropServices;

namespace FocusSlots.MouseNavigation;

internal static class Program
{
    private const int WhMouseLowLevel = 14;
    private const int WmQuit = 0x0012;
    private const int WmXButtonDown = 0x020B;
    private const int WmMouseWheel = 0x020A;
    private const int VkMenu = 0x12;
    private const int VkControl = 0x11;
    private const int VkLWin = 0x5B;
    private const int VkRWin = 0x5C;
    private const int DwmwaBorderColor = 34;
    private const uint XButton1 = 1;
    private const uint XButton2 = 2;
    private const uint OledBlack = 0x00000000;

    private static readonly LowLevelMouseProc MouseProc = HandleMouse;
    private static IntPtr _mouseHook;
    private static uint _messageThreadId;
    private static Timer? _parentTimer;
    private static int _parentProcessId;
    private static IntPtr _styledWindow;

    private static int Main(string[] args)
    {
        _messageThreadId = GetCurrentThreadId();
        if (args.Length > 0 && int.TryParse(args[0], out var parentPid))
        {
            _parentProcessId = parentPid;
            StyleParentWindow(parentPid);
            _parentTimer = new Timer(_ => MonitorParent(parentPid), null, 250, 1000);
        }

        var module = GetModuleHandle(null);
        _mouseHook = SetMouseHook(WhMouseLowLevel, MouseProc, module, 0);
        if (_mouseHook == IntPtr.Zero)
        {
            if (_mouseHook != IntPtr.Zero) UnhookWindowsHookEx(_mouseHook);
            _parentTimer?.Dispose();
            return 2;
        }

        while (GetMessage(out var message, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref message);
            DispatchMessage(ref message);
        }

        _parentTimer?.Dispose();
        UnhookWindowsHookEx(_mouseHook);
        return 0;
    }

    private static void MonitorParent(int parentPid)
    {
        try
        {
            using var parent = Process.GetProcessById(parentPid);
            if (!parent.HasExited)
            {
                StyleParentWindow(parent);
                return;
            }
        }
        catch
        {
            // A missing process means the Electron parent has already exited.
        }

        PostThreadMessage(_messageThreadId, WmQuit, UIntPtr.Zero, IntPtr.Zero);
    }

    private static void StyleParentWindow(int parentPid)
    {
        try
        {
            using var parent = Process.GetProcessById(parentPid);
            StyleParentWindow(parent);
        }
        catch
        {
            // The first attempt can run before Electron has created its window.
        }
    }

    private static void StyleParentWindow(Process parent)
    {
        parent.Refresh();
        var window = parent.MainWindowHandle;
        if (window == IntPtr.Zero || window == _styledWindow) return;
        var borderColor = OledBlack;
        if (DwmSetWindowAttribute(window, DwmwaBorderColor, ref borderColor, sizeof(uint)) == 0)
        {
            _styledWindow = window;
        }
    }

    private static IntPtr HandleMouse(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0 && message.ToInt32() == WmXButtonDown)
        {
            var mouse = Marshal.PtrToStructure<MsllHookStruct>(data);
            var button = (mouse.MouseData >> 16) & 0xffff;
            if (button == XButton1) Console.WriteLine("back");
            if (button == XButton2) Console.WriteLine("forward");
            Console.Out.Flush();
        }

        if (code >= 0 && message.ToInt32() == WmMouseWheel && IsParentForeground())
        {
            var mouse = Marshal.PtrToStructure<MsllHookStruct>(data);
            var delta = unchecked((short)((mouse.MouseData >> 16) & 0xffff));
            var alt = GetAsyncKeyState(VkMenu) < 0;
            var control = GetAsyncKeyState(VkControl) < 0;
            var windows = GetAsyncKeyState(VkLWin) < 0 || GetAsyncKeyState(VkRWin) < 0;
            if (delta != 0 && !windows && control)
            {
                var direction = delta > 0 ? -1 : 1;
                Console.WriteLine($"{(alt ? "ctrl-alt" : "ctrl")}-wheel:{direction}");
                Console.Out.Flush();
                return (IntPtr)1;
            }
        }

        return CallNextHookEx(_mouseHook, code, message, data);
    }

    private static bool IsParentForeground()
    {
        if (_parentProcessId <= 0) return false;
        var foreground = GetForegroundWindow();
        if (foreground == IntPtr.Zero) return false;
        GetWindowThreadProcessId(foreground, out var processId);
        return processId == unchecked((uint)_parentProcessId);
    }

    private delegate IntPtr LowLevelMouseProc(int code, IntPtr message, IntPtr data);

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MsllHookStruct
    {
        public Point Position;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public IntPtr Window;
        public uint Value;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public Point Position;
        public uint Private;
    }

    [DllImport("user32.dll", EntryPoint = "SetWindowsHookExW", SetLastError = true)]
    private static extern IntPtr SetMouseHook(int hookId, LowLevelMouseProc callback, IntPtr module, uint threadId);

    [DllImport("user32.dll")]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out Message message, IntPtr window, uint minimum, uint maximum);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref Message message);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref Message message);

    [DllImport("user32.dll")]
    private static extern bool PostThreadMessage(uint threadId, int message, UIntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? moduleName);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int virtualKey);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref uint value, int size);
}
