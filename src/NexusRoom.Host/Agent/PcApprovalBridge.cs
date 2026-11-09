using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using NexusRoom.Host.Core;

namespace NexusRoom.Host.Agent;

internal sealed class PcApprovalBridge(ApprovalService approvals, string roomId, string targetId, string runId,
    Action<Approval> onCreated, CancellationToken runToken) : IAsyncDisposable
{
    private readonly CancellationTokenSource lifetime = CancellationTokenSource.CreateLinkedTokenSource(runToken);
    private readonly ConcurrentDictionary<Guid, Task> handlers = new();
    private Task? listener;
    private Process? child;

    public string PipeName { get; } = "NexusRoom-Approval-" + Guid.NewGuid().ToString("N");

    public void Start(Process process)
    {
        child = process;
        listener = Listen(lifetime.Token);
    }

    private async Task Listen(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            var pipe = new NamedPipeServerStream(PipeName, PipeDirection.InOut,
                NamedPipeServerStream.MaxAllowedServerInstances, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            try { await pipe.WaitForConnectionAsync(token); }
            catch (OperationCanceledException) { pipe.Dispose(); break; }
            catch (IOException) { pipe.Dispose(); if (!token.IsCancellationRequested) continue; break; }

            if (child is null || child.HasExited || !GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var clientPid)
                || clientPid != (uint)child.Id)
            {
                pipe.Dispose();
                continue;
            }

            var key = Guid.NewGuid();
            var handler = Handle(pipe, token);
            handlers[key] = handler;
            _ = handler.ContinueWith(completed => handlers.TryRemove(key, out var ignored), TaskScheduler.Default);
        }
    }

    private async Task Handle(NamedPipeServerStream pipe, CancellationToken token)
    {
        using (pipe)
        using (var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, leaveOpen: true))
        using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, leaveOpen: true) { AutoFlush = true, NewLine = "\n" })
        {
            try
            {
                using var pending = CancellationTokenSource.CreateLinkedTokenSource(token);
                pending.CancelAfter(TimeSpan.FromSeconds(10));
                var line = await reader.ReadLineAsync(pending.Token);
                if (line is null || Encoding.UTF8.GetByteCount(line) > 64 * 1024) return;
                using var document = JsonDocument.Parse(line);
                var request = document.RootElement;
                var id = Text(request, "id", 64);
                var tool = Text(request, "toolName", 256);
                if (id.Length == 0 || tool.Length == 0) return;
                var reason = Text(request, "reason", 8000);
                var callId = Text(request, "callId", 256);
                var arguments = request.TryGetProperty("arguments", out var args) ? args.Clone() : default;
                var summary = JsonSerializer.SerializeToElement(new { reason, callId,
                    arguments = arguments.ValueKind == JsonValueKind.Undefined ? (object?)null : arguments }, Json.Options);

                using var decision = CancellationTokenSource.CreateLinkedTokenSource(token);
                var approval = approvals.AskPc(roomId, targetId, tool, summary, runId, id, onCreated, decision.Token);
                var disconnected = reader.ReadLineAsync(decision.Token).AsTask();
                var winner = await Task.WhenAny(approval, disconnected);
                if (winner == disconnected)
                {
                    decision.Cancel();
                    try { await approval; } catch (Exception error) when (error is OperationCanceledException or ApiException) { }
                    return;
                }

                string outcome;
                try { outcome = await approval ? "allowed-once" : "rejected"; }
                catch (ApiException error) when (error.Status == 408) { outcome = "unavailable"; }
                catch (OperationCanceledException) { outcome = "cancelled"; }
                catch (Exception) { outcome = "unavailable"; }
                decision.Cancel();
                try { await disconnected; } catch (OperationCanceledException) { }
                await writer.WriteLineAsync(JsonSerializer.Serialize(new { id, outcome }, Json.Options));
            }
            catch (Exception error) when (error is IOException or JsonException or OperationCanceledException or ObjectDisposedException) { }
        }
    }

    private static string Text(JsonElement source, string name, int maxLength)
    {
        if (!source.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String) return "";
        var text = value.GetString() ?? "";
        return text.Length <= maxLength ? text : "";
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint clientProcessId);

    public async ValueTask DisposeAsync()
    {
        lifetime.Cancel();
        approvals.CancelRun(runId);
        if (listener is not null) await listener;
        await Task.WhenAll(handlers.Values);
        lifetime.Dispose();
    }
}
