package com.nexusroom.android;

import android.Manifest;
import android.app.ActivityOptions;
import android.app.AppOpsManager;
import android.app.ActivityManager;
import android.app.PendingIntent;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.net.Uri;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.os.StatFs;
import android.os.SystemClock;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.Settings;
import android.content.res.Configuration;
import android.view.Display;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityNodeInfo;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.common.HybridBinarizer;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.InputStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import okhttp3.MediaType;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/** The only Android capabilities exposed to model-generated tool calls. */
final class AgentTools {
    static final class Entry {
        final String name, description, category;
        final boolean approval;
        final JSONObject parameters;
        Entry(String n, String d, String c, boolean a, JSONObject p) {
            name=n; description=d; category=c; approval=a; parameters=p;
        }
    }
    private static final LinkedHashMap<String,Entry> REGISTRY = new LinkedHashMap<>();
    static {
        add("get_device_info", "Read basic phone, battery and storage information.", "device", false, schema(props()));
        add("list_room_devices", "List this room's Android and Windows devices, including exact IDs, names, models, communication online status and availability. Use before arranging calls or meetings. A duplicate name or model is ambiguous; use an exact ID after asking the user to identify the device.", "communication", false, schema(props()));
        add("arrange_communication", "Arrange a room communication from THIS phone: action=call sends a private audio-call request to targetId; action=meeting creates a public or private video meeting and invites inviteeIds. IDs can be exact device IDs or unique exact room device names/models. The other devices must accept. Never accepts for others or enables microphone, camera or screen sharing. Return the actual request/meeting result, never claim that a request was already accepted. A call accepts only action and targetId; meeting-only parameters are invalid for a call.", "communication", true, schema(props("action",enumeration("call or meeting","call","meeting"),"targetId",p("string","For call: target ID or unique exact name/model"),"title",p("string","Optional meeting title, up to 80 characters, defaults to NexusRoom 会议"),"visibility",enumeration("Meeting visibility, defaults to private","private","public"),"inviteeIds",strings("For meeting: device IDs or unique exact names/models, maximum 32")),"action"));
        add("list_apps", "List launchable apps and their package names.", "apps", false, schema(props("query", p("string", "Optional app name filter"))));
        add("open_app_by_name", "Open an installed app by display name or exact package name.", "apps", true, schema(props("name", p("string", "App display name or package")), "name"));
        add("open_settings_page", "Open an allowed Android settings page: settings, wifi, bluetooth, app_details, accessibility, all_files_access, usage_access, notification_access.", "apps", true, schema(props("page", p("string", "Settings page"), "packageName", p("string", "Package for app_details")), "page"));
        add("open_url", "Open an HTTP or HTTPS URL in the user's browser.", "apps", true, schema(props("url", p("string", "Web URL")), "url"));
        add("screenshot", "Capture the current Android display for a vision-capable model. Requires screen and accessibility permission. If Android returns a black frame, an already-consented same-room screen share may provide a fallback; secure windows may still be unavailable.", "screen", true, schema(props()));
        add("clipboard_get", "Read the current Android system clipboard text when Android permits access.", "clipboard", false, schema(props()));
        add("clipboard_set", "Set the Android system clipboard to text.", "clipboard", true, schema(props("text", p("string", "Text, maximum 65536 characters")), "text"));
        add("get_page_info", "Read visible application and overlay windows with resource IDs, element indexes, focused state and text-input candidates. Some apps do not label their composer editable; the text tools also inspect Android input focus. Password text is excluded.", "ui", false, schema(props()));
        add("click_element", "Click one freshly matched accessibility element. Specify text, resourceId or description; use index only to disambiguate from the latest get_page_info snapshot.", "ui", true, schema(props("text", p("string", "Exact visible text"), "resourceId", p("string", "Resource ID"), "description", p("string", "Exact content description"), "className", p("string", "Optional class"), "index", p("integer", "Index from latest page snapshot"))));
        add("set_input_text", "Replace text in the current non-password input. Checks focused fields across application windows and Android's active input connection; if exactly one visible text field is available it can focus that field. For multiple fields, first select the intended one.", "ui", true, schema(props("text", p("string", "Text to enter")), "text"));
        add("append_text", "Insert text at the current caret in a non-password input. Checks application windows and Android's active input connection; select the intended field first when several are visible.", "ui", true, schema(props("text", p("string", "Text to append")), "text"));
        add("clear_text", "Clear the focused non-password input field.", "ui", true, schema(props()));
        add("press_key", "Press a safe text editing key such as Enter, Backspace, Delete, ArrowLeft or ArrowRight.", "ui", true, schema(props("key", p("string", "Enter, Backspace, Delete, ArrowLeft, ArrowRight, Home or End")), "key"));
        add("back", "Go back in Android.", "ui", true, schema(props()));
        add("home", "Go to Android home screen.", "ui", true, schema(props()));
        add("recent", "Open recent apps.", "ui", true, schema(props()));
        add("scroll", "Scroll current page vertically.", "ui", true, schema(props("direction", p("string", "down or up")), "direction"));
        add("tap", "Fallback: tap normalized screen coordinates (0 to 1). Prefer click_element.", "ui", true, schema(props("x", p("number", "Horizontal fraction"), "y", p("number", "Vertical fraction")), "x", "y"));
        add("swipe", "Fallback: swipe normalized coordinates (0 to 1).", "ui", true, schema(props("x", p("number", "Start x"), "y", p("number", "Start y"), "endX", p("number", "End x"), "endY", p("number", "End y"), "duration", p("integer", "Milliseconds")), "x", "y", "endX", "endY"));
        add("get_app_usage_time", "Read Android daily app foreground aggregates overlapping the requested time range, with Usage Access enabled. Daily buckets may include time outside the requested range; use coveredStartTime and coveredEndTime to see their actual bounds.", "usage", false, schema(props("startTime", p("integer", "Unix milliseconds"), "endTime", p("integer", "Unix milliseconds"), "packageName", p("string", "Optional app package"))));
        add("get_notifications", "Read currently active notifications with Notification Access enabled. Removed notifications are not retained.", "notifications", false, schema(props("query", p("string", "Optional title/text filter"), "packageName", p("string", "Optional app package"), "sinceTime", p("integer", "Unix milliseconds"), "untilTime", p("integer", "Unix milliseconds"), "includeOngoing", p("boolean", "Include persistent notifications"), "category", p("string", "Optional Android notification category"))));
        add("list_phone_files", "List phone files, optionally restricted by path, name or extension. Returns opaque file IDs.", "files", false, schema(props("path", p("string", "Optional relative folder path"), "query", p("string", "Optional file name fragment"), "type", p("string", "Optional extension such as pdf"), "limit", p("integer", "Maximum 1 to 50"))));
        add("find_photos", "Find photos by file name, newest first. Requires full photo access.", "files", false, schema(props("query", p("string", "Optional name fragment"), "limit", p("integer", "Maximum 1 to 20"))));
        add("list_photos", "List the newest photos, optionally filtered by file name. Requires full photo access.", "files", false, schema(props("query", p("string", "Optional name fragment"), "limit", p("integer", "Maximum 1 to 20"))));
        add("decode_recent_qr", "Decode the newest photo's QR code locally without uploading the image to the model.", "files", false, schema(props()));
        add("find_phone_files", "Find phone files by name and return opaque file IDs. Requires Android All Files Access.", "files", false, schema(props("query", p("string", "File name fragment"), "type", p("string", "Optional extension such as pdf")), "query"));
        add("get_file_info", "Get metadata for an opaque file ID from find_phone_files.", "files", false, schema(props("fileId", p("string", "Opaque file ID")), "fileId"));
        add("read_phone_file", "Read a small UTF-8 text segment from an opaque file ID.", "files", false, schema(props("fileId", p("string", "Opaque file ID"), "offset", p("integer", "Byte offset 0 or greater")), "fileId"));
        add("open_file", "Open a file with an installed viewer; opening is not proof it was read.", "files", true, schema(props("fileId", p("string", "Opaque file ID")), "fileId"));
        add("share_file", "Open Android share sheet for a file; this does not confirm sending.", "files", true, schema(props("fileId", p("string", "Opaque file ID")), "fileId"));
        add("send_file_to_pc", "Upload a file into this room's Windows file library and verify server receipt.", "files", true, schema(props("fileId", p("string", "Opaque file ID")), "fileId"));
        add("list_files", "List Windows files already imported into this room's file library and available for this phone. Returns file IDs for send_file; this does not browse arbitrary Windows folders. Optionally search file names.", "files", false, schema(props("query", p("string", "Optional file name fragment, up to 100 characters"))));
        add("send_file", "Deliver one Windows room-library file returned by list_files to this phone and verify its receipt.", "files", true, schema(props("fileId", p("string", "File ID returned by list_files")), "fileId"));
        add("compose_email", "Open an email composer addressed to a recipient. Set send=true only when the user explicitly asked to send; the tool verifies the visible recipient, subject and body before clicking the mail app's send control.", "apps", true, schema(props("to", p("string", "Email recipient"), "subject", p("string", "Subject"), "body", p("string", "Message body"), "send", p("boolean", "Send after verifying the visible composer; requires explicit user intent")), "to", "subject", "body"));
        add("send_qr_link_email", "Decode the newest photo QR locally and prepare an email with the HTTP(S) URL. Set openUrl=true to open the URL first. Set send=true only when the user explicitly asked to send; the tool verifies the visible recipient, subject and body before clicking the mail app's send control.", "files", true, schema(props("to", p("string", "Email recipient"), "subject", p("string", "Optional subject"), "bodyPrefix", p("string", "Optional text before the URL"), "openUrl", p("boolean", "Open the decoded URL before composing"), "send", p("boolean", "Send after verifying the visible composer; requires explicit user intent")), "to"));
    }
    private static void add(String n,String d,String c,boolean a,JSONObject p) { REGISTRY.put(n,new Entry(n,d,c,a,p)); }
    private static JSONObject p(String type,String description) { try{return new JSONObject().put("type",type).put("description",description);}catch(Exception e){throw new IllegalStateException(e);} }
    private static JSONObject enumeration(String description,String...values){try{return p("string",description).put("enum",new JSONArray(values));}catch(Exception e){throw new IllegalStateException(e);}}
    private static JSONObject strings(String description){try{return p("array",description).put("items",p("string","Device ID or exact name/model")).put("maxItems",32);}catch(Exception e){throw new IllegalStateException(e);}}
    private static JSONObject props(Object... values) { try{JSONObject p=new JSONObject(); for(int i=0;i<values.length;i+=2)p.put((String)values[i],values[i+1]); return p;}catch(Exception e){throw new IllegalStateException(e);} }
    private static JSONObject schema(JSONObject properties,String... required) { try{return new JSONObject().put("type","object").put("properties",properties).put("required",new JSONArray(required)).put("additionalProperties",false);}catch(Exception e){throw new IllegalStateException(e);} }
    static Entry entry(String name) { return REGISTRY.get(name); }
    static JSONArray definitions(boolean responses)throws Exception {
        JSONArray out=new JSONArray();
        for(Entry e:REGISTRY.values()) {
            JSONObject item=new JSONObject().put("type","function");
            if(responses)item.put("name",e.name).put("description",e.description).put("parameters",e.parameters);
            else item.put("function",new JSONObject().put("name",e.name).put("description",e.description).put("parameters",e.parameters));
            out.put(item);
        }
        return out;
    }

