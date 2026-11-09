using System.Net;
using System.Threading.RateLimiting;
using NexusRoom.Host.Agent;
using NexusRoom.Host.Api;
using NexusRoom.Host.Core;
using NexusRoom.Host.Devices;
using NexusRoom.Host.Files;
using NexusRoom.Host.Desktop;
using NexusRoom.Host.Communication;
using NexusRoom.Host.Voice;

namespace NexusRoom.Host;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        var headless = args.Contains("--headless");
        ApplicationConfiguration.Initialize();
        try
        {
            var store = new StateStore();
            using var instance = new Mutex(true, "Local\\NexusRoom-" + store.UiPort, out var first);
            if (!first) { if (!headless) MessageBox.Show("NexusRoom 已在运行。", "NexusRoom"); return; }
            var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = args.Where(a => a != "--headless").ToArray(), ContentRootPath = AppContext.BaseDirectory, WebRootPath = Path.Combine(AppContext.BaseDirectory, "wwwroot") });
            builder.Logging.ClearProviders();
            if (headless) builder.Logging.AddSimpleConsole(o => o.SingleLine = true);
            builder.WebHost.ConfigureKestrel(k =>
            {
                k.AddServerHeader = false; k.Limits.MaxRequestBodySize = FileService.MaxFileSize;
                k.Limits.RequestHeadersTimeout = TimeSpan.FromSeconds(15);
                k.Listen(IPAddress.Loopback, store.UiPort);
                k.Listen(IPAddress.Any, store.DevicePort, listener => listener.UseHttps(store.Certificate));
            });
            builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = Json.Options.PropertyNamingPolicy);
            builder.Services.AddSingleton(store);
            builder.Services.AddSingleton<DeviceHub>(); builder.Services.AddHostedService(s => s.GetRequiredService<DeviceHub>());
            builder.Services.AddSingleton<CommunicationService>(); builder.Services.AddHostedService(s => s.GetRequiredService<CommunicationService>());
            builder.Services.AddSingleton<PcWorkCoordinator>();
            builder.Services.AddSingleton<PcRemoteService>(); builder.Services.AddHostedService(s => s.GetRequiredService<PcRemoteService>());
            builder.Services.AddHostedService<DiscoveryService>();
            builder.Services.AddSingleton<ClipboardBridge>(); builder.Services.AddHostedService(s => s.GetRequiredService<ClipboardBridge>());
            builder.Services.AddSingleton<FileService>(); builder.Services.AddSingleton<PcTools>();
            builder.Services.AddSingleton<ApprovalService>(); builder.Services.AddSingleton<ToolService>(); builder.Services.AddSingleton<AgentRunner>();
            builder.Services.AddSingleton<PcAgentRunner>(); builder.Services.AddSingleton<AgentRouter>();
            builder.Services.AddSingleton<VoiceIntentResolver>(); builder.Services.AddSingleton<VoiceCoordinator>();
            builder.Services.AddSingleton<WindowsVoiceService>(); builder.Services.AddHostedService(s => s.GetRequiredService<WindowsVoiceService>());
            builder.Services.AddHostedService<VoiceWindowsBridge>();
            builder.Services.AddRateLimiter(options =>
            {
                options.RejectionStatusCode = 429;
                options.AddPolicy("join", context => RateLimitPartition.GetFixedWindowLimiter(context.Connection.RemoteIpAddress?.ToString() ?? "unknown", _ => new FixedWindowRateLimiterOptions { PermitLimit = 8, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
            });
            var app = builder.Build();
            app.UseMiddleware<SecurityMiddleware>();
            app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(20) });
            app.UseRateLimiter(); app.UseDefaultFiles(); app.UseStaticFiles(); app.MapNexus(); app.MapVoice();
            app.StartAsync().GetAwaiter().GetResult(); store.WriteProtected("launch.dat", store.LaunchUrl); store.Audit("server", "本地服务器启动");
            if (headless) app.WaitForShutdownAsync().GetAwaiter().GetResult(); else Application.Run(new DesktopWindow(store, app.Services.GetRequiredService<WindowsVoiceService>()));
            app.StopAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult(); app.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
        catch (Exception e)
        {
            if (headless) Console.Error.WriteLine($"NexusRoom startup failed: {e.GetType().Name}: {e.Message}");
            else MessageBox.Show($"NexusRoom 无法启动。请检查端口与本机配置。\n{e.Message}", "NexusRoom", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Environment.ExitCode = 1;
        }
    }
}
