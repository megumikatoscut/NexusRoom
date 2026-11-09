using System.Diagnostics;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using NAudio.Wave;
using NexusRoom.Host.Voice;
using SherpaOnnx;

static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
static float[] Read(string path)
{
    using var reader = new WaveFileReader(path);
    Require(reader.WaveFormat.Encoding == WaveFormatEncoding.Pcm && reader.WaveFormat.SampleRate == 16000 && reader.WaveFormat.BitsPerSample == 16 && reader.WaveFormat.Channels == 1, "Fixture must be 16 kHz mono PCM16.");
    var bytes = new byte[reader.Length];
    reader.ReadExactly(bytes);
    return Enumerable.Range(0, bytes.Length / 2).Select(i => (short)(bytes[i * 2] | bytes[i * 2 + 1] << 8) / 32768F).ToArray();
}
static int WakeCount(OfflineVoiceModels models, float[] audio)
{
    using var spotter = models.CreateKeywordSpotter();
    using var stream = spotter.CreateStream();
    var hits = 0;
    foreach (var chunk in audio.Concat(new float[16000]).Chunk(640))
    {
        stream.AcceptWaveform(16000, chunk);
        while (spotter.IsReady(stream))
        {
            spotter.Decode(stream);
            if (spotter.GetResult(stream).Keyword.Length > 0) { hits++; spotter.Reset(stream); }
        }
    }
    return hits;
}
static string WakeTranscribe(OfflineVoiceModels models, float[] audio)
{
    using var spotter = models.CreateKeywordSpotter();
    using var keyword = spotter.CreateStream();
    using var recognizer = models.CreateRecognizer();
    OnlineStream? speech = null;
    var preRoll = new Queue<float[]>();
    try
    {
        foreach (var chunk in audio.Chunk(640))
        {
            if (speech == null)
            {
                preRoll.Enqueue(chunk);
                while (preRoll.Count > 10) preRoll.Dequeue(); // real Windows 400 ms wake tail
                keyword.AcceptWaveform(16000, chunk);
                while (spotter.IsReady(keyword)) spotter.Decode(keyword);
                if (spotter.GetResult(keyword).Keyword.Length > 0)
                {
                    speech = recognizer.CreateStream();
                    foreach (var buffered in preRoll) speech.AcceptWaveform(16000, buffered);
                }
            }
            else speech.AcceptWaveform(16000, chunk);
            if (speech != null) while (recognizer.IsReady(speech)) recognizer.Decode(speech);
        }
        Require(speech != null, "KWS did not start the ASR pipeline.");
        speech!.AcceptWaveform(16000, new float[8000]); speech.InputFinished();
        while (recognizer.IsReady(speech)) recognizer.Decode(speech);
        return WindowsVoiceService.StripWakePhrase(recognizer.GetResult(speech).Text);
    }
    finally { speech?.Dispose(); }
}

