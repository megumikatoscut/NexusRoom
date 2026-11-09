package com.nexusroom.android;

import android.content.ContentValues;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import okhttp3.MediaType;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okio.BufferedSink;

final class FileExchange {
    private static final long MAX = 512L * 1024 * 1024;
    interface TransferGuard { void check() throws Exception; }
    private final RoomService service;
    private final RoomService.RoomLink link;
    private final String lease;
    private final String taskId;
    private final TransferGuard guard;
    FileExchange(RoomService service,RoomService.RoomLink link) { this(service,link,null,null,null); }
    FileExchange(RoomService service,RoomService.RoomLink link,String lease) { this(service,link,lease,null,null); }
    FileExchange(RoomService service,RoomService.RoomLink link,String lease,TransferGuard guard) { this(service,link,lease,null,guard); }
    FileExchange(RoomService service,RoomService.RoomLink link,String lease,String taskId,TransferGuard guard) {
        this.service=service;this.link=link;this.lease=lease;this.taskId=taskId;this.guard=guard;
    }
    void require(boolean agent) throws Exception {
        if (!link.online || link.config.leaving || !link.config.files)
            throw new Exception("文件传输权限已关闭或设备离线");
        if (agent) {
            if (!link.config.agent) throw new Exception("Agent 权限已关闭");
            // An owning room alone is insufficient: this must be the exact lease that started the transfer.
            service.requireOwner(link,lease);
            if (guard != null) guard.check();
        }
    }
    JSONObject upload(Uri uri, boolean agent) throws Exception {
        require(agent);
        String name = "文件"; long size = -1;
        try (Cursor cursor = service.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) { name = cursor.getString(0); if (!cursor.isNull(1)) size = cursor.getLong(1); }
        }
        require(agent);
        if (size > MAX) throw new Exception("单个文件最大 512 MB");
        final long length = size;
        RequestBody body = new RequestBody() {
            @Override public MediaType contentType() { return MediaType.get("application/octet-stream"); }
            @Override public long contentLength() { return length; }
            @Override public void writeTo(BufferedSink sink) throws java.io.IOException {
                try (InputStream input = service.getContentResolver().openInputStream(uri)) {
                    if (input == null) throw new java.io.IOException("无法读取文件"); byte[] b = new byte[65536]; int count; long total = 0;
                    while (true) {
                        require(agent);
                        count = input.read(b);
                        if (count == -1) break;
                        require(agent);
                        total += count;
                        if (total > MAX) throw new Exception("文件过大");
                        sink.write(b, 0, count);
                    }
                    require(agent);
                } catch (Exception e) { throw new java.io.IOException(e.getMessage(), e); }
            }
        };
        require(agent);
        Request.Builder requestBuilder = link.request("/device/files")
            .header("X-File-Name", URLEncoder.encode(name, "UTF-8").replace("+", "%20"));
        if (agent && taskId != null && !taskId.isEmpty()) {
            if (!taskId.matches("[A-Za-z0-9_-]{8,80}") || guard == null)
                throw new Exception("Agent 文件任务标识无效");
            requestBuilder.header("X-Agent-Task-Id", taskId);
        }
        Request request = requestBuilder.post(body).build();
        try (Response response = link.client.newCall(request).execute()) {
            require(agent);
            if (!response.isSuccessful() || response.body() == null) throw new Exception("上传失败：HTTP " + response.code());
            JSONObject result = new JSONObject(response.body().string());
            require(agent);
            service.notice("已发送到电脑：" + name);
            return result;
        }
    }
    JSONObject receive(JSONObject args) throws Exception {
        boolean agent = args.optBoolean("agent");
        if (!args.optString("taskId","").isEmpty() && (!agent || guard == null || !args.optString("taskId").equals(taskId)))
            throw new Exception("Agent 文件任务标识缺少有效校验");
        require(agent);
        String id = args.getString("fileId"), name = args.getString("name"), expected = args.getString("sha256"); long size = args.getLong("size");
        if (!id.matches("[a-f0-9]{32}") || !expected.matches("[a-f0-9]{64}") || size < 0 || size > MAX || name.contains("/") || name.contains("\\") || name.length() > 180) throw new Exception("文件信息无效");
        if (agent) {
            JSONObject previous = previouslyReceived(id, expected, size);
            if (previous != null) return previous;
        }
        if (new android.os.StatFs(service.getCacheDir().getAbsolutePath()).getAvailableBytes() < size * 2 + 20L * 1024 * 1024) throw new Exception("手机存储空间不足");
        File temp = File.createTempFile("nexus-receive-", ".part", service.getCacheDir()); Uri destination = null;
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256"); long total = 0;
            try (Response response = link.client.newCall(link.request("/device/files/" + id).get().build()).execute(); OutputStream output = new FileOutputStream(temp)) {
                if (!response.isSuccessful() || response.body() == null) throw new Exception("下载失败：HTTP " + response.code());
                try (InputStream input = response.body().byteStream()) {
                    byte[] b = new byte[65536]; int count;
                    while (true) {
                        require(agent);
                        count = input.read(b);
                        if (count == -1) break;
                        require(agent);
                        total += count;
                        if (total > size) throw new Exception("文件大小异常");
                        digest.update(b, 0, count);
                        output.write(b, 0, count);
                    }
                }
            }
            String actual = RoomConfig.hex(digest.digest());
            if (total != size || !actual.equals(expected)) throw new Exception("文件不完整或 SHA-256 校验失败");
            require(agent);
            int dot = name.lastIndexOf('.');
            String mime = dot < 0 ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
            ContentValues values = new ContentValues(); values.put(MediaStore.Downloads.DISPLAY_NAME, name); values.put(MediaStore.Downloads.MIME_TYPE, mime == null ? "application/octet-stream" : mime); values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/NexusRoom"); values.put(MediaStore.Downloads.IS_PENDING, 1);
            destination = service.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (destination == null) throw new Exception("无法创建下载文件");
            require(agent);
            try (InputStream input = new FileInputStream(temp); OutputStream output = service.getContentResolver().openOutputStream(destination)) {
                if (output == null) throw new Exception("无法保存下载文件"); byte[] b = new byte[65536]; int n;
                while (true) {
                    require(agent);
                    n = input.read(b);
                    if (n == -1) break;
                    require(agent);
                    output.write(b, 0, n);
                }
            }
            require(agent);
            values.clear(); values.put(MediaStore.Downloads.IS_PENDING, 0);
            if (service.getContentResolver().update(destination, values, null, null) != 1)
                throw new Exception("下载文件提交失败");
            require(agent);
            // MediaStore chooses a unique name on collisions; report the name it actually saved.
            String savedName = name;
            try (Cursor cursor = service.getContentResolver().query(destination, new String[]{MediaStore.Downloads.DISPLAY_NAME}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) savedName = cursor.getString(0);
            }
            require(agent);
            // Persist after MediaStore commits and before returning. A Host timeout or task
            // cancellation after this point can safely retry the same transfer ID.
            if (agent) rememberReceipt(id, actual, size, destination);
            service.notice("已保存到 下载/NexusRoom：" + savedName);
            return new JSONObject().put("ok", true).put("sha256", actual).put("savedTo", "Download/NexusRoom/" + savedName);
        } catch (Exception e) {
            if (destination != null) try { service.getContentResolver().delete(destination, null, null); }
                catch (Exception cleanup) { e.addSuppressed(cleanup); }
            throw e;
        }
        finally { if (temp.exists()) temp.delete(); }
    }
    private SharedPreferences receipts() {
        return ReleaseStorage.preferences(service, "agent-file-receipts");
    }
    private String receiptKey(String id) { return link.config.deviceId + ":" + id; }
    private void rememberReceipt(String id,String sha256,long size,Uri uri) throws Exception {
        JSONObject value = new JSONObject().put("sha256",sha256).put("size",size).put("uri",uri.toString());
        if (!receipts().edit().putString(receiptKey(id),value.toString()).commit())
            throw new Exception("无法保存 Agent 收件记录");
    }
    private void forgetReceipt(String id) { receipts().edit().remove(receiptKey(id)).apply(); }
    private JSONObject previouslyReceived(String id,String expected,long size) throws Exception {
        String raw = receipts().getString(receiptKey(id),null);
        if (raw == null) return null;
        JSONObject record;
        try { record = new JSONObject(raw); }
        catch (Exception invalid) { forgetReceipt(id); return null; }
        if (!expected.equals(record.optString("sha256")) || size != record.optLong("size",-1)) return null;
        Uri uri = Uri.parse(record.optString("uri"));
        if (!"content".equals(uri.getScheme()) || !"media".equals(uri.getAuthority())) {
            forgetReceipt(id); return null;
        }
        String savedName, relativePath;
        try (Cursor cursor = service.getContentResolver().query(uri,
                new String[]{MediaStore.Downloads.DISPLAY_NAME,MediaStore.Downloads.RELATIVE_PATH,
                    MediaStore.Downloads.SIZE,MediaStore.Downloads.IS_PENDING},null,null,null)) {
            if (cursor == null) throw new Exception("无法核验已收文件");
            if (!cursor.moveToFirst()) { forgetReceipt(id); return null; }
            if (cursor.getLong(2) != size || cursor.getInt(3) != 0) { forgetReceipt(id); return null; }
            savedName = cursor.getString(0);
            relativePath = cursor.getString(1);
        } catch (FileNotFoundException missing) { forgetReceipt(id); return null; }
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long length = 0;
        try (InputStream input = service.getContentResolver().openInputStream(uri)) {
            if (input == null) { forgetReceipt(id); return null; }
            byte[] buffer = new byte[65536]; int count;
            while (true) {
                require(true);
                count = input.read(buffer);
                if (count == -1) break;
                length += count;
                if (length > size) break;
                digest.update(buffer,0,count);
            }
        } catch (FileNotFoundException missing) { forgetReceipt(id); return null; }
        require(true);
        if (length != size || !RoomConfig.hex(digest.digest()).equals(expected)) {
            forgetReceipt(id); return null;
        }
        String directory = relativePath == null || relativePath.isEmpty() ? "Download/NexusRoom/" : relativePath;
        String savedTo = (directory.endsWith("/") ? directory : directory + "/") + savedName;
        return new JSONObject().put("ok",true).put("sha256",expected).put("savedTo",savedTo).put("alreadyReceived",true);
    }
    JSONArray photos(int count) throws Exception { return photos(count,true); }
    JSONArray photos(int count,boolean agent) throws Exception {
        require(agent); JSONArray photos = new JSONArray();
        try (Cursor cursor = service.getContentResolver().query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, new String[]{MediaStore.Images.Media._ID, MediaStore.Images.Media.DISPLAY_NAME, MediaStore.Images.Media.SIZE}, null, null, MediaStore.Images.Media.DATE_ADDED + " DESC, " + MediaStore.Images.Media._ID + " DESC")) {
            if (cursor != null) while (cursor.moveToNext() && photos.length() < Math.max(1, Math.min(20, count))) {
                require(agent);
                photos.put(new JSONObject().put("photoId", Long.toString(cursor.getLong(0))).put("name", cursor.getString(1)).put("size", cursor.getLong(2)));
            }
        } catch (SecurityException e) { throw new Exception("请在 Android 端允许照片库访问"); }
        require(agent);
        return photos;
    }
    JSONObject export(String id) throws Exception { return export(id,true); }
    JSONObject export(String id,boolean agent) throws Exception { if (!id.matches("[0-9]{1,20}")) throw new Exception("照片 ID 无效"); return upload(Uri.withAppendedPath(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id), agent); }
}
