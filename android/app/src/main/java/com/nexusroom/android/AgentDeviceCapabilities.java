package com.nexusroom.android;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ColorSpace;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.view.Display;
import android.util.Base64;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Phone-local capabilities used by the Agent, with a fresh room/lease check at the operation. */
final class AgentDeviceCapabilities {
    private static final int MAX_IMAGE_BYTES = 512 * 1024;
    private static final int MAX_CLIPBOARD_CHARS = 65536;
    private static final ExecutorService screenshotWork = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "NexusRoom-AgentScreenshot");
        thread.setDaemon(true);
        return thread;
    });

    private AgentDeviceCapabilities() { }

    static JSONObject screenshot(RoomService room, RoomService.RoomLink link, String lease, String taskId) throws Exception {
        requireAgent(room, link, lease, taskId);
        if (!link.config.control || !link.config.screenAllowed)
            throw new Exception("PermissionDenied: 请先允许此房间远程控制和屏幕访问");
        ControlService service = ControlService.instance;
        if (service == null)
            throw new Exception("PermissionDenied: 请在 Android 设置中启用 NexusRoom 无障碍服务");
        if (Build.VERSION.SDK_INT < 30)
            return projectionScreenshot(room, link, lease, taskId, service,
                "ToolUnavailable: Android 10 不提供无障碍服务截图 API；请先在手机确认同房间屏幕共享后重试");
        AccessibilityServiceInfo info = service.getServiceInfo();
        if (info == null || (info.getCapabilities() & AccessibilityServiceInfo.CAPABILITY_CAN_TAKE_SCREENSHOT) == 0)
            return projectionScreenshot(room, link, lease, taskId, service,
                "ToolUnavailable: 无障碍服务未获截图能力；请重新启用服务或先在手机确认同房间屏幕共享");

        CompletableFuture<JSONObject> pending = new CompletableFuture<>();
        room.handler.post(() -> {
            try {
                requireAgent(room, link, lease, taskId);
                if (!link.config.control || !link.config.screenAllowed || ControlService.instance != service)
                    throw new Exception("PermissionDenied: 屏幕访问或无障碍服务已关闭");
                service.takeScreenshot(Display.DEFAULT_DISPLAY, screenshotWork,
                    new AccessibilityService.TakeScreenshotCallback() {
                        @Override public void onSuccess(AccessibilityService.ScreenshotResult result) {
                            HardwareBuffer buffer = result.getHardwareBuffer();
                            try {
                                if (pending.isDone()) return;
                                requireAgent(room, link, lease, taskId);
                                if (!link.config.control || !link.config.screenAllowed || ControlService.instance != service)
                                    throw new Exception("PermissionDenied: 屏幕访问或无障碍服务已关闭");
                                JSONObject image = encodeScreenshot(buffer, result.getColorSpace());
                                // Encoding can take long enough for the owner or permission to change.
                                requireAgent(room, link, lease, taskId);
                                if (!link.config.control || !link.config.screenAllowed || ControlService.instance != service)
                                    throw new Exception("PermissionDenied: 屏幕访问或无障碍服务已关闭");
                                pending.complete(image);
                            } catch (Exception | OutOfMemoryError error) {
                                pending.completeExceptionally(error);
                            } finally {
                                if (buffer != null) buffer.close();
                            }
                        }
                        @Override public void onFailure(int errorCode) {
                            pending.completeExceptionally(new Exception("ScreenshotFailed: Android 拒绝截图（错误码 " + errorCode + "）；请确认屏幕已解锁且当前内容允许截图"));
                        }
                    });
            } catch (Exception error) {
                pending.completeExceptionally(error);
            }
        });
        try {
            JSONObject image=pending.get(10, TimeUnit.SECONDS);
            if(image.optInt("brightSamples")>0)return image.put("source","accessibility");
            // Some emulator and vendor renderers return a successful, opaque black
            // accessibility buffer. Use a fresh frame only from an already-consented
            // projection owned by the same room; never start screen sharing silently.
            return projectionScreenshot(room, link, lease, taskId, service,
                "ScreenshotFailed: Android 无障碍截图返回全黑画面；请先在手机确认屏幕共享后重试，或改用结构化页面工具");
        } catch (TimeoutException error) {
            pending.cancel(false);
            throw new Exception("ScreenshotFailed: Android 截图超时，请稍后重试", error);
        } catch (ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw new Exception("ScreenshotFailed: 截图图像处理失败", cause);
        } catch (InterruptedException error) {
            pending.cancel(false);
            Thread.currentThread().interrupt();
            throw error;
        }
    }

    private static JSONObject projectionScreenshot(RoomService room, RoomService.RoomLink link,
                                                   String lease, String taskId, ControlService service,
                                                   String unavailableMessage) throws Exception {
        requireScreenshotAccess(room, link, lease, taskId, service);
        ScreenCapture capture = room.capture;
        byte[] frame = capture == null ? null : capture.agentFrame(link);
        if (frame == null) throw new Exception(unavailableMessage);
        JSONObject image = encodeProjectionFrame(frame);
        requireScreenshotAccess(room, link, lease, taskId, service);
        if (room.capture != capture || capture.agentFrame(link) == null)
            throw new Exception("PermissionDenied: 已授权屏幕共享已结束或不属于当前房间");
        if (image.optInt("brightSamples") == 0)
            throw new Exception("ScreenshotFailed: 已授权屏幕共享画面为全黑，当前内容可能受系统保护");
        return image.put("source", "active_media_projection");
    }

    private static void requireScreenshotAccess(RoomService room, RoomService.RoomLink link,
                                                String lease, String taskId, ControlService service) throws Exception {
        requireAgent(room, link, lease, taskId);
        if (!link.config.control || !link.config.screenAllowed || ControlService.instance != service)
            throw new Exception("PermissionDenied: 屏幕访问或无障碍服务已关闭");
    }

    private static JSONObject encodeScreenshot(HardwareBuffer buffer, ColorSpace colorSpace) throws Exception {
        if (buffer == null) throw new Exception("ScreenshotFailed: Android 没有返回屏幕图像");
        Bitmap hardware = Bitmap.wrapHardwareBuffer(buffer,
            colorSpace == null ? ColorSpace.get(ColorSpace.Named.SRGB) : colorSpace);
        if (hardware == null) throw new Exception("ScreenshotFailed: 无法读取屏幕图像");
        Bitmap software = null;
        try {
            long pixels = (long) hardware.getWidth() * hardware.getHeight();
            if (pixels <= 0 || pixels > 16_000_000L)
                throw new Exception("ScreenshotFailed: 屏幕图像尺寸超出处理上限");
            software = hardware.copy(Bitmap.Config.ARGB_8888, false);
            if (software == null) throw new Exception("ScreenshotFailed: 无法转换屏幕图像");
            return encodeBitmap(software);
        } finally {
            if (software != null) software.recycle();
            hardware.recycle();
        }
    }

    private static JSONObject encodeProjectionFrame(byte[] frame) throws Exception {
        Bitmap bitmap=BitmapFactory.decodeByteArray(frame,0,frame.length);
        if(bitmap==null)throw new Exception("ScreenshotFailed: 无法读取已授权屏幕共享画面");
        try {return encodeBitmap(bitmap);}
        finally {bitmap.recycle();}
    }

    private static JSONObject encodeBitmap(Bitmap software) throws Exception {
            long pixels=(long)software.getWidth()*software.getHeight();
            if(pixels<=0||pixels>16_000_000L)throw new Exception("ScreenshotFailed: 屏幕图像尺寸超出处理上限");
            int samples=0,brightSamples=0;long brightness=0,alpha=0;
            for(int row=0;row<12;row++)for(int col=0;col<12;col++) {
                int pixel=software.getPixel((col*software.getWidth()+software.getWidth()/2)/12,
                    (row*software.getHeight()+software.getHeight()/2)/12);
                int value=(android.graphics.Color.red(pixel)+android.graphics.Color.green(pixel)+android.graphics.Color.blue(pixel))/3;
                brightness+=value;alpha+=android.graphics.Color.alpha(pixel);samples++;
                if(value>20)brightSamples++;
            }
            int[] sizes = {1024, 768, 640, 512};
            int[] qualities = {70, 65, 55, 45};
            for (int i = 0; i < sizes.length; i++) {
                int originalLong = Math.max(software.getWidth(), software.getHeight());
                float scale = Math.min(1f, sizes[i] / (float) originalLong);
                int width = Math.max(1, Math.round(software.getWidth() * scale));
                int height = Math.max(1, Math.round(software.getHeight() * scale));
                Bitmap resized = width == software.getWidth() && height == software.getHeight()
                    ? software : Bitmap.createScaledBitmap(software, width, height, true);
                try {
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream(128 * 1024);
                    if (!resized.compress(Bitmap.CompressFormat.JPEG, qualities[i], bytes))
                        throw new Exception("ScreenshotFailed: JPEG 编码失败");
                    if (bytes.size() <= MAX_IMAGE_BYTES)
                        return new JSONObject().put("mimeType", "image/jpeg")
                            .put("width", width).put("height", height)
                            .put("averageBrightness",brightness/samples).put("averageAlpha",alpha/samples)
                            .put("brightSamples",brightSamples)
                            .put("imageBase64", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
                } finally {
                    if (resized != software) resized.recycle();
                }
            }
            throw new Exception("ScreenshotFailed: 截图压缩后仍超过 512 KiB，请降低显示分辨率");
    }

    static JSONObject clipboardGet(RoomService room, RoomService.RoomLink link, String lease, String taskId) throws Exception {
        requireAgent(room, link, lease, taskId);
        if (!link.config.clipboard) throw new Exception("PermissionDenied: 本房间剪贴板权限未开启");
        return room.onMain(() -> {
            requireAgent(room, link, lease, taskId);
            if (!link.config.clipboard) throw new Exception("PermissionDenied: 本房间剪贴板权限已关闭");
            ClipboardManager manager = room.getSystemService(ClipboardManager.class);
            if (manager == null) throw new Exception("ToolUnavailable: 系统剪贴板不可用");
            ClipData clip;
            try {
                clip = manager.getPrimaryClip();
            } catch (SecurityException error) {
                throw new Exception(clipboardReadDenied(room), error);
            }
            if (clip == null || clip.getItemCount() == 0 || clip.getItemAt(0).getText() == null) {
                if (!NexusClipboardInputMethod.isSelected(room))
                    throw new Exception(clipboardReadDenied(room));
                throw new Exception("TargetNotFound: 当前剪贴板没有可读取的文本");
            }
            String text = clip.getItemAt(0).getText().toString();
            if (text.length() > MAX_CLIPBOARD_CHARS)
                throw new Exception("InvalidArguments: 剪贴板文本超过 65536 字符");
            link.clipboardLast = text;
            return new JSONObject().put("text", text).put("source", "system_fresh");
        });
    }

    static JSONObject clipboardSet(RoomService room, RoomService.RoomLink link, String lease, String taskId, String text) throws Exception {
        requireAgent(room, link, lease, taskId);
        if (!link.config.clipboard) throw new Exception("PermissionDenied: 本房间剪贴板权限未开启");
        if (text == null || text.length() > MAX_CLIPBOARD_CHARS)
            throw new Exception("InvalidArguments: 剪贴板文本不能超过 65536 字符");
        return room.onMain(() -> {
            requireAgent(room, link, lease, taskId);
            if (!link.config.clipboard) throw new Exception("PermissionDenied: 本房间剪贴板权限已关闭");
            ClipboardManager manager = room.getSystemService(ClipboardManager.class);
            if (manager == null) throw new Exception("ToolUnavailable: 系统剪贴板不可用");
            link.clipboardLast = text;
            manager.setPrimaryClip(ClipData.newPlainText("NexusRoom", text));
            return new JSONObject().put("ok", true);
        });
    }

    private static String clipboardReadDenied(RoomService room) {
        return NexusClipboardInputMethod.isSelected(room)
            ? "PermissionDenied: Android 当前不允许读取剪贴板，请确认 NexusRoom 剪贴板桥仍是默认输入法并重试"
            : "PermissionDenied: Android 限制后台读取剪贴板，请在系统键盘设置中启用并设为默认「NexusRoom 剪贴板桥」后重试";
    }

    private static void requireAgent(RoomService room, RoomService.RoomLink link, String lease, String taskId) throws Exception {
        if (room == null || RoomService.instance != room || link == null || !link.config.agent)
            throw new Exception("PermissionDenied: 本房间 Agent 权限已关闭");
        room.requireOwner(link, lease);
        room.agentEngine.requireTaskRunning(link, lease, taskId);
    }
}