try
{
    Require(args.Length >= 3, "Provide English wake, Chinese command and negative WAV fixtures.");
    var models = new OfflineVoiceModels();
    Require(models.Ready, "Published/copied voice models are missing.");
    var clock = Stopwatch.StartNew();
    var englishAudio = Read(args[0]);
    if (args.Contains("--presentation")) await VoicePresentationChecks.Run(models, englishAudio);
    var chineseAudio = Read(args[1]);
    var negativeAudio = Read(args[2]);
    var english = models.Transcribe(englishAudio);
    var chinese = models.Transcribe(chineseAudio);
    var wakeHits = WakeCount(models, englishAudio);
    var negativeHits = WakeCount(models, negativeAudio);
    var wakeCommand = WakeTranscribe(models, englishAudio);
    Require(!string.IsNullOrWhiteSpace(english) && english.Contains("COMPUTER", StringComparison.OrdinalIgnoreCase), "English ASR did not decode the command target: " + english);
    Require(chinese.Contains("电脑") && chinese.Contains("记事本"), "Chinese ASR did not decode the command target: " + chinese);
    Require(wakeHits >= 1, "Hi Nexus KWS fixture was not detected.");
    Require(negativeHits == 0, "Unrelated speech incorrectly woke KWS.");
    Require(wakeCommand.Contains("THIS COMPUTER CREATE A NEW TEXT FILE", StringComparison.OrdinalIgnoreCase), "The KWS/ASR boundary lost command target or action: " + wakeCommand);
    Require(WindowsVoiceService.StripWakePhrase("Hi Nexus, on this computer open a file") == "on this computer open a file", "Full wake prefix removal failed.");
    Require(WindowsVoiceService.StripWakePhrase("NEXUS 请在电脑打开记事本") == "请在电脑打开记事本", "KWS tail prefix removal failed.");
    Require(WindowsVoiceService.StripWakePhrase("HIGH NEXT IS ON THIS COMPUTER CREATE A NEW TEXT FILE") == "ON THIS COMPUTER CREATE A NEW TEXT FILE", "Bilingual ASR wake spelling removal failed.");
    var vad = new WindowsVoiceActivity();
    vad.Observe(Enumerable.Repeat(0.04F, 6400).ToArray());
    Require(vad.HasSpeech && !vad.Complete, "VAD did not detect voiced audio.");
    for (var i = 0; i < 7; i++) vad.Observe(new float[3200]);
    Require(vad.Complete, "VAD did not finish after trailing silence.");
    var silent = new WindowsVoiceActivity();
    for (var i = 0; i < 36; i++) silent.Observe(new float[3200]);
    Require(silent.Complete && !silent.HasSpeech, "VAD did not stop an empty wake recording.");
    var microphone = "not requested";
    if (args.Contains("--microphone"))
    {
        using var engine = new WindowsVoiceService(NullLogger<WindowsVoiceService>.Instance);
        await engine.StartAsync(CancellationToken.None);
        try
        {
            Require(engine.GetStatus().Phase == "disabled", "Engine must start disabled.");
            await engine.ConfigureAsync(new WindowsVoiceOptions(true, false, "voice-smoke-room"));
            var id = await engine.BeginManualAsync("voice-smoke-room");
            await Task.Delay(300);
            try { await engine.EndManualAsync("stale-recording-id"); throw new InvalidOperationException("Stale recording ID was accepted."); }
            catch (InvalidOperationException error) when (error.Message.Contains("录音已结束")) { }
            Require(engine.GetStatus().RecordingId == id && engine.GetStatus().RecordingRoomId == "voice-smoke-room" && engine.GetStatus().LastWake == null, "Manual capture has the wrong presentation identity.");
            try { await engine.EndManualAsync(id, "another-room"); throw new InvalidOperationException("Cross-Room stop was accepted."); }
            catch (InvalidOperationException error) when (error.Message.Contains("不属于当前房间")) { }
            try { await engine.CancelManualAsync(id, "another-room"); throw new InvalidOperationException("Cross-Room cancel was accepted."); }
            catch (InvalidOperationException error) when (error.Message.Contains("不属于当前房间")) { }
            Require(engine.GetStatus().RecordingId == id, "A different Room changed the recording.");
            await engine.CancelManualAsync(id);
            Require(engine.GetStatus().RecordingId == null, "Manual cancel retained the recorder.");
            id = await engine.BeginManualAsync("voice-smoke-room");
            await Task.Delay(500);
            var result = await engine.EndManualAsync(id);
            Require(result.Manual && result.EventId == id, "Manual result ownership changed.");
            await engine.ConfigureAsync(new WindowsVoiceOptions(true, true, "voice-smoke-room"));
            Require(engine.GetStatus().Phase == "listening", "Wake microphone did not start.");
            await engine.ConfigureAsync(new WindowsVoiceOptions(false));
            Require(engine.GetStatus().Phase == "disabled" && engine.GetStatus().RecordingId == null, "Disable did not release recording.");
            microphone = "manual begin/end, stale ID, cancel, wake listen, disable passed";
        }
        finally { await engine.StopAsync(CancellationToken.None); }
    }
    var resultJson = JsonSerializer.Serialize(new { sherpa = VersionInfo.Version, onnxRuntime = VersionInfo.OnnxruntimeVersion, english, chinese, wakeCommand, wakeHits, negativeHits, vad = "passed", microphone, presentation = args.Contains("--presentation") ? "passed" : "not requested", elapsedMilliseconds = clock.ElapsedMilliseconds });
    Console.WriteLine(resultJson);
    var evidenceIndex = Array.IndexOf(args, "--evidence");
    if (evidenceIndex >= 0 && args.Length > evidenceIndex + 1)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(args[evidenceIndex + 1]))!);
        File.WriteAllText(args[evidenceIndex + 1], resultJson + Environment.NewLine, new System.Text.UTF8Encoding(false));
    }
}
catch (Exception error)
{
    Console.Error.WriteLine(error);
    Environment.ExitCode = 1;
}
