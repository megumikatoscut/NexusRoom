package com.nexusroom.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.InputType;
import android.view.View;
import android.widget.*;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import okhttp3.*;

/** Manages room-owned model profiles through the authenticated Android room connection. */
final class ProfileManager {
    private static final ExecutorService IO = Executors.newCachedThreadPool();
    private static final int INK = Color.rgb(22,45,43), MUTED = Color.rgb(108,128,124), ACCENT = Color.rgb(17,139,119);
    private ProfileManager() {}

    static void open(Activity activity, RoomService.RoomLink link) {
        if (link == null || !link.online) { Toast.makeText(activity, "电脑离线，暂时无法同步方案", Toast.LENGTH_LONG).show(); return; }
        load(activity, link, "");
    }

    private static void load(Activity activity, RoomService.RoomLink link, String preserveId) {
        IO.execute(() -> {
            try {
                JSONObject room = (JSONObject) request(link, "/device/room", null, "GET");
                JSONArray raw = room.optJSONArray("profiles");
                ArrayList<JSONObject> profiles = new ArrayList<>();
                if (raw != null) for (int i = 0; i < raw.length(); i++) { JSONObject profile = raw.optJSONObject(i); if (profile != null) profiles.add(profile); }
                String defaultId = room.optString("defaultProfileId");
                activity.runOnUiThread(() -> showList(activity, link, profiles, defaultId, preserveId));
            } catch (Exception e) { activity.runOnUiThread(() -> toast(activity, "读取方案失败：" + message(e))); }
        });
    }

