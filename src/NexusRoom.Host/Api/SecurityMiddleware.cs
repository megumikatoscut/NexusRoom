using System.Net;
using System.Text.Json;
using NexusRoom.Host.Core;

namespace NexusRoom.Host.Api;

public sealed class SecurityMiddleware(RequestDelegate next)
{
    public async Task Invoke(HttpContext c, StateStore store, ILogger<SecurityMiddleware> logger)
    {
        try
        {
            var ip = c.Connection.RemoteIpAddress;
            if (ip == null || !StateStore.PrivateIp(ip)) throw new ApiException(403, "只允许局域网访问");
            var local = c.Connection.LocalPort == store.UiPort && IPAddress.IsLoopback(ip);
            var path = (c.Request.Path.Value ?? "/").ToLowerInvariant();
            if (c.Request.ContentType?.StartsWith("application/json", StringComparison.OrdinalIgnoreCase) == true && c.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit) limit.MaxRequestBodySize = 1024 * 1024;
            c.Response.Headers.XContentTypeOptions = "nosniff";
            c.Response.Headers["Referrer-Policy"] = "no-referrer";
            c.Response.Headers["Content-Security-Policy"] = "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
            c.Response.Headers["Cache-Control"] = "no-store";
            if (local && c.Request.Host.Value != $"127.0.0.1:{store.UiPort}") throw new ApiException(403, "Host 不合法");
            var origin = c.Request.Headers.Origin.ToString();
            if (origin.Length > 0 && origin != store.UiOrigin) throw new ApiException(403, "拒绝跨来源请求");
            var bearer = c.Request.Headers.Authorization.ToString();
            if (path.StartsWith("/api/", StringComparison.Ordinal))
            {
                if (!local) throw new ApiException(403, "控制台只能在主机本地访问");
                if (path != "/api/session")
                {
                    var token = bearer.StartsWith("Bearer ", StringComparison.Ordinal) ? bearer[7..] : c.Request.Cookies["nr_session"];
                    if (token == null || !StateStore.Equal(token, store.BootstrapToken)) throw new ApiException(401, "控制台登录已失效，请从桌面应用重新打开");
                }
                if ((HttpMethods.IsPost(c.Request.Method) || HttpMethods.IsPut(c.Request.Method) || HttpMethods.IsPatch(c.Request.Method) || HttpMethods.IsDelete(c.Request.Method)) && c.Request.Headers["X-Nexus-Request"] != "1") throw new ApiException(403, "缺少请求校验头");
            }
            else if (path.StartsWith("/agent/", StringComparison.Ordinal))
            {
                if (!bearer.StartsWith("Bearer ", StringComparison.Ordinal) || store.State.ExternalTokenHash.Length == 0 || !StateStore.Equal(StateStore.Hash(bearer[7..]), store.State.ExternalTokenHash)) throw new ApiException(401, "Agent API 凭据无效");
            }
            else if (path.StartsWith("/device/", StringComparison.Ordinal)) { if (!c.Request.IsHttps) throw new ApiException(403, "Android 必须使用 HTTPS"); }
            else if (!local && path != "/health") throw new ApiException(404, "页面不存在");
            await next(c);
        }
        catch (Exception e) when (!c.Response.HasStarted)
        {
            var invalidJsonType = e is InvalidOperationException
                && (e.Source == "System.Text.Json" || e.TargetSite?.DeclaringType?.Namespace == "System.Text.Json");
            var status = e is ApiException api ? api.Status : e is JsonException or BadHttpRequestException or FormatException or KeyNotFoundException || invalidJsonType ? 400 : e is OperationCanceledException ? 408 : 500;
            if (status == 500) logger.LogError("Request failed: {Type} at {Path}\n{Stack}", e.GetType().Name, c.Request.Path, e.StackTrace);
            c.Response.StatusCode = status;
            await c.Response.WriteAsJsonAsync(new { title = e is ApiException ? e.Message : status == 400 ? "请求参数无效" : status == 408 ? "请求已取消或超时" : "服务暂时不可用，请查看操作日志", status }, Json.Options);
        }
    }
}
