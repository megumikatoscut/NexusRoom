package com.nexusroom.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.text.InputFilter;
import android.view.View;
import android.view.ViewGroup;
import android.widget.*;
import org.json.JSONArray;
import org.json.JSONObject;
import okhttp3.Call;
import okhttp3.Response;
import java.util.ArrayList;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/** Browses Windows folders and files through the paired, certificate-pinned Host. */
final class PcWorkspacePicker {
    private static final class Entry {
        final String name, path, modifiedAt;
        final boolean directory;
        final long size;
        Entry(JSONObject value, boolean directory) {
            name = value.optString("name"); path = value.optString("path");
            modifiedAt = value.optString("modifiedAt"); size = value.optLong("size", -1);
            this.directory = directory;
        }
    }
    private final Activity activity;
    private final RoomService.RoomLink link;
    private final BooleanSupplier valid;
    private final Consumer<String> choose;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final AlertDialog dialog;
    private final TextView location, error;
    private final Button up, home;
    private final LinearLayout drives;
    private final ListView folders;
    private final EditText filter;
    private final ArrayList<Entry> entries = new ArrayList<>();
    private final ArrayAdapter<Entry> adapter;
    private AlertDialog fileDialog;
    private String currentPath = "", parentPath = "", browsePath = "";
    private volatile boolean closed;
    private boolean busy;
    private boolean changingFilter;
    private int sequence;
    private volatile Call call;
    private final Runnable search;