    private static void showList(Activity activity, RoomService.RoomLink link, ArrayList<JSONObject> profiles, String defaultId, String preserveId) {
        LinearLayout page = new LinearLayout(activity); page.setOrientation(LinearLayout.VERTICAL); page.setPadding(dp(activity, 16), dp(activity, 8), dp(activity, 16), dp(activity, 8));
        TextView summary = text(activity, "此房间目前有 " + profiles.size() + " 个模型方案。Android 和电脑共享同一份配置。", 13, MUTED, false); page.addView(summary);
        Spinner spinner = new Spinner(activity);
        ArrayList<String> labels = new ArrayList<>(); int selected = 0, defaultIndex = 0; boolean preferredFound = false;
        String[] liveDefaultId = { defaultId };
        String preferredId = preserveId.isEmpty() ? defaultId : preserveId;
        for (int i = 0; i < profiles.size(); i++) {
            JSONObject p = profiles.get(i); String id = p.optString("id");
            labels.add(p.optString("name", "未命名方案") + " · " + p.optString("model", "未配置") + (id.equals(defaultId) ? " · 默认" : "") + (p.optBoolean("hasKey") ? "" : " · 缺少 API Key"));
            if (id.equals(defaultId)) defaultIndex = i;
            if (id.equals(preferredId)) { selected = i; preferredFound = true; }
        }
        if (!preferredFound) selected = defaultIndex;
        if (profiles.isEmpty()) labels.add("尚无方案，请新增");
        ArrayAdapter<String> adapter = new ArrayAdapter<>(activity, android.R.layout.simple_spinner_item, labels); adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item); spinner.setAdapter(adapter); if (!profiles.isEmpty()) spinner.setSelection(selected); page.addView(spinner);
        LinearLayout actions = new LinearLayout(activity); actions.setOrientation(LinearLayout.HORIZONTAL);
        Button add = button(activity, "新增方案"); Button edit = button(activity, "编辑"); Button test = button(activity, "测试连接"); Button makeDefault = button(activity, "设为默认"); Button delete = button(activity, "删除");
        actions.addView(add, weight(activity)); actions.addView(edit, weight(activity)); actions.addView(test, weight(activity)); page.addView(actions);
        LinearLayout actions2 = new LinearLayout(activity); actions2.setOrientation(LinearLayout.HORIZONTAL); actions2.addView(makeDefault, weight(activity)); actions2.addView(delete, weight(activity)); page.addView(actions2);
        AlertDialog dialog = new AlertDialog.Builder(activity).setTitle("房间模型方案 · " + profiles.size()).setView(page).setNegativeButton("关闭", null).setNeutralButton("刷新", null).create();
        Runnable updateButtons = () -> { boolean hasSelection = !profiles.isEmpty() && spinner.getSelectedItemPosition() >= 0; edit.setEnabled(hasSelection); test.setEnabled(hasSelection); makeDefault.setEnabled(hasSelection && !selectedProfileId(profiles, spinner).equals(liveDefaultId[0])); delete.setEnabled(profiles.size() > 1 && hasSelection); };
        spinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() { public void onNothingSelected(AdapterView<?> parent) { updateButtons.run(); } public void onItemSelected(AdapterView<?> parent, View view, int position, long id) { updateButtons.run(); } });
        add.setOnClickListener(v -> { dialog.dismiss(); edit(activity, link, null, profiles, defaultId); });
        edit.setOnClickListener(v -> { JSONObject profile = selectedProfile(profiles, spinner); if (profile != null) { dialog.dismiss(); edit(activity, link, profile, profiles, defaultId); } });
        test.setOnClickListener(v -> { JSONObject profile = selectedProfile(profiles, spinner); if (profile != null) test(activity, link, profile); });
        makeDefault.setOnClickListener(v -> { JSONObject profile = selectedProfile(profiles, spinner); if (profile != null) { String id = profile.optString("id"); dialog.dismiss(); mutate(activity, link, "/device/room/profiles/" + id + "/default", new JSONObject(), "POST", id, "默认方案已更新"); } });
        delete.setOnClickListener(v -> { JSONObject profile = selectedProfile(profiles, spinner); if (profile == null) return; String id = profile.optString("id"); String name = profile.optString("name"); dialog.dismiss(); new AlertDialog.Builder(activity).setTitle("删除模型方案？").setMessage("将从房间内所有设备删除“" + name + "”。此操作不可撤销。").setNegativeButton("取消", (d, w) -> load(activity, link, id)).setPositiveButton("删除", (d, w) -> mutate(activity, link, "/device/room/profiles/" + id, null, "DELETE", "", "方案已删除")).show(); });
        android.os.Handler liveHandler = new android.os.Handler(android.os.Looper.getMainLooper());
        Runnable liveRefresh = new Runnable() { public void run() { if (!dialog.isShowing()) return; refreshRows(activity, link, dialog, summary, spinner, profiles, labels, adapter, liveDefaultId, updateButtons); liveHandler.postDelayed(this, 6000); } };
        updateButtons.run(); dialog.setOnShowListener(ignored -> { dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v -> { String currentId = selectedProfileId(profiles, spinner); dialog.dismiss(); load(activity, link, currentId); }); liveHandler.postDelayed(liveRefresh, 6000); }); dialog.setOnDismissListener(ignored -> liveHandler.removeCallbacks(liveRefresh)); dialog.show();
    }

    private static void refreshRows(Activity activity, RoomService.RoomLink link, AlertDialog dialog, TextView summary, Spinner spinner, ArrayList<JSONObject> profiles, ArrayList<String> labels, ArrayAdapter<String> adapter, String[] defaultId, Runnable updateButtons) {
        IO.execute(() -> {
            try {
                JSONObject room = (JSONObject) request(link, "/device/room", null, "GET");
                JSONArray raw = room.optJSONArray("profiles"); ArrayList<JSONObject> fresh = new ArrayList<>();
                if (raw != null) for (int i = 0; i < raw.length(); i++) { JSONObject profile = raw.optJSONObject(i); if (profile != null) fresh.add(profile); }
                String freshDefault = room.optString("defaultProfileId");
                activity.runOnUiThread(() -> {
                    if (!dialog.isShowing()) return;
                    String selectedId = selectedProfileId(profiles, spinner);
                    profiles.clear(); profiles.addAll(fresh); labels.clear(); defaultId[0] = freshDefault;
                    int selection = 0;
                    for (int i = 0; i < profiles.size(); i++) {
                        JSONObject profile = profiles.get(i); String id = profile.optString("id");
                        labels.add(profile.optString("name", "未命名方案") + " · " + profile.optString("model", "未配置") + (id.equals(defaultId[0]) ? " · 默认" : "") + (profile.optBoolean("hasKey") ? "" : " · 缺少 API Key"));
                        if (id.equals(selectedId)) selection = i;
                    }
                    if (profiles.isEmpty()) labels.add("尚无方案，请新增");
                    adapter.notifyDataSetChanged();
                    if (!profiles.isEmpty()) {
                        if (selectedId.isEmpty() || profiles.stream().noneMatch(profile -> profile.optString("id").equals(selectedId))) {
                            for (int i = 0; i < profiles.size(); i++) if (profiles.get(i).optString("id").equals(defaultId[0])) { selection = i; break; }
                        }
                        spinner.setSelection(selection);
                    }
                    summary.setText(activity.getString(R.string.profile_count_summary, profiles.size()));
                    dialog.setTitle(activity.getString(R.string.profile_count_title, profiles.size())); updateButtons.run();
                });
            } catch (Exception error) { activity.runOnUiThread(() -> { if (dialog.isShowing()) summary.setText(activity.getString(R.string.profile_load_failed, message(error))); }); }
        });
    }

    private static void edit(Activity activity, RoomService.RoomLink link, JSONObject selected, ArrayList<JSONObject> profiles, String defaultId) {
        boolean creating = selected == null;
        JSONObject source = selected == null ? (profiles.isEmpty() ? new JSONObject() : profiles.get(0)) : selected;
        LinearLayout form = new LinearLayout(activity); form.setOrientation(LinearLayout.VERTICAL); form.setPadding(dp(activity, 16), 0, dp(activity, 16), 0);
        ScrollView scroll = new ScrollView(activity); scroll.addView(form);
        EditText name = field(activity, form, "方案名称", "方案名称"); name.setText(creating ? "新模型方案" : source.optString("name"));
        EditText url = field(activity, form, "API URL", "https://api.openai.com/v1"); url.setText(source.optString("apiUrl", "https://api.openai.com/v1"));
        Spinner type = new Spinner(activity); type.setAdapter(new ArrayAdapter<String>(activity, android.R.layout.simple_spinner_dropdown_item, new String[]{"Chat Completions", "Responses"})); type.setSelection("responses".equals(source.optString("apiType")) ? 1 : 0); form.addView(type);
        EditText model = field(activity, form, "模型", "gpt-5.6-sol"); model.setText(source.optString("model", "gpt-5.6-sol"));
        EditText key = field(activity, form, "API Key（留空保留）", source.optBoolean("hasKey") ? "已安全保存，输入以替换" : "输入模型服务密钥"); key.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        EditText calls = field(activity, form, "最多调用次数", "24"); calls.setInputType(InputType.TYPE_CLASS_NUMBER); calls.setText(String.valueOf(source.optInt("maxCalls", 24)));
        EditText steps = field(activity, form, "最多操作步数", "24"); steps.setInputType(InputType.TYPE_CLASS_NUMBER); steps.setText(String.valueOf(source.optInt("maxSteps", 24)));
        EditText timeout = field(activity, form, "超时（秒）", "900"); timeout.setInputType(InputType.TYPE_CLASS_NUMBER); timeout.setText(String.valueOf(source.optInt("timeoutSeconds", 900)));
        AlertDialog dialog = new AlertDialog.Builder(activity).setTitle(creating ? "新增房间模型方案" : "编辑房间模型方案").setMessage("此房间共有 " + profiles.size() + " 个方案。更改会同步到 Android 与电脑。").setView(scroll).setNegativeButton("取消", null).setPositiveButton("保存", null).setNeutralButton("测试连接", null).create();
        dialog.setOnShowListener(ignored -> {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
                try {
                    JSONObject payload = new JSONObject().put("name", name.getText().toString().trim()).put("apiType", type.getSelectedItemPosition() == 1 ? "responses" : "chat_completions").put("apiUrl", url.getText().toString().trim()).put("model", model.getText().toString().trim()).put("apiKey", key.getText().toString()).put("maxCalls", Integer.parseInt(calls.getText().toString())).put("maxSteps", Integer.parseInt(steps.getText().toString())).put("timeoutSeconds", Integer.parseInt(timeout.getText().toString())).put("setDefault", creating && profiles.isEmpty());
                    if (creating) payload.put("createNew", true); else payload.put("profileId", selected.optString("id"));
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);
                    save(activity, link, payload, selected == null ? "" : selected.optString("id"), dialog);
                } catch (Exception e) { toast(activity, "请检查方案名称和调用限制：" + message(e)); }
            });
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v -> {
                try {
                    JSONObject draft = new JSONObject()
                            .put("name", name.getText().toString().trim())
                            .put("apiType", type.getSelectedItemPosition() == 1 ? "responses" : "chat_completions")
                            .put("apiUrl", url.getText().toString().trim())
                            .put("model", model.getText().toString().trim())
                            .put("apiKey", key.getText().toString())
                            .put("maxCalls", Integer.parseInt(calls.getText().toString()))
                            .put("maxSteps", Integer.parseInt(steps.getText().toString()))
                            .put("timeoutSeconds", Integer.parseInt(timeout.getText().toString()));
                    if (selected != null) draft.put("profileId", selected.optString("id"));
                    testDraft(activity, link, draft);
                } catch (Exception e) { toast(activity, "请检查方案参数和 API Key：" + message(e)); }
            });
        });
        dialog.show();
    }

    private static void save(Activity activity, RoomService.RoomLink link, JSONObject payload, String id, AlertDialog editor) {
        IO.execute(() -> {
            try { request(link, "/device/room/profiles", payload, "POST"); activity.runOnUiThread(() -> { if (editor.isShowing()) editor.dismiss(); toast(activity, "模型方案已同步到房间"); load(activity, link, id); }); }
            catch (Exception e) { activity.runOnUiThread(() -> { if (editor.isShowing()) editor.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true); toast(activity, "保存失败：" + message(e)); }); }
        });
    }

    private static void test(Activity activity, RoomService.RoomLink link, JSONObject profile) {
        String id = profile.optString("id");
        IO.execute(() -> {
            try { JSONObject result = (JSONObject) request(link, "/device/room/profiles/" + id + "/test", new JSONObject(), "POST"); activity.runOnUiThread(() -> toast(activity, "连接成功：" + result.optString("reply"))); }
            catch (Exception e) { activity.runOnUiThread(() -> toast(activity, "连接测试失败：" + message(e))); }
        });
    }

    private static void testDraft(Activity activity, RoomService.RoomLink link, JSONObject draft) {
        IO.execute(() -> {
            try { JSONObject result = (JSONObject) request(link, "/device/room/profiles/test", draft, "POST"); activity.runOnUiThread(() -> toast(activity, "连接成功：" + result.optString("reply"))); }
            catch (Exception e) { activity.runOnUiThread(() -> toast(activity, "连接测试失败：" + message(e))); }
        });
    }

    private static void mutate(Activity activity, RoomService.RoomLink link, String path, JSONObject body, String method, String selectedId, String success) {
        IO.execute(() -> { try { request(link, path, body, method); activity.runOnUiThread(() -> { toast(activity, success); load(activity, link, selectedId); }); } catch (Exception e) { activity.runOnUiThread(() -> toast(activity, "操作失败：" + message(e))); } });
    }

    private static Object request(RoomService.RoomLink link, String path, JSONObject body, String method) throws Exception {
        Request.Builder builder = link.request(path);
        if (!method.equals("GET")) builder.method(method, method.equals("DELETE") ? null : RequestBody.create((body == null ? new JSONObject() : body).toString(), MediaType.get("application/json")));
        try (Response response = link.client.newCall(builder.build()).execute()) {
            String raw = response.body().string();
            if (!response.isSuccessful()) throw new Exception(new JSONObject(raw).optString("title", "请求失败"));
            if (raw.startsWith("[")) return new JSONArray(raw);
            return new JSONObject(raw);
        }
    }
    private static JSONObject selectedProfile(ArrayList<JSONObject> profiles, Spinner spinner) { int position = spinner.getSelectedItemPosition(); return position >= 0 && position < profiles.size() ? profiles.get(position) : null; }
    private static String selectedProfileId(ArrayList<JSONObject> profiles, Spinner spinner) { JSONObject selected = selectedProfile(profiles, spinner); return selected == null ? "" : selected.optString("id"); }
    private static EditText field(Activity activity, LinearLayout group, String label, String hint) { TextView title = text(activity, label, 12, MUTED, true); group.addView(title); EditText input = new EditText(activity); input.setTextSize(14); input.setTextColor(INK); input.setHint(hint); input.setSingleLine(true); input.setPadding(dp(activity, 12), dp(activity, 4), dp(activity, 12), dp(activity, 4)); input.setBackground(background(activity, Color.rgb(245,248,247), 8)); group.addView(input, new LinearLayout.LayoutParams(-1, dp(activity, 48))); return input; }
    private static Button button(Activity activity, String label) { Button button = new Button(activity); button.setText(label); button.setTextSize(11); button.setAllCaps(false); button.setTextColor(ACCENT); button.setMinHeight(dp(activity, 42)); button.setPadding(dp(activity, 3), dp(activity, 2), dp(activity, 3), dp(activity, 2)); return button; }
    private static LinearLayout.LayoutParams weight(Activity activity) { return new LinearLayout.LayoutParams(0, dp(activity, 46), 1); }
    private static TextView text(Activity activity, String value, int size, int color, boolean bold) { TextView view = new TextView(activity); view.setText(value); view.setTextSize(size); view.setTextColor(color); if (bold) view.setTypeface(null, Typeface.BOLD); return view; }
    private static GradientDrawable background(Activity activity, int color, int radius) { GradientDrawable drawable = new GradientDrawable(); drawable.setColor(color); drawable.setCornerRadius(dp(activity, radius)); return drawable; }
    private static int dp(Activity activity, int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }
    private static String message(Exception error) { return error.getMessage() == null ? "请重试" : error.getMessage(); }
    private static void toast(Activity activity, String value) { Toast.makeText(activity, value, Toast.LENGTH_LONG).show(); }
}
