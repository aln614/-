using System;
using System.Runtime.InteropServices;
using Windows.UI.Composition;
using Windows.UI.Composition.Desktop;
using System.Numerics;
using System.Windows.Forms;
using Microsoft.Graphics.Canvas.Effects;

[ComImport, Guid("29E691FA-4567-4DCA-B319-D0F207EB6807"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICompositorDesktopInterop {
    void CreateDesktopWindowTarget(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool topmost, out IntPtr target);
    void EnsureOnThread(uint threadId);
}

class Probe {
    [StructLayout(LayoutKind.Sequential)]
    struct DispatcherQueueOptions { public int size, threadType, apartmentType; }
    [DllImport("CoreMessaging.dll")]
    static extern int CreateDispatcherQueueController(DispatcherQueueOptions options, out IntPtr controller);
    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
    [STAThread]
    static void Main(string[] args) {
      try {
        IntPtr queue;
        var options = new DispatcherQueueOptions { size = Marshal.SizeOf(typeof(DispatcherQueueOptions)), threadType = 2, apartmentType = 2 };
        Marshal.ThrowExceptionForHR(CreateDispatcherQueueController(options, out queue));
        Console.WriteLine("Creating compositor");
        var compositor = new Compositor();
        Console.WriteLine("Creating blur effect");
        var effect = new GaussianBlurEffect { Name="blur", BlurAmount=10, Source=new CompositionEffectSourceParameter("backdrop") };
        var factory = compositor.CreateEffectFactory(effect, new[] { "blur.BlurAmount" });
        var brush = factory.CreateBrush();
        brush.SetSourceParameter("backdrop", compositor.CreateBackdropBrush());
        Console.WriteLine("Composition effect created");
        if(args.Length == 0) return;
        var hwnd=new IntPtr(long.Parse(args[0]));
        int value=1;
        Console.WriteLine("DWM attribute: "+DwmSetWindowAttribute(hwnd,17,ref value,4));
        IntPtr raw;
        ((ICompositorDesktopInterop)(object)compositor).CreateDesktopWindowTarget(hwnd, false, out raw);
        var target=(DesktopWindowTarget)Marshal.GetObjectForIUnknown(raw);
        var visual=compositor.CreateSpriteVisual();
        visual.Size=new Vector2(800,600);
        visual.Brush=brush;
        target.Root=visual;
        Console.WriteLine("TARGET OK");
        Application.Run();
      } catch (Exception error) {
        Console.WriteLine("Failure: " + error.GetType().FullName + " HRESULT " + error.HResult.ToString("X8") + " " + error.Message);
        Environment.ExitCode = 1;
      }
    }
}
