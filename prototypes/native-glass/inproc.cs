using System;
using System.Collections.Generic;
using System.Numerics;
using System.Runtime.InteropServices;
using Windows.UI.Composition;
using Windows.UI.Composition.Desktop;
using Microsoft.Graphics.Canvas.Effects;

[ComImport, Guid("29E691FA-4567-4DCA-B319-D0F207EB6807"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICompositorDesktopInterop {
    void CreateDesktopWindowTarget(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool topmost, out IntPtr target);
    void EnsureOnThread(uint threadId);
}

public static class NativeGlass {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct ACTCTX {
        public int size, flags;
        public string source;
        public ushort processorArchitecture, langId;
        public string assemblyDirectory, resourceName, applicationName;
        public IntPtr module;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateActCtx(ref ACTCTX ctx);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool ActivateActCtx(IntPtr ctx, out IntPtr cookie);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool DeactivateActCtx(uint flags, IntPtr cookie);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")]
    static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW", SetLastError=true)]
    static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int left,top,right,bottom; }
    [DllImport("user32.dll", SetLastError=true)]
    static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")]
    static extern uint GetDpiForWindow(IntPtr hwnd);
    [StructLayout(LayoutKind.Sequential)]
    struct DispatcherQueueOptions { public int size, threadType, apartmentType; }
    [DllImport("CoreMessaging.dll")]
    static extern int CreateDispatcherQueueController(DispatcherQueueOptions options, out IntPtr controller);
    static IntPtr queue, context;
    static Compositor compositor;
    static readonly Dictionary<long, object[]> windows = new Dictionary<long, object[]>();

    public static int Init(string argument) {
        IntPtr cookie=IntPtr.Zero;
        try {
            var parts=argument.Split('|');
            AppDomain.CurrentDomain.AssemblyResolve += (sender,eventArgs) => {
                System.IO.File.AppendAllText(parts[2],"assembly resolve: "+eventArgs.Name+"\n");
                if(eventArgs.Name.StartsWith("Microsoft.Graphics.Canvas")) return System.Reflection.Assembly.LoadFrom(System.IO.Path.Combine(System.IO.Path.GetDirectoryName(parts[1]),"Microsoft.Graphics.Canvas.winmd"));
                return null;
            };
            AppDomain.CurrentDomain.TypeResolve += (sender,eventArgs) => {
                System.IO.File.AppendAllText(parts[2],"type resolve: "+eventArgs.Name+"\n");
                if(eventArgs.Name.StartsWith("Microsoft.Graphics.Canvas")) return System.Reflection.Assembly.LoadFrom(System.IO.Path.Combine(System.IO.Path.GetDirectoryName(parts[1]),"Microsoft.Graphics.Canvas.winmd"));
                return null;
            };
            var hwnd=new IntPtr(long.Parse(parts[0]));
            var options=new DispatcherQueueOptions { size=Marshal.SizeOf(typeof(DispatcherQueueOptions)), threadType=2, apartmentType=2 };
            int hr=CreateDispatcherQueueController(options,out queue);
            System.IO.File.AppendAllText(parts[2],"queue="+hr.ToString("X8")+"\n");
            var ctx=new ACTCTX { size=Marshal.SizeOf(typeof(ACTCTX)), source=parts[1] };
            System.IO.File.AppendAllText(parts[2],"manifest="+parts[1]+"\n");
            context=CreateActCtx(ref ctx);
            if(context==new IntPtr(-1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            System.IO.File.AppendAllText(parts[2],"context created\n");
            if(!ActivateActCtx(context,out cookie)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            System.IO.File.AppendAllText(parts[2],"context activated\n");
            var nativeCanvas=LoadLibraryEx(System.IO.Path.Combine(System.IO.Path.GetDirectoryName(parts[1]),"Microsoft.Graphics.Canvas.dll"),IntPtr.Zero,0x00001100);
            if(nativeCanvas==IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            System.IO.File.AppendAllText(parts[2],"canvas loaded\n");
            compositor=new Compositor();
            Create(hwnd);
            System.IO.File.AppendAllText(parts[2],"success\n");
            return 0;
        } catch(Exception e) {
            try { System.IO.File.AppendAllText(argument.Split('|')[2],e.ToString()+"\n"); } catch {}
            return e.HResult;
        } finally {
            if(cookie!=IntPtr.Zero) DeactivateActCtx(0,cookie);
        }
    }
    static void Create(IntPtr hwnd) {
        if(windows.ContainsKey(hwnd.ToInt64())) throw new InvalidOperationException("Window already has a backdrop");
        var style=GetWindowLongPtr(hwnd,-20).ToInt64();
        SetWindowLongPtr(hwnd,-20,new IntPtr(style|0x00200000));
        var effect=new GaussianBlurEffect { Name="blur", BlurAmount=10, Source=new CompositionEffectSourceParameter("backdrop") };
        var factory=compositor.CreateEffectFactory(effect,new[]{"blur.BlurAmount"});
        var brush=factory.CreateBrush();
        brush.SetSourceParameter("backdrop",compositor.CreateBackdropBrush());
        int value=1;
        Marshal.ThrowExceptionForHR(DwmSetWindowAttribute(hwnd,17,ref value,4));
        IntPtr raw;
        ((ICompositorDesktopInterop)(object)compositor).CreateDesktopWindowTarget(hwnd,false,out raw);
        var target=(DesktopWindowTarget)Marshal.GetObjectForIUnknown(raw);
        Marshal.Release(raw);
        var visual=compositor.CreateSpriteVisual();
        visual.RelativeSizeAdjustment=new Vector2(1,1);
        visual.Brush=brush;
        var geometry=compositor.CreateRoundedRectangleGeometry();
        visual.Clip=compositor.CreateGeometricClip(geometry);
        target.Root=visual;
        windows[hwnd.ToInt64()]=new object[]{target,visual,brush,factory,style,geometry};
        UpdateGeometry(hwnd,geometry,false);
    }
    static void UpdateGeometry(IntPtr hwnd,CompositionRoundedRectangleGeometry geometry,bool maximized) {
        RECT rect;
        if(!GetClientRect(hwnd,out rect)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        geometry.Size=new Vector2(rect.right-rect.left,rect.bottom-rect.top);
        float radius=maximized ? 0 : 28f*GetDpiForWindow(hwnd)/96f;
        geometry.CornerRadius=new Vector2(radius,radius);
    }
    public static int Resize(string argument) {
        try {
            var parts=argument.Split('|');
            var hwnd=new IntPtr(long.Parse(parts[0]));
            UpdateGeometry(hwnd,(CompositionRoundedRectangleGeometry)windows[hwnd.ToInt64()][5],parts.Length>1 && parts[1]=="1");
            return 0;
        } catch(Exception error) { return error.HResult; }
    }
    public static int AddWindow(string argument) {
        IntPtr cookie=IntPtr.Zero;
        try {
            if(compositor==null) throw new InvalidOperationException("Native glass is not initialized");
            if(!ActivateActCtx(context,out cookie)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            Create(new IntPtr(long.Parse(argument)));
            return 0;
        } catch(Exception error) { return error.HResult; }
        finally { if(cookie!=IntPtr.Zero) DeactivateActCtx(0,cookie); }
    }
    public static int RemoveWindow(string argument) {
        try {
            long handle=long.Parse(argument);
            object[] state;
            if(!windows.TryGetValue(handle,out state)) return 0;
            ((DesktopWindowTarget)state[0]).Root=null;
            for(int i=1;i<4;i++) { var disposable=state[i] as IDisposable; if(disposable!=null) disposable.Dispose(); }
            for(int i=5;i<state.Length;i++) { var disposable=state[i] as IDisposable; if(disposable!=null) disposable.Dispose(); }
            var target=state[0] as IDisposable; if(target!=null) target.Dispose();
            SetWindowLongPtr(new IntPtr(handle),-20,new IntPtr((long)state[4]));
            windows.Remove(handle);
            return 0;
        } catch(Exception error) { return error.HResult; }
    }
    public static int SetBlur(string argument) {
        try {
            var parts=argument.Split('|');
            var brush=(CompositionEffectBrush)windows[long.Parse(parts[0])][2];
            brush.Properties.InsertScalar("blur.BlurAmount",float.Parse(parts[1],System.Globalization.CultureInfo.InvariantCulture));
            return 0;
        } catch(Exception error) { return error.HResult; }
    }
    public static int TestDisplacement(string log) {
        IntPtr localCookie=IntPtr.Zero;
        try {
            if(!ActivateActCtx(context,out localCookie)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            var effect=new DisplacementMapEffect {
                Source=new CompositionEffectSourceParameter("backdrop"),
                Displacement=new CompositionEffectSourceParameter("map"),
                Amount=10
            };
            var factory=compositor.CreateEffectFactory(effect);
            factory.Dispose();
            return 0;
        } catch(Exception error) {
            System.IO.File.AppendAllText(log,error.ToString()+"\n");
            return error.HResult;
        } finally {if(localCookie!=IntPtr.Zero) DeactivateActCtx(0,localCookie);}
    }
    public static int TestTransform(string log) {
        IntPtr localCookie=IntPtr.Zero;
        try {
            if(!ActivateActCtx(context,out localCookie)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            var effect=new Transform2DEffect {Source=new CompositionEffectSourceParameter("backdrop"),TransformMatrix=Matrix3x2.CreateScale(1.01f)};
            var factory=compositor.CreateEffectFactory(effect);
            factory.Dispose();
            return 0;
        } catch(Exception error) {
            System.IO.File.AppendAllText(log,error.ToString()+"\n");
            return error.HResult;
        } finally {if(localCookie!=IntPtr.Zero) DeactivateActCtx(0,localCookie);}
    }
}