    PcWorkspacePicker(Activity activity, RoomService.RoomLink link, String initialPath,
                      BooleanSupplier valid, Consumer<String> choose) {
        this.activity = activity;
        this.link = link;
        this.valid = valid;
        this.choose = choose;
        LinearLayout body = new LinearLayout(activity);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(dp(18), dp(8), dp(18), 0);
        TextView explanation = new TextView(activity);
        explanation.setText("浏览电脑文件夹和文件；进入所需目录后确认选择。点击文件可查看详情与路径。");
        explanation.setTextSize(13);
        body.addView(explanation);
        LinearLayout navigation = new LinearLayout(activity);
        home = new Button(activity); home.setText("用户主目录");
        home.setContentDescription("用户主目录");
        up = new Button(activity); up.setText("返回上级");
        up.setContentDescription("返回上级目录");
        navigation.addView(home, new LinearLayout.LayoutParams(0, dp(48), 1));
        navigation.addView(up, new LinearLayout.LayoutParams(0, dp(48), 1));
        body.addView(navigation);
        home.setOnClickListener(v -> navigate(""));
        up.setOnClickListener(v -> navigate(parentPath));
        HorizontalScrollView driveScroll = new HorizontalScrollView(activity);
        drives = new LinearLayout(activity);
        driveScroll.addView(drives);
        body.addView(driveScroll);
        location = new TextView(activity);
        location.setContentDescription("当前文件夹");
        location.setTextIsSelectable(true);
        location.setTextSize(14);
        location.setPadding(0, dp(10), 0, dp(10));
        body.addView(location);
        error = new TextView(activity);
        error.setTextColor(Color.rgb(165, 61, 48)); error.setTextSize(12);
        body.addView(error);
        filter = new EditText(activity);
        search = () -> load(browsePath, filter.getText().toString().trim());
        filter.setHint("搜索此目录中的文件和文件夹");
        filter.setContentDescription("搜索当前目录的文件和文件夹");
        filter.setSingleLine(true); filter.setTextSize(13);
        filter.setFilters(new InputFilter[]{new InputFilter.LengthFilter(100)});
        body.addView(filter, new LinearLayout.LayoutParams(-1, dp(44)));
        filter.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int a, int c, int f) { }
            public void afterTextChanged(Editable e) { }
            public void onTextChanged(CharSequence s, int a, int b, int c) {
                if (!changingFilter) { main.removeCallbacks(search); main.postDelayed(search, 350); }
            }
        });
        folders = new ListView(activity);
        folders.setContentDescription("电脑文件和文件夹");
        adapter = new ArrayAdapter<>(activity, android.R.layout.simple_list_item_2, entries) {
            @Override public View getView(int position, View reusable, ViewGroup parent) {
                View row = reusable == null ? activity.getLayoutInflater().inflate(android.R.layout.simple_list_item_2, parent, false) : reusable;
                Entry entry = getItem(position);
                if (entry != null) {
                    TextView name = row.findViewById(android.R.id.text1), metadata = row.findViewById(android.R.id.text2);
                    name.setText((entry.directory ? "📁  " : "📄  ") + entry.name);
                    name.setTextSize(14); name.setMaxLines(2);
                    metadata.setText(entry.directory ? "文件夹" : fileMetadata(entry));
                    metadata.setTextSize(12);
                }
                return row;
            }
        };
        folders.setAdapter(adapter);
        folders.setOnItemClickListener((p, v, index, id) -> {
            if (busy || index >= entries.size() || !valid.getAsBoolean()) return;
            Entry entry = entries.get(index);
            if (entry.directory) navigate(entry.path); else showFile(entry);
        });
        int listHeight = Math.min(dp(250), Math.max(dp(70), activity.getResources().getDisplayMetrics().heightPixels - dp(410)));
        body.addView(folders, new LinearLayout.LayoutParams(-1, listHeight));
        TextView empty = new TextView(activity);
        empty.setText("此目录为空，可以直接选择。");
        empty.setPadding(0, dp(16), 0, dp(16)); empty.setTextSize(13);
        empty.setVisibility(View.GONE);
        body.addView(empty); folders.setEmptyView(empty);
        dialog = new AlertDialog.Builder(activity).setTitle("选择 PC 工作目录").setView(body)
            .setNegativeButton("取消", null).setNeutralButton("使用默认目录", null)
            .setPositiveButton("选择此文件夹", null).create();
        dialog.setOnDismissListener(d -> close());
        dialog.show();
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            if (!busy && !currentPath.isEmpty() && valid.getAsBoolean()) { choose.accept(currentPath); dialog.dismiss(); }
        });
        dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v -> {
            if (valid.getAsBoolean()) choose.accept("");
            dialog.dismiss();
        });
        load(initialPath);
    }

    private int dp(int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }
    private static String fileType(Entry entry) {
        int dot = entry.name.lastIndexOf('.');
        if (dot <= 0 || dot == entry.name.length() - 1) return "无扩展名文件";
        String extension = entry.name.substring(dot + 1).toUpperCase(Locale.ROOT);
        return (extension.length() > 20 ? extension.substring(0, 20) + "…" : extension) + " 文件";
    }
    private static String fileSize(long size) {
        if (size < 0) return "大小未知";
        if (size < 1024) return size + " B";
        double value = size;
        String[] units = {"B", "KB", "MB", "GB"}; int unit = 0;
        while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
        return String.format(Locale.getDefault(), "%.1f %s", value, units[unit]);
    }
    private String modifiedTime(String raw) {
        try {
            Date date = Date.from(java.time.OffsetDateTime.parse(raw).toInstant());
            return android.text.format.DateFormat.getDateFormat(activity).format(date) + " " + android.text.format.DateFormat.getTimeFormat(activity).format(date);
        } catch (RuntimeException invalid) { return ""; }
    }
    private String fileMetadata(Entry entry) {
        String modified = modifiedTime(entry.modifiedAt);
        return fileType(entry) + " · " + fileSize(entry.size) + (modified.isEmpty() ? "" : " · " + modified);
    }
    private void showFile(Entry entry) {
        if (closed || !valid.getAsBoolean()) { dismiss(); return; }
        TextView details = new TextView(activity);
        details.setText(entry.name + "\n\n" + fileMetadata(entry) + "\n\n完整路径：\n" + entry.path);
        details.setTextIsSelectable(true); details.setTextSize(14); details.setPadding(dp(20), dp(12), dp(20), dp(12));
        ScrollView content = new ScrollView(activity); content.addView(details);
        fileDialog = new AlertDialog.Builder(activity).setTitle("电脑文件详情").setView(content)
            .setPositiveButton("关闭", null).setNeutralButton("复制路径", (d, which) -> {
                if (closed || !valid.getAsBoolean()) return;
                ClipboardManager clipboard = activity.getSystemService(ClipboardManager.class);
                if (clipboard != null) {
                    clipboard.setPrimaryClip(ClipData.newPlainText("电脑文件路径", entry.path));
                    Toast.makeText(activity, "已复制电脑文件路径", Toast.LENGTH_SHORT).show();
                }
            }).create();
        fileDialog.show();
    }
    private void controls(boolean loading) {
        busy = loading;
        home.setEnabled(!loading); up.setEnabled(!loading && !parentPath.isEmpty());
        folders.setEnabled(!loading);
        for (int i = 0; i < drives.getChildCount(); i++) drives.getChildAt(i).setEnabled(!loading);
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(!loading && !currentPath.isEmpty() && error.getText().length() == 0);
    }
    private void load(String path) {
        load(path, "");
    }
    private void navigate(String path) {
        main.removeCallbacks(search);
        changingFilter = true; filter.setText(""); changingFilter = false;
        load(path);
    }
    private void load(String path, String query) {
        if (closed || !valid.getAsBoolean()) { dismiss(); return; }
        browsePath = path;
        int epoch = ++sequence;
        Call previous = call; if (previous != null) previous.cancel();
        error.setText(""); controls(true); location.setText("正在读取电脑文件夹…");
        io.execute(() -> {
            try {
                String endpoint = "/device/agent/workspace?path=" + android.net.Uri.encode(path) + "&query=" + android.net.Uri.encode(query);
                Call pending = link.client.newCall(link.request(endpoint).build());
                call = pending;
                if (closed) { pending.cancel(); return; }
                JSONObject result;
                try (Response response = pending.execute()) {
                    if (response.body() == null) throw new Exception("电脑没有返回文件夹信息");
                    result = new JSONObject(response.body().string());
                    if (!response.isSuccessful()) throw new Exception(result.optString("title", "读取目录失败"));
                } finally { call = null; }
                main.post(() -> {
                    if (!accepts(epoch)) return;
                    currentPath = result.optString("path"); parentPath = result.optString("parentPath");
                    if (parentPath.equals("null")) parentPath = "";
                    location.setText(currentPath);
                    entries.clear();
                    JSONArray directories = result.optJSONArray("directories");
                    if (directories != null) for (int i = 0; i < directories.length(); i++) {
                        JSONObject entry = directories.optJSONObject(i); if (entry == null) continue;
                        entries.add(new Entry(entry, true));
                    }
                    JSONArray files = result.optJSONArray("files");
                    if (files != null) for (int i = 0; i < files.length(); i++) {
                        JSONObject entry = files.optJSONObject(i); if (entry == null) continue;
                        entries.add(new Entry(entry, false));
                    }
                    adapter.notifyDataSetChanged(); folders.setSelection(0); drives.removeAllViews();
                    ((TextView) folders.getEmptyView()).setText(query.isEmpty()
                        ? "此目录为空，可以直接选择。"
                        : "没有匹配的文件或文件夹，可更改搜索词。");
                    JSONArray roots = result.optJSONArray("roots");
                    if (roots != null) for (int i = 0; i < roots.length(); i++) {
                        JSONObject entry = roots.optJSONObject(i); if (entry == null) continue;
                        String rootPath = entry.optString("path"); Button drive = new Button(activity);
                        drive.setText(entry.optString("name")); drive.setContentDescription("打开磁盘 " + rootPath);
                        drive.setOnClickListener(v -> navigate(rootPath)); drives.addView(drive);
                    }
                    if (result.optBoolean("truncated")) error.setText("列表较长，输入名称可搜索此目录中的文件和文件夹。");
                    controls(false);
                    // A truncated listing is still a valid, selectable directory.
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(!currentPath.isEmpty());
                });
            } catch (Exception e) {
                main.post(() -> {
                    if (!accepts(epoch)) return;
                    location.setText(currentPath.isEmpty() ? "用户主目录" : currentPath);
                    error.setText(e.getMessage() == null ? "读取失败，请返回用户主目录重试" : e.getMessage()); controls(false);
                });
            }
        });
    }
    private boolean accepts(int epoch) {
        if (closed || epoch != sequence) return false;
        if (!valid.getAsBoolean()) { dismiss(); return false; }
        return true;
    }
    void dismiss() { dialog.dismiss(); close(); }
    private void close() {
        if (closed) return;
        closed = true; sequence++;
        if (fileDialog != null) { fileDialog.dismiss(); fileDialog = null; }
        Call pending = call; if (pending != null) pending.cancel();
        io.shutdownNow(); main.removeCallbacksAndMessages(null);
    }
}
