using SherpaOnnx;

namespace NexusRoom.Host.Voice;

/// <summary>Fixed local CPU models; no network access and no microphone until explicitly enabled.</summary>
public sealed class OfflineVoiceModels
{
    public const int SampleRate = 16000;
    public const string WakeTokens = "HH AY1 N EH1 K S AH0 S :2.0 #0.30 @Hi_Nexus";
    private readonly string root;

    public OfflineVoiceModels(string? root = null) => this.root = root ?? Path.Combine(AppContext.BaseDirectory, "voice");

    public bool Ready => new[] { "kws", "asr" }.All(model =>
        new[] { "encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt" }.All(file => File.Exists(Path.Combine(root, model, file))));

    private OnlineModelConfig Model(string name)
    {
        var folder = Path.Combine(root, name);
        foreach (var file in new[] { "encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt" })
            if (!File.Exists(Path.Combine(folder, file))) throw new InvalidOperationException($"本地语音模型缺失：voice/{name}/{file}，请重新安装完整 NexusRoom 客户端。");
        var config = new OnlineModelConfig();
        config.Transducer.Encoder = Path.Combine(folder, "encoder.int8.onnx");
        config.Transducer.Decoder = Path.Combine(folder, "decoder.onnx");
        config.Transducer.Joiner = Path.Combine(folder, "joiner.int8.onnx");
        config.Tokens = Path.Combine(folder, "tokens.txt");
        config.Provider = "cpu";
        config.NumThreads = 1;
        config.Debug = 0;
        return config;
    }

    public KeywordSpotter CreateKeywordSpotter()
    {
        var config = new KeywordSpotterConfig();
        config.FeatConfig.SampleRate = SampleRate;
        config.FeatConfig.FeatureDim = 80;
        config.ModelConfig = Model("kws");
        config.KeywordsBuf = WakeTokens + "\n";
        config.KeywordsBufSize = System.Text.Encoding.UTF8.GetByteCount(config.KeywordsBuf);
        config.KeywordsThreshold = 0.30F;
        config.KeywordsScore = 1.0F;
        config.NumTrailingBlanks = 1;
        return new KeywordSpotter(config);
    }

    public OnlineRecognizer CreateRecognizer()
    {
        var config = new OnlineRecognizerConfig();
        config.FeatConfig.SampleRate = SampleRate;
        config.FeatConfig.FeatureDim = 80;
        config.ModelConfig = Model("asr");
        config.DecodingMethod = "greedy_search";
        config.EnableEndpoint = 1;
        config.Rule1MinTrailingSilence = 6.0F;
        config.Rule2MinTrailingSilence = 1.2F;
        config.Rule3MinUtteranceLength = 40.0F;
        return new OnlineRecognizer(config);
    }

    /// <summary>Executable model validation path used by the WAV regression runner.</summary>
    public string Transcribe(float[] samples, int sampleRate = SampleRate)
    {
        using var recognizer = CreateRecognizer();
        using var stream = recognizer.CreateStream();
        for (var offset = 0; offset < samples.Length; offset += 3200)
        {
            stream.AcceptWaveform(sampleRate, samples.AsSpan(offset, Math.Min(3200, samples.Length - offset)).ToArray());
            while (recognizer.IsReady(stream)) recognizer.Decode(stream);
        }
        stream.AcceptWaveform(SampleRate, new float[SampleRate / 2]);
        stream.InputFinished();
        while (recognizer.IsReady(stream)) recognizer.Decode(stream);
        return recognizer.GetResult(stream).Text.Trim();
    }
}
