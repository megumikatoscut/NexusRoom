using System.Diagnostics;
using System.Drawing.Imaging;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text.Json;
using System.Threading.Channels;
using NexusRoom.Host.Core;

namespace NexusRoom.Host.Communication;

// Keep Windows camera acquisition out of Chromium's device-selection service.
// Only JPEG frames cross the authenticated, process-owned loopback connection;
// the renderer sends its canvas track through the existing WebRTC camera slot.
internal static class WindowsCameraCapture
{
    internal static Func<CancellationToken, Task<bool>>? RequestConsent { get; set; }
    internal static bool Supported => OperatingSystem.IsWindows() && RequestConsent != null;
    private static readonly SemaphoreSlim DeviceGate = new(1, 1);
    private static IMoniker? cameraMoniker;

    internal static async Task Stream(WebSocket socket, Action authorize, CancellationToken aborted, Action<string> diagnostic)
    {
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(aborted);
        var token = stop.Token;
        var frames = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true, SingleWriter = true });
        var receiver = Task.Run(async () =>
        {
            try
            {
                var buffer = new byte[256];
                while (socket.State == WebSocketState.Open && !token.IsCancellationRequested)
                {
                    var message = await socket.ReceiveAsync(buffer, token);
                    if (message.MessageType == WebSocketMessageType.Close) break;
                    // This is a receive-only camera connection.
                    if (message.Count > 0) break;
                }
            }
            catch (Exception e) when (e is OperationCanceledException or WebSocketException) { if (e is WebSocketException) diagnostic(e.GetType().Name + ": " + e.Message); }
            finally { stop.Cancel(); }
        }, CancellationToken.None);
        Task? producer = null;
        var acquired = false;
        try
        {
            authorize();
            var consent = RequestConsent;
            if (consent == null || !await consent(token)) throw new ApiException(403, "摄像头权限未获批准，请在应用的媒体授权中选择允许后重试。");
            authorize(); token.ThrowIfCancellationRequested();
            // WebSocket.close() returns before the previous capture graph has
            // stopped. Allow a quick off/on toggle to await that release.
            acquired = await DeviceGate.WaitAsync(TimeSpan.FromSeconds(3), token);
            if (!acquired) throw new ApiException(409, "摄像头正在使用，请关闭摄像头后重试。");
            producer = Task.Run(() =>
            {
                try
                {
                    using var capture = new Capture(frame => frames.Writer.TryWrite(frame), error => frames.Writer.TryComplete(error));
                    capture.Start();
                    token.WaitHandle.WaitOne();
                }
                catch (Exception error) { frames.Writer.TryComplete(error); }
                finally { frames.Writer.TryComplete(); }
            }, CancellationToken.None);
            while (!token.IsCancellationRequested)
            {
                byte[] frame;
                using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(token))
                {
                    timeout.CancelAfter(TimeSpan.FromSeconds(10));
                    frame = await frames.Reader.ReadAsync(timeout.Token);
                }
                authorize();
                using var send = CancellationTokenSource.CreateLinkedTokenSource(token);
                send.CancelAfter(TimeSpan.FromSeconds(2));
                await socket.SendAsync(frame, WebSocketMessageType.Binary, true, send.Token);
            }
        }
        catch (Exception error) when (error is ApiException or COMException or ExternalException or InvalidOperationException or OperationCanceledException or WebSocketException or ChannelClosedException)
        {
            var cause = (error as ChannelClosedException)?.InnerException ?? error;
            if (!token.IsCancellationRequested) diagnostic(cause.GetType().Name + " (0x" + cause.HResult.ToString("X8") + "): " + cause.Message);
            if (!token.IsCancellationRequested && socket.State == WebSocketState.Open)
            {
                var message = cause is ApiException ? cause.Message : cause.HResult == unchecked((int)0x80070005)
                    ? "Windows 未允许摄像头访问，请在隐私设置中开启摄像头和桌面应用访问权限。"
                    : "摄像头暂时无法使用，请关闭其他占用它的应用并检查设备连接后重试。";
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(1));
                try { await socket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(new { type = "error", error = message }), WebSocketMessageType.Text, true, timeout.Token); }
                catch (Exception e) when (e is WebSocketException or OperationCanceledException) { }
            }
        }
        finally
        {
            stop.Cancel();
            if (producer != null) await producer;
            if (acquired) DeviceGate.Release();
            if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(1));
                try { await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "摄像头采集已停止", timeout.Token); }
                catch (Exception e) when (e is WebSocketException or OperationCanceledException) { }
            }
            await receiver;
        }
    }

    private sealed class Capture : IDisposable
    {
        private readonly List<object> objects = [];
        private readonly FrameCallback callback;
        private IMediaControl? control;
        private ISampleGrabber? grabber;
        public Capture(Action<byte[]> frame, Action<Exception> failure)
        {
            callback = new FrameCallback(frame, failure);
            try
            {
                var graphObject = Create("E436EBB3-524F-11CE-9F53-0020AF0BA770");
                var graph = (IGraphBuilder)graphObject; control = (IMediaControl)graphObject;
                var builder = (ICaptureGraphBuilder)Create("BF87B6E1-8C27-11D0-B3F0-00AA003761C5");
                Check(builder.SetFiltergraph(graph));
                var source = FindCamera(); Check(graph.AddFilter(source, "NexusRoom camera"));
                var sample = Create("C1F400A0-3F08-11D3-9F0B-006008039E37"); grabber = (ISampleGrabber)sample;
                Check(graph.AddFilter((IBaseFilter)sample, "NexusRoom frames"));
                var type = new MediaType { MajorType = new("73646976-0000-0010-8000-00AA00389B71"), SubType = new("E436EB7D-524F-11CE-9F53-0020AF0BA770"), FormatType = new("05589F80-C356-11CE-BF01-00AA0055595A") };
                Check(grabber.SetMediaType(type));
                var renderer = (IBaseFilter)Create("C1F400A4-3F08-11D3-9F0B-006008039E37"); Check(graph.AddFilter(renderer, "NexusRoom sink"));
                var category = new Guid("FB6C4281-0353-11D1-905F-0000C0CC16BA");
                Check(builder.RenderStream(ref category, ref type.MajorType, source, (IBaseFilter)sample, renderer));
                var connected = new MediaType();
                try
                {
                    Check(grabber.GetConnectedMediaType(connected));
                    if (connected.FormatType != type.FormatType || connected.FormatSize < 88 || connected.Format == IntPtr.Zero) throw new InvalidOperationException("摄像头输出格式不受支持");
                    var width = Marshal.ReadInt32(connected.Format, 52); var signedHeight = Marshal.ReadInt32(connected.Format, 56);
                    if (width < 1 || width > 4096 || signedHeight == int.MinValue || Math.Abs(signedHeight) > 2160 || signedHeight == 0 || Marshal.ReadInt16(connected.Format, 62) != 24) throw new InvalidOperationException("摄像头画面尺寸不受支持");
                    callback.Width = width; callback.Height = Math.Abs(signedHeight); callback.BottomUp = signedHeight > 0;
                }
                finally { connected.Free(); }
                Check(grabber.SetOneShot(false)); Check(grabber.SetBufferSamples(false)); Check(grabber.SetCallback(callback, 1));
            }
            catch { Dispose(); throw; }
        }
        public void Start() => Check(control!.Run());
        private object Create(string clsid)
        {
            var value = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid(clsid), true)!)!; objects.Add(value); return value;
        }
        private IBaseFilter FindCamera()
        {
            // The Windows device enumerator can temporarily drop a camera
            // after closing its capture graph. Rebind the known device rather
            // than depending on a second enumeration to rediscover it.
            if (cameraMoniker != null)
            {
                try
                {
                    var iid = typeof(IBaseFilter).GUID;
                    cameraMoniker.BindToObject(null!, null, ref iid, out var cached);
                    objects.Add(cached); return (IBaseFilter)cached;
                }
                catch (Exception error) when (error is COMException or IOException)
                {
                    Marshal.FinalReleaseComObject(cameraMoniker); cameraMoniker = null;
                }
            }
            var devices = (ICreateDevEnum)Create("62BE5D10-60EB-11D0-BD3B-00A0C911CE86");
            var category = new Guid("860BB310-5D01-11D0-BD3B-00A0C911CE86");
            Check(devices.CreateClassEnumerator(ref category, out var enumerator, 0));
            if (enumerator == null) throw new ApiException(409, "未找到可用的摄像头，请连接设备并检查系统设备设置。");
            try
            {
                var monikers = new IMoniker[1];
                if (enumerator.Next(1, monikers, IntPtr.Zero) != 0) throw new ApiException(409, "未找到可用的摄像头，请连接设备并检查系统设备设置。");
                try
                {
                    var iid = typeof(IBaseFilter).GUID;
                    monikers[0].BindToObject(null!, null, ref iid, out var source); cameraMoniker = monikers[0]; objects.Add(source); return (IBaseFilter)source;
                }
                finally { if (!ReferenceEquals(cameraMoniker, monikers[0])) Marshal.FinalReleaseComObject(monikers[0]); }
            }
            finally { Marshal.FinalReleaseComObject(enumerator); }
        }
        public void Dispose()
        {
            callback.Stopped = true;
            if (control != null) try { control.Stop(); } catch (COMException) { }
            if (grabber != null) try { grabber.SetCallback(null, 1); } catch (COMException) { }
            for (var i = objects.Count - 1; i >= 0; i--) Marshal.FinalReleaseComObject(objects[i]);
            objects.Clear(); control = null; grabber = null;
        }
        private static void Check(int result) { if (result < 0) Marshal.ThrowExceptionForHR(result); }
    }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    private sealed class FrameCallback(Action<byte[]> frame, Action<Exception> failure) : ISampleGrabberCallback
    {
        internal int Width, Height;
        internal bool BottomUp;
        internal volatile bool Stopped;
        private long lastFrame;
        public int SampleCB(double time, IntPtr sample) => 0;
        public int BufferCB(double time, IntPtr buffer, int length)
        {
            if (Stopped || buffer == IntPtr.Zero) return 0;
            var now = Stopwatch.GetTimestamp();
            if (now - lastFrame < Stopwatch.Frequency / 20) return 0;
            lastFrame = now;
            try
            {
                var stride = checked((Width * 3 + 3) & ~3);
                if (length < checked(stride * Height)) throw new InvalidOperationException("摄像头帧不完整");
                using var bitmap = new Bitmap(Width, Height, stride, PixelFormat.Format24bppRgb, buffer);
                using var image = new Bitmap(bitmap);
                if (BottomUp) image.RotateFlip(RotateFlipType.RotateNoneFlipY);
                using var bytes = new MemoryStream(); image.Save(bytes, ImageFormat.Jpeg);
                if (!Stopped) frame(bytes.ToArray());
            }
            catch (Exception error) { Stopped = true; failure(error); }
            return 0;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private sealed class MediaType
    {
        public Guid MajorType, SubType;
        [MarshalAs(UnmanagedType.Bool)] public bool FixedSizeSamples, TemporalCompression;
        public int SampleSize;
        public Guid FormatType;
        public IntPtr Unknown;
        public int FormatSize;
        public IntPtr Format;
        internal void Free() { if (Format != IntPtr.Zero) Marshal.FreeCoTaskMem(Format); if (Unknown != IntPtr.Zero) Marshal.Release(Unknown); Format = Unknown = IntPtr.Zero; }
    }
    [ComImport, Guid("29840822-5B84-11D0-BD3B-00A0C911CE86"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ICreateDevEnum { [PreserveSig] int CreateClassEnumerator(ref Guid category, out IEnumMoniker? enumerator, int flags); }
    [ComImport, Guid("56A86895-0AD4-11CE-B03A-0020AF0BA770"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IBaseFilter { }
    [ComImport, Guid("56A868A9-0AD4-11CE-B03A-0020AF0BA770"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IGraphBuilder
    {
        [PreserveSig] int AddFilter(IBaseFilter filter, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int RemoveFilter(IBaseFilter filter);
        [PreserveSig] int EnumFilters(out IntPtr filters);
        [PreserveSig] int FindFilterByName([MarshalAs(UnmanagedType.LPWStr)] string name, out IBaseFilter filter);
        [PreserveSig] int ConnectDirect(IntPtr output, IntPtr input, IntPtr type);
        [PreserveSig] int Reconnect(IntPtr pin);
        [PreserveSig] int Disconnect(IntPtr pin);
        [PreserveSig] int SetDefaultSyncSource();
    }
    [ComImport, Guid("93E5A4E0-2D50-11D2-ABFA-00A0C9C6E38D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ICaptureGraphBuilder
    {
        [PreserveSig] int SetFiltergraph(IGraphBuilder graph);
        [PreserveSig] int GetFiltergraph(out IGraphBuilder graph);
        [PreserveSig] int SetOutputFileName(ref Guid type, [MarshalAs(UnmanagedType.LPWStr)] string file, out IBaseFilter filter, out IntPtr sink);
        [PreserveSig] int FindInterface(ref Guid category, ref Guid type, IBaseFilter filter, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object value);
        [PreserveSig] int RenderStream(ref Guid category, ref Guid type, [MarshalAs(UnmanagedType.IUnknown)] object source, IBaseFilter compressor, IBaseFilter renderer);
    }
    [ComImport, Guid("56A868B1-0AD4-11CE-B03A-0020AF0BA770"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
    private interface IMediaControl
    {
        [PreserveSig] int Run();
        [PreserveSig] int Pause();
        [PreserveSig] int Stop();
    }
    [ComImport, Guid("6B652FFF-11FE-4FCE-92AD-0266B5D7C78F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ISampleGrabber
    {
        [PreserveSig] int SetOneShot([MarshalAs(UnmanagedType.Bool)] bool value);
        [PreserveSig] int SetMediaType([In] MediaType type);
        [PreserveSig] int GetConnectedMediaType([Out] MediaType type);
        [PreserveSig] int SetBufferSamples([MarshalAs(UnmanagedType.Bool)] bool value);
        [PreserveSig] int GetCurrentBuffer(ref int size, IntPtr buffer);
        [PreserveSig] int GetCurrentSample(out IntPtr sample);
        [PreserveSig] int SetCallback(ISampleGrabberCallback? callback, int method);
    }
    [ComVisible(true), Guid("0579154A-2B53-4994-B0D0-E773148EFF85"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ISampleGrabberCallback
    {
        [PreserveSig] int SampleCB(double time, IntPtr sample);
        [PreserveSig] int BufferCB(double time, IntPtr buffer, int length);
    }
}
