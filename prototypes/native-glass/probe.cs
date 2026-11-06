using System;
using System.Runtime.InteropServices;
using Windows.UI.Composition;
using Windows.Graphics.Effects;

[ComVisible(true)]
[Guid("2FC57384-A068-44D7-A331-30982FCF7177")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IGraphicsEffectD2D1Interop {
    Guid GetEffectId();
    void GetNamedPropertyMapping([MarshalAs(UnmanagedType.LPWStr)] string name, out uint index, out uint mapping);
    uint GetPropertyCount();
    [return: MarshalAs(UnmanagedType.IInspectable)] object GetProperty(uint index);
    uint GetSourceCount();
    [return: MarshalAs(UnmanagedType.IInspectable)] object GetSource(uint index);
}

[ComVisible(true)]
class BlurEffect : IGraphicsEffect, IGraphicsEffectSource, IGraphicsEffectD2D1Interop {
    public string Name { get; set; }
    public IGraphicsEffectSource Source { get; set; }
    public Guid GetEffectId() { return new Guid("1FEB6D69-2FE6-4AC9-8C58-1D7F93E7A6A5"); }
    public void GetNamedPropertyMapping(string name, out uint index, out uint mapping) { index = 0; mapping = 0; }
    public uint GetPropertyCount() { return 1; }
    public object GetProperty(uint index) { return 10f; }
    public uint GetSourceCount() { return 1; }
    public object GetSource(uint index) { return Source; }
}

class Probe {
    [StructLayout(LayoutKind.Sequential)]
    struct DispatcherQueueOptions { public int size, threadType, apartmentType; }
    [DllImport("CoreMessaging.dll")]
    static extern int CreateDispatcherQueueController(DispatcherQueueOptions options, out IntPtr controller);
    [STAThread]
    static void Main() {
      try {
        IntPtr queue;
        var options = new DispatcherQueueOptions { size = Marshal.SizeOf(typeof(DispatcherQueueOptions)), threadType = 2, apartmentType = 2 };
        Marshal.ThrowExceptionForHR(CreateDispatcherQueueController(options, out queue));
        Console.WriteLine("Creating compositor");
        var compositor = new Compositor();
        var effect = new BlurEffect { Name="blur", Source=new CompositionEffectSourceParameter("backdrop") };
        var factory = compositor.CreateEffectFactory(effect, new[] { "blur.BlurAmount" });
        var brush = factory.CreateBrush();
        brush.SetSourceParameter("backdrop", compositor.CreateHostBackdropBrush());
        Console.WriteLine("Composition effect created");
      } catch (Exception error) {
        Console.WriteLine("Failure: " + error.GetType().FullName + " HRESULT " + error.HResult.ToString("X8") + " " + error.Message);
        Environment.ExitCode = 1;
      }
    }
}
