package com.nexusroom.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.animation.ObjectAnimator;
import android.animation.ValueAnimator;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import android.Manifest;
import android.content.pm.PackageManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.inputmethod.InputMethodManager;
import android.widget.*;
import org.json.*;
import okhttp3.*;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** An in-app overlay; the optional system overlay grant is used only for local wake navigation. */
final class AgentOverlay {
    private final Activity activity;
    private final FrameLayout root;
    private final LinearLayout panel, modes, footer;
    private final Button launcher, requestMode, automaticMode, targetPicker, send, stop, mic, voiceSettings;
    private final Spinner profilePicker;
    private final TextView room, hint, output, status;
    private final View recordingDot;
    private ObjectAnimator recordingBlink;
    private final EditText input;
    private final Button workspacePicker,arrangeCommunication;
    private String workspacePath = "";
    private PcWorkspacePicker directoryDialog;
    private final ScrollView conversation;
    private final SharedPreferences prefs;
    private final VoiceController voice;
    private String voiceState="";
    private boolean holdingMic;
    private final VoiceController.Listener voiceListener=new VoiceController.Listener(){
        public void state(String message,boolean recording){if(destroyed)return;voiceState=message;boolean local=voice.recording(member);mic.setText(local?"●":"🎙");mic.setContentDescription(local?"正在录音，松开完成转写":"长按麦克风，松开后填入任务");refreshControls();}
        public void manualText(String source,String text){if(destroyed||!resumed||!visible||!open||occluded||!source.equals(member))return;String draft=input.getText().toString();input.setText(draft.isBlank()?text:draft+"\n"+text);input.setSelection(input.length());setOpen(true);}
        public void automaticResult(String source,String text,JSONObject result){if(destroyed||!source.equals(member))return;String id=result.optString("targetId");if(!id.isEmpty()){targetId=id;savedTargetId=id;prefs.edit().putString("target:"+member,id).apply();for(TargetInfo device:targetDevices)if(device.id.equals(id)){targetName=device.name;targetOnline=device.online;targetAgent=device.agent;targetActivity=device.activity;break;}}JSONObject run=result.optJSONObject("run");runningMode=run==null?"automatic":run.optString("mode","automatic");runningId=run==null?result.optString("runId"):run.optString("id",result.optString("runId"));output.setText(activity.getString(R.string.agent_planning,text));setOpen(true);targetsAt=0;loadTargets();refreshControls();poll();}
    };
    private final Runnable startVoiceHold=this::beginVoiceHold;
    private void beginVoiceHold(){holdingMic=true;voice.beginManual();}
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final int ink = Color.rgb(22,45,43), muted = Color.rgb(100,121,115), accent = Color.rgb(17,139,119);
    private RoomService.RoomLink link;
    private String member = "", mode = "request", runningMode = "request", runningId = "", approvalShown = "", selectedProfileId = "", defaultProfileId = "";
    private String targetId = "", savedTargetId = "", targetName = "本机", targetActivity = "offline";
    private boolean targetOnline, targetAgent, targetLoading;
    private long targetsAt, profilesAt;
    private boolean open, visible, resumed, destroyed, polling, sending, loading, occluded;
    private final ArrayList<TargetInfo> targetDevices = new ArrayList<>();
    private final ArrayList<ProfileInfo> profiles = new ArrayList<>();
    private boolean profileLoading, changingProfile;
    private int generation;
    private AlertDialog approvalDialog, targetDialog;
    private float panelX, panelY, bubbleX, bubbleY;
    private final Runnable tick = new Runnable() { public void run() { poll(); main.postDelayed(this,2500); } };
    private static final class TargetInfo {
        final String id, name, activity;
        final boolean online, agent;
        TargetInfo(String id, String name, String activity, boolean online, boolean agent) { this.id=id; this.name=name; this.activity=activity; this.online=online; this.agent=agent; }
    }
    private static final class ProfileInfo {
        final String id, name, model;
        final boolean hasKey;
        ProfileInfo(String id, String name, String model, boolean hasKey) { this.id=id; this.name=name; this.model=model; this.hasKey=hasKey; }
    }

