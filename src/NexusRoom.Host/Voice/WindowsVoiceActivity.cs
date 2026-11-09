namespace NexusRoom.Host.Voice;

/// <summary>Cheap adaptive energy VAD. ASR endpoint detection supplies the second independent end-of-speech signal.</summary>
public sealed class WindowsVoiceActivity
{
    private double noiseFloor = 0.002;
    private double elapsed, trailingSilence, speechDuration;
    public bool HasSpeech => speechDuration >= 0.18;
    public double Elapsed => elapsed;

    public void Observe(float[] samples)
    {
        if (samples.Length == 0) return;
        var seconds = (double)samples.Length / OfflineVoiceModels.SampleRate;
        elapsed += seconds;
        var energy = 0.0;
        foreach (var sample in samples) energy += sample * sample;
        var rms = Math.Sqrt(energy / samples.Length);
        var speech = rms > Math.Max(0.008, noiseFloor * 3.0);
        if (speech) { speechDuration += seconds; trailingSilence = 0; }
        else
        {
            trailingSilence += seconds;
            noiseFloor = Math.Clamp(noiseFloor * 0.98 + rms * 0.02, 0.0003, 0.012);
        }
    }

    public bool Complete => elapsed >= 40 || (HasSpeech && trailingSilence >= 1.2) || (!HasSpeech && elapsed >= 7);
}
