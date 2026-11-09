package com.nexusroom.android;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.accessibilityservice.GestureDescription;
import android.content.Intent;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.InputType;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import android.view.KeyEvent;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.SurroundingText;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

public final class ControlService extends AccessibilityService {
    static volatile ControlService instance;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private View activityLaunchAnchor;
    @Override protected void onServiceConnected() {
        instance = this;
        // Android 13+ can expose the focused editor's InputConnection to accessibility services.
        // It works with apps whose accessibility node does not report isEditable/ACTION_SET_TEXT.
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            AccessibilityServiceInfo info = getServiceInfo();
            if (info != null && (info.flags & AccessibilityServiceInfo.FLAG_INPUT_METHOD_EDITOR) == 0) {
                info.flags |= AccessibilityServiceInfo.FLAG_INPUT_METHOD_EDITOR;
                setServiceInfo(info);
            }
        }
        if (RoomService.instance != null) RoomService.instance.heartbeat(); RoomService.changed(this);
    }
    @Override public void onAccessibilityEvent(AccessibilityEvent event) { }
    @Override public void onInterrupt() { }
    @Override public void onDestroy() {
        removeActivityLaunchAnchor();
        instance = null; if (RoomService.instance != null) RoomService.instance.heartbeat(); RoomService.changed(this); super.onDestroy();
    }

    /** Called on the service main thread to verify a real foreground window. */
    boolean hasVisiblePackage(String packageName) {
        if (packageName == null || packageName.isEmpty()) return false;
        try {
            AccessibilityNodeInfo active = getRootInActiveWindow();
            if (active != null) {
                CharSequence owner = active.getPackageName();
                boolean match = packageName.contentEquals(owner);
                active.recycle();
                if (match) return true;
            }
            for (AccessibilityWindowInfo window : getWindows()) {
                try {
                    AccessibilityNodeInfo root = window.getRoot();
                    if (root != null) {
                        CharSequence owner = root.getPackageName();
                        boolean match = packageName.contentEquals(owner) && window.isActive();
                        root.recycle();
                        if (match) return true;
                    }
                } finally { window.recycle(); }
            }
        } catch (Exception ignored) { }
        return false;
    }

    /**
     * Android 12 blocks a background service from starting a third-party
     * Activity. An accessibility overlay is a user-approved visible window,
     * so keep a tiny, transparent anchor while the system processes the
     * launch. The anchor is removed immediately after the start request.
     */
    void startAgentActivity(Intent intent) throws Exception {
        if (android.os.Build.VERSION.SDK_INT < 23) { startActivity(intent); return; }
        CompletableFuture<Boolean> result = new CompletableFuture<>();
        mainHandler.post(() -> {
            try {
                removeActivityLaunchAnchor();
                WindowManager manager = (WindowManager)getSystemService(WINDOW_SERVICE);
                if (manager == null) throw new Exception("系统窗口服务不可用");
                View anchor = new View(this);
                anchor.setBackgroundColor(Color.TRANSPARENT);
                anchor.setAlpha(1f);
                WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                    2, 2, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                    PixelFormat.TRANSLUCENT);
                params.gravity = Gravity.TOP | Gravity.START;
                manager.addView(anchor, params);
                activityLaunchAnchor = anchor;
                startActivity(intent);
                result.complete(true);
                mainHandler.postDelayed(this::removeActivityLaunchAnchor, 1200L);
            } catch (Exception error) {
                removeActivityLaunchAnchor();
                result.completeExceptionally(error);
            }
        });
        try { result.get(5, TimeUnit.SECONDS); }
        catch (java.util.concurrent.TimeoutException e) { throw new Exception("启动应用超时"); }
        catch (java.util.concurrent.ExecutionException e) {
            Throwable cause=e.getCause(); throw new Exception(cause==null?"启动应用失败":cause.getMessage(),cause);
        }
    }

    private void removeActivityLaunchAnchor() {
        View anchor=activityLaunchAnchor; activityLaunchAnchor=null;
        if(anchor==null)return;
        try { WindowManager manager=(WindowManager)getSystemService(WINDOW_SERVICE); if(manager!=null)manager.removeViewImmediate(anchor); }
        catch(Exception ignored) { }
    }
    static JSONObject execute(String tool, JSONObject args,RoomService.RoomLink link,String lease) throws Exception {
        ControlService service = instance;
        if (service == null) throw new Exception("请在 Android 设置中启用 NexusRoom 无障碍服务");
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                RoomService room = RoomService.instance;
                if (room == null || !link.config.control || !link.online || (args.optBoolean("agent") && !link.config.agent)) throw new Exception("远程控制权限已关闭");
                room.requireOwner(link,lease);
                if (args.has("agentTaskId")) room.agentEngine.requireTaskRunning(link,lease,args.optString("agentTaskId"));
                android.util.DisplayMetrics metrics = new android.util.DisplayMetrics();
                ((android.view.WindowManager)service.getSystemService(WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(metrics);
                int width = metrics.widthPixels, height = metrics.heightPixels;
                if (tool.equals("ui_tree")) {
                    JSONArray nodes = new JSONArray();
                    java.util.List<AccessibilityWindowInfo> windows = service.getWindows();
                    if (windows.isEmpty()) collect(service.getRootInActiveWindow(), nodes, width, height, 0);
                    else for (AccessibilityWindowInfo window : windows) {
                        try {
                            // Floating selection toolbars and dialogs may be separate application windows.
                            if (window.getType() == AccessibilityWindowInfo.TYPE_APPLICATION || window.isActive())
                                collect(window.getRoot(), nodes, width, height, 0);
                        } finally { window.recycle(); }
                    }
                    result.complete(new JSONObject().put("nodes", nodes)); return;
                }
                if (tool.equals("text") || tool.equals("edit")) {
                    String value = args.optString("text"); if (value.length() > 8192) throw new Exception("输入内容过长");
                    String editAction = tool.equals("edit") ? args.optString("action", "insert") : "replace";
                    AccessibilityNodeInfo focused = findInputTarget(service);
                    if (focused == null || !isTextTarget(focused)) {
                        if (focused != null) { focused.recycle(); focused = null; }
                        if (performInputMethodAction(service, editAction.equals("clear") ? "replace" : editAction, value)) {
                            result.complete(new JSONObject().put("ok", true)); return;
                        }
                        if (tool.equals("text") || editAction.equals("clear"))
                            throw new Exception("无法验证输入框文本已完整替换，请先点击可编辑区域或重新读取页面；密码框不支持远程输入");
                        throw new Exception("未检测到可用的文本输入焦点。请先点击应用中的输入区域；密码框不支持远程输入");
                    }
                    String before=focused.isShowingHintText()||focused.getText()==null?"":focused.getText().toString();int start=Math.max(0,Math.min(before.length(),focused.getTextSelectionStart())),end=Math.max(start,Math.min(before.length(),focused.getTextSelectionEnd()));
                    if(tool.equals("edit")){
                        String action=editAction;
                        if(action.equals("copy")||action.equals("cut")){if(!link.config.clipboard)throw new Exception("请先允许剪贴板同步");String selected=before.substring(start,end);if(action.equals("copy")){result.complete(new JSONObject().put("text",selected));return;}value="";}
                        else if(action.equals("selectAll")){if(!setSelection(service,focused,0,before.length()))throw new Exception("此输入框不支持全选");result.complete(new JSONObject().put("ok",true));return;}
                        else if(action.equals("Backspace")){if(start==end&&start>0)start=before.offsetByCodePoints(start,-1);value="";}
                        else if(action.equals("Delete")){if(start==end&&end<before.length())end=before.offsetByCodePoints(end,1);value="";}
                        else if(action.equals("clear")){value="";start=0;end=before.length();}
                        else if(action.equals("Enter")){if(android.os.Build.VERSION.SDK_INT>=30&&focused.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId())){result.complete(new JSONObject().put("ok",true));return;}value="\n";}
                        else if(action.equals("ArrowLeft")||action.equals("ArrowRight")||action.equals("Home")||action.equals("End")){int pos=action.equals("Home")?0:action.equals("End")?before.length():action.equals("ArrowLeft")?start>0?before.offsetByCodePoints(start,-1):0:end<before.length()?before.offsetByCodePoints(end,1):before.length();if(!setSelection(service,focused,pos,pos))throw new Exception("此输入框不支持移动光标");result.complete(new JSONObject().put("ok",true));return;}
                        else if(!action.equals("insert")&&!action.equals("cut"))throw new Exception("不支持的编辑操作");
                        String selected=before.substring(start,end);int caret=start+value.length();value=before.substring(0,start)+value+before.substring(end);
                        Bundle update=new Bundle();update.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,value);if(!focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,update)){
                            if (performInputMethodAction(service, action.equals("clear") ? "replace" : action, action.equals("insert") ? args.optString("text") : value)) { result.complete(new JSONObject().put("ok",true).put("text",action.equals("cut")?selected:"")); return; }
                            throw new Exception("此输入框不支持无障碍文字输入，请确认输入框仍处于焦点状态");
                        }boolean positioned=setSelection(service,focused,caret,caret);if(!positioned){
                            AccessibilityNodeInfo current=findInputTarget(service);
                            try {
                                if(current==null||!inputTextMatches(current, value))
                                    throw new Exception("文本已更新，但无法验证输入结果；请重新读取页面");
                            } finally {if(current!=null)current.recycle();}
                        }
                        result.complete(new JSONObject().put("ok",true).put("cursorPositioned",positioned).put("text",action.equals("cut")?selected:""));return;
                    }
                    Bundle bundle = new Bundle(); bundle.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
                    if (!focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle) && !performInputMethodAction(service, "replace", value)) throw new Exception("此输入框不支持可验证的文字替换，请确认输入框仍处于焦点状态");
                    focused.recycle();
                    result.complete(new JSONObject().put("ok", true)); return;
                }
                int action = tool.equals("back") ? GLOBAL_ACTION_BACK : tool.equals("home") ? GLOBAL_ACTION_HOME : tool.equals("recents") ? GLOBAL_ACTION_RECENTS : -1;
                if (action != -1) { if (!service.performGlobalAction(action)) throw new Exception("系统按键执行失败"); result.complete(new JSONObject().put("ok", true)); return; }
                double x = coordinate(args, "x"), y = coordinate(args, "y");
                Path path = new Path(); path.moveTo((float)(x * (width - 1)), (float)(y * (height - 1)));
                int duration = 60;
                if (tool.equals("swipe")) { path.lineTo((float)(coordinate(args, "endX") * (width - 1)), (float)(coordinate(args, "endY") * (height - 1))); duration = Math.max(100, Math.min(3000, args.optInt("duration", 350))); }
                else if (tool.equals("scroll")) { float end = (float)Math.max(0.08, Math.min(0.92, y + (args.optDouble("delta", 1) > 0 ? -0.35 : 0.35))); path.lineTo((float)(x * (width - 1)), end * (height - 1)); duration = 300; }
                else if (!tool.equals("tap")) throw new Exception("不支持的控制指令");
                boolean accepted = service.dispatchGesture(new GestureDescription.Builder().addStroke(new GestureDescription.StrokeDescription(path, 0, duration)).build(), new GestureResultCallback() {
                    @Override public void onCompleted(GestureDescription gesture) { try { result.complete(new JSONObject().put("ok", true)); } catch (Exception e) { result.completeExceptionally(e); } }
                    @Override public void onCancelled(GestureDescription gesture) { result.completeExceptionally(new Exception("手势被系统取消")); }
                }, null);
                if (!accepted) throw new Exception("Android 未接受手势");
            } catch (Exception e) { result.completeExceptionally(e); }
        });
        return result.get(8, TimeUnit.SECONDS);
    }
    private static double coordinate(JSONObject args, String name) throws Exception { double v = args.getDouble(name); if (!Double.isFinite(v) || v < 0 || v > 1) throw new Exception("坐标必须为 0 到 1"); return v; }
    /** Finds the actual text field across app/dialog windows, preferring the system input focus. */
    private static AccessibilityNodeInfo findInputTarget(ControlService service) {
        java.util.ArrayList<AccessibilityNodeInfo> roots = new java.util.ArrayList<>();
        java.util.ArrayList<AccessibilityNodeInfo> candidates = new java.util.ArrayList<>();
        try {
            java.util.HashSet<Integer> windowIds = new java.util.HashSet<>();
            AccessibilityNodeInfo active = service.getRootInActiveWindow();
            if (active != null) { roots.add(active); windowIds.add(active.getWindowId()); }
            for (AccessibilityWindowInfo window : service.getWindows()) {
                try {
                    if (!windowIds.add(window.getId())) continue;
                    AccessibilityNodeInfo root = window.getRoot();
                    if (root != null) roots.add(root);
                } finally { window.recycle(); }
            }
            for (AccessibilityNodeInfo root : roots) {
                AccessibilityNodeInfo focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
                if (usableInput(focused)) return focused;
                if (focused != null) focused.recycle();
                AccessibilityNodeInfo accessibilityFocused = root.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY);
                if (usableInput(accessibilityFocused)) return accessibilityFocused;
                if (accessibilityFocused != null) accessibilityFocused.recycle();
                collectEditable(root, 0, candidates);
            }
            if (candidates.size() == 1) {
                AccessibilityNodeInfo only = candidates.remove(0);
                // Preserve the convenient single-input behavior: focus the sole visible field
                // when a remote command is sent before the app has reported input focus.
                if (!only.isFocused()) {
                    only.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
                    only.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                }
                return only;
            }
            // Some apps expose multiple editors but correctly mark only the currently focused one.
            AccessibilityNodeInfo best = null;
            for (AccessibilityNodeInfo candidate : candidates) {
                if (candidate.isFocused()) {
                    if (best != null) { best = null; break; }
                    best = candidate;
                }
            }
            if (best != null) { candidates.remove(best); return best; }
        } catch (Exception ignored) {
        } finally {
            for (AccessibilityNodeInfo root : roots) root.recycle();
            for (AccessibilityNodeInfo candidate : candidates) candidate.recycle();
        }
        return null;
    }
    private static boolean usableInput(AccessibilityNodeInfo node) {
        return node != null && node.isVisibleToUser() && isTextTarget(node);
    }

    private static boolean setSelection(ControlService service, AccessibilityNodeInfo node, int start, int end) {
        Bundle selection = new Bundle();
        selection.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, start);
        selection.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, end);
        try {
            if (node != null && node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selection)) return true;
            if (node != null && node.refresh() && node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selection)) return true;
            AccessibilityNodeInfo current = findInputTarget(service);
            if (current == null) return false;
            try { return current.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selection); }
            finally { current.recycle(); }
        } catch (Exception ignored) { return false; }
    }
    static boolean isTextTarget(AccessibilityNodeInfo node) {
        if (node == null || node.isPassword()) return false;
        if (node.isEditable()) return true;
        try {
            if (node.getActionList().contains(AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_TEXT)) return true;
            CharSequence name = node.getClassName();
            String className = name == null ? "" : name.toString();
            return className.contains("EditText") || className.contains("TextField") || className.contains("TextInput");
        } catch (Exception ignored) { return false; }
    }
    private static boolean inputTextMatches(AccessibilityNodeInfo node, String expected) {
        if (node == null) return false;
        CharSequence text = node.getText();
        if (expected.isEmpty()) {
            // Android may expose an EditText hint through getText() after it has been
            // cleared. isShowingHintText distinguishes that state from real content.
            return text == null || text.length() == 0 || node.isShowingHintText();
        }
        return text != null && expected.contentEquals(text);
    }
    private static void collectEditable(AccessibilityNodeInfo node, int depth, java.util.List<AccessibilityNodeInfo> candidates) {
        if (node == null || depth > 18 || candidates.size() > 12) return;
        try {
            if (node.isVisibleToUser() && isTextTarget(node)) { candidates.add(AccessibilityNodeInfo.obtain(node)); return; }
            for (int i = 0; i < node.getChildCount(); i++) {
                AccessibilityNodeInfo child = node.getChild(i);
                if (child != null) try { collectEditable(child, depth + 1, candidates); } finally { child.recycle(); }
            }
        } catch (Exception ignored) { }
    }
    private static boolean performInputMethodAction(ControlService service, String action, String value) {
        if (android.os.Build.VERSION.SDK_INT < 33) return false;
        try {
            android.accessibilityservice.InputMethod method = service.getInputMethod();
            if (method == null || !method.getCurrentInputStarted()) return false;
            EditorInfo editor = method.getCurrentInputEditorInfo();
            if (editor == null || isPasswordInput(editor.inputType)) return false;
            android.accessibilityservice.InputMethod.AccessibilityInputConnection connection = method.getCurrentInputConnection();
            if (connection == null) return false;
            switch (action) {
                case "replace":
                    if (connection.getSurroundingText(8192, 8192, 0) == null) return false;
                    connection.performContextMenuAction(android.R.id.selectAll);
                    SurroundingText selected = connection.getSurroundingText(8192, 8192, 0);
                    if (selected == null || selected.getOffset() != 0 || selected.getSelectionStart() != 0
                        || selected.getSelectionEnd() != selected.getText().length()) return false;
                    connection.commitText(value, 1, null);
                    SurroundingText replaced = connection.getSurroundingText(value.length(), 1, 0);
                    return replaced != null && replaced.getOffset() == 0
                        && replaced.getText().toString().equals(value)
                        && replaced.getSelectionStart() == value.length()
                        && replaced.getSelectionEnd() == value.length();
                case "insert": connection.commitText(value, 1, null); return true;
                case "Enter": sendEditorKey(connection, KeyEvent.KEYCODE_ENTER, 0); return true;
                case "Backspace": sendEditorKey(connection, KeyEvent.KEYCODE_DEL, 0); return true;
                case "Delete": sendEditorKey(connection, KeyEvent.KEYCODE_FORWARD_DEL, 0); return true;
                case "ArrowLeft": sendEditorKey(connection, KeyEvent.KEYCODE_DPAD_LEFT, 0); return true;
                case "ArrowRight": sendEditorKey(connection, KeyEvent.KEYCODE_DPAD_RIGHT, 0); return true;
                case "Home": sendEditorKey(connection, KeyEvent.KEYCODE_MOVE_HOME, 0); return true;
                case "End": sendEditorKey(connection, KeyEvent.KEYCODE_MOVE_END, 0); return true;
                case "selectAll": sendEditorKey(connection, KeyEvent.KEYCODE_A, KeyEvent.META_CTRL_ON); return true;
                case "clear": sendEditorKey(connection, KeyEvent.KEYCODE_A, KeyEvent.META_CTRL_ON); sendEditorKey(connection, KeyEvent.KEYCODE_DEL, 0); return true;
                case "cut": sendEditorKey(connection, KeyEvent.KEYCODE_X, KeyEvent.META_CTRL_ON); return true;
                default: return false;
            }
        } catch (Exception ignored) { return false; }
    }
    private static void sendEditorKey(android.accessibilityservice.InputMethod.AccessibilityInputConnection connection, int keyCode, int metaState) {
        if (android.os.Build.VERSION.SDK_INT < 33) return;
        long now = SystemClock.uptimeMillis();
        connection.sendKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, keyCode, 0, metaState));
        connection.sendKeyEvent(new KeyEvent(now, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, keyCode, 0, metaState));
    }
    private static boolean isPasswordInput(int inputType) {
        int inputClass = inputType & InputType.TYPE_MASK_CLASS;
        int variation = inputType & InputType.TYPE_MASK_VARIATION;
        return inputClass == InputType.TYPE_CLASS_TEXT && (variation == InputType.TYPE_TEXT_VARIATION_PASSWORD
            || variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD || variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD)
            || inputClass == InputType.TYPE_CLASS_NUMBER && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD;
    }
    private static void collect(AccessibilityNodeInfo node, JSONArray nodes, int w, int h, int depth) throws Exception {
        if (node == null) return;
        try {
        if (nodes.length() >= 150 || depth > 18) return;
        if (!node.refresh()) return;
        Rect bounds = new Rect(); node.getBoundsInScreen(bounds);
        if (node.isVisibleToUser() && !node.isPassword() && (node.getText() != null || node.getContentDescription() != null || node.isClickable() || node.isEditable())) {
            nodes.put(new JSONObject().put("text", node.getText() == null ? "" : node.getText().toString()).put("description", node.getContentDescription() == null ? "" : node.getContentDescription().toString()).put("className", node.getClassName() == null ? "" : node.getClassName().toString()).put("clickable", node.isClickable()).put("editable", node.isEditable()).put("focused", node.isFocused()).put("x", Math.max(0, Math.min(1, bounds.exactCenterX() / w))).put("y", Math.max(0, Math.min(1, bounds.exactCenterY() / h))));
        }
        for (int i = 0; i < node.getChildCount() && nodes.length() < 150; i++) collect(node.getChild(i), nodes, w, h, depth + 1);
        } finally { node.recycle(); }
    }
}
