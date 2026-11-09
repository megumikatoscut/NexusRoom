using System.Buffers.Binary;
using System.Diagnostics;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace NexusRoom.Host.Desktop;

// Only the default render endpoint is captured. No microphone is ever opened.
internal sealed class PcLoopbackAudio(Action<byte[]> emit, Action<bool, string> status, Stopwatch clock, Func<bool> allowed) : IDisposable
{
    private WasapiLoopbackCapture? capture;
    private MMDevice? device;
    private string deviceId = "";
    private long retryAt;
    private bool disposed;
    public void Refresh()
    {
        if (disposed) return;
        if (!allowed()) { Stop(); return; }
        if (clock.ElapsedMilliseconds < retryAt) return;
        try
        {
            using var enumerator = new MMDeviceEnumerator();
            var next = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            if (capture != null && deviceId == next.ID) { next.Dispose(); return; }
            Stop(); device = next; deviceId = next.ID;
            var current = new WasapiLoopbackCapture(next);
            capture = current;
            current.DataAvailable += (_, args) =>
            {
                if (disposed || !ReferenceEquals(capture, current) || !allowed()) return;
                try { Convert(args.Buffer, args.BytesRecorded, current.WaveFormat); }
                catch (Exception) { retryAt = clock.ElapsedMilliseconds + 3000; status(false, "系统音频格式暂不支持，画面仍可使用"); }
            };
            current.RecordingStopped += (_, args) =>
            {
                if (!disposed && ReferenceEquals(capture, current) && args.Exception != null)
                {
                    deviceId = ""; retryAt = clock.ElapsedMilliseconds + 3000;
                    status(false, "系统播放设备已变化，正在重新连接音频");
                }
            };
            current.StartRecording(); status(true, "");
        }
        catch (Exception)
        {
            Stop(); retryAt = clock.ElapsedMilliseconds + 3000;
            status(false, "没有可用的系统播放设备，画面仍可使用");
        }
    }
    private void Convert(byte[] source, int count, WaveFormat format)
    {
        var channels = format.Channels; var bytes = format.BitsPerSample / 8;
        var frames = count / format.BlockAlign;
        var floating = format.Encoding == WaveFormatEncoding.IeeeFloat || format is WaveFormatExtensible extensible && extensible.SubFormat == new Guid("00000003-0000-0010-8000-00aa00389b71");
        if (channels is < 1 or > 32 || bytes is < 2 or > 4 || floating && bytes != 4 || format.SampleRate is < 8000 or > 192000) throw new InvalidOperationException();
        var mono = new double[frames];
        for (var frame = 0; frame < frames; frame++)
        {
            double sample = 0;
            for (var channel = 0; channel < channels; channel++)
            {
                var at = frame * format.BlockAlign + channel * bytes;
                sample += floating ? BitConverter.ToSingle(source, at) : bytes switch
                {
                    2 => BinaryPrimitives.ReadInt16LittleEndian(source.AsSpan(at, 2)) / 32768.0,
                    3 => ((source[at] | source[at + 1] << 8 | source[at + 2] << 16) << 8 >> 8) / 8388608.0,
                    _ => BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(at, 4)) / 2147483648.0
                };
            }
            mono[frame] = double.IsFinite(sample) ? Math.Clamp(sample / channels, -1, 1) : 0;
        }
        // Normalize even 96/192 kHz render endpoints to the Android 48 kHz PCM
        // contract. Interpolate before PCM16 quantization rather than dropping.
        const int outputRate = 48000;
        var outputFrames = (int)Math.Round(frames * (double)outputRate / format.SampleRate);
        var start = Math.Max(0, clock.ElapsedTicks * 1_000_000 / Stopwatch.Frequency - frames * 1_000_000L / format.SampleRate);
        var chunkFrames = outputRate / 50;
        for (var offset = 0; offset < outputFrames; offset += chunkFrames)
        {
            var size = Math.Min(chunkFrames, outputFrames - offset);
            var pcm = new byte[size * 2];
            for (var frame = 0; frame < size; frame++)
            {
                var sourceAt = (offset + frame) * (double)format.SampleRate / outputRate;
                var low = Math.Min(frames - 1, (int)sourceAt); var high = Math.Min(frames - 1, low + 1);
                var value = mono[low] + (mono[high] - mono[low]) * (sourceAt - low);
                BinaryPrimitives.WriteInt16LittleEndian(pcm.AsSpan(frame * 2), (short)Math.Clamp(Math.Round(value * 32767), short.MinValue, short.MaxValue));
            }
            emit(PcRemoteService.Packet(2, start + offset * 1_000_000L / outputRate, outputRate, 1, pcm));
        }
    }
    private void Stop()
    {
        var old = capture; capture = null; deviceId = "";
        if (old != null) { try { old.StopRecording(); } catch { } old.Dispose(); }
        device?.Dispose(); device = null;
    }
    public void Dispose() { disposed = true; Stop(); }
}