    AgentOverlay(Activity activity, FrameLayout root) {
        this.activity=activity; this.root=root;
        prefs=ReleaseStorage.preferences(activity,"agent-overlay");
        voice=VoiceController.get(activity);
        open=prefs.getBoolean("open",false);
        panelX=prefs.getFloat("panel-x",1); panelY=prefs.getFloat("panel-y",.35f);
        bubbleX=prefs.getFloat("bubble-x",1); bubbleY=prefs.getFloat("bubble-y",.88f);
        panel=new LinearLayout(activity);panel.setOrientation(LinearLayout.VERTICAL);panel.setPadding(dp(14),dp(8),dp(14),dp(12));
        panel.setBackground(bg(Color.WHITE,20));panel.setElevation(dp(14));panel.setClickable(true);
        panel.setContentDescription("Nexus Agent 悬浮窗");
        LinearLayout header=row();TextView title=text("✦  Nexus Agent   ⠿",18,ink,true);title.setGravity(Gravity.CENTER_VERTICAL);
        title.setContentDescription("拖动 Agent 悬浮窗");header.addView(title,new LinearLayout.LayoutParams(0,dp(46),1));
        recordingDot=new View(activity);GradientDrawable dot=new GradientDrawable();dot.setShape(GradientDrawable.OVAL);dot.setColor(Color.rgb(224,49,49));recordingDot.setBackground(dot);recordingDot.setContentDescription("本机正在录音");recordingDot.setVisibility(View.GONE);
        LinearLayout.LayoutParams dotParams=new LinearLayout.LayoutParams(dp(10),dp(10));dotParams.gravity=Gravity.CENTER_VERTICAL;dotParams.setMargins(dp(8),0,dp(8),0);header.addView(recordingDot,dotParams);
        Button hide=button("—",false);hide.setContentDescription("收起 Agent 悬浮窗");hide.setOnClickListener(v->setOpen(false));header.addView(hide,new LinearLayout.LayoutParams(dp(48),dp(46)));panel.addView(header);
        room=text("",12,muted,false);room.setSingleLine(true);room.setEllipsize(android.text.TextUtils.TruncateAt.END);panel.addView(room,new LinearLayout.LayoutParams(-1,dp(28)));
        targetPicker=button("目标设备：本机",false);targetPicker.setContentDescription("选择 Agent 目标设备");targetPicker.setOnClickListener(v->chooseTarget());panel.addView(targetPicker,new LinearLayout.LayoutParams(-1,dp(42)));
        arrangeCommunication=button("安排会议或通话",false);arrangeCommunication.setContentDescription("安排会议或通话");arrangeCommunication.setOnClickListener(v->chooseCommunication());panel.addView(arrangeCommunication,new LinearLayout.LayoutParams(-1,dp(42)));
        workspacePicker=button("PC 工作目录：Windows 用户主目录  ▾",false);workspacePicker.setContentDescription("选择 PC 工作目录");workspacePicker.setSingleLine(true);workspacePicker.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);panel.addView(workspacePicker,new LinearLayout.LayoutParams(-1,dp(42)));
        workspacePicker.setOnClickListener(v->chooseWorkspace());
        profilePicker=new Spinner(activity);profilePicker.setContentDescription("选择房间模型方案");panel.addView(profilePicker,new LinearLayout.LayoutParams(-1,dp(44)));
        profilePicker.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener(){public void onNothingSelected(android.widget.AdapterView<?> parent){}public void onItemSelected(android.widget.AdapterView<?> parent,View view,int position,long id){if(changingProfile||position<0||position>=profiles.size())return;selectedProfileId=profiles.get(position).id;if(!member.isEmpty())prefs.edit().putString("profile:"+member,selectedProfileId).apply();refreshControls();}});
        modes=row();modes.setBackground(bg(Color.rgb(239,245,241),10));requestMode=button("请求模式",false);automaticMode=button("自动模式",false);
        modes.addView(requestMode,new LinearLayout.LayoutParams(0,dp(44),1));modes.addView(automaticMode,new LinearLayout.LayoutParams(0,dp(44),1));panel.addView(modes);
        requestMode.setOnClickListener(v->chooseMode("request"));automaticMode.setOnClickListener(v->chooseMode("automatic"));
        hint=text("",11,muted,false);hint.setPadding(0,dp(5),0,dp(4));panel.addView(hint);
        conversation=new ScrollView(activity);conversation.setFillViewport(true);conversation.setBackground(bg(Color.rgb(247,250,248),10));
        output=text("描述你想完成的事情。\n\n可以操作手机，或让电脑发送已授权的文件。",13,ink,false);output.setPadding(dp(12),dp(12),dp(12),dp(12));output.setTextIsSelectable(true);conversation.addView(output);
        panel.addView(conversation,new LinearLayout.LayoutParams(-1,0,1));
        status=text("",11,muted,false);status.setSingleLine(true);status.setEllipsize(android.text.TextUtils.TruncateAt.END);status.setPadding(0,dp(4),0,dp(4));panel.addView(status,new LinearLayout.LayoutParams(-1,dp(28)));
        input=new EditText(activity);input.setTextSize(14);input.setTextColor(ink);input.setHintTextColor(muted);input.setHint("让手机与电脑帮你完成任务…");input.setContentDescription("输入 Agent 任务");
        input.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_MULTI_LINE);input.setGravity(Gravity.TOP);input.setMaxLines(3);input.setFilters(new InputFilter[]{new InputFilter.LengthFilter(8000)});input.setPadding(dp(10),dp(8),dp(10),dp(8));input.setBackground(bg(Color.rgb(240,246,242),10));
        LinearLayout inputRow=row();mic=button("🎙",false);mic.setTextSize(20);mic.setContentDescription("长按麦克风，松开后填入任务");voiceSettings=button("⚙",false);voiceSettings.setContentDescription("离线语音设置");
        inputRow.addView(mic,new LinearLayout.LayoutParams(dp(46),dp(66)));inputRow.addView(input,new LinearLayout.LayoutParams(0,dp(66),1));inputRow.addView(voiceSettings,new LinearLayout.LayoutParams(dp(38),dp(66)));panel.addView(inputRow,new LinearLayout.LayoutParams(-1,-2));
        mic.setOnClickListener(v->{if(!voice.hasPermission())requestVoicePermission();else Toast.makeText(activity,"长按麦克风开始录音，松开完成转写",Toast.LENGTH_SHORT).show();});
        mic.setOnTouchListener((v,event)->{switch(event.getActionMasked()){case MotionEvent.ACTION_DOWN:holdingMic=false;if(!voice.hasPermission()){requestVoicePermission();return true;}main.postDelayed(startVoiceHold,ViewConfiguration.getLongPressTimeout());return true;case MotionEvent.ACTION_UP:main.removeCallbacks(startVoiceHold);if(holdingMic){voice.endManual(false);holdingMic=false;}else v.performClick();return true;case MotionEvent.ACTION_CANCEL:main.removeCallbacks(startVoiceHold);voice.endManual(true);holdingMic=false;return true;default:return true;}});
        voiceSettings.setOnClickListener(v->configureVoice());
        input.addTextChangedListener(new TextWatcher(){public void beforeTextChanged(CharSequence s,int a,int c,int f){}public void onTextChanged(CharSequence s,int a,int b,int c){if(!loading&&!member.isEmpty())prefs.edit().putString("draft:"+member,s.toString()).apply();refreshControls();}public void afterTextChanged(Editable e){}});
        footer=row();footer.setPadding(0,dp(8),0,0);stop=button("停止任务",false);send=button("执行任务  ↑",true);footer.addView(stop,new LinearLayout.LayoutParams(0,dp(44),1));footer.addView(send,new LinearLayout.LayoutParams(0,dp(44),1));panel.addView(footer);
        send.setOnClickListener(v->submit());stop.setOnClickListener(v->cancel());
        launcher=button("✦ Agent",true);launcher.setContentDescription("打开 Agent 悬浮窗");launcher.setElevation(dp(8));launcher.setOnClickListener(v->setOpen(true));
        root.addView(panel,new FrameLayout.LayoutParams(-1,-1));root.addView(launcher,new FrameLayout.LayoutParams(dp(124),dp(50)));
        drag(title,panel,true);drag(launcher,launcher,false);
        root.addOnLayoutChangeListener((v,l,t,r,b,ol,ot,or,ob)->layout());
        refreshControls();visibility();
    }

    void bind(RoomService.RoomLink next, boolean show) {
        String id=next==null?"":next.config.deviceId;
        if(!member.equals(id)) {
            if(directoryDialog!=null){directoryDialog.dismiss();directoryDialog=null;}
            dismissTargetDialog();
            if(approvalDialog!=null){approvalDialog.dismiss();approvalDialog=null;}
            generation++; member=id; runningId=""; approvalShown=""; sending=false; mode=prefs.getString("mode:"+id,"request");
            if(!mode.equals("automatic"))mode="request";
            targetId=id;savedTargetId=id.isEmpty()?"":prefs.getString("target:"+id,"");selectedProfileId=id.isEmpty()?"":prefs.getString("profile:"+id,"");defaultProfileId="";targetName="本机";targetActivity=next==null?"offline":"online";targetOnline=next!=null&&next.online;targetAgent=next!=null&&next.config.agent;targetLoading=false;targetDevices.clear();profiles.clear();targetsAt=0;profilesAt=0;
            loading=true;input.setText(prefs.getString("draft:"+id,""));workspacePath=prefs.getString("workspace:"+id,"");loading=false;
            output.setText("描述你想完成的事情。\n\n使用电脑为此房间配置的模型；执行过程将在这里显示。");
            conversation.scrollTo(0,0);
        }
        link=next;visible=show&&next!=null&&!next.config.leaving;
        room.setText(next==null?"":next.config.roomName+" · "+next.config.hostName);
        if(next!=null){loadTargets();loadProfiles();}
        refreshControls();visibility();if(resumed)poll();
    }
    void resume(){resumed=true;voice.bind(voiceListener,member,selectedProfileId,workspacePath);voice.foreground(true);main.removeCallbacks(tick);main.post(tick);}
    private void cancelVoiceHold(){main.removeCallbacks(startVoiceHold);holdingMic=false;voice.endManual(true);}
    void pause(){resumed=false;updateRecordingIndicator();cancelVoiceHold();voice.foreground(false);main.removeCallbacks(tick);dismissTargetDialog();if(directoryDialog!=null){directoryDialog.dismiss();directoryDialog=null;}}
    void setOccluded(boolean value){
        if(occluded==value)return;occluded=value;
        int accessibility=value?View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS:View.IMPORTANT_FOR_ACCESSIBILITY_AUTO;
        panel.setImportantForAccessibility(accessibility);launcher.setImportantForAccessibility(accessibility);
        if(value){cancelVoiceHold();input.clearFocus();dismissTargetDialog();if(directoryDialog!=null){directoryDialog.dismiss();directoryDialog=null;}if(approvalDialog!=null){approvalDialog.dismiss();approvalDialog=null;}approvalShown="";}
        visibility();if(!value&&resumed)poll();
    }
    void destroy(){destroyed=true;pause();voice.unbind(voiceListener);if(directoryDialog!=null){directoryDialog.dismiss();directoryDialog=null;}if(approvalDialog!=null){approvalDialog.dismiss();approvalDialog=null;}io.shutdownNow();main.removeCallbacksAndMessages(null);}
    boolean collapse(){if(visible&&open){setOpen(false);return true;}return false;}
    void openForWake(String source){if(!destroyed&&visible&&source.equals(member)){setOpen(true);updateRecordingIndicator();}}
    private void updateRecordingIndicator(){
        if(recordingDot==null)return;
        boolean show=!destroyed&&resumed&&visible&&open&&!occluded&&voice.recording(member);
        recordingDot.setVisibility(show?View.VISIBLE:View.GONE);
        if(show&&recordingBlink==null){recordingBlink=ObjectAnimator.ofFloat(recordingDot,View.ALPHA,1f,.2f);recordingBlink.setDuration(500);recordingBlink.setRepeatMode(ValueAnimator.REVERSE);recordingBlink.setRepeatCount(ValueAnimator.INFINITE);recordingBlink.start();}
        else if(!show&&recordingBlink!=null){recordingBlink.cancel();recordingBlink=null;recordingDot.setAlpha(1f);}
    }
    private void setOpen(boolean value){open=value;prefs.edit().putBoolean("open",value).apply();if(!value){cancelVoiceHold();input.clearFocus();dismissTargetDialog();if(directoryDialog!=null){directoryDialog.dismiss();directoryDialog=null;}((InputMethodManager)activity.getSystemService(Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(input.getWindowToken(),0);}visibility();if(value)poll();}
    private void chooseWorkspace(){
        if(link==null||!workspacePicker.isEnabled())return;
        if(directoryDialog!=null)directoryDialog.dismiss();
        RoomService.RoomLink source=link;int epoch=generation;
        directoryDialog=new PcWorkspacePicker(activity,source,workspacePath,()->resumed&&valid(epoch)&&link==source&&source.online&&source.config.agent&&targetId.startsWith("pc:")&&!sending&&runningId.isEmpty(),path->{workspacePath=path;prefs.edit().putString("workspace:"+member,path).apply();refreshControls();});
    }
    private void visibility(){boolean showPanel=!occluded&&visible&&open;if(!showPanel)cancelVoiceHold();panel.setVisibility(showPanel?View.VISIBLE:View.GONE);launcher.setVisibility(!occluded&&visible&&!open?View.VISIBLE:View.GONE);updateRecordingIndicator();root.post(this::layout);}
    private void chooseMode(String value){if(sending||!runningId.isEmpty())return;mode=value;prefs.edit().putString("mode:"+member,value).apply();refreshControls();}
    private void refreshControls(){
        if(send==null)return;
        voice.configure(member,selectedProfileId,workspacePath);
        updateRecordingIndicator();
        mic.setEnabled(voice.enabled()&&resumed&&!sending&&runningId.isEmpty());mic.setAlpha(mic.isEnabled()?1f:.45f);
        boolean active=!runningId.isEmpty(), connected=link!=null&&link.online, sourceBusy=link!=null&&"busy".equals(link.activity());
        // Voice runs execute automatically without changing the user's text-input mode.
        String displayMode=active?runningMode:mode;
        boolean targetBusy="busy".equals(targetActivity), targetUsable=targetOnline&&targetAgent&&!targetBusy;
        requestMode.setEnabled(!active&&!sending);automaticMode.setEnabled(!active&&!sending);
        requestMode.setSelected(displayMode.equals("request"));automaticMode.setSelected(displayMode.equals("automatic"));
        requestMode.setBackground(bg(displayMode.equals("request")?Color.WHITE:Color.TRANSPARENT,9));automaticMode.setBackground(bg(displayMode.equals("automatic")?Color.WHITE:Color.TRANSPARENT,9));
        hint.setText(displayMode.equals("automatic")?"已授权操作自动连续执行，无需逐步批准。":"敏感操作会逐次请求批准。");
        targetPicker.setText(targetName.isEmpty()?"目标设备：本机":"目标设备："+targetName);
        targetPicker.setEnabled(connected&&link.config.agent&&!sourceBusy&&!active&&!sending);
        arrangeCommunication.setEnabled(connected&&link.config.agent&&!sourceBusy&&!active&&!sending&&link.communication.online);
        workspacePicker.setVisibility(targetId.startsWith("pc:")?View.VISIBLE:View.GONE);
        workspacePicker.setText("PC 工作目录："+(workspacePath.isEmpty()?"Windows 用户主目录":workspacePath)+"  ▾");
        workspacePicker.setEnabled(connected&&link.config.agent&&targetAgent&&!active&&!sending);
        profilePicker.setEnabled(!active&&!sending&&profiles.size()>0);
        send.setEnabled(connected&&link.config.agent&&!sourceBusy&&targetUsable&&!active&&!sending&&!selectedProfileId.isEmpty()&&selectedProfileHasKey()&&!input.getText().toString().trim().isEmpty());
        send.setText(sending?"正在提交…":"执行任务  ↑");stop.setEnabled(connected&&active);
        send.setAlpha(send.isEnabled()?1f:.45f);stop.setAlpha(stop.isEnabled()?1f:.45f);
        status.setText(!voiceState.isEmpty()&&!active?voiceState:!connected?"电脑离线，连接后可继续":!link.config.agent?"请先在房间页面开启 Agent 操作":profiles.isEmpty()?"正在读取房间模型方案…":!selectedProfileHasKey()?"所选方案尚未配置 API Key":sourceBusy?"本机正在其他房间工作":!targetOnline?"目标设备离线":!targetAgent?"目标设备尚未允许 Agent":targetBusy?"目标设备正在其他房间工作":active?"任务执行中 · "+modeLabel(displayMode):"目标："+targetName+" · "+modeLabel(mode));
        launcher.setText(active?"✦ Agent · 执行中":"✦ Agent");
    }
    private void requestVoicePermission(){activity.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},31);}
    void voicePermissionResult(boolean granted){voiceState=granted?"麦克风已授权，请再次长按或开启语音唤醒":"麦克风未授权，文字输入仍可使用";refreshControls();}
    private void configureVoice(){
        LinearLayout content=new LinearLayout(activity);content.setOrientation(LinearLayout.VERTICAL);content.setPadding(dp(22),dp(10),dp(22),dp(10));
        Switch enabled=new Switch(activity);enabled.setText("离线语音输入");enabled.setChecked(voice.enabled());content.addView(enabled);
        Switch wake=new Switch(activity);wake.setText("Hi Nexus 自动唤醒");wake.setChecked(voice.wakeEnabled());content.addView(wake);
        Switch background=new Switch(activity);background.setText("允许后台监听（持续麦克风通知）");background.setChecked(voice.backgroundEnabled());content.addView(background);
        content.addView(text("本机响应 Hi Nexus 后打开 Agent；录音时标题旁显示闪烁红点。后台自动打开需要 NexusRoom 无障碍服务或系统‘显示在其他应用上层’授权。",12,muted,false));
        Button wakePermission=button("允许后台唤醒打开 Agent",false);wakePermission.setOnClickListener(v->activity.startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,Uri.parse("package:"+activity.getPackageName()))));content.addView(wakePermission);
        content.addView(text("长按麦克风只填入文字，由你确认发送。唤醒后自动识别设备并按自动模式执行；识别全程本地离线。后台监听须从应用前台启动，通知可随时停止。通话占用麦克风时暂停语音。",12,muted,false));
        new AlertDialog.Builder(activity).setTitle("离线语音设置").setView(content).setNegativeButton("取消",null).setPositiveButton("保存",(d,w)->{
            voice.enabled(enabled.isChecked());
            if((wake.isChecked()||background.isChecked())&&!voice.hasPermission()){voice.wake(false);voice.background(false);requestVoicePermission();return;}
            if(background.isChecked()&&!voice.hasBackgroundPermissions()){voice.wake(enabled.isChecked()&&wake.isChecked());voice.background(false);activity.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},32);Toast.makeText(activity,"后台监听需要通知权限，授权后请再次开启",Toast.LENGTH_LONG).show();return;}
            voice.wake(enabled.isChecked()&&wake.isChecked());voice.background(enabled.isChecked()&&wake.isChecked()&&background.isChecked());refreshControls();
            if(enabled.isChecked()&&wake.isChecked()&&background.isChecked()&&!VoiceWakeUi.canOpenFromBackground(activity)){
                Toast.makeText(activity,"允许显示在其他应用上层后，后台唤醒可自动打开 Agent",Toast.LENGTH_LONG).show();
                activity.startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,Uri.parse("package:"+activity.getPackageName())));
            }
        }).show();
    }
    private static String modeLabel(String mode){return mode.equals("automatic")?"自动模式":"请求模式";}
    private static String statusLabel(String s){switch(s){case "running":return "执行中";case "completed":return "已完成";case "cancelled":return "已停止";case "failed":return "未完成";default:return s;}}
    private void submit(){
        if(!send.isEnabled())return;
        RoomService.RoomLink target=link;int epoch=generation;String task=input.getText().toString().trim(), chosen=mode, chosenTarget=targetId, workspacePath=this.workspacePath;
        sending=true;refreshControls();input.clearFocus();((InputMethodManager)activity.getSystemService(Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(input.getWindowToken(),0);
        String profileId=selectedProfileId;
        io.execute(()->{try{JSONObject body=new JSONObject().put("task",task).put("mode",chosen).put("profileId",profileId).put("targetDeviceId",chosenTarget);if(chosenTarget.startsWith("pc:"))body.put("workspacePath",workspacePath);JSONObject run=(JSONObject)request(target,"/device/agent/runs",body,"POST");main.post(()->{if(!valid(epoch))return;sending=false;runningMode=run.optString("mode",chosen);runningId=run.optString("id");input.setText("");output.setText(activity.getString(R.string.agent_planning,task));refreshControls();poll();});}catch(Exception e){main.post(()->{if(valid(epoch)){sending=false;showError(e);refreshControls();}});}});
    }
    private void poll(){
        if(destroyed||occluded||polling||!visible||link==null||!link.online||!link.config.agent)return;
        loadTargets();
        loadProfiles();
        polling=true;RoomService.RoomLink target=link;int epoch=generation;String selectedTarget=targetId;
        io.execute(()->{try{String suffix=selectedTarget.isEmpty()?"":"?targetDeviceId="+android.net.Uri.encode(selectedTarget);JSONArray runs=(JSONArray)request(target,"/device/agent/runs"+suffix,null,"GET");main.post(()->{
            polling=false;
            // A target can change while its old request is still in flight.
            // Its runs and approvals must never replace the new target's view.
            if(occluded)return;
            if(!valid(epoch)||link!=target||!selectedTarget.equals(targetId)){poll();return;}
            showRuns(runs);
        });}catch(Exception e){main.post(()->{
            polling=false;
            if(!valid(epoch)||link!=target||!selectedTarget.equals(targetId)){poll();return;}
            if(open)status.setText("任务状态更新失败，正在重试");
        });}});
    }
    private void loadTargets(){
        if(destroyed||link==null||!link.online||!link.config.agent||targetLoading||android.os.SystemClock.elapsedRealtime()-targetsAt<8000)return;
        targetLoading=true;targetsAt=android.os.SystemClock.elapsedRealtime();RoomService.RoomLink source=link;int epoch=generation;
        io.execute(()->{try{JSONArray devices=(JSONArray)request(source,"/device/room/devices",null,"GET");main.post(()->{if(!valid(epoch)){targetLoading=false;return;}targetLoading=false;targetDevices.clear();for(int i=0;i<devices.length();i++){JSONObject d=devices.optJSONObject(i);if(d==null)continue;targetDevices.add(new TargetInfo(d.optString("id"),d.optString("name","Android"),d.optString("activity","offline"),d.optBoolean("online"),d.optBoolean("agent")));}TargetInfo selected=null;for(TargetInfo d:targetDevices)if(d.id.equals(savedTargetId)){selected=d;break;}if(selected==null)for(TargetInfo d:targetDevices)if(d.id.equals(member)){selected=d;break;}if(selected!=null){if(!targetId.equals(selected.id))clearTargetView();targetId=selected.id;targetName=selected.name;targetActivity=selected.activity;targetOnline=selected.online;targetAgent=selected.agent;prefs.edit().putString("target:"+member,targetId).apply();}refreshControls();});}catch(Exception e){main.post(()->targetLoading=false);}});
    }
    private void chooseCommunication(){
        RoomService.RoomLink source=link;int epoch=generation;if(source==null||!source.online||!source.config.agent||!arrangeCommunication.isEnabled())return;
        new AlertDialog.Builder(activity).setTitle("安排会议或通话").setItems(new String[]{"拨打私人音频电话","创建公开视频会议","创建私密视频会议"},(dialog,which)->{
            if(!valid(epoch)||link!=source)return;JSONArray devices=source.communication.state.optJSONArray("devices");ArrayList<JSONObject> choices=new ArrayList<>();if(devices!=null)for(int i=0;i<devices.length();i++){JSONObject device=devices.optJSONObject(i);if(device!=null&&!device.optString("id").equals(member)&&device.optBoolean("communicationOnline")&&!device.optBoolean("busy"))choices.add(device);}
            String[] labels=new String[choices.size()];for(int i=0;i<choices.size();i++)labels[i]=choices.get(i).optString("name","设备")+" · "+choices.get(i).optString("system");
            if(which==0){if(choices.isEmpty()){Toast.makeText(activity,"暂无可通话设备",Toast.LENGTH_SHORT).show();return;}new AlertDialog.Builder(activity).setTitle("选择呼叫设备").setItems(labels,(d,index)->{if(!valid(epoch)||link!=source)return;JSONObject device=choices.get(index);prepareCommunicationPrompt("请给 "+device.optString("name")+"（设备 ID："+device.optString("id")+"）打私人音频电话。");}).setNegativeButton("取消",null).show();}
            else {boolean[] checked=new boolean[choices.size()];new AlertDialog.Builder(activity).setTitle("选择邀请设备").setMultiChoiceItems(labels,checked,(d,index,value)->checked[index]=value).setNegativeButton("取消",null).setPositiveButton("准备任务",(d,w)->{if(!valid(epoch)||link!=source)return;ArrayList<String> invitees=new ArrayList<>();for(int i=0;i<checked.length;i++)if(checked[i]){JSONObject device=choices.get(i);invitees.add(device.optString("name")+"（设备 ID："+device.optString("id")+"）");}prepareCommunicationPrompt("请在本机创建一个"+(which==1?"公开":"私密")+"视频会议室，标题为房间视频会议"+(invitees.isEmpty()?"。":"，邀请 "+String.join("、",invitees)+" 加入。"));}).show();}
        }).show();
    }
    private void prepareCommunicationPrompt(String prompt){if(link==null||!link.online||!link.config.agent||sending||!runningId.isEmpty())return;clearTargetView();targetId=member;savedTargetId=member;targetName="本机";targetActivity=link.activity();targetOnline=link.online;targetAgent=link.config.agent;prefs.edit().putString("target:"+member,member).apply();input.setText(prompt);input.setSelection(input.length());refreshControls();}
    private boolean selectedProfileHasKey(){for(ProfileInfo profile:profiles)if(profile.id.equals(selectedProfileId))return profile.hasKey;return false;}
    private void loadProfiles(){
        if(destroyed||link==null||!link.online||profileLoading||android.os.SystemClock.elapsedRealtime()-profilesAt<8000)return;
        profileLoading=true;profilesAt=android.os.SystemClock.elapsedRealtime();RoomService.RoomLink source=link;int epoch=generation;
        io.execute(()->{try{JSONObject room=(JSONObject)request(source,"/device/room",null,"GET");JSONArray values=room.optJSONArray("profiles");ArrayList<ProfileInfo> loaded=new ArrayList<>();if(values!=null)for(int i=0;i<values.length();i++){JSONObject item=values.optJSONObject(i);if(item!=null)loaded.add(new ProfileInfo(item.optString("id"),item.optString("name","未命名方案"),item.optString("model"),item.optBoolean("hasKey")));}String chosen=room.optString("defaultProfileId");main.post(()->{if(!valid(epoch)){profileLoading=false;return;}profileLoading=false;profiles.clear();profiles.addAll(loaded);defaultProfileId=chosen;String preferred=selectedProfileId.isEmpty()?prefs.getString("profile:"+member,""):selectedProfileId;boolean exists=false;for(ProfileInfo profile:profiles)if(profile.id.equals(preferred)){exists=true;break;}if(!exists)preferred=defaultProfileId;selectedProfileId=preferred;changingProfile=true;ArrayList<String> labels=new ArrayList<>();int selected=0;for(int i=0;i<profiles.size();i++){ProfileInfo profile=profiles.get(i);labels.add(profile.name+" · "+profile.model+(profile.id.equals(defaultProfileId)?" · 默认":"")+(profile.hasKey?"":" · 未配置"));if(profile.id.equals(selectedProfileId))selected=i;}ArrayAdapter<String> adapter=new ArrayAdapter<>(activity,android.R.layout.simple_spinner_item,labels);adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);profilePicker.setAdapter(adapter);if(!profiles.isEmpty())profilePicker.setSelection(selected);changingProfile=false;if(!selectedProfileId.isEmpty())prefs.edit().putString("profile:"+member,selectedProfileId).apply();refreshControls();});}catch(Exception e){main.post(()->{profileLoading=false;if(valid(epoch))status.setText("读取房间模型方案失败："+(e.getMessage()==null?"请重试":e.getMessage()));});}});
    }
    private void chooseTarget(){
        if(link==null||!targetPicker.isEnabled()||sending||!runningId.isEmpty())return;
        if(targetDevices.isEmpty()){loadTargets();Toast.makeText(activity,"正在读取房间设备…",Toast.LENGTH_SHORT).show();return;}
        // Bind every displayed row to its identity even if polling refreshes,
        // removes or reorders the live device list while this dialog is open.
        ArrayList<TargetInfo> choices=new ArrayList<>(targetDevices);
        RoomService.RoomLink source=link;int epoch=generation;
        String[] labels=new String[choices.size()];int checked=0;
        for(int i=0;i<choices.size();i++){TargetInfo d=choices.get(i);labels[i]=d.name+" · "+(d.online?(d.agent?("busy".equals(d.activity)?"忙碌":"在线"):"未授权"):"离线");if(d.id.equals(targetId))checked=i;}
        dismissTargetDialog();
        targetDialog=new AlertDialog.Builder(activity).setTitle("选择 Agent 目标设备").setSingleChoiceItems(labels,checked,(dialog,which)->{
            if(!valid(epoch)||link!=source||!source.online||!source.config.agent||sending||!runningId.isEmpty()||which<0||which>=choices.size()){dialog.dismiss();return;}
            TargetInfo selected=choices.get(which);
            // Use current availability for that same id; a removed member must
            // be selected again from the refreshed list, never by an old index.
            TargetInfo current=null;for(TargetInfo item:targetDevices)if(item.id.equals(selected.id)){current=item;break;}
            if(current==null){dialog.dismiss();Toast.makeText(activity,"目标设备列表已变化，请重新选择",Toast.LENGTH_SHORT).show();return;}
            clearTargetView();targetId=current.id;savedTargetId=current.id;targetName=current.name;targetActivity=current.activity;targetOnline=current.online;targetAgent=current.agent;
            prefs.edit().putString("target:"+member,targetId).apply();dialog.dismiss();refreshControls();poll();
        }).setNegativeButton("取消",null).create();
        targetDialog.setOnDismissListener(dialog->{if(targetDialog==dialog)targetDialog=null;});
        targetDialog.show();
    }
    private void dismissTargetDialog(){if(targetDialog!=null){targetDialog.dismiss();targetDialog=null;}}
    private void clearTargetView(){approvalShown="";runningId="";if(approvalDialog!=null){approvalDialog.dismiss();approvalDialog=null;}if(directoryDialog!=null){directoryDialog.dismiss();directoryDialog=null;}output.setText("描述你想完成的事情。\n\n执行过程将在选定设备上显示。");}
    private void showRuns(JSONArray runs){
        StringBuilder text=new StringBuilder();runningId="";JSONObject pendingApproval=null;String pendingTaskId="";
        for(int i=0;i<runs.length();i++){
            JSONObject run=runs.optJSONObject(i);if(run==null)continue;
            boolean active="running".equals(run.optString("status"));
            if(active){runningId=run.optString("id");runningMode=run.optString("mode","request");}
            if(i>=3)continue;
            StringBuilder runText=new StringBuilder();
            runText.append(modeLabel(run.optString("mode","request"))).append(" · ").append(statusLabel(run.optString("status"))).append("\n").append(run.optString("task")).append("\n\n");
            JSONObject candidate=null;JSONArray events=run.optJSONArray("events");
            if(events!=null)for(int n=Math.max(0,events.length()-12);n<events.length();n++){
                JSONObject event=events.optJSONObject(n);if(event==null)continue;
                String value=event.optString("text");runText.append(value.length()>2400?value.substring(0,2400)+"…":value).append("\n\n");
                if(!active)continue;
                String kind=event.optString("kind",event.optString("status"));
                if("permission_required".equals(kind))candidate=event;
                else if("tool_started".equals(kind)||"tool_finished".equals(kind)||"completed".equals(kind)
                    ||"failed".equals(kind)||"cancelled".equals(kind)||"tool".equals(kind)||"assistant".equals(kind)||"error".equals(kind))candidate=null;
            }
            if(active&&candidate!=null){pendingApproval=candidate;pendingTaskId=run.optString("id");}
            runText.append("────────────\n\n");
            // Host returns newest first; place the latest run at the bottom
            // so normal conversation following shows its current result.
            text.insert(0,runText);
        }
        if(approvalDialog!=null&&(pendingApproval==null||!pendingApproval.optString("requestId").equals(approvalShown))){approvalDialog.dismiss();approvalDialog=null;}
        if(!occluded&&open&&pendingApproval!=null){String requestId=pendingApproval.optString("requestId");if(requestId.length()>0&&!requestId.equals(approvalShown)){approvalShown=requestId;showApproval(pendingTaskId,requestId,pendingApproval.optString("tool","手机操作"),pendingApproval.optJSONObject("arguments"));}}
        if(text.length()>0){String value=text.length()>32000?"…\n"+text.substring(text.length()-32000):text.toString();if(!output.getText().toString().equals(value)){boolean bottom=output.getHeight()-conversation.getScrollY()-conversation.getHeight()<dp(70);output.setText(value);if(bottom)conversation.post(()->conversation.fullScroll(View.FOCUS_DOWN));}}
        refreshControls();
    }
    private void showApproval(String taskId,String requestId,String tool,JSONObject arguments){
        String detail="无需额外参数";
        if(arguments!=null&&arguments.length()>0){try{detail=arguments.toString(2);}catch(org.json.JSONException e){detail=arguments.toString();}}
        if(detail.length()>1800)detail=detail.substring(0,1800)+"…";
        if(approvalDialog!=null)approvalDialog.dismiss();
        approvalDialog=new AlertDialog.Builder(activity).setTitle("Agent 请求确认").setMessage("即将执行："+tool+"\n\n操作参数：\n"+detail+"\n\n请核对后确认。")
            .setNegativeButton("拒绝",(d,w)->sendApproval(taskId,requestId,false)).setPositiveButton("允许一次",(d,w)->sendApproval(taskId,requestId,true)).setOnCancelListener(d->sendApproval(taskId,requestId,false)).show();
    }
    private void sendApproval(String taskId,String requestId,boolean approved){RoomService.RoomLink target=link;int epoch=generation;io.execute(()->{try{request(target,"/device/agent/approve",new JSONObject().put("taskId",taskId).put("requestId",requestId).put("approved",approved),"POST");main.post(()->{if(valid(epoch))status.setText(approved?"已允许下一步操作":"已拒绝下一步操作");});}catch(Exception e){main.post(()->{if(valid(epoch))showError(e);});}});}
    private void cancel(){if(link==null||runningId.isEmpty())return;RoomService.RoomLink target=link;String id=runningId;int epoch=generation;stop.setEnabled(false);io.execute(()->{try{request(target,"/device/agent/runs/"+id,null,"DELETE");main.post(()->{if(valid(epoch)){status.setText("已请求停止任务");poll();}});}catch(Exception e){main.post(()->{if(valid(epoch)){showError(e);refreshControls();}});}});}
    private boolean valid(int epoch){return !destroyed&&epoch==generation;}
    private void showError(Exception e){String message=e.getMessage()==null?"连接失败，请重试":e.getMessage();output.setText(activity.getString(R.string.agent_failed,message));}
    private Object request(RoomService.RoomLink target,String path,JSONObject body,String method)throws Exception{
        Request.Builder request=target.request(path);if(!method.equals("GET"))request.method(method,method.equals("DELETE")?null:RequestBody.create(body.toString(),MediaType.get("application/json")));
        try(Response response=target.client.newCall(request.build()).execute()){String raw=response.body().string();if(!response.isSuccessful())throw new Exception(new JSONObject(raw).optString("title","请求失败"));return raw.startsWith("[")?new JSONArray(raw):new JSONObject(raw);}
    }
    private void layout(){
        if(destroyed||root.getWidth()==0||root.getHeight()==0)return;
        int width=Math.min(dp(400),root.getWidth()-dp(16)),height=Math.min(dp(590),root.getHeight()-dp(16));
        FrameLayout.LayoutParams p=(FrameLayout.LayoutParams)panel.getLayoutParams();if(p.width!=width||p.height!=height){p.width=width;p.height=height;panel.setLayoutParams(p);}
        boolean compact=height<dp(520);hint.setVisibility(compact?View.GONE:View.VISIBLE);room.setVisibility(compact?View.GONE:View.VISIBLE);targetPicker.setVisibility(View.VISIBLE);workspacePicker.setVisibility(targetId.startsWith("pc:")?View.VISIBLE:View.GONE);
        LinearLayout.LayoutParams entry=(LinearLayout.LayoutParams)input.getLayoutParams();
        int entryHeight=dp(compact?48:66);
        if(entry.height!=entryHeight){entry.height=entryHeight;input.setLayoutParams(entry);}
        place(panel,panelX,panelY,width,height);place(launcher,bubbleX,bubbleY,dp(124),dp(50));
    }
    private void place(View v,float x,float y,int w,int h){v.setX(dp(8)+Math.max(0,root.getWidth()-w-dp(16))*x);v.setY(dp(8)+Math.max(0,root.getHeight()-h-dp(16))*y);}
    private void drag(View handle,View target,boolean isPanel){handle.setOnTouchListener(new View.OnTouchListener(){float x,y,startX,startY;boolean moved;public boolean onTouch(View v,MotionEvent e){switch(e.getActionMasked()){case MotionEvent.ACTION_DOWN:x=e.getRawX();y=e.getRawY();startX=target.getX();startY=target.getY();moved=false;return true;case MotionEvent.ACTION_MOVE:float dx=e.getRawX()-x,dy=e.getRawY()-y;if(Math.hypot(dx,dy)>ViewConfiguration.get(activity).getScaledTouchSlop())moved=true;if(moved){float mx=Math.max(0,root.getWidth()-target.getWidth()-dp(16)),my=Math.max(0,root.getHeight()-target.getHeight()-dp(16));float px=Math.max(0,Math.min(mx,startX+dx-dp(8))),py=Math.max(0,Math.min(my,startY+dy-dp(8)));if(isPanel){panelX=mx==0?0:px/mx;panelY=my==0?0:py/my;}else{bubbleX=mx==0?0:px/mx;bubbleY=my==0?0:py/my;}layout();}return true;case MotionEvent.ACTION_UP:if(moved)prefs.edit().putFloat("panel-x",panelX).putFloat("panel-y",panelY).putFloat("bubble-x",bubbleX).putFloat("bubble-y",bubbleY).apply();else v.performClick();return true;case MotionEvent.ACTION_CANCEL:return true;default:return false;}}});}
    private TextView text(String value,int size,int color,boolean bold){TextView v=new TextView(activity);v.setText(value);v.setTextSize(size);v.setTextColor(color);v.setLineSpacing(dp(3),1);if(bold)v.setTypeface(null,Typeface.BOLD);return v;}
    private Button button(String title,boolean primary){Button b=new Button(activity);b.setText(title);b.setTextSize(13);b.setAllCaps(false);b.setMinWidth(0);b.setMinimumWidth(0);b.setPadding(dp(8),0,dp(8),0);b.setTextColor(primary?Color.WHITE:accent);b.setBackground(bg(primary?accent:Color.rgb(237,245,241),12));return b;}
    private LinearLayout row(){LinearLayout r=new LinearLayout(activity);r.setOrientation(LinearLayout.HORIZONTAL);return r;}
    private GradientDrawable bg(int color,int radius){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));return d;}
    private int dp(int n){return Math.round(n*activity.getResources().getDisplayMetrics().density);}
}
