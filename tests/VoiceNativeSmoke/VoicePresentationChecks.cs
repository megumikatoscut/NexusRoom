using System.Reflection;
using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging.Abstractions;
using NexusRoom.Host.Desktop;
using NexusRoom.Host.Voice;

internal static class VoicePresentationChecks
{
    public static async Task Run(OfflineVoiceModels models, float[] wakeAudio)
    {
        // Feed production ProcessAudio with real KWS PCM; avoid room/model services.
        foreach (var accepted in new[] { false, true })
        {
            using var engine = new WindowsVoiceService(NullLogger<WindowsVoiceService>.Instance);
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic;
            var type = typeof(WindowsVoiceService);
            var spotter = models.CreateKeywordSpotter();
            type.GetField("options", flags)!.SetValue(engine, new WindowsVoiceOptions(true, true, "local-room"));
            type.GetField("spotter", flags)!.SetValue(engine, spotter);
            type.GetMethod("ResetKeywordStream", flags)!.Invoke(engine, null);
            engine.WakeDetected = _ => Task.FromResult(accepted);
            var presentations = 0;
            var identityValid = true;
            engine.LocalWake += wake =>
            {
                presentations++;
                var status = engine.GetStatus();
                if (wake.RoomId != "local-room" || status.RecordingRoomId != wake.RoomId || status.Phase != "recording-wake" || status.LastWake?.EventId != wake.EventId)
                    identityValid = false;
            };
            try
            {
                foreach (var chunk in wakeAudio.Chunk(640))
                    await (Task)type.GetMethod("ProcessAudio", flags)!.Invoke(engine, new object[] { chunk })!;
                if (presentations != (accepted ? 1 : 0)) throw new InvalidOperationException("Wake presentation bypassed the claim decision or repeated.");
                if (!identityValid) throw new InvalidOperationException("Local wake presentation has the wrong recording/room identity.");
                if (!accepted && engine.GetStatus().LastWake != null) throw new InvalidOperationException("Rejected wake retained a navigation event.");
                type.GetMethod("CancelRecording", flags)!.Invoke(engine, null);
                if (engine.GetStatus().RecordingId != null) throw new InvalidOperationException("Cancellation retained recording presentation.");
            }
            finally { type.GetMethod("ReleaseModels", flags)!.Invoke(engine, null); }
        }
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            using var window = new Form { Text = "NexusRoom voice presentation regression", Width = 400, Height = 240 };
            using var timer = new System.Windows.Forms.Timer { Interval = 300 };
            var stage = 0;
            timer.Tick += (_, _) =>
            {
                try
                {
                    if (stage++ == 0) { window.WindowState = FormWindowState.Minimized; return; }
                    if (stage == 2) { WindowActivation.BringToForeground(window.Handle); return; }
                    if (window.WindowState == FormWindowState.Minimized || GetForegroundWindow() != window.Handle)
                        throw new InvalidOperationException("The minimized native window was not restored to the foreground.");
                    completion.TrySetResult();
                }
                catch (Exception error) { completion.TrySetException(error); }
                timer.Stop(); window.Close();
            };
            window.Shown += (_, _) => timer.Start();
            Application.Run(window);
        }) { IsBackground = true };
        thread.SetApartmentState(ApartmentState.STA); thread.Start();
        await completion.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Console.WriteLine("PASS local accepted/rejected KWS navigation, recording Room identity, cancellation, native minimized foreground restoration.");
    }
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
}