    private final RoomService room;
    private final RoomService.RoomLink link;
    private final String lease;
    private final String taskId;
    private volatile JSONArray lastPageNodes;
    AgentTools(RoomService room,RoomService.RoomLink link,String lease,String taskId) { this.room=room; this.link=link; this.lease=lease; this.taskId=taskId; }
    JSONObject execute(String name,JSONObject args) throws Exception {
        Entry e=entry(name);
        if(e==null)throw new Exception("ToolUnavailable: 未注册工具 " + name);
        check(e);
        switch(name) {
            case "get_device_info": return deviceInfo();
            case "list_room_devices": return roomDevices();
            case "arrange_communication": return arrangeCommunication(args);
            case "list_apps": return listApps(args.optString("query"));
            case "open_app_by_name": return openApp(required(args,"name",100));
            case "open_settings_page": return openSettings(required(args,"page",50),args.optString("packageName"));
            case "open_url": return openUrl(required(args,"url",2048));
            case "screenshot": return AgentDeviceCapabilities.screenshot(room,link,lease,taskId);
            case "clipboard_get": return AgentDeviceCapabilities.clipboardGet(room,link,lease,taskId);
            case "clipboard_set": return AgentDeviceCapabilities.clipboardSet(room,link,lease,taskId,textArg(args,"text",65536));
            case "get_page_info": return room.onMain(()->{check(e);room.agentEngine.requireTaskRunning(link,lease,taskId);return pageInfo();});
            case "click_element": return clickElement(args);
            case "set_input_text": return control("text",new JSONObject().put("text",textArg(args,"text",8192)));
            case "append_text": return control("edit",new JSONObject().put("action","insert").put("text",textArg(args,"text",8192)));
            case "clear_text": return control("edit",new JSONObject().put("action","clear"));
            case "press_key": return pressKey(args);
            case "back": return control("back",new JSONObject());
            case "home": return control("home",new JSONObject());
            case "recent": return control("recents",new JSONObject());
            case "scroll": return scroll(args);
            case "tap": return control("tap",args);
            case "swipe": return control("swipe",args);
            case "get_app_usage_time": return usage(args);
            case "get_notifications": return AgentNotificationListener.snapshot(args);
            case "find_photos": return photos(args);
            case "list_photos": return photos(args);
            case "decode_recent_qr": return decodeRecentQr();
            case "list_phone_files": return files(args,false);
            case "find_phone_files": return files(args,true);
            case "get_file_info": return fileInfo(args);
            case "read_phone_file": return readFile(args);
            case "open_file": return openOrShare(args,false);
            case "share_file": return openOrShare(args,true);
            case "send_file_to_pc": return sendFile(args);
            case "list_files": return listHostFiles(args);
            case "send_file": return sendHostFile(args);
            case "compose_email": return composeEmail(args,"compose_email");
            case "send_qr_link_email": return sendQrLinkEmail(args);
            default: throw new Exception("ToolUnavailable: 未注册工具 " + name);
        }
    }
    private void check(Entry e)throws Exception {
        room.requireOwner(link,lease);
        if(!link.config.agent)throw new Exception("PermissionDenied: 本房间 Agent 权限已关闭");
        if((e.category.equals("ui")||opensAndroidActivity(e.name))&&(!link.config.control||ControlService.instance==null))throw new Exception("PermissionDenied: 请开启远程控制权限和 NexusRoom 无障碍服务");
        if(e.category.equals("screen")&&(!link.config.screenAllowed||!link.config.control||ControlService.instance==null))throw new Exception("PermissionDenied: 请允许此房间使用屏幕和远程控制，并开启 NexusRoom 无障碍服务");
        if(e.category.equals("clipboard")&&!link.config.clipboard)throw new Exception("PermissionDenied: 本房间剪贴板权限未开启");
        if(e.category.equals("files")&&!link.config.files)throw new Exception("PermissionDenied: 本房间文件与照片权限未开启");
        if(e.category.equals("notifications")&&AgentNotificationListener.instance==null)throw new Exception("PermissionDenied: 请在 Android 设置开启 NexusRoom 通知使用权");
        if(e.category.equals("usage")) {
            AppOpsManager ops=room.getSystemService(AppOpsManager.class);
            if(ops==null||ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS,android.os.Process.myUid(),room.getPackageName())!=AppOpsManager.MODE_ALLOWED)
                throw new Exception("PermissionDenied: 请在 Android 设置开启 NexusRoom 使用情况访问权限");
        }
    }
    private JSONObject roomDevices()throws Exception {
        room.agentEngine.requireTaskRunning(link,lease,taskId);
        try(Response response=link.client.newCall(link.request("/device/agent/communication/devices?taskId="+URLEncoder.encode(taskId,StandardCharsets.UTF_8.name())).get().build()).execute()){
            String raw=response.body()==null?"{}":response.peekBody(256*1024).string();room.agentEngine.requireTaskRunning(link,lease,taskId);
            if(!response.isSuccessful())throw new Exception("CommunicationError: 无法读取房间通信设备");JSONObject state=new JSONObject(raw);JSONArray devices=state.optJSONArray("devices");if(devices==null)devices=new JSONArray();return new JSONObject().put("roomId",state.optString("roomId")).put("selfId",state.optString("selfId",link.config.deviceId)).put("devices",devices).put("count",devices.length());
        }
    }
    private JSONObject arrangeCommunication(JSONObject args)throws Exception {
        for(java.util.Iterator<String> fields=args.keys();fields.hasNext();){String field=fields.next();if(!field.equals("action")&&!field.equals("targetId")&&!field.equals("title")&&!field.equals("visibility")&&!field.equals("inviteeIds"))throw new Exception("InvalidArguments: 不支持参数 "+field);}
        String action=communicationString(args,"action",20,null);if(!action.equals("call")&&!action.equals("meeting"))throw new Exception("InvalidArguments: action 必须为 call 或 meeting");
        JSONObject payload=new JSONObject().put("taskId",taskId).put("action",action);
        if(action.equals("call")){if(args.has("title")||args.has("visibility")||args.has("inviteeIds"))throw new Exception("InvalidArguments: 电话不接受会议标题、可见性或邀请列表");payload.put("targetId",communicationString(args,"targetId",100,null));}
        else {if(args.has("targetId"))throw new Exception("InvalidArguments: 会议请使用 inviteeIds 而非 targetId");String visibility=communicationString(args,"visibility",20,"private");if(!visibility.equals("public")&&!visibility.equals("private"))throw new Exception("InvalidArguments: visibility 必须为 public 或 private");String title=communicationString(args,"title",80,"NexusRoom 会议");if(args.has("inviteeIds")&&!(args.opt("inviteeIds") instanceof JSONArray))throw new Exception("InvalidArguments: inviteeIds 必须为设备名称或 ID 数组");JSONArray invitees=args.optJSONArray("inviteeIds");if(invitees==null)invitees=new JSONArray();if(invitees.length()>32)throw new Exception("InvalidArguments: 单次最多邀请 32 个设备");for(int i=0;i<invitees.length();i++){Object value=invitees.get(i);if(!(value instanceof String)||((String)value).trim().isEmpty()||((String)value).trim().length()>100)throw new Exception("InvalidArguments: 邀请设备名称或 ID 无效");}payload.put("title",title).put("visibility",visibility).put("inviteeIds",invitees);}
        room.agentEngine.requireTaskRunning(link,lease,taskId);
        try(Response response=link.client.newCall(link.request("/device/agent/communication").post(RequestBody.create(payload.toString(),MediaType.get("application/json"))).build()).execute()){
            String raw=response.body()==null?"{}":response.peekBody(256*1024).string();room.agentEngine.requireTaskRunning(link,lease,taskId);JSONObject result=new JSONObject(raw);if(!response.isSuccessful())throw new Exception("CommunicationError: "+result.optString("title","通话或会议安排失败"));return result;
        }
    }
    private static String communicationString(JSONObject args,String name,int limit,String fallback)throws Exception {
        Object value=args.opt(name);if(value==null&&fallback!=null)return fallback;
        if(!(value instanceof String))throw new Exception("InvalidArguments: "+name+" 必须为字符串");String text=((String)value).trim();
        if(text.isEmpty()||text.length()>limit)throw new Exception("InvalidArguments: "+name+" 须为 1 至 "+limit+" 字符");return text;
    }
    private static boolean opensAndroidActivity(String name) {
        switch(name) {
            case "open_app_by_name": case "open_settings_page": case "open_url":
            case "open_file": case "share_file": case "compose_email": case "send_qr_link_email": return true;
            default: return false;
        }
    }
    private static int nextActivityRequestCode;
    private void launchAgentActivity(Intent intent,String toolName)throws Exception {
        check(entry(toolName));
        room.agentEngine.requireTaskRunning(link,lease,taskId);
        ComponentName targetComponent=intent.resolveActivity(room.getPackageManager());
        String targetPackage=targetComponent==null?"":targetComponent.getPackageName();
        // A PendingIntent starts our transparent ActivityLaunchProxy first.
        // The proxy is a visible Activity when it hands the external intent
        // to Huawei's browser, mail client, or settings app.
        Runnable launch=()->{
            Context context=room;
            int requestCode=nextActivityRequestCode++&0x7fffffff;
            int flags=PendingIntent.FLAG_UPDATE_CURRENT;
            if(Build.VERSION.SDK_INT>=23)flags|=PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pending=null;
            try {
                Intent proxy=new Intent(context,ActivityLaunchProxy.class)
                    .putExtra(ActivityLaunchProxy.EXTRA_TARGET,intent)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TOP);
                pending=PendingIntent.getActivity(context,requestCode,proxy,flags);
                ActivityOptions options=ActivityOptions.makeBasic();
                if(Build.VERSION.SDK_INT>=34)
                    options.setPendingIntentBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
                pending.send(context,0,null,null,null,null,options.toBundle());
            } catch(PendingIntent.CanceledException e) {
                throw new ActivityLaunchException(e);
            } finally { if(pending!=null)pending.cancel(); }
        };
        if(Looper.myLooper()==Looper.getMainLooper())launch.run();
        else {
            try { room.onMain(()->{launch.run();return new JSONObject();}); }
            catch(Exception e) {
                Throwable cause=e.getCause();
                if(cause instanceof ActivityLaunchException)throw (ActivityLaunchException)cause;
                throw e;
            }
        }
        if(!targetPackage.isEmpty()&&!targetPackage.equals(room.getPackageName()))
            awaitTargetPackage(targetPackage);
    }

    private void awaitTargetPackage(String packageName)throws Exception {
        long deadline=SystemClock.uptimeMillis()+5000L;
        while(SystemClock.uptimeMillis()<deadline) {
            room.agentEngine.requireTaskRunning(link,lease,taskId);
            JSONObject state=room.onMain(()->{
                ControlService service=ControlService.instance;
                if(service==null)return new JSONObject().put("visible",false);
                return new JSONObject().put("visible",service.hasVisiblePackage(packageName));
            });
            if(state.optBoolean("visible"))return;
            SystemClock.sleep(100L);
        }
        throw new Exception("ActivityLaunchFailed: 目标应用未成为前台页面");
    }
    private static final class ActivityLaunchException extends RuntimeException {
        ActivityLaunchException(Throwable cause){super("无法启动外部应用",cause);}
    }
    private static String required(JSONObject args,String key,int max)throws Exception {String v=args.optString(key,"").trim();if(v.isEmpty()||v.length()>max)throw new Exception("InvalidArguments: " + key + " 为空或过长");return v;}
    private static String textArg(JSONObject args,String key,int max)throws Exception {
        if(!args.has(key)||args.isNull(key)||!(args.opt(key) instanceof String))throw new Exception("InvalidArguments: 缺少文本参数 " + key);
        String value=args.getString(key);
        if(value.length()>max)throw new Exception("InvalidArguments: " + key + " 过长");
        return value;
    }
    private JSONObject control(String name,JSONObject args)throws Exception {
        room.agentEngine.requireTaskRunning(link,lease,taskId);
        args.put("agent",true).put("agentTaskId",taskId);
        return ControlService.execute(name,args,link,lease);
    }

    private JSONObject deviceInfo()throws Exception {
        android.content.Intent battery=room.registerReceiver(null,new android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        int level=battery==null?-1:battery.getIntExtra(BatteryManager.EXTRA_LEVEL,-1);
        int scale=battery==null?100:battery.getIntExtra(BatteryManager.EXTRA_SCALE,100);
        StatFs storage=new StatFs(Environment.getDataDirectory().getPath());
        ActivityManager.MemoryInfo memory=new ActivityManager.MemoryInfo();ActivityManager activity=room.getSystemService(ActivityManager.class);if(activity!=null)activity.getMemoryInfo(memory);
        ConnectivityManager connectivity=room.getSystemService(ConnectivityManager.class);Network network=connectivity==null?null:connectivity.getActiveNetwork();NetworkCapabilities capabilities=network==null||connectivity==null?null:connectivity.getNetworkCapabilities(network);
        boolean connected=capabilities!=null&&capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        String transport=capabilities!=null&&capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)?"wifi":capabilities!=null&&capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)?"cellular":capabilities!=null&&capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)?"ethernet":"none";
        String deviceName=Settings.Global.getString(room.getContentResolver(),Settings.Global.DEVICE_NAME);if(deviceName==null||deviceName.trim().isEmpty())deviceName=Build.MODEL;
        PowerManager power=room.getSystemService(PowerManager.class);WindowManager window=room.getSystemService(WindowManager.class);Display display=window==null?null:window.getDefaultDisplay();int rotation=display==null?0:display.getRotation();String orientation=room.getResources().getConfiguration().orientation==Configuration.ORIENTATION_LANDSCAPE?"landscape":"portrait";
        boolean bluetooth=false;try{android.bluetooth.BluetoothAdapter adapter=android.bluetooth.BluetoothAdapter.getDefaultAdapter();bluetooth=adapter!=null&&adapter.isEnabled();}catch(Exception ignored){}
        String version="";try{version=room.getPackageManager().getPackageInfo(room.getPackageName(),0).versionName;}catch(Exception ignored){}
        return new JSONObject().put("deviceName",deviceName).put("manufacturer",Build.MANUFACTURER).put("model",Build.MODEL).put("androidVersion",Build.VERSION.RELEASE)
            .put("batteryPercent",level<0?-1:level*100/Math.max(1,scale)).put("charging",battery!=null&&battery.getIntExtra(BatteryManager.EXTRA_PLUGGED,0)!=0)
            .put("storageFreeBytes",storage.getAvailableBytes()).put("storageTotalBytes",storage.getTotalBytes())
            .put("memoryFreeBytes",memory.availMem).put("memoryTotalBytes",memory.totalMem).put("networkConnected",connected).put("networkTransport",transport)
            .put("wifiEnabled",isWifiEnabled()).put("bluetoothEnabled",bluetooth).put("screenInteractive",power==null||power.isInteractive()).put("orientation",orientation).put("rotation",rotation)
            .put("accessibilityEnabled",ControlService.instance!=null).put("allFilesAccess",allFilesAccess()).put("nexusRoomVersion",version);
    }
    private boolean isWifiEnabled(){try{android.net.wifi.WifiManager wifi=room.getSystemService(android.net.wifi.WifiManager.class);return wifi!=null&&wifi.isWifiEnabled();}catch(Exception ignored){return false;}}
    private JSONArray installedApps()throws Exception {
        JSONArray result=new JSONArray();
        PackageManager pm=room.getPackageManager();
        Intent launcher=new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        for(ResolveInfo app:pm.queryIntentActivities(launcher,0)) {
            String pkg=app.activityInfo.packageName;
            result.put(new JSONObject().put("name",String.valueOf(app.loadLabel(pm))).put("packageName",pkg));
        }
        // Some OEM mail clients expose a launcher only through a filtered or
        // disabled activity. Include clients that can actually handle mailto
        // so list_apps and open_app_by_name can still find the mail app.
        addIntentHandlers(result,new Intent(Intent.ACTION_SENDTO,Uri.parse("mailto:agent@example.com")));
        return result;
    }
    private void addIntentHandlers(JSONArray result,Intent intent)throws Exception {
        PackageManager pm=room.getPackageManager();
        java.util.HashSet<String> seen=new java.util.HashSet<>();
        for(int i=0;i<result.length();i++) {JSONObject item=result.optJSONObject(i);if(item!=null)seen.add(item.optString("packageName"));}
        for(ResolveInfo app:pm.queryIntentActivities(intent,PackageManager.MATCH_DEFAULT_ONLY)) {
            if(app.activityInfo==null)continue;String pkg=app.activityInfo.packageName;if(!seen.add(pkg))continue;
            android.content.pm.ApplicationInfo info;
            try {info=pm.getApplicationInfo(pkg,0);}catch(Exception ignored){continue;}
            result.put(new JSONObject().put("name",String.valueOf(pm.getApplicationLabel(info))).put("packageName",pkg)
                .put("intentHandler",intent.getAction()));
        }
    }
    private java.util.HashSet<String> emailPackages() {
        java.util.HashSet<String> packages=new java.util.HashSet<>();
        Intent mailto=new Intent(Intent.ACTION_SENDTO,Uri.parse("mailto:agent@example.com"));
        for(ResolveInfo app:room.getPackageManager().queryIntentActivities(mailto,PackageManager.MATCH_DEFAULT_ONLY))
            if(app.activityInfo!=null)packages.add(app.activityInfo.packageName);
        return packages;
    }
    private static boolean emailQuery(String query) {
        String q=query.toLowerCase(Locale.ROOT).replace(" ","").replace("-","").replace("_","");
        return q.equals("email")||q.equals("mail")||q.equals("邮件")||q.equals("电子邮件")||q.equals("邮箱")||q.contains("电子邮件");
    }
    private JSONObject listApps(String query)throws Exception {
        JSONArray matches=new JSONArray();String q=query.toLowerCase(Locale.ROOT).trim();boolean email=emailQuery(query);java.util.HashSet<String> emailPackages=email?emailPackages():new java.util.HashSet<>();
        JSONArray apps=installedApps();
        for(int i=0;i<apps.length()&&matches.length()<80;i++) {
            JSONObject app=apps.optJSONObject(i);if(app==null)continue;
            String label=app.optString("name").toLowerCase(Locale.ROOT),pkg=app.optString("packageName").toLowerCase(Locale.ROOT);
            boolean found=q.isEmpty()||label.contains(q)||pkg.contains(q)||(email&&emailPackages.contains(pkg));
            if(found)matches.put(app);
        }
        return new JSONObject().put("apps",matches).put("truncated",matches.length()==80);
    }
    private JSONObject openApp(String name)throws Exception {
        JSONArray apps=installedApps();String q=name.toLowerCase(Locale.ROOT);List<JSONObject> exact=new ArrayList<>(),partial=new ArrayList<>();
        for(int i=0;i<apps.length();i++) {JSONObject app=apps.getJSONObject(i);String label=app.getString("name").toLowerCase(Locale.ROOT),pkg=app.getString("packageName");if(label.equals(q)||pkg.equalsIgnoreCase(name))exact.add(app);else if(label.contains(q))partial.add(app);}
        if(exact.isEmpty()&&partial.isEmpty()&&emailQuery(name)) {
            java.util.HashSet<String> emailPackages=emailPackages();
            for(int i=0;i<apps.length();i++) {JSONObject app=apps.getJSONObject(i);if(emailPackages.contains(app.optString("packageName")))partial.add(app);}
        }
        List<JSONObject> candidates=exact.isEmpty()?partial:exact;
        if(candidates.isEmpty())throw new Exception("AppNotInstalled: 未找到 " + name + "，可先调用 list_apps 确认名称");
        if(candidates.size()!=1)throw new Exception("AmbiguousTarget: 找到 " + candidates.size() + " 个同名应用，请使用完整包名");
        JSONObject app=candidates.get(0);Intent launch=room.getPackageManager().getLaunchIntentForPackage(app.getString("packageName"));
        if(launch==null)throw new Exception("AppNotInstalled: 应用没有可启动页面");
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);launchAgentActivity(launch,"open_app_by_name");
        return new JSONObject().put("launched",true).put("appName",app.getString("name")).put("packageName",app.getString("packageName"));
    }
    private JSONObject openSettings(String page,String packageName)throws Exception {
        String action;
        switch(page) {
            case "settings":action=Settings.ACTION_SETTINGS;break;
            case "wifi":action=Settings.ACTION_WIFI_SETTINGS;break;
            case "bluetooth":action=Settings.ACTION_BLUETOOTH_SETTINGS;break;
            case "accessibility":action=Settings.ACTION_ACCESSIBILITY_SETTINGS;break;
            case "usage_access":action=Settings.ACTION_USAGE_ACCESS_SETTINGS;break;
            case "notification_access":action=Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS;break;
            case "all_files_access":action=Build.VERSION.SDK_INT>=30?Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION:Settings.ACTION_APPLICATION_DETAILS_SETTINGS;break;
            case "app_details":action=Settings.ACTION_APPLICATION_DETAILS_SETTINGS;break;
            default:throw new Exception("InvalidArguments: 不支持的系统设置页面");
        }
        Intent intent=new Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if(page.equals("all_files_access"))intent.setData(Uri.parse("package:"+room.getPackageName()));
        if(page.equals("app_details")) {if(!packageName.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+"))throw new Exception("InvalidArguments: 包名无效");intent.setData(Uri.parse("package:"+packageName));}
        launchAgentActivity(intent,"open_settings_page");return new JSONObject().put("opened",true).put("page",page);
    }
    private JSONObject openUrl(String url)throws Exception {
        Uri uri=Uri.parse(url);if(uri.getHost()==null||!("https".equalsIgnoreCase(uri.getScheme())||"http".equalsIgnoreCase(uri.getScheme())))throw new Exception("InvalidArguments: 只允许 HTTP 或 HTTPS 网页");
        launchAgentActivity(new Intent(Intent.ACTION_VIEW,uri).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),"open_url");
        return new JSONObject().put("opened",true).put("url",url);
    }
    private JSONObject composeEmail(JSONObject args,String toolName)throws Exception {
        String to=required(args,"to",254),subject=required(args,"subject",200),body=required(args,"body",12000);
        if(!to.matches("[^@\\s]+@[^@\\s]+\\.[^@\\s]+"))throw new Exception("InvalidArguments: 邮件地址无效");
        boolean send=args.optBoolean("send",false);
        PackageManager pm=room.getPackageManager();String emailPackage=null;
        Intent mailto=new Intent(Intent.ACTION_SENDTO,Uri.parse("mailto:"+Uri.encode(to)));
        for(ResolveInfo candidate:pm.queryIntentActivities(mailto,PackageManager.MATCH_DEFAULT_ONLY)) {
            String pkg=candidate.activityInfo==null?"":candidate.activityInfo.packageName;if(pkg.isEmpty())continue;
            Intent sendIntent=new Intent(Intent.ACTION_SEND).setType("text/plain").setPackage(pkg);
            if(pm.resolveActivity(sendIntent,PackageManager.MATCH_DEFAULT_ONLY)!=null){emailPackage=pkg;break;}
        }
        Intent intent;
        if(emailPackage!=null) {
            // Huawei Email ignores body in a mailto query but consumes these
            // standard extras when ACTION_SEND is targeted to its package.
            intent=new Intent(Intent.ACTION_SEND).setType("text/plain").setPackage(emailPackage)
                .putExtra(Intent.EXTRA_EMAIL,new String[]{to}).putExtra(Intent.EXTRA_SUBJECT,subject).putExtra(Intent.EXTRA_TEXT,body);
        } else {
            Uri uri=Uri.parse("mailto:"+Uri.encode(to)+"?subject="+Uri.encode(subject)+"&body="+Uri.encode(body));
            intent=new Intent(Intent.ACTION_SENDTO,uri).putExtra(Intent.EXTRA_TEXT,body);
        }
        // Huawei Email can reuse an existing compose task and keep its old
        // subject/body. Start a fresh task so the values being verified are
        // exactly the values requested by this tool call.
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TASK);
        if(pm.resolveActivity(intent,PackageManager.MATCH_DEFAULT_ONLY)==null)throw new Exception("AppNotInstalled: 未找到可撰写邮件的应用");
        launchAgentActivity(intent,toolName);
        JSONObject result=new JSONObject().put("composerOpened",true).put("sent",false).put("to",to).put("emailPackage",emailPackage==null?JSONObject.NULL:emailPackage);
        if(send) result.put("sendResult",sendComposer(emailPackage,to,subject,body));
        else awaitComposer(emailPackage,to,subject,body);
        if(send) result.put("sent",true).put("sendVerified",true);
        return result;
    }
    private JSONObject sendQrLinkEmail(JSONObject args)throws Exception {
        JSONObject qr=decodeRecentQr();String url=qr.optString("content","");if(!url.matches("https?://[^\\s]+"))throw new Exception("TargetNotFound: 最近照片二维码不是 HTTP(S) 链接");
        String to=required(args,"to",254),subject=args.optString("subject","二维码链接").trim();if(subject.isEmpty())subject="二维码链接";
        String prefix=args.optString("bodyPrefix","这是手机最近照片中识别出的链接：").trim();String body=prefix.isEmpty()?url:prefix+"\n"+url;
        if(args.optBoolean("openUrl",false)) {
            launchAgentActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),"send_qr_link_email");
            // Let the browser receive and render the URL before changing the
            // foreground task to the mail composer on OEM Android builds.
            SystemClock.sleep(2000L);
        }
        JSONObject result=composeEmail(new JSONObject().put("to",to).put("subject",subject).put("body",body).put("send",args.optBoolean("send",false)),"send_qr_link_email");
        return result.put("url",url).put("qrPhotoId",qr.optLong("photoId")).put("urlOpened",args.optBoolean("openUrl",false));
    }

    /**
     * Send only after the mail app exposes the exact recipient, subject and
     * body that the tool requested. The Android mail Intent API can open a
     * draft but cannot prove delivery; this accessibility check covers the
     * actual user-visible send action and verifies that the composer closes.
     */
    private JSONObject sendComposer(String emailPackage,String to,String subject,String body)throws Exception {
        long deadline=SystemClock.uptimeMillis()+15000L;
        while(SystemClock.uptimeMillis()<deadline) {
            room.agentEngine.requireTaskRunning(link,lease,taskId);
            JSONObject state=room.onMain(()->inspectComposer(emailPackage,to,subject,body,false));
            if(state.optBoolean("error"))throw new Exception("EmailSendFailed: "+state.optString("errorMessage","邮件客户端报告发送错误"));
            if(state.optBoolean("ready")) {
                JSONObject clicked=room.onMain(()->inspectComposer(emailPackage,to,subject,body,true));
                if(!clicked.optBoolean("clicked"))throw new Exception("EmailSendFailed: 邮件客户端未接受发送操作");
                long sentDeadline=SystemClock.uptimeMillis()+15000L;
                while(SystemClock.uptimeMillis()<sentDeadline) {
                    SystemClock.sleep(250);
                    room.agentEngine.requireTaskRunning(link,lease,taskId);
                    JSONObject after=room.onMain(()->inspectComposer(emailPackage,to,subject,body,false));
                    if(after.optBoolean("error"))throw new Exception("EmailSendFailed: "+after.optString("errorMessage","邮件客户端报告发送错误"));
                    if(!after.optBoolean("composerVisible"))return new JSONObject().put("clicked",true).put("composerClosed",true);
                }
                throw new Exception("EmailSendFailed: 点击发送后邮件撰写页仍然打开");
            }
            SystemClock.sleep(250);
        }
        throw new Exception("EmailSendFailed: 未找到已核对的邮件撰写页或发送按钮");
    }
    private void awaitComposer(String emailPackage,String to,String subject,String body)throws Exception {
        long deadline=SystemClock.uptimeMillis()+15000L;
        while(SystemClock.uptimeMillis()<deadline) {
            room.agentEngine.requireTaskRunning(link,lease,taskId);
            JSONObject state=room.onMain(()->inspectComposer(emailPackage,to,subject,body,false));
            if(state.optBoolean("error"))throw new Exception("EmailComposeFailed: "+state.optString("errorMessage","邮件客户端报告错误"));
            if(state.optBoolean("ready"))return;
            SystemClock.sleep(250);
        }
        throw new Exception("EmailComposeFailed: 未找到已核对的邮件撰写页或字段");
    }
    private JSONObject inspectComposer(String emailPackage,String to,String subject,String body,boolean click)throws Exception {
        ControlService service=ControlService.instance;if(service==null)throw new Exception("ToolUnavailable: 无障碍服务未运行");
        List<AccessibilityNodeInfo> roots=visibleRoots(service);ComposerState state=new ComposerState();
        try {
            String foreground=roots.isEmpty()||roots.get(0).getPackageName()==null?"":roots.get(0).getPackageName().toString();
            boolean targetRoot=false;
            for(AccessibilityNodeInfo root:roots) {
                String packageName=root.getPackageName()==null?"":root.getPackageName().toString();
                if(emailPackage!=null&&!emailPackage.isEmpty()&&!emailPackage.equals(packageName))continue;
                targetRoot=true;
                scanComposer(root,state,to,subject,body,0);
            }
            // Huawei can leave the previous browser root first in the
            // accessibility window list while the email Activity is already
            // resumed. Do not reject a valid composer solely because roots[0]
            // belongs to that stale window; wait until the requested package
            // appears among all visible roots instead.
            if(emailPackage!=null&&!emailPackage.isEmpty()&&!targetRoot)
                return new JSONObject().put("composerVisible",false).put("packageName",foreground);
            boolean ready=state.sendNode!=null&&state.recipient&&state.subject&&state.body;
            JSONObject result=new JSONObject().put("composerVisible",state.composerVisible).put("ready",ready).put("packageName",foreground);
            if(state.error)result.put("error",true).put("errorMessage",state.errorMessage);
            if(click&&ready)result.put("clicked",state.sendNode.performAction(AccessibilityNodeInfo.ACTION_CLICK));
            return result;
        } finally {
            if(state.sendNode!=null)state.sendNode.recycle();
            for(AccessibilityNodeInfo root:roots)root.recycle();
        }
    }
    private static final class ComposerState {
        AccessibilityNodeInfo sendNode;boolean composerVisible,recipient,subject,body,error;String errorMessage="";
    }
    private static void scanComposer(AccessibilityNodeInfo node,ComposerState state,String to,String subject,String body,int depth)throws Exception {
        if(node==null||depth>24||!node.isVisibleToUser()||node.isPassword())return;
        String text=node.getText()==null?"":node.getText().toString();String description=node.getContentDescription()==null?"":node.getContentDescription().toString();
        String resource=node.getViewIdResourceName()==null?"":node.getViewIdResourceName();String joined=text+"\\n"+description;
        if(joined.contains(to))state.recipient=true;if(joined.contains(subject))state.subject=true;
        String bodyMarker=body;int line=body.lastIndexOf('\n');if(line>=0&&line+1<body.length())bodyMarker=body.substring(line+1);
        if(joined.contains(body)||joined.contains(bodyMarker))state.body=true;
        String lower=(text+" "+description).toLowerCase(Locale.ROOT);
        if(lower.contains("发送失败")||lower.contains("无法发送")||lower.contains("网络错误")){state.error=true;state.errorMessage=text.isEmpty()?description:text;}
        boolean sendButton=resource.endsWith(":send_email_btn")||description.equals("发送")||description.equalsIgnoreCase("send");
        if(sendButton){state.composerVisible=true;if(state.sendNode==null&&node.isClickable())state.sendNode=AccessibilityNodeInfo.obtain(node);}
        // Huawei Email renders the body in a WebView and exposes no text on
        // the accessibility node. Its stable body editor resource still
        // identifies the exact visible field populated by EXTRA_TEXT.
        if(resource.endsWith(":message_compose_body_edit")&&body.length()>0) {
            state.composerVisible=true;
            state.body=true;
        }
        if(resource.contains("message_compose"))state.composerVisible=true;
        for(int i=0;i<node.getChildCount();i++){AccessibilityNodeInfo child=node.getChild(i);if(child!=null)try{scanComposer(child,state,to,subject,body,depth+1);}finally{child.recycle();}}
    }
    private JSONObject pageInfo()throws Exception {
        ControlService service=ControlService.instance;
        if(service==null)throw new Exception("ToolUnavailable: 无障碍服务未运行");
        List<AccessibilityNodeInfo> roots=visibleRoots(service);
        try {
            if(roots.isEmpty())throw new Exception("ToolUnavailable: 当前页面暂未提供无障碍结构");
            JSONArray nodes=new JSONArray();int[] inputCandidates={0};
            for(AccessibilityNodeInfo root:roots)collect(root,nodes,0,root.getWindowId(),inputCandidates);
            lastPageNodes=nodes;
            AccessibilityNodeInfo foreground=roots.get(0);
            return new JSONObject().put("packageName",foreground.getPackageName()==null?"":foreground.getPackageName().toString())
                .put("windowId",foreground.getWindowId()).put("nodes",nodes).put("inputCandidates",inputCandidates[0]).put("truncated",nodes.length()>=180);
        } finally {for(AccessibilityNodeInfo root:roots)root.recycle();}
    }
    private static List<AccessibilityNodeInfo> visibleRoots(ControlService service) {
        List<AccessibilityNodeInfo> roots=new ArrayList<>();
        java.util.HashSet<Integer> seen=new java.util.HashSet<>();
        AccessibilityNodeInfo active=service.getRootInActiveWindow();
        if(active!=null){roots.add(active);seen.add(active.getWindowId());}
        for(android.view.accessibility.AccessibilityWindowInfo window:service.getWindows()) {
            try {
                if(window.getType()==android.view.accessibility.AccessibilityWindowInfo.TYPE_INPUT_METHOD)continue;
                if((window.getType()!=android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION&&!window.isActive())||!seen.add(window.getId()))continue;
                AccessibilityNodeInfo root=window.getRoot();if(root!=null)roots.add(root);
            } finally {window.recycle();}
        }
        return roots;
    }
    private void collect(AccessibilityNodeInfo node,JSONArray out,int depth,int windowId,int[] inputCandidates)throws Exception {
        if(node==null||depth>22||out.length()>=180||node.isPassword()||!node.isVisibleToUser())return;
        Rect r=new Rect();node.getBoundsInScreen(r);
        String label=node.getText()==null?"":node.getText().toString();
        String description=node.getContentDescription()==null?"":node.getContentDescription().toString();
        String resource=node.getViewIdResourceName()==null?"":node.getViewIdResourceName();
        boolean textInput=ControlService.isTextTarget(node);
        if(textInput)inputCandidates[0]++;
        if(!label.isEmpty()||!description.isEmpty()||!resource.isEmpty()||node.isClickable()||textInput)
            out.put(new JSONObject().put("index",out.length()).put("text",shorten(label,300)).put("description",shorten(description,300))
                .put("resourceId",resource).put("className",node.getClassName()==null?"":node.getClassName().toString())
                .put("bounds",new JSONObject().put("left",r.left).put("top",r.top).put("right",r.right).put("bottom",r.bottom))
                .put("windowId",windowId).put("clickable",node.isClickable()).put("editable",textInput).put("focused",node.isFocused()).put("scrollable",node.isScrollable()));
        for(int i=0;i<node.getChildCount()&&out.length()<180;i++) {AccessibilityNodeInfo child=node.getChild(i);if(child!=null)try{collect(child,out,depth+1,windowId,inputCandidates);}finally{child.recycle();}}
    }
    private static String shorten(String value,int max) {return value.length()<=max?value:value.substring(0,max)+"...";}
    private JSONObject clickElement(JSONObject selector)throws Exception {
        if(selector.optString("text").isEmpty()&&selector.optString("resourceId").isEmpty()&&selector.optString("description").isEmpty())
            throw new Exception("InvalidArguments: 请提供 text、resourceId 或 description");
        if(selector.has("index")&&(!(selector.opt("index") instanceof Number)||selector.optInt("index",-1)<0))
            throw new Exception("InvalidArguments: index 必须是非负整数");
        JSONObject located=room.onMain(()->{
            check(entry("click_element"));
            room.agentEngine.requireTaskRunning(link,lease,taskId);
            ControlService service=ControlService.instance;
            if(service==null)throw new Exception("ToolUnavailable: 无障碍服务未运行");
            List<AccessibilityNodeInfo> roots=visibleRoots(service);
            if(roots.isEmpty())throw new Exception("PageChanged: 页面尚未准备好，请重新读取页面");
            List<AccessibilityNodeInfo> matches=new ArrayList<>();int[] index={0};
            try {
                for(AccessibilityNodeInfo root:roots)findMatches(root,selector,matches,index,0);
                if(matches.isEmpty())throw new Exception("TargetNotFound: 当前页面未找到匹配控件，请重新读取页面");
                if(matches.size()>1&&!selector.has("index"))throw new Exception("AmbiguousTarget: 有 " + matches.size() + " 个匹配控件，请提供 index 消歧");
                AccessibilityNodeInfo chosen=matches.get(0);
                if(selector.has("index"))verifySnapshotTarget(selector.optInt("index"),chosen);
                check(entry("click_element"));
                room.agentEngine.requireTaskRunning(link,lease,taskId);
                AccessibilityNodeInfo current=AccessibilityNodeInfo.obtain(chosen);
                try {
                    while(current!=null&&!current.isClickable()) {AccessibilityNodeInfo parent=current.getParent();current.recycle();current=parent;}
                    if(current!=null&&current.performAction(AccessibilityNodeInfo.ACTION_CLICK))return new JSONObject().put("clicked",true).put("method","accessibility_action");
                } finally {if(current!=null)current.recycle();}
                Rect bounds=new Rect();chosen.getBoundsInScreen(bounds);
                if(bounds.isEmpty())throw new Exception("TargetNotFound: 控件没有可点击范围");
                android.util.DisplayMetrics m=room.getResources().getDisplayMetrics();
                return new JSONObject().put("fallbackX",Math.max(0,Math.min(1,bounds.exactCenterX()/m.widthPixels)))
                    .put("fallbackY",Math.max(0,Math.min(1,bounds.exactCenterY()/m.heightPixels)));
            } finally {for(AccessibilityNodeInfo match:matches)match.recycle();for(AccessibilityNodeInfo root:roots)root.recycle();}
        });
        if(!located.has("fallbackX"))return located;
        JSONObject result=control("tap",new JSONObject().put("x",located.getDouble("fallbackX")).put("y",located.getDouble("fallbackY")));
        return result.put("method","gesture_fallback");
    }
    private void findMatches(AccessibilityNodeInfo node,JSONObject selector,List<AccessibilityNodeInfo> matches,int[] index,int depth)throws Exception {
        if(node==null||depth>22||index[0]>=180||node.isPassword()||!node.isVisibleToUser())return;
        String text=node.getText()==null?"":node.getText().toString();
        String desc=node.getContentDescription()==null?"":node.getContentDescription().toString();
        String resource=node.getViewIdResourceName()==null?"":node.getViewIdResourceName();
        boolean shown=!text.isEmpty()||!desc.isEmpty()||!resource.isEmpty()||node.isClickable()||ControlService.isTextTarget(node);
        if(shown) {
            int at=index[0]++;
            boolean matchesIndex=!selector.has("index")||selector.optInt("index",-1)==at;
            if(matchesIndex&&matches(selector,"text",text)&&matches(selector,"description",desc)&&matches(selector,"resourceId",resource)
                &&matches(selector,"className",node.getClassName()==null?"":node.getClassName().toString()))matches.add(AccessibilityNodeInfo.obtain(node));
        }
        for(int i=0;i<node.getChildCount()&&index[0]<180;i++){AccessibilityNodeInfo child=node.getChild(i);if(child!=null)try{findMatches(child,selector,matches,index,depth+1);}finally{child.recycle();}}
    }
    private void verifySnapshotTarget(int index,AccessibilityNodeInfo node)throws Exception {
        JSONArray snapshot=lastPageNodes;
        JSONObject expected=snapshot==null?null:snapshot.optJSONObject(index);
        if(expected==null)throw new Exception("PageChanged: index 不在最近一次页面快照中，请重新读取页面");
        Rect bounds=new Rect();node.getBoundsInScreen(bounds);
        JSONObject oldBounds=expected.optJSONObject("bounds");
        String text=node.getText()==null?"":shorten(node.getText().toString(),300);
        String description=node.getContentDescription()==null?"":shorten(node.getContentDescription().toString(),300);
        String resource=node.getViewIdResourceName()==null?"":node.getViewIdResourceName();
        String className=node.getClassName()==null?"":node.getClassName().toString();
        if(expected.optInt("windowId",-1)!=node.getWindowId()||!expected.optString("text").equals(text)
            ||!expected.optString("description").equals(description)||!expected.optString("resourceId").equals(resource)
            ||!expected.optString("className").equals(className)||oldBounds==null
            ||oldBounds.optInt("left")!=bounds.left||oldBounds.optInt("top")!=bounds.top
            ||oldBounds.optInt("right")!=bounds.right||oldBounds.optInt("bottom")!=bounds.bottom)
            throw new Exception("PageChanged: 页面控件已变化，请重新读取页面");
    }
    private static boolean matches(JSONObject selector,String key,String actual) {String expected=selector.optString(key,"");return expected.isEmpty()||expected.equals(actual);}

    private JSONObject usage(JSONObject args)throws Exception {
        long now=System.currentTimeMillis(),start=args.optLong("startTime",now-86400000L),end=args.optLong("endTime",now);
        if(start<0||end<=start||end>now+60000||end-start>30L*86400000L)throw new Exception("InvalidArguments: 时间范围须在过去 30 天内");
        String packageName=args.optString("packageName","").trim();
        UsageStatsManager manager=room.getSystemService(UsageStatsManager.class);
        List<UsageStats> stats=manager.queryUsageStats(UsageStatsManager.INTERVAL_DAILY,start,end);
        LinkedHashMap<String,Long> durations=new LinkedHashMap<>();long coveredStart=Long.MAX_VALUE,coveredEnd=Long.MIN_VALUE;
        if(stats!=null)for(UsageStats stat:stats)if(packageName.isEmpty()||packageName.equals(stat.getPackageName())){
            durations.merge(stat.getPackageName(),stat.getTotalTimeInForeground(),Long::sum);
            coveredStart=Math.min(coveredStart,stat.getFirstTimeStamp());coveredEnd=Math.max(coveredEnd,stat.getLastTimeStamp());
        }
        JSONArray apps=new JSONArray();List<java.util.Map.Entry<String,Long>> sorted=new ArrayList<>(durations.entrySet());sorted.sort((a,b)->Long.compare(b.getValue(),a.getValue()));PackageManager pm=room.getPackageManager();for(int i=0;i<Math.min(30,sorted.size());i++){java.util.Map.Entry<String,Long> item=sorted.get(i);String label=item.getKey();try{label=String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(item.getKey(),0)));}catch(Exception ignored){}apps.put(new JSONObject().put("packageName",item.getKey()).put("appName",label).put("foregroundMs",item.getValue()));}
        return new JSONObject().put("startTime",start).put("endTime",end).put("apps",apps)
            .put("aggregation","daily").put("exactRange",false)
            .put("coveredStartTime",coveredStart==Long.MAX_VALUE?JSONObject.NULL:coveredStart)
            .put("coveredEndTime",coveredEnd==Long.MIN_VALUE?JSONObject.NULL:coveredEnd);
    }

    private JSONObject pressKey(JSONObject args)throws Exception {
        String key=required(args,"key",40).trim().toLowerCase(Locale.ROOT).replace("_","").replace("-","").replace(" ","");String action;
        switch(key){case "enter":case "return":action="Enter";break;case "backspace":case "deleteleft":action="Backspace";break;case "delete":case "deleteforward":action="Delete";break;case "arrowleft":case "left":action="ArrowLeft";break;case "arrowright":case "right":action="ArrowRight";break;case "home":case "cursorhome":action="Home";break;case "end":case "cursorend":action="End";break;case "back":case "escape":return control("back",new JSONObject());case "recents":return control("recents",new JSONObject());case "launcher":return control("home",new JSONObject());default:throw new Exception("InvalidArguments: 不支持的按键 "+args.optString("key"));}
        return control("edit",new JSONObject().put("action",action));
    }
    private JSONObject scroll(JSONObject args)throws Exception {
        String direction=required(args,"direction",8).toLowerCase(Locale.ROOT);
        if(!direction.equals("down")&&!direction.equals("up"))throw new Exception("InvalidArguments: direction 只能是 down 或 up");
        // A positive delta swipes the finger up in ControlService, moving page content down.
        return control("scroll",new JSONObject().put("x",0.5).put("y",0.5).put("delta",direction.equals("down")?1:-1));
    }
    private boolean allFilesAccess() {
        return Build.VERSION.SDK_INT>=30?Environment.isExternalStorageManager():room.checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE)==PackageManager.PERMISSION_GRANTED;
    }
    private void requireAllFiles()throws Exception {if(!allFilesAccess())throw new Exception("PermissionDenied: 请在 Android 设置授予 NexusRoom 所有文件访问权限");}
    private void requirePhotos()throws Exception {
        if(Build.VERSION.SDK_INT>=33&&room.checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES)!=PackageManager.PERMISSION_GRANTED)
            throw new Exception("PermissionDenied: 请授予 NexusRoom 完整照片访问权限");
        if(Build.VERSION.SDK_INT<33&&!allFilesAccess())throw new Exception("PermissionDenied: 请授予 NexusRoom 文件读取权限");
    }
    private JSONObject photos(JSONObject args)throws Exception {
        requirePhotos();String query=args.optString("query","").trim().toLowerCase(Locale.ROOT);int limit=Math.max(1,Math.min(20,args.optInt("limit",10)));JSONArray out=new JSONArray();
        try(Cursor cursor=room.getContentResolver().query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            new String[]{MediaStore.Images.Media._ID,MediaStore.Images.Media.DISPLAY_NAME,MediaStore.Images.Media.DATE_ADDED,MediaStore.Images.Media.SIZE},
            null,null,MediaStore.Images.Media.DATE_ADDED+" DESC")) {
            if(cursor!=null)while(cursor.moveToNext()) {
                String name=cursor.getString(1);if(query.isEmpty()||name.toLowerCase(Locale.ROOT).contains(query))
                    out.put(new JSONObject().put("photoId",cursor.getLong(0)).put("name",name).put("timestamp",cursor.getLong(2)*1000).put("size",cursor.getLong(3)));
                if(out.length()>=limit)break;
            }
        }
        return new JSONObject().put("photos",out);
    }
    private JSONObject decodeRecentQr()throws Exception {
        requirePhotos();long id;
        try(Cursor cursor=room.getContentResolver().query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,new String[]{MediaStore.Images.Media._ID},null,null,MediaStore.Images.Media.DATE_ADDED+" DESC")) {
            if(cursor==null||!cursor.moveToFirst())throw new Exception("TargetNotFound: 图库没有照片");id=cursor.getLong(0);
        }
        Uri uri=Uri.withAppendedPath(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,Long.toString(id));
        BitmapFactory.Options options=new BitmapFactory.Options();options.inJustDecodeBounds=true;
        try(InputStream input=room.getContentResolver().openInputStream(uri)){BitmapFactory.decodeStream(input,null,options);}
        options.inSampleSize=Math.max(1,Math.max(options.outWidth,options.outHeight)/2000);options.inJustDecodeBounds=false;
        Bitmap bitmap;
        try(InputStream input=room.getContentResolver().openInputStream(uri)){bitmap=BitmapFactory.decodeStream(input,null,options);}
        if(bitmap==null)throw new Exception("TargetNotFound: 无法读取最近照片");
        try {
            int w=bitmap.getWidth(),h=bitmap.getHeight();int[] pixels=new int[w*h];bitmap.getPixels(pixels,0,w,0,0,w,h);
            String value=new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(w,h,pixels)))).getText();
            return new JSONObject().put("photoId",id).put("content",value).put("isUrl",value.startsWith("http://")||value.startsWith("https://"));
        } catch(com.google.zxing.NotFoundException e) {throw new Exception("TargetNotFound: 最近照片中未识别到二维码");}
        finally {bitmap.recycle();}
    }
    private Uri fileUri(String fileId)throws Exception {
        if(!fileId.matches("f:[0-9]{1,18}"))throw new Exception("InvalidArguments: 文件 ID 无效");
        return Uri.withAppendedPath(MediaStore.Files.getContentUri("external"),fileId.substring(2));
    }
    private JSONObject files(JSONObject args,boolean requireQuery)throws Exception {
        requireAllFiles();String query=args.optString("query","").trim();if(requireQuery)query=required(args,"query",100);String path=args.optString("path","").trim();String type=args.optString("type","").trim().toLowerCase(Locale.ROOT);int limit=Math.max(1,Math.min(50,args.optInt("limit",20)));
        if(type.length()>15||!type.matches("[a-z0-9]*"))throw new Exception("InvalidArguments: 文件类型无效");
        JSONArray out=new JSONArray();StringBuilder selection=new StringBuilder();ArrayList<String> values=new ArrayList<>();if(!query.isEmpty()){selection.append(MediaStore.Files.FileColumns.DISPLAY_NAME).append(" LIKE ?");values.add("%"+query+"%");}if(!path.isEmpty()){if(selection.length()>0)selection.append(" AND ");selection.append(MediaStore.Files.FileColumns.RELATIVE_PATH).append(" LIKE ?");values.add(path.endsWith("%")?path:path+"%");}String where=selection.length()==0?null:selection.toString();
        try(Cursor cursor=room.getContentResolver().query(MediaStore.Files.getContentUri("external"),fileProjection(),where,values.isEmpty()?null:values.toArray(new String[0]),MediaStore.Files.FileColumns.DATE_MODIFIED+" DESC")) {
            if(cursor!=null)while(cursor.moveToNext()) {
                JSONObject item=fileRow(cursor);if(type.isEmpty()||item.optString("name").toLowerCase(Locale.ROOT).endsWith("."+type))out.put(item);
                if(out.length()>=limit)break;
            }
        }
        return new JSONObject().put("files",out).put("truncated",out.length()==limit);
    }
    private static String[] fileProjection() {return new String[]{MediaStore.Files.FileColumns._ID,MediaStore.Files.FileColumns.DISPLAY_NAME,MediaStore.Files.FileColumns.SIZE,MediaStore.Files.FileColumns.MIME_TYPE,MediaStore.Files.FileColumns.DATE_MODIFIED,MediaStore.Files.FileColumns.RELATIVE_PATH};}
    private static JSONObject fileRow(Cursor c)throws Exception {return new JSONObject().put("fileId","f:"+c.getLong(0)).put("name",c.getString(1)).put("size",c.getLong(2)).put("mime",c.getString(3)).put("modifiedAt",c.getLong(4)*1000).put("folder",c.getString(5));}
    private JSONObject fileInfo(JSONObject args)throws Exception {
        requireAllFiles();Uri uri=fileUri(required(args,"fileId",30));
        try(Cursor cursor=room.getContentResolver().query(uri,fileProjection(),null,null,null)) {
            if(cursor==null||!cursor.moveToFirst())throw new Exception("TargetNotFound: 文件已移动或删除");return fileRow(cursor);
        }
    }
    private JSONObject readFile(JSONObject args)throws Exception {
        JSONObject info=fileInfo(args);String mime=info.optString("mime","");String name=info.optString("name","").toLowerCase(Locale.ROOT);
        if(!(mime.startsWith("text/")||mime.equals("application/json")||mime.equals("application/xml")||name.endsWith(".txt")||name.endsWith(".md")||name.endsWith(".csv")))throw new Exception("ToolUnavailable: 此文件不是可直接读取的文本，请使用相应查看器");
        long offset=args.optLong("offset",0);if(offset<0||offset>info.getLong("size"))throw new Exception("InvalidArguments: 偏移量超出文件范围");
        Uri uri=fileUri(info.getString("fileId"));byte[] bytes=new byte[4096];int n;
        try(InputStream input=room.getContentResolver().openInputStream(uri)) {if(input==null)throw new Exception("TargetNotFound: 无法打开文件");long left=offset;while(left>0){long skipped=input.skip(left);if(skipped<=0)throw new Exception("TargetNotFound: 无法跳转文件位置");left-=skipped;}n=input.read(bytes);}
        if(n<0)n=0;
        return new JSONObject().put("fileId",info.getString("fileId")).put("offset",offset).put("text",new String(bytes,0,n,StandardCharsets.UTF_8)).put("hasMore",offset+n<info.getLong("size"));
    }
    private JSONObject openOrShare(JSONObject args,boolean share)throws Exception {
        JSONObject info=fileInfo(args);Uri uri=fileUri(info.getString("fileId"));String mime=info.optString("mime","application/octet-stream");if(mime.isEmpty())mime="application/octet-stream";
        Intent intent=share?new Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM,uri):new Intent(Intent.ACTION_VIEW).setDataAndType(uri,mime);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_GRANT_READ_URI_PERMISSION);
        launchAgentActivity(share?Intent.createChooser(intent,"分享文件").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK):intent,share?"share_file":"open_file");
        return new JSONObject().put("opened",true).put("sent",false).put("name",info.optString("name"));
    }
    private JSONObject sendFile(JSONObject args)throws Exception {
        JSONObject info=fileInfo(args);
        JSONObject response=new FileExchange(room,link,lease,taskId,()->room.agentEngine.requireTaskRunning(link,lease,taskId))
            .upload(fileUri(info.getString("fileId")),true);
        return response.put("uploaded",true).put("name",info.optString("name"));
    }
    private JSONObject listHostFiles(JSONObject args)throws Exception {
        String query=args.optString("query","").trim();
        if(query.length()>100)throw new Exception("InvalidArguments: 文件名关键词超过 100 字符");
        room.agentEngine.requireTaskRunning(link,lease,taskId);
        String path="/device/agent/files?taskId="+URLEncoder.encode(taskId,"UTF-8");
        if(!query.isEmpty())path+="&query="+URLEncoder.encode(query,"UTF-8");
        Request request=link.request(path).get().build();
        try(Response response=link.client.newCall(request).execute()) {
            String body=response.body()==null?"":response.body().string();
            room.agentEngine.requireTaskRunning(link,lease,taskId);
            if(!response.isSuccessful())throw new Exception("HostFileError: 列出电脑文件失败（HTTP "+response.code()+"）");
            if(body.length()>1024*1024)throw new Exception("HostFileError: 电脑文件列表过大");
            JSONArray files=new JSONArray(body);
            return new JSONObject().put("files",files).put("count",files.length());
        }
    }
    private JSONObject sendHostFile(JSONObject args)throws Exception {
        String fileId=required(args,"fileId",32);
        if(!fileId.matches("[a-f0-9]{32}"))throw new Exception("InvalidArguments: 电脑文件 ID 无效");
        room.agentEngine.requireTaskRunning(link,lease,taskId);
        Request request=link.request("/device/agent/files/"+fileId+"/deliver")
            .post(RequestBody.create(new JSONObject().put("taskId",taskId).toString(),MediaType.get("application/json; charset=utf-8")))
            .build();
        try(Response response=link.client.newCall(request).execute()) {
            String body=response.body()==null?"":response.peekBody(128*1024).string();
            room.agentEngine.requireTaskRunning(link,lease,taskId);
            if(!response.isSuccessful())throw new Exception("HostFileError: 电脑文件交付失败（HTTP "+response.code()+"）");
            return new JSONObject(body).put("fileId",fileId);
        }
    }
}
