using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Channels;
using NexusRoom.Host.Core;

namespace NexusRoom.Host.Communication;

// Process loopback excludes this Host and its WebView/Chromium descendants.
// Endpoint loopback would send the other participants' voices back to them.
public static class WindowsScreenAudio
{
    public static bool Supported => OperatingSystem.IsWindowsVersionAtLeast(10, 0, 20348);

    public static async Task Stream(WebSocket socket, Action authorize, CancellationToken requestToken)
    {
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(requestToken);
        var token = stop.Token;
        var frames = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(8)
        {
            SingleReader = true, SingleWriter = true, FullMode = BoundedChannelFullMode.DropOldest
        });
        using var capture = new ProcessCapture();
        Task? producer = null, receiver = null;
        try
        {
            authorize();
            await capture.Start(token);
            authorize();
            await socket.SendAsync(Encoding.UTF8.GetBytes("{\"type\":\"ready\",\"sampleRate\":48000,\"channels\":1,\"encoding\":\"pcm16le\"}"), WebSocketMessageType.Text, true, token);
            receiver = Task.Run(async () =>
            {
                try
                {
                    var input = new byte[256];
                    while (socket.State == WebSocketState.Open && !token.IsCancellationRequested)
                    {
                        var result = await socket.ReceiveAsync(input, token);
                        if (result.MessageType == WebSocketMessageType.Close) break;
                        // This is a receive-only PCM stream. Do not accept commands.
                        if (result.Count > 0) break;
                    }
                }
                catch (Exception error) when (error is OperationCanceledException or WebSocketException) { }
                finally { stop.Cancel(); }
            }, CancellationToken.None);
            producer = Task.Run(async () =>
            {
                try
                {
                    while (!token.IsCancellationRequested)
                    {
                        authorize();
                        foreach (var frame in capture.Read()) frames.Writer.TryWrite(frame);
                        await Task.Delay(10, token);
                    }
                }
                catch (Exception error) { frames.Writer.TryComplete(error); return; }
                finally { frames.Writer.TryComplete(); }
            }, CancellationToken.None);
            await foreach (var frame in frames.Reader.ReadAllAsync(token))
            {
                authorize();
                // A slow local renderer must not retain unbounded audio or capture.
                using var send = CancellationTokenSource.CreateLinkedTokenSource(token);
                send.CancelAfter(TimeSpan.FromSeconds(2));
                await socket.SendAsync(frame, WebSocketMessageType.Binary, true, send.Token);
            }
        }
        catch (Exception error) when (error is OperationCanceledException or WebSocketException or COMException or InvalidCastException or TimeoutException or ApiException)
        {
            if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                using var close = new CancellationTokenSource(TimeSpan.FromSeconds(1));
                try { await socket.CloseOutputAsync(WebSocketCloseStatus.PolicyViolation, "设备声音共享已停止；系统采集不可用或会议已结束", close.Token); }
                catch (Exception closing) when (closing is WebSocketException or OperationCanceledException) { }
            }
        }
        finally
        {
            stop.Cancel();
            if (producer != null) try { await producer; } catch (OperationCanceledException) { }
            if (receiver != null) try { await receiver; } catch (OperationCanceledException) { }
        }
    }

    private sealed class ProcessCapture : IDisposable
    {
        private IAudioClient? client;
        private IAudioCaptureClient? reader;
        private readonly AutoResetEvent ready = new(false);
        public Task Start(CancellationToken token) => Task.Run(() => Initialize(token), token);
        private void Initialize(CancellationToken token)
        {
            Check(CoInitializeEx(IntPtr.Zero, 0));
            var parameters = Marshal.AllocHGlobal(12);
            try
            {
                Marshal.WriteInt32(parameters, 0, 1); // PROCESS_LOOPBACK activation
                Marshal.WriteInt32(parameters, 4, Environment.ProcessId);
                Marshal.WriteInt32(parameters, 8, 1); // EXCLUDE_TARGET_PROCESS_TREE
                var variant = new BlobVariant { Type = 65, Length = 12, Data = parameters }; // VT_BLOB
                var completion = new ActivationCompletion();
                var iid = typeof(IAudioClient).GUID;
                Check(ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, ref variant, completion, out var operation));
                try { client = (IAudioClient)completion.Result.Task.WaitAsync(TimeSpan.FromSeconds(6), token).GetAwaiter().GetResult(); }
                catch { completion.Abandon(); throw; }
                finally { if (Marshal.IsComObject(operation)) Marshal.ReleaseComObject(operation); }
            }
            finally { Marshal.FreeHGlobal(parameters); CoUninitialize(); }
            var format = new WaveFormat { Tag = 1, Channels = 1, Rate = 48000, BytesPerSecond = 96000, BlockAlign = 2, Bits = 16 };
            // Microsoft's ApplicationLoopback sample uses event mode, shared PCM
            // conversion and zero durations for this virtual activation endpoint.
            Check(client.Initialize(0, 0x80060000, 0, 0, ref format, IntPtr.Zero));
            var captureId = typeof(IAudioCaptureClient).GUID;
            Check(client.GetService(ref captureId, out var service));
            reader = (IAudioCaptureClient)service;
            Check(client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle()));
            Check(client.Start());
        }
        public IEnumerable<byte[]> Read()
        {
            if (reader == null) yield break;
            Check(reader.GetNextPacketSize(out var next));
            while (next > 0)
            {
                Check(reader.GetBuffer(out var data, out var count, out var flags, out _, out _));
                byte[] bytes;
                try
                {
                    bytes = new byte[checked((int)count * 2)];
                    if ((flags & 2) == 0 && bytes.Length > 0) Marshal.Copy(data, bytes, 0, bytes.Length);
                }
                finally { Check(reader.ReleaseBuffer(count)); }
                // Keep even an unusually large WASAPI packet below 20 ms/message.
                for (var offset = 0; offset < bytes.Length; offset += 1920)
                    yield return bytes.AsSpan(offset, Math.Min(1920, bytes.Length - offset)).ToArray();
                Check(reader.GetNextPacketSize(out next));
            }
        }
        public void Dispose()
        {
            if (client != null) client.Stop();
            if (reader != null && Marshal.IsComObject(reader)) Marshal.ReleaseComObject(reader);
            if (client != null && Marshal.IsComObject(client)) Marshal.ReleaseComObject(client);
            reader = null; client = null; ready.Dispose();
        }
    }
    private static void Check(int result) { if (result < 0) Marshal.ThrowExceptionForHR(result); }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class ActivationCompletion : IActivationCompletion, IAgileObject
    {
        public readonly TaskCompletionSource<object> Result = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int abandoned;
        public void Abandon()
        {
            if (Interlocked.Exchange(ref abandoned, 1) != 0) return;
            // WaitAsync cancellation does not cancel the native activation or
            // its TaskCompletionSource. Release a racing result, or make a late
            // completion release it instead of retaining an unused audio client.
            if (!Result.TrySetCanceled() && Result.Task.IsCompletedSuccessfully) ReleaseResult(Result.Task.Result);
        }
        public int ActivateCompleted(IActivationOperation operation)
        {
            object? value = null;
            try
            {
                var status = operation.GetActivateResult(out var result, out var activated);
                value = activated; Check(status); Check(result);
                if (Result.TrySetResult(value)) value = null;
            }
            catch (Exception error) { Result.TrySetException(error); }
            finally { if (value != null) ReleaseResult(value); }
            return 0;
        }
        private static void ReleaseResult(object value)
        {
            if (Marshal.IsComObject(value)) Marshal.ReleaseComObject(value);
        }
    }
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct BlobVariant
    {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public int Length;
        [FieldOffset(16)] public IntPtr Data;
    }
    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WaveFormat
    {
        public ushort Tag, Channels;
        public uint Rate, BytesPerSecond;
        public ushort BlockAlign, Bits, Extra;
    }
    [DllImport("Mmdevapi.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern int ActivateAudioInterfaceAsync(string devicePath, ref Guid iid, ref BlobVariant parameters,
        IActivationCompletion completion, out IActivationOperation operation);
    [ComVisible(true), Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivationCompletion { [PreserveSig] int ActivateCompleted(IActivationOperation operation); }
    [ComVisible(true), Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAgileObject { }
    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivationOperation { [PreserveSig] int GetActivateResult(out int result, [MarshalAs(UnmanagedType.IUnknown)] out object value); }
    [DllImport("ole32.dll")] private static extern int CoInitializeEx(IntPtr reserved, uint apartment);
    [DllImport("ole32.dll")] private static extern void CoUninitialize();
    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        [PreserveSig] int Initialize(int mode, uint flags, long duration, long periodicity, ref WaveFormat format, IntPtr session);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint frames);
        [PreserveSig] int IsFormatSupported(int mode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long normal, out long minimum);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }
    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong position, out ulong timestamp);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }
}
