using System.Net;
using System.Text;
using NexusRoom.Host.Core;
using NexusRoom.Host.Voice;

if (args.Contains("--live"))
{
    var key = Environment.GetEnvironmentVariable("NEXUS_TEST_MODEL_KEY") ?? throw new Exception("Set NEXUS_TEST_MODEL_KEY for the explicitly authorized live model check");
    var liveProfile = new AgentProfile { ApiUrl = Environment.GetEnvironmentVariable("NEXUS_TEST_MODEL_URL") ?? "https://open.bigmodel.cn/api/v1", ApiKey = key, Model = "glm-5.3-flash" };
    VoiceDevice[] liveDevices = [new("pc:test", "测试电脑", "pc", true, true, false), new("phone:test", "测试手机", "android", true, true, false)];
    using var liveResolver = new VoiceIntentResolver();
    var target = await liveResolver.Resolve("请用电脑浏览器打开天气网页，然后把网址分享到手机", "phone:test", liveDevices, liveProfile, default);
    if (target != "pc:test") throw new Exception("Live model selected unexpected candidate: " + target);
    Console.WriteLine("PASS authorized GLM live text intent routing selected Windows; no audio or credentials in evidence");
    return;
}

var disk = new Dictionary<string, string>();
VoiceWakeLedger Ledger() => new(k => disk.GetValueOrDefault(k), (k, v) => disk[k] = v);
var ledger = Ledger(); var passed = 0;
void Check(string name, Action test) { test(); passed++; Console.WriteLine("PASS " + name); }
void Equal<T>(T a, T b) { if (!EqualityComparer<T>.Default.Equals(a, b)) throw new Exception($"Expected {b}, got {a}"); }
void Reject(int status, Action action) { try { action(); } catch (ApiException e) when (e.Status == status) { return; } throw new Exception("Expected HTTP " + status); }
string Event() => Guid.NewGuid().ToString();
var pc = "pc:room"; var phone = "phone"; var a = Event(); var b = Event();
var first = ledger.Claim("room", pc, a, "profile", null);
var second = ledger.Claim("room", phone, b, "profile", null);
Check("simultaneous different-source wakes receive same Room wake id", () => Equal(first.WakeId, second.WakeId));
Check("network retry of same event receives same wake id", () => Equal(ledger.Claim("room", pc, a, "different-profile", null).WakeId, first.WakeId));
var task = ledger.Reserve("room", pc, first.WakeId, a, "Hi Nexus, 在手机打开浏览器。");
var other = ledger.Reserve("room", phone, second.WakeId, b, "在手机打开浏览器");
Check("case/punctuation/wake prefix duplicate allocates only one task", () => { Equal(other.New, false); Equal(other.Task.TaskId, task.Task.TaskId); });
ledger.Update(task.Wake, task.Task, "started", phone, "existing-run");
Check("replayed submit preserves existing Agent run id", () => Equal(ledger.Reserve("room", pc, first.WakeId, a, "另一条不该执行").Task.RunId, "existing-run"));
Check("new instruction from same listener does not reuse temporal wake", () => Equal(ledger.Claim("room", pc, Event(), "profile", null).WakeId == first.WakeId, false));
Check("cross-room submit denied", () => Reject(403, () => ledger.Reserve("other", phone, first.WakeId, b, "指令")));
Check("wrong-source event denied", () => Reject(403, () => ledger.Reserve("room", "intruder", first.WakeId, b, "指令")));
Check("invalid ids denied", () => Reject(400, () => ledger.Claim("room", pc, "../../state", "profile", null)));
var c = Event(); var d = Event(); var group = ledger.Claim("distinct", pc, c, "profile", null); ledger.Claim("distinct", phone, d, "profile", null);
var t1 = ledger.Reserve("distinct", pc, group.WakeId, c, "删除文件 A1");
var t2 = ledger.Reserve("distinct", phone, group.WakeId, d, "删除文件 A2");
Check("different entity/number prompts in simultaneous wakes stay distinct", () => { Equal(t2.New, true); Equal(t1.Task.TaskId == t2.Task.TaskId, false); Equal(t2.Task.SourceId, phone); });
Check("decimal separators and operators remain meaningful in deduplication", () => { Equal(VoiceWakeLedger.Fingerprint("输入1.2") == VoiceWakeLedger.Fingerprint("输入12"), false); Equal(VoiceWakeLedger.Fingerprint("计算1+2") == VoiceWakeLedger.Fingerprint("计算12"), false); Equal(VoiceWakeLedger.Fingerprint("打开a/b") == VoiceWakeLedger.Fingerprint("打开ab"), false); });
Check("real bilingual KWS-to-ASR boundary variants deduplicate without changing command entities", () => Equal(VoiceWakeLedger.Fingerprint("HIGH NEXT IS ON THIS COMPUTER CREATE A NEW TEXT FILE"), VoiceWakeLedger.Fingerprint("哦 THIS COMPUTER CREATE A NEW TEXT FILE")));
Check("path and quoted literal spaces are not lost in deduplication", () => { Equal(VoiceWakeLedger.Fingerprint("打开 a b.txt") == VoiceWakeLedger.Fingerprint("打开 ab.txt"), false); Equal(VoiceWakeLedger.Fingerprint("输入\"a b\"") == VoiceWakeLedger.Fingerprint("输入\"ab\""), false); });
Check("quoted literal case remains significant", () => Equal(VoiceWakeLedger.Fingerprint("输入\"ABC\"") == VoiceWakeLedger.Fingerprint("输入\"abc\""), false));
Check("explicit Android path case remains significant", () => Equal(VoiceWakeLedger.Fingerprint("打开/sdcard/FileA.txt") == VoiceWakeLedger.Fingerprint("打开/sdcard/filea.txt"), false));
var cancelled = Event(); var cancelWake = ledger.Claim("cancel", pc, cancelled, "profile", null); ledger.Cancel("cancel", pc, cancelWake.WakeId, cancelled);
Check("cancelled audio cannot execute", () => Reject(409, () => ledger.Reserve("cancel", pc, cancelWake.WakeId, cancelled, "打开浏览器")));
Check("cancelled wake retry cannot recapture", () => Equal(ledger.Claim("cancel", pc, cancelled, "profile", null).Capture, false));
var afterRestart = Ledger();
Check("persisted event retry after restart preserves task and cannot recapture", () => { Equal(afterRestart.Claim("room", pc, a, "profile", null).Capture, false); Equal(afterRestart.Reserve("room", pc, first.WakeId, a, "test").Task.RunId, "existing-run"); });
ledger.Update(t1.Wake, t1.Task, "dispatching", pc);
Check("uncertain crash during dispatch is not replayed", () => Equal(Ledger().Reserve("distinct", pc, group.WakeId, c, "删除文件 A1").Task.Status, "interrupted"));
Check("punctuation-only input rejected", () => Reject(400, () => { var id = Event(); var w = ledger.Claim("empty", pc, id, "profile", null); ledger.Reserve("empty", pc, w.WakeId, id, "。！"); }));
VoiceDevice[] devices = [new(pc, "DESKTOP-TEST", "pc", true, true, false), new(phone, "测试手机", "android", true, true, false)];
Check("explicit computer uses Windows target", () => Equal(VoiceIntentResolver.KeywordTarget("在电脑打开网页", phone, devices), pc));
Check("explicit phone uses Android target", () => Equal(VoiceIntentResolver.KeywordTarget("在手机打开设置", pc, devices), phone));
Check("this device follows canonical wake source", () => Equal(VoiceIntentResolver.KeywordTarget("在这台设备上打开设置", phone, devices), phone));
Check("unique room device name recognized", () => Equal(VoiceIntentResolver.KeywordTarget("在测试手机上打开浏览器", pc, devices), phone));
Check("mentioned recipient conflicting with executor keyword needs model analysis", () => Equal(VoiceIntentResolver.KeywordTarget("在电脑保存小米发来的文件", pc, [devices[0], devices[1] with { Name = "小米" }]), null));
Check("this-device hint takes precedence over a generic peer name", () => Equal(VoiceIntentResolver.KeywordTarget("在这台设备打开设置", pc, [devices[0], devices[1] with { Name = "设备" }]), pc));
Check("mixed device intent requires model analysis", () => Equal(VoiceIntentResolver.KeywordTarget("把手机照片复制到电脑", phone, devices), null));
Check("ambiguous no-keyword request requires model analysis", () => Equal(VoiceIntentResolver.KeywordTarget("打开浏览器", pc, devices), null));
Check("busy explicit target cannot silently redirect", () => Reject(409, () => VoiceIntentResolver.KeywordTarget("电脑打开浏览器", phone, [devices[0] with { Busy = true }, devices[1]])));
var profile = new AgentProfile { ApiUrl = "https://model.test/v1", ApiKey = "fixture-secret", Model = "fixture" };
using (var resolver = new VoiceIntentResolver(new ModelHandler("{\"choices\":[{\"message\":{\"content\":\"{\\\"targetId\\\":\\\"phone\\\"}\"}}]}")))
    Check("ambiguous Chat Completions text intent selects only valid candidate", () => Equal(resolver.Resolve("打开浏览器", pc, devices, profile, default).GetAwaiter().GetResult(), phone));
profile.ApiType = "responses";
using (var resolver = new VoiceIntentResolver(new ModelHandler("{\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"{\\\"targetId\\\":\\\"pc:room\\\"}\"}]}]}")))
    Check("Responses text intent supported", () => Equal(resolver.Resolve("打开浏览器", phone, devices, profile, default).GetAwaiter().GetResult(), pc));
using (var resolver = new VoiceIntentResolver(new ModelHandler("{\"output_text\":\"{\\\"targetId\\\":\\\"other-room-phone\\\"}\"}")))
    Check("model target outside Room candidate allow-list rejected", () => Reject(409, () => resolver.Resolve("打开浏览器", pc, devices, profile, default).GetAwaiter().GetResult()));
Console.WriteLine($"Voice core: {passed} checks passed.");

sealed class ModelHandler(string body) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (request.RequestUri?.Scheme != "https" || request.Headers.Authorization?.Parameter != "fixture-secret") throw new Exception("Bad model auth/transport");
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
    }
}
