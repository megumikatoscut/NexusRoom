using System.Threading.Channels;
using NAudio.Wave;
using SherpaOnnx;

namespace NexusRoom.Host.Voice;

public sealed record WindowsVoiceOptions(bool Enabled = false, bool WakeEnabled = false, string? RoomId = null, string? ProfileId = null, string? WorkspacePath = null);
public sealed record WindowsWakeEvent(string EventId, string RoomId, DateTimeOffset DetectedAt, WindowsVoiceOptions Options);
public sealed record WindowsVoiceTranscript(string EventId, string RoomId, string Text, bool Manual, DateTimeOffset DetectedAt, WindowsVoiceOptions Options);
public sealed record WindowsLocalWake(string EventId, string RoomId, DateTimeOffset DetectedAt);
public sealed record WindowsVoiceStatus(bool Enabled, bool WakeEnabled, bool Ready, string Phase, string? Error, string? RoomId, string? ProfileId, string? WorkspacePath, string? RecordingId, string? RecordingRoomId = null, WindowsLocalWake? LastWake = null);

/// <summary>
/// Optional local microphone engine. Native recognizers and microphone lifetimes are confined to
/// one worker; microphone events only copy bounded PCM frames. Exceptions never stop the Host.
/// Room task selection/arbitration is supplied by callbacks and stays outside this module.
/// </summary>
public sealed class WindowsVoiceService : BackgroundService
{
    private readonly OfflineVoiceModels models = new();
    private readonly ILogger<WindowsVoiceService> logger;
    private readonly Channel<Func<Task>> commands = Channel.CreateBounded<Func<Task>>(new BoundedChannelOptions(32) { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
    private readonly Channel<float[]> audio = Channel.CreateBounded<float[]>(new BoundedChannelOptions(128) { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
    private readonly Channel<WindowsVoiceTranscript> submissions = Channel.CreateBounded<WindowsVoiceTranscript>(new BoundedChannelOptions(4) { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
    private readonly Queue<float[]> preRoll = new();
    private readonly object statusLock = new();
    private WindowsVoiceOptions options = new();
    private WindowsVoiceStatus status;
    private WaveInEvent? microphone;
    private KeywordSpotter? spotter;
    private OnlineStream? keywordStream;
    private OnlineRecognizer? recognizer;
    private OnlineStream? speechStream;
    private WindowsWakeEvent? recording;
    private WindowsVoiceTranscript? lastManual;
    private WindowsLocalWake? lastWake;
    private bool manual;
    private WindowsVoiceActivity? activity;
    private int preRollSamples;
    private Exception? captureError;
    private DateTimeOffset retryAt, cooldownUntil, keywordStreamStarted, startedAt;
    private CancellationToken serviceToken;

    public WindowsVoiceService(ILogger<WindowsVoiceService> logger)
    {
        this.logger = logger;
        status = Snapshot("disabled", null);
    }

    /// <summary>Claim each wake before transcription; false rejects this event. Keep callback bounded.</summary>
    public Func<WindowsWakeEvent, Task<bool>>? WakeDetected { get; set; }
    /// <summary>Called once per completed wake recording. Existing Room Agent routing owns execution.</summary>
    public Func<WindowsVoiceTranscript, Task>? WakeTranscript { get; set; }
    /// <summary>Local presentation only; never raised by another Room device or an Agent result.</summary>
    public event Action<WindowsLocalWake>? LocalWake;
    public WindowsVoiceStatus GetStatus() { lock (statusLock) return status; }

    public Task<WindowsVoiceStatus> ConfigureAsync(WindowsVoiceOptions updated) => Post(async () =>
    {
        updated = updated with { RoomId = updated.RoomId?.Trim(), ProfileId = updated.ProfileId?.Trim() };
        if (options == updated && GetStatus().Phase != "error") return GetStatus();
        // Cancel on Room/profile changes: a pending voice must never cross to a different Room.
        if (options != updated) CancelRecording();
        options = updated;
        if (!options.Enabled)
        {
            StopMicrophone(); ReleaseModels(); lastManual = null;
            Publish("disabled", null);
        }
        else
        {
            try
            {
                if (!models.Ready) throw new InvalidOperationException("本地语音模型未安装，请重新安装完整客户端。");
                if (options.WakeEnabled && !string.IsNullOrWhiteSpace(options.RoomId)) StartListening();
                else { StopMicrophone(); ReleaseKeywordSpotter(); Publish("idle", null); }
            }
            catch (Exception error) { Fail(error); throw; }
        }
        await Task.CompletedTask;
        return GetStatus();
    });

    public Task<string> BeginManualAsync(string roomId) => Post(async () =>
    {
        if (!options.Enabled) throw new InvalidOperationException("请先开启本地语音功能。");
        if (string.IsNullOrWhiteSpace(roomId)) throw new InvalidOperationException("请先选择 Room。");
        if (recording != null) throw new InvalidOperationException("麦克风正在录音，请先完成当前语音。");
        DrainAudio(); preRoll.Clear(); preRollSamples = 0;
        lastManual = null;
        try
        {
            // Capture immediately on press: native ASR model initialization may take time,
            // and the bounded PCM queue retains the beginning spoken during that load.
            StartMicrophone();
            BeginRecording(new WindowsWakeEvent(Guid.NewGuid().ToString("N"), roomId, DateTimeOffset.UtcNow, options with { RoomId = roomId }), true);
        }
        catch (Exception error) { Fail(error); throw; }
        await Task.CompletedTask;
        return recording!.EventId;
    });

    public Task<WindowsVoiceTranscript> EndManualAsync(string? recordingId = null, string? expectedRoom = null) => Post(async () =>
    {
        if (recording == null && lastManual != null && (recordingId == null || recordingId == lastManual.EventId))
        {
            EnsureRoom(lastManual.RoomId, expectedRoom);
            return lastManual;
        }
        EnsureManual(recordingId);
        EnsureRoom(recording!.RoomId, expectedRoom);
        // Consume frames already captured before the pointer release before finalizing the decoder.
        try
        {
            StopMicrophone(discardAudio: false);
            while (audio.Reader.TryRead(out var frame)) AcceptSpeech(frame);
            var result = await FinishRecording();
            return result ?? throw new InvalidOperationException("录音已取消。");
        }
        catch (Exception error) { Fail(error); throw; }
    });

    public Task CancelManualAsync(string? recordingId = null, string? expectedRoom = null) => Post(async () =>
    {
        if (recording != null && manual && (recordingId == null || recording.EventId == recordingId))
        {
            EnsureRoom(recording.RoomId, expectedRoom);
            CancelRecording();
        }
        await Task.CompletedTask;
        return true;
    });

    private void EnsureManual(string? recordingId)
    {
        if (recording == null || !manual || (recordingId != null && recording.EventId != recordingId))
            throw new InvalidOperationException("录音已结束或不属于当前输入框，请重新长按录音。");
    }
    private static void EnsureRoom(string room, string? expectedRoom)
    {
        if (expectedRoom != null && room != expectedRoom) throw new InvalidOperationException("录音不属于当前房间。");
    }

    private Task<T> Post<T>(Func<Task<T>> action)
    {
        var completion = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!commands.Writer.TryWrite(async () =>
        {
            try { completion.TrySetResult(await action()); }
            catch (Exception error)
            {
                completion.TrySetException(new InvalidOperationException(Describe(error), error));
            }
        })) completion.TrySetException(new InvalidOperationException("语音服务已关闭或请求过于频繁，请稍后重试。"));
        return completion.Task;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        serviceToken = stoppingToken;
        var submissionWorker = DispatchSubmissions(stoppingToken);
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    // Control commands win over PCM, so disable/cancel cannot starve behind audio.
                    while (commands.Reader.TryRead(out var command)) await command();
                    var failure = Interlocked.Exchange(ref captureError, null);
                    if (failure != null) throw failure;
                    var processed = 0;
                    while (processed++ < 12 && audio.Reader.TryRead(out var frame)) await ProcessAudio(frame);
                    if (recording != null && DateTimeOffset.UtcNow - startedAt > TimeSpan.FromSeconds(45)) await FinishRecording();
                    if (options.Enabled && options.WakeEnabled && !string.IsNullOrWhiteSpace(options.RoomId) && microphone == null && DateTimeOffset.UtcNow >= retryAt) StartListening();
                    // A timer also catches missing microphone callbacks and permits recovery.
                    await Task.Delay(20, stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
                catch (Exception error) { Fail(error); }
            }
        }
        finally
        {
            commands.Writer.TryComplete();
            // Resolve queued callers on shutdown; do not leave hanging HTTP requests.
            while (commands.Reader.TryRead(out var command)) await command();
            CancelRecording(); StopMicrophone(); ReleaseModels();
            submissions.Writer.TryComplete();
            await submissionWorker;
        }
    }

    private async Task ProcessAudio(float[] samples)
    {
        if (speechStream != null)
        {
            AcceptSpeech(samples);
            if (!manual && activity!.Complete) await FinishRecording();
            else if (!manual && activity!.HasSpeech && recognizer!.IsEndpoint(speechStream)) await FinishRecording();
            else if (manual && activity!.Elapsed >= 40) await FinishRecording();
            return;
        }
        if (!options.Enabled || !options.WakeEnabled || keywordStream == null || DateTimeOffset.UtcNow < cooldownUntil) return;
        AddPreRoll(samples);
        keywordStream.AcceptWaveform(OfflineVoiceModels.SampleRate, samples);
        while (spotter!.IsReady(keywordStream)) spotter.Decode(keywordStream);
        if (!string.IsNullOrWhiteSpace(spotter!.GetResult(keywordStream).Keyword))
        {
            var wake = new WindowsWakeEvent(Guid.NewGuid().ToString("N"), options.RoomId!, DateTimeOffset.UtcNow, options);
            ResetKeywordStream();
            Publish("arbitrating", null);
            var accepted = WakeDetected != null && await WakeDetected(wake).WaitAsync(TimeSpan.FromSeconds(4), serviceToken);
            if (accepted)
            {
                BeginRecording(wake, false);
                // KWS confirmation and model loading can occur after command speech has begun.
                // A bounded 400 ms tail protects that beginning without keeping raw audio history.
                foreach (var frame in preRoll) AcceptSpeech(frame, observeActivity: false);
                preRoll.Clear(); preRollSamples = 0;
            }
            else { cooldownUntil = DateTimeOffset.UtcNow.AddSeconds(1); Publish("listening", null); }
        }
        else if (DateTimeOffset.UtcNow - keywordStreamStarted > TimeSpan.FromMinutes(5)) ResetKeywordStream();
    }

    private void BeginRecording(WindowsWakeEvent wake, bool isManual)
    {
        recording = wake; manual = isManual; activity = new WindowsVoiceActivity(); startedAt = DateTimeOffset.UtcNow;
        if (!isManual) lastWake = new(wake.EventId, wake.RoomId, wake.DetectedAt);
        Publish(isManual ? "recording-manual" : "recording-wake", null);
        if (!isManual)
        {
            // Presentation must not delay capture or make an otherwise valid wake fail.
            try { LocalWake?.Invoke(lastWake!); }
            catch (Exception error) { logger.LogWarning("Local voice presentation failed: {Error}", error.GetType().Name); }
        }
        recognizer ??= models.CreateRecognizer();
        speechStream = recognizer.CreateStream();
        if (speechStream.Handle == IntPtr.Zero) throw new InvalidOperationException("本地 ASR 初始化失败。");
    }

    private void AcceptSpeech(float[] samples, bool observeActivity = true)
    {
        if (speechStream == null) return;
        speechStream.AcceptWaveform(OfflineVoiceModels.SampleRate, samples);
        while (recognizer!.IsReady(speechStream)) recognizer.Decode(speechStream);
        if (observeActivity) activity!.Observe(samples);
    }

    private async Task<WindowsVoiceTranscript?> FinishRecording()
    {
        if (recording == null || speechStream == null) return null;
        var wake = recording;
        var wasManual = manual;
        Publish("transcribing", null);
        speechStream.AcceptWaveform(OfflineVoiceModels.SampleRate, new float[OfflineVoiceModels.SampleRate / 2]);
        speechStream.InputFinished();
        while (recognizer!.IsReady(speechStream)) recognizer.Decode(speechStream);
        var text = recognizer!.GetResult(speechStream).Text.Trim();
        if (!wasManual) text = activity?.HasSpeech == true ? StripWakePhrase(text) : "";
        var result = new WindowsVoiceTranscript(wake.EventId, wake.RoomId, text, wasManual, wake.DetectedAt, wake.Options);
        speechStream.Dispose(); speechStream = null; recording = null; activity = null;
        recognizer.Dispose(); recognizer = null; // larger ASR model is absent during idle KWS listening
        if (wasManual) lastManual = result;
        if (options.Enabled && options.WakeEnabled && !string.IsNullOrWhiteSpace(options.RoomId))
        {
            ResetKeywordStream(); StartMicrophone(); cooldownUntil = DateTimeOffset.UtcNow.AddSeconds(1); Publish("listening", null);
        }
        else { StopMicrophone(); Publish(options.Enabled ? "idle" : "disabled", null); }
        if (!wasManual && !string.IsNullOrWhiteSpace(text) && WakeTranscript != null && !submissions.Writer.TryWrite(result))
        {
            Publish(GetStatus().Phase, "Room 语音任务排队已满，请稍后重试。");
        }
        await Task.CompletedTask;
        return result;
    }

    private async Task DispatchSubmissions(CancellationToken stoppingToken)
    {
        try
        {
            await foreach (var transcript in submissions.Reader.ReadAllAsync(stoppingToken))
            {
                // A Room/profile change or disabling wake invalidates local
                // recordings that have not yet been submitted to the Room.
                if (options != transcript.Options || !options.Enabled || !options.WakeEnabled) continue;
                // LLM intent selection and Room submission never block microphone/control processing.
                try
                {
                    var submit = WakeTranscript;
                    if (submit != null) await submit(transcript).WaitAsync(TimeSpan.FromSeconds(30), stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
                catch (Exception error)
                {
                    logger.LogWarning("Voice Room submission failed: {Error}", error.GetType().Name);
                    lock (statusLock) status = status with { Error = "语音已转写，但 Room 任务提交失败：" + Describe(error) };
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }

    public static string StripWakePhrase(string text) => System.Text.RegularExpressions.Regex.Replace(text,
        @"^\s*(?:(?:hi|high|hey|嗨|海)\s*[,，]?\s*)?(?:nexus|next\s+(?:is|us))\s*[,，。.!！:：]?\s*", "", System.Text.RegularExpressions.RegexOptions.IgnoreCase).Trim();

    private void StartListening()
    {
        if (serviceToken.IsCancellationRequested) return;
        spotter ??= models.CreateKeywordSpotter();
        if (keywordStream == null) ResetKeywordStream();
        StartMicrophone(); Publish("listening", null);
    }

    private void StartMicrophone()
    {
        if (serviceToken.IsCancellationRequested) throw new InvalidOperationException("语音服务已关闭。");
        if (microphone != null) return;
        if (WaveInEvent.DeviceCount == 0) throw new InvalidOperationException("没有可用麦克风，请连接麦克风并允许 Windows 桌面应用访问麦克风。");
        var capture = new WaveInEvent { DeviceNumber = -1, WaveFormat = new WaveFormat(OfflineVoiceModels.SampleRate, 16, 1), BufferMilliseconds = 40, NumberOfBuffers = 3 };
        capture.DataAvailable += (_, e) =>
        {
            if (microphone != capture || e.BytesRecorded < 2) return;
            var samples = new float[e.BytesRecorded / 2];
            for (var i = 0; i < samples.Length; i++) samples[i] = (short)(e.Buffer[i * 2] | e.Buffer[i * 2 + 1] << 8) / 32768F;
            if (!audio.Writer.TryWrite(samples)) Interlocked.CompareExchange(ref captureError, new InvalidOperationException("本地语音处理负载过高，录音已停止，请重试。"), null);
        };
        capture.RecordingStopped += (_, e) =>
        {
            if (microphone == capture) Interlocked.CompareExchange(ref captureError, e.Exception ?? new InvalidOperationException("麦克风采集已意外停止。"), null);
        };
        microphone = capture;
        try { capture.StartRecording(); }
        catch { microphone = null; capture.Dispose(); throw; }
    }

    private void StopMicrophone(bool discardAudio = true)
    {
        var capture = microphone; microphone = null;
        if (capture != null)
        {
            try { capture.StopRecording(); } catch { }
            capture.Dispose();
        }
        if (discardAudio) { DrainAudio(); preRoll.Clear(); preRollSamples = 0; }
    }

    private void CancelRecording()
    {
        speechStream?.Dispose(); speechStream = null; recognizer?.Dispose(); recognizer = null;
        recording = null; activity = null;
        DrainAudio(); preRoll.Clear(); preRollSamples = 0;
        if (!options.Enabled || !options.WakeEnabled) StopMicrophone();
        else if (spotter != null) ResetKeywordStream();
        Publish(options.Enabled ? (microphone == null ? "idle" : "listening") : "disabled", null);
    }

    private void ResetKeywordStream()
    {
        keywordStream?.Dispose(); keywordStream = spotter?.CreateStream(); keywordStreamStarted = DateTimeOffset.UtcNow;
        if (keywordStream != null && keywordStream.Handle == IntPtr.Zero) throw new InvalidOperationException("本地 KWS 初始化失败。");
    }
    private void ReleaseKeywordSpotter() { keywordStream?.Dispose(); keywordStream = null; spotter?.Dispose(); spotter = null; }
    private void ReleaseModels() { speechStream?.Dispose(); speechStream = null; recognizer?.Dispose(); recognizer = null; ReleaseKeywordSpotter(); }
    private void DrainAudio() { while (audio.Reader.TryRead(out _)) { } }
    private void AddPreRoll(float[] samples)
    {
        preRoll.Enqueue(samples); preRollSamples += samples.Length;
        while (preRollSamples > OfflineVoiceModels.SampleRate * 0.4 && preRoll.Count > 1) preRollSamples -= preRoll.Dequeue().Length;
    }
    private void Fail(Exception error)
    {
        try { CancelRecording(); StopMicrophone(); ReleaseModels(); } catch { }
        retryAt = DateTimeOffset.UtcNow.AddSeconds(5);
        Publish("error", Describe(error));
        logger.LogWarning("Local microphone engine failed: {Error}", error.GetType().Name);
    }
    private WindowsVoiceStatus Snapshot(string phase, string? error) => new(options.Enabled, options.WakeEnabled, models.Ready, phase, error, options.RoomId, options.ProfileId, options.WorkspacePath, recording?.EventId, recording?.RoomId, lastWake);
    private void Publish(string phase, string? error) { lock (statusLock) status = Snapshot(phase, error); }
    private static string Describe(Exception error) => error switch
    {
        DllNotFoundException or BadImageFormatException or EntryPointNotFoundException => "离线语音原生运行库缺失或版本不匹配，请重新安装完整客户端。",
        NAudio.MmException => "无法使用麦克风。请检查 Windows 隐私设置、麦克风权限及占用麦克风的应用。",
        TimeoutException => "语音唤醒或任务提交超时，请检查 Room 连接。",
        _ => error.Message
    };
}
