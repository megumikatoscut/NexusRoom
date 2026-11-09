package com.nexusroom.android;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.RendererCommon;
import org.webrtc.SurfaceViewRenderer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;

/** Native, consent-based calls and meeting UI for the selected room. */
public final class CommunicationActivity extends Activity {
    private final int ink=Color.rgb(22,45,43),muted=Color.rgb(108,128,124),accent=Color.rgb(17,139,119);
    private LinearLayout body;
    private ScrollView scroll;
    private FrameLayout root,fullscreen;
    private SurfaceViewRenderer fullscreenRenderer;
    private AspectFitVideoFrame fullscreenVideoFrame;
    private CommunicationMedia fullscreenMedia;
    private CommunicationMedia.Video fullscreenVideo;
    private int previousOrientation,previousSystemUi;
    private boolean previousKeepScreenOn;
    private TextView mediaStatus;
    private EditText chatInput;
    private String member="",signature="",chatDraft="",permissionSession="",projectionSession="";
    private boolean registered,busy,projectionAudio;
    private String pendingMicSession="";
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final ArrayList<SurfaceViewRenderer> renderers=new ArrayList<>();
    private final HashMap<SurfaceViewRenderer,CommunicationMedia> rendererMedia=new HashMap<>();
    private final BroadcastReceiver changes=new BroadcastReceiver(){@Override public void onReceive(Context context,Intent intent){render();}};
    private final Runnable mediaPoll=new Runnable(){public void run(){CommunicationMedia media=media();if(mediaStatus!=null&&media!=null)mediaStatus.setText(media.status);if(registered)handler.postDelayed(this,1000);}};
    @Override public void onCreate(Bundle state){super.onCreate(state);member=getIntent().getStringExtra("member");if(member==null)member="";if(state!=null){projectionSession=state.getString("projectionSession","");projectionAudio=state.getBoolean("projectionAudio");permissionSession=state.getString("permissionSession","");pendingMicSession=state.getString("pendingMicSession","");chatDraft=state.getString("chatDraft","");}root=new FrameLayout(this);scroll=new ScrollView(this);scroll.setFillViewport(true);scroll.setBackgroundColor(Color.rgb(244,249,247));body=new LinearLayout(this);body.setOrientation(LinearLayout.VERTICAL);body.setPadding(dp(20),dp(18),dp(20),dp(32));scroll.addView(body);root.addView(scroll);setContentView(root);if(Build.VERSION.SDK_INT>=35)scroll.setOnApplyWindowInsetsListener((view,insets)->{android.graphics.Insets bars=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.ime());view.setPadding(bars.left,bars.top,bars.right,bars.bottom);return insets;});render();}
    @Override protected void onSaveInstanceState(Bundle state){state.putString("projectionSession",projectionSession);state.putBoolean("projectionAudio",projectionAudio);state.putString("permissionSession",permissionSession);state.putString("pendingMicSession",pendingMicSession);state.putString("chatDraft",chatDraft);super.onSaveInstanceState(state);}
    @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);setIntent(intent);member=intent.getStringExtra("member");if(member==null)member="";signature="";render();}
    @Override protected void onResume(){super.onResume();if(!registered){androidx.core.content.ContextCompat.registerReceiver(this,changes,new IntentFilter(RoomService.UPDATE),androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED);registered=true;}signature="";render();handler.removeCallbacks(mediaPoll);handler.post(mediaPoll);}
    @Override protected void onPause(){if(registered){unregisterReceiver(changes);registered=false;}handler.removeCallbacks(mediaPoll);super.onPause();}
    @Override protected void onDestroy(){exitFullscreen();releaseRenderers();handler.removeCallbacksAndMessages(null);super.onDestroy();}
    @Override public void onConfigurationChanged(Configuration configuration){super.onConfigurationChanged(configuration);signature="";render();}
    @Override public void onBackPressed(){if(fullscreen!=null)exitFullscreen();else super.onBackPressed();}
    private CommunicationClient client(){RoomService service=RoomService.instance;if(service==null)return null;RoomService.RoomLink link=service.links.get(member);if(link==null&&member.isEmpty())link=service.selected();if(link==null||link.closed||link.config.leaving)return null;member=link.config.deviceId;return link.communication;}
    private CommunicationMedia media(){RoomService service=RoomService.instance;CommunicationMedia media=service==null?null:service.communicationMedia;return media!=null&&media.client.link.config.deviceId.equals(member)&&!media.closed?media:null;}
    private void releaseRenderers(){for(SurfaceViewRenderer renderer:renderers){CommunicationMedia media=rendererMedia.get(renderer);if(media!=null)media.detachSink(renderer);renderer.release();}renderers.clear();rendererMedia.clear();}
    private void render(){
        if(isFinishing()||isDestroyed())return;CommunicationClient client=client();JSONObject state=client==null?new JSONObject():client.state;CommunicationMedia media=media();validateFullscreen(state,media);String next=(client==null?"none":client.online+":"+state.toString())+":"+busy+":"+(media==null?"":media.microphone+":"+media.camera+":"+media.screen+":"+media.screenAudio+":"+media.speaker+":"+videoSignature(media));
        if(next.equals(signature))return;signature=next;int position=scroll.getScrollY();boolean chatFocused=chatInput!=null&&chatInput.hasFocus();releaseRenderers();body.removeAllViews();chatInput=null;mediaStatus=null;
        body.addView(text("通话与视频会议",25,ink,true));gap(body,6);body.addView(text(client==null?"请先连接房间":client.link.config.roomName+" · "+client.status,13,muted,false));body.addView(button("返回房间",false,v->finish()));gap(body,12);
        if(client==null||!client.online){body.addView(text("房间通信连接后，可拨打私人音频电话或创建视频会议。",15,muted,false));return;}
        JSONArray sessions=state.optJSONArray("sessions"),invitations=state.optJSONArray("invitations");String self=state.optString("selfId",member),activeId=state.optString("activeSessionId");JSONObject active=find(sessions,activeId);
        if(sessions!=null)for(int i=0;i<sessions.length();i++){JSONObject session=sessions.optJSONObject(i);if(session==null||!session.optString("kind").equals("call")||!session.optString("status").equals("ringing"))continue;
            if(self.equals(session.optString("calleeId"))){LinearLayout panel=panel();panel.addView(text("私人音频来电",20,ink,true));panel.addView(text(RoomService.communicationDeviceLabel(state,session.optString("callerId"))+" 请求与你通话",15,muted,false));panel.addView(button("接听",true,v->manualCall(client,"/calls/"+session.optString("id")+"/decision",object("accept",true))));panel.addView(button("拒绝",false,v->action(client,"/calls/"+session.optString("id")+"/decision",object("accept",false))));}
            else if(self.equals(session.optString("callerId"))){LinearLayout panel=panel();panel.addView(text("等待对方接听",20,ink,true));panel.addView(text("正在呼叫 "+RoomService.communicationDeviceLabel(state,session.optString("calleeId")),15,muted,false));panel.addView(button("取消通话",false,v->action(client,"/sessions/"+session.optString("id")+"/end",new JSONObject())));}
        }
        if(invitations!=null)for(int i=0;i<invitations.length();i++){JSONObject invite=invitations.optJSONObject(i);if(invite==null)continue;LinearLayout panel=panel();panel.addView(text("会议邀请 · "+invite.optString("title"),18,ink,true));panel.addView(text(invite.optString("hostName","设备")+" 邀请你参加"+(invite.optString("visibility").equals("private")?"私密":"公开")+"会议",13,muted,false));panel.addView(button("同意加入",true,v->action(client,"/invitations/"+invite.optString("id")+"/decision",object("accept",true))));panel.addView(button("拒绝邀请",false,v->action(client,"/invitations/"+invite.optString("id")+"/decision",object("accept",false))));}
        if(active!=null&&active.optString("status").equals("active"))activeView(client,active,media,self);
        if(!pendingMicSession.isEmpty()){JSONObject pending=find(sessions,pendingMicSession);if(pending==null||pending.optString("status").equals("ended"))pendingMicSession="";else if(registered&&media!=null&&media.sessionId.equals(pendingMicSession)){String request=pendingMicSession;pendingMicSession="";handler.post(()->microphone(request));}}
        LinearLayout create=panel();create.addView(text("创建会议",18,ink,true));create.addView(text("公开会议可自由加入；私密会议只向受邀设备显示。媒体默认关闭，加入后可自行开启。",13,muted,false));Button publicMeeting=button("创建公开会议",true,v->createMeeting(client,"public"));Button privateMeeting=button("创建私密会议",false,v->createMeeting(client,"private"));publicMeeting.setEnabled(!busy&&activeId.isEmpty());privateMeeting.setEnabled(!busy&&activeId.isEmpty());create.addView(publicMeeting);create.addView(privateMeeting);
        LinearLayout publicList=panel();publicList.addView(text("房间公开会议",18,ink,true));boolean visible=false;
        if(sessions!=null)for(int i=0;i<sessions.length();i++){JSONObject session=sessions.optJSONObject(i);if(session==null||!session.optString("kind").equals("meeting")||!session.optString("visibility").equals("public")||!session.optString("status").equals("active")||session.optString("id").equals(activeId))continue;visible=true;Button join=button("加入 · "+session.optString("title","视频会议"),false,v->action(client,"/meetings/"+session.optString("id")+"/join",new JSONObject()));join.setEnabled(!busy&&activeId.isEmpty());publicList.addView(join);}if(!visible)publicList.addView(text("目前没有可加入的公开会议",13,muted,false));
        LinearLayout directory=panel();directory.addView(text("房间设备 · 私人音频电话",18,ink,true));JSONArray devices=state.optJSONArray("devices");if(devices!=null)for(int i=0;i<devices.length();i++){JSONObject device=devices.optJSONObject(i);if(device==null||device.optString("id").equals(self))continue;boolean available=device.optBoolean("communicationOnline")&&!device.optBoolean("busy");String name=device.optString("name","设备");directory.addView(text(name+" · "+(available?"可通话":device.optBoolean("communicationOnline")?"通话中":"通信离线"),14,ink,true));Button callButton=button("给 "+name+" 打电话",false,v->manualCall(client,"/calls",object("targetId",device.optString("id"))));callButton.setEnabled(!busy&&activeId.isEmpty()&&available);directory.addView(callButton);}
        scroll.post(()->scroll.scrollTo(0,position));if(chatFocused&&chatInput!=null){chatInput.requestFocus();chatInput.setSelection(chatInput.length());}
    }
    private String videoSignature(CommunicationMedia media){StringBuilder out=new StringBuilder();for(CommunicationMedia.Video video:media.videos())out.append(video.deviceId).append(video.kind).append(System.identityHashCode(video.track));return out.toString();}
    private void enterFullscreen(CommunicationMedia media,CommunicationMedia.Video video){
        if(media==null||media.closed||media.eglContext()==null)return;exitFullscreen();
        android.view.inputmethod.InputMethodManager keyboard=(android.view.inputmethod.InputMethodManager)getSystemService(INPUT_METHOD_SERVICE);keyboard.hideSoftInputFromWindow(root.getWindowToken(),0);
        previousOrientation=getRequestedOrientation();previousSystemUi=getWindow().getDecorView().getSystemUiVisibility();previousKeepScreenOn=(getWindow().getAttributes().flags&WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)!=0;
        fullscreenMedia=media;fullscreenVideo=video;fullscreen=new FrameLayout(this);fullscreen.setBackgroundColor(Color.BLACK);
        fullscreenRenderer=new SurfaceViewRenderer(this);fullscreenVideoFrame=new AspectFitVideoFrame(this,fullscreenRenderer);fullscreenRenderer.init(media.eglContext(),fullscreenVideoFrame);fullscreenRenderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT);fullscreenRenderer.setEnableHardwareScaler(true);fullscreenRenderer.setMirror(video.deviceId.equals(media.selfId)&&video.kind.equals("camera"));fullscreen.addView(fullscreenVideoFrame,new FrameLayout.LayoutParams(-1,-1));media.attachSink(video,fullscreenRenderer);
        LinearLayout controls=new LinearLayout(this);controls.setOrientation(LinearLayout.VERTICAL);controls.setPadding(dp(12),dp(8),dp(12),dp(12));controls.setBackgroundColor(0xbb162d2b);controls.addView(text(video.label,13,Color.WHITE,true));
        LinearLayout buttons=new LinearLayout(this);Button rotate=button("横屏观看",false,v->{boolean landscape=getResources().getConfiguration().orientation==Configuration.ORIENTATION_LANDSCAPE;setRequestedOrientation(landscape?ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR:ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);});Button leave=button("退出全屏",false,v->exitFullscreen());buttons.addView(rotate,new LinearLayout.LayoutParams(0,dp(46),1));LinearLayout.LayoutParams end=new LinearLayout.LayoutParams(0,dp(46),1);end.leftMargin=dp(8);buttons.addView(leave,end);controls.addView(buttons);FrameLayout.LayoutParams bottom=new FrameLayout.LayoutParams(-1,-2,Gravity.BOTTOM);fullscreen.addView(controls,bottom);
        controls.addOnLayoutChangeListener((view,left,top,right,bottomEdge,oldLeft,oldTop,oldRight,oldBottom)->{if(fullscreenVideoFrame!=null){FrameLayout.LayoutParams videoLayout=(FrameLayout.LayoutParams)fullscreenVideoFrame.getLayoutParams();int reserved=bottomEdge-top;if(videoLayout.bottomMargin!=reserved){videoLayout.bottomMargin=reserved;fullscreenVideoFrame.setLayoutParams(videoLayout);}}});
        root.addView(fullscreen,new FrameLayout.LayoutParams(-1,-1));scroll.setVisibility(View.GONE);getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY|View.SYSTEM_UI_FLAG_FULLSCREEN|View.SYSTEM_UI_FLAG_HIDE_NAVIGATION|View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN|View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION|View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR);
        android.util.Log.i("NexusRoom.RTC","fullscreen=true kind="+video.kind+" device="+video.deviceId);
    }
    private void exitFullscreen(){
        if(fullscreen==null)return;FrameLayout previous=fullscreen;fullscreen=null;
        if(fullscreenRenderer!=null){if(fullscreenMedia!=null)fullscreenMedia.detachSink(fullscreenRenderer);fullscreenRenderer.release();fullscreenRenderer=null;}fullscreenVideoFrame=null;fullscreenMedia=null;fullscreenVideo=null;root.removeView(previous);scroll.setVisibility(View.VISIBLE);getWindow().getDecorView().setSystemUiVisibility(previousSystemUi);if(!previousKeepScreenOn)getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);setRequestedOrientation(previousOrientation);
        android.util.Log.i("NexusRoom.RTC","fullscreen=false");
    }
    private void validateFullscreen(JSONObject state,CommunicationMedia media){
        if(fullscreen==null)return;if(media!=fullscreenMedia||fullscreenVideo==null){exitFullscreen();return;}
        JSONObject session=find(state.optJSONArray("sessions"),state.optString("activeSessionId"));JSONObject person=session==null?null:participant(session.optJSONArray("participants"),fullscreenVideo.deviceId);boolean same=false;for(CommunicationMedia.Video video:media.videos())if(video.track==fullscreenVideo.track)same=true;
        if(person==null||!person.optBoolean(fullscreenVideo.kind.equals("screen")?"screen":"camera")||!same)exitFullscreen();
    }
    private void activeView(CommunicationClient client,JSONObject session,CommunicationMedia media,String self){
        String id=session.optString("id");boolean call=session.optString("kind").equals("call"),host=self.equals(session.optString("hostId"));LinearLayout panel=panel();panel.addView(text(session.optString("title",call?"私人音频电话":"视频会议"),21,ink,true));panel.addView(text(call?"私人音频电话":(session.optString("visibility").equals("private")?"私密会议 · 邀请制":"公开会议"),13,muted,false));mediaStatus=text(media==null?"媒体准备中":media.status,12,accent,false);panel.addView(mediaStatus);gap(panel,6);
        Button mic=button(media!=null&&media.microphone?"关闭麦克风":"开启麦克风",media!=null&&media.microphone,v->microphone(id));mic.setEnabled(!busy&&media!=null);panel.addView(mic);
        if(!call){Button camera=button(media!=null&&media.camera?"关闭摄像头":"开启摄像头",media!=null&&media.camera,v->camera(id));camera.setEnabled(!busy&&media!=null);panel.addView(camera);Button screen=button(media!=null&&media.screen?"停止会议屏幕共享":"共享屏幕",media!=null&&media.screen,v->screen(id));screen.setEnabled(!busy&&media!=null);panel.addView(screen);if(media!=null&&media.screen){Switch sound=new Switch(this);sound.setText("共享设备声音（媒体 / 游戏）");sound.setContentDescription("共享设备声音");sound.setChecked(media.screenAudio);sound.setOnCheckedChangeListener((view,checked)->screenAudio(id,checked));panel.addView(sound);}panel.addView(text("共享屏幕可全屏及横屏查看；设备声音单独选择，部分应用会禁止捕获。每次共享需系统确认，与远控投屏互斥。",12,muted,false));}
        Button speaker=button(media!=null&&media.speaker?"切换听筒 / 系统音频设备":"使用扬声器",false,v->{CommunicationMedia current=media();if(current!=null)current.setSpeaker(!current.speaker);});speaker.setEnabled(media!=null);panel.addView(speaker);
        JSONArray people=session.optJSONArray("participants");panel.addView(text("参与者",17,ink,true));if(people!=null)for(int i=0;i<people.length();i++){JSONObject person=people.optJSONObject(i);if(person==null)continue;String deviceId=person.optString("deviceId");panel.addView(text(person.optString("name","设备")+(deviceId.equals(self)?"（我）":"")+(deviceId.equals(session.optString("hostId"))?" · 主持人":"")+" · "+(person.optBoolean("microphone")?"麦克风开":"麦克风关"),13,ink,false));if(host&&!deviceId.equals(self)&&!call)panel.addView(button("移出 "+person.optString("name"),false,v->new AlertDialog.Builder(this).setTitle("移出此参与者？").setNegativeButton("取消",null).setPositiveButton("移出",(d,w)->action(client,"/meetings/"+id+"/remove",object("deviceId",deviceId))).show()));}
        if(media!=null&&!call&&media.eglContext()!=null)for(CommunicationMedia.Video video:media.videos()){
            JSONObject person=participant(people,video.deviceId);if(person==null||!person.optBoolean(video.kind.equals("screen")?"screen":"camera"))continue;
            panel.addView(text(video.label,13,ink,true));SurfaceViewRenderer renderer=new SurfaceViewRenderer(this);AspectFitVideoFrame videoFrame=new AspectFitVideoFrame(this,renderer);renderer.init(media.eglContext(),videoFrame);renderer.setEnableHardwareScaler(true);renderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT);renderer.setMirror(video.deviceId.equals(self)&&video.kind.equals("camera"));panel.addView(videoFrame,new LinearLayout.LayoutParams(-1,dp(220)));media.attachSink(video,renderer);renderers.add(renderer);rendererMedia.put(renderer,media);panel.addView(button("全屏查看 · "+video.label,false,v->enterFullscreen(media,video)));gap(panel,8);
        }
        if(!call){if(host)panel.addView(button("邀请房间设备",true,v->invite(client,session)));panel.addView(text("会议聊天",18,ink,true));JSONArray messages=session.optJSONArray("messages");if(messages!=null)for(int i=Math.max(0,messages.length()-60);i<messages.length();i++){JSONObject message=messages.optJSONObject(i);if(message!=null)panel.addView(text(message.optString("senderName","设备")+"："+message.optString("text"),13,ink,false));}
            chatInput=new EditText(this);chatInput.setTextSize(14);chatInput.setHint("输入会议消息");chatInput.setContentDescription("会议消息");chatInput.setText(chatDraft);chatInput.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(2000)});chatInput.addTextChangedListener(new TextWatcher(){public void beforeTextChanged(CharSequence s,int start,int count,int after){}public void onTextChanged(CharSequence s,int start,int before,int count){chatDraft=s.toString();}public void afterTextChanged(Editable e){}});panel.addView(chatInput);
            panel.addView(button("发送会议消息",true,v->{String text=chatDraft.trim();if(text.isEmpty()){toast("请先输入消息");return;}action(client,"/sessions/"+id+"/chat",object("text",text),()->{chatDraft="";signature="";render();});}));
        }
        panel.addView(button(call?"挂断电话":"退出会议",false,v->{if(!call&&host)new AlertDialog.Builder(this).setTitle("退出并结束会议？").setMessage("主持人退出后，所有参与者将离开此会议。").setNegativeButton("取消",null).setPositiveButton("结束会议",(d,w)->action(client,"/sessions/"+id+"/end",new JSONObject())).show();else action(client,"/sessions/"+id+"/leave",new JSONObject());}));
        if(host&&!call)panel.addView(button("结束会议",false,v->new AlertDialog.Builder(this).setTitle("结束此会议？").setMessage("所有参与者将退出，媒体与聊天会话关闭。").setNegativeButton("取消",null).setPositiveButton("结束",(d,w)->action(client,"/sessions/"+id+"/end",new JSONObject())).show()));
    }
    private void createMeeting(CommunicationClient client,String visibility){EditText title=new EditText(this);title.setHint("会议名称");title.setText("NexusRoom 会议");title.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(80)});new AlertDialog.Builder(this).setTitle(visibility.equals("private")?"创建私密会议":"创建公开会议").setView(title).setNegativeButton("取消",null).setPositiveButton("选择邀请设备",(d,w)->chooseDevices(client,"选择要邀请的设备",new JSONArray(),ids->action(client,"/meetings",object("title",title.getText().toString().trim(),"visibility",visibility,"inviteeIds",ids)))).show();}
    private void invite(CommunicationClient client,JSONObject session){JSONArray excluded=new JSONArray();JSONArray people=session.optJSONArray("participants");if(people!=null)for(int i=0;i<people.length();i++){JSONObject person=people.optJSONObject(i);if(person!=null)excluded.put(person.optString("deviceId"));}chooseDevices(client,"邀请房间设备",excluded,ids->{if(ids.length()==0){toast("请选择要邀请的设备");return;}action(client,"/meetings/"+session.optString("id")+"/invite",object("deviceIds",ids));});}
    interface DeviceSelection{void selected(JSONArray ids);}
    private void chooseDevices(CommunicationClient client,String title,JSONArray excluded,DeviceSelection selection){
        ArrayList<JSONObject> choices=new ArrayList<>();JSONArray devices=client.state.optJSONArray("devices");if(devices!=null)for(int i=0;i<devices.length();i++){JSONObject device=devices.optJSONObject(i);if(device==null||device.optString("id").equals(member)||!device.optBoolean("communicationOnline")||device.optBoolean("busy"))continue;boolean skip=false;for(int j=0;j<excluded.length();j++)if(device.optString("id").equals(excluded.optString(j)))skip=true;if(!skip)choices.add(device);}
        String[] labels=new String[choices.size()];boolean[] checked=new boolean[choices.size()];for(int i=0;i<choices.size();i++)labels[i]=choices.get(i).optString("name","设备");
        new AlertDialog.Builder(this).setTitle(title).setMultiChoiceItems(labels,checked,(d,which,value)->checked[which]=value).setNegativeButton("取消",null).setPositiveButton("确定",(d,w)->{if(client()!=client){toast("房间已切换，请重试");return;}JSONArray ids=new JSONArray();for(int i=0;i<checked.length;i++)if(checked[i])ids.put(choices.get(i).optString("id"));selection.selected(ids);}).show();
    }
    private void microphone(String id){CommunicationMedia media=media();if(media==null||!id.equals(media.sessionId))return;if(media.microphone){media.setMicrophone(false);return;}permissionSession=id;if(checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},501);else media.setMicrophone(true);}
    private void camera(String id){CommunicationMedia media=media();if(media==null||!id.equals(media.sessionId))return;if(media.camera){media.setCamera(false);return;}permissionSession=id;if(checkSelfPermission(Manifest.permission.CAMERA)!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{Manifest.permission.CAMERA},502);else media.setCamera(true);}
    private void screen(String id){CommunicationMedia media=media();if(media==null||!id.equals(media.sessionId))return;if(media.screen){media.stopScreen();return;}RoomService service=RoomService.instance;if(service==null)return;if(service.capture!=null||!service.pendingProjection.isEmpty()){toast("请先在房间页面停止电脑远控手机的投屏");return;}CheckBox sound=new CheckBox(this);sound.setText("同时共享设备声音（媒体 / 游戏）");sound.setContentDescription("同时共享设备声音");sound.setPadding(dp(20),dp(12),dp(20),dp(12));new AlertDialog.Builder(this).setTitle("共享屏幕").setMessage("设备声音独立于麦克风，可在共享期间开关。系统或应用禁止捕获的声音不会发送。").setView(sound).setNegativeButton("取消",null).setPositiveButton("继续",(dialog,which)->{CommunicationMedia current=media();if(current==null||!id.equals(current.sessionId))return;projectionSession=id;projectionAudio=sound.isChecked();if(projectionAudio&&checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED){permissionSession=id;requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},504);}else requestProjection(id);}).show();}
    private void requestProjection(String id){CommunicationMedia current=media();if(current==null||!id.equals(current.sessionId)){projectionSession="";return;}startActivityForResult(((MediaProjectionManager)getSystemService(MEDIA_PROJECTION_SERVICE)).createScreenCaptureIntent(),503);}
    private void screenAudio(String id,boolean enabled){CommunicationMedia media=media();if(media==null||!id.equals(media.sessionId)||!media.screen)return;if(enabled&&checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED){permissionSession=id;requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},505);}else media.setScreenAudio(enabled);}
    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] results){super.onRequestPermissionsResult(request,permissions,results);CommunicationMedia media=media();String session=permissionSession;permissionSession="";if(media==null||!media.sessionId.equals(session))return;boolean allowed=results.length>0&&results[0]==PackageManager.PERMISSION_GRANTED;if(request==504){projectionAudio=allowed;if(!allowed)toast("未允许录音权限，仅共享画面");requestProjection(session);return;}if(!allowed){toast("权限未允许，媒体保持关闭");signature="";render();return;}if(request==501)media.setMicrophone(true);else if(request==502)media.setCamera(true);else if(request==505)media.setScreenAudio(true);}
    @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(request!=503)return;CommunicationMedia media=media();if(media==null||!media.sessionId.equals(projectionSession)){toast("会议已结束，共享未开始");projectionSession="";projectionAudio=false;return;}projectionSession="";boolean sound=projectionAudio;projectionAudio=false;if(result==RESULT_OK&&data!=null)media.startScreen(data,sound);else toast("已取消屏幕共享");}
    private void manualCall(CommunicationClient client,String path,JSONObject body){if(busy)return;busy=true;signature="";render();client.action(path,body,(result,error)->{if(isFinishing()||isDestroyed())return;busy=false;if(!error.isEmpty())toast(error);else if(result!=null){JSONObject session=result.optJSONObject("session");if(session!=null)pendingMicSession=session.optString("id");}signature="";render();});}
    private void action(CommunicationClient client,String path,JSONObject body){action(client,path,body,null);}
    private void action(CommunicationClient client,String path,JSONObject body,Runnable success){if(busy)return;busy=true;signature="";render();client.action(path,body,(result,error)->{if(isFinishing()||isDestroyed())return;busy=false;if(!error.isEmpty())toast(error);else if(success!=null)success.run();signature="";render();});}
    private static JSONObject object(Object...pairs){JSONObject out=new JSONObject();try{for(int i=0;i<pairs.length;i+=2)out.put((String)pairs[i],pairs[i+1]);}catch(Exception e){throw new IllegalArgumentException(e);}return out;}
    private static JSONObject find(JSONArray values,String id){if(values!=null&&!id.isEmpty())for(int i=0;i<values.length();i++){JSONObject value=values.optJSONObject(i);if(value!=null&&value.optString("id").equals(id))return value;}return null;}
    private static JSONObject participant(JSONArray values,String id){if(values!=null)for(int i=0;i<values.length();i++){JSONObject value=values.optJSONObject(i);if(value!=null&&value.optString("deviceId").equals(id))return value;}return null;}
    private LinearLayout panel(){LinearLayout view=new LinearLayout(this);view.setOrientation(LinearLayout.VERTICAL);view.setPadding(dp(14),dp(14),dp(14),dp(14));GradientDrawable background=new GradientDrawable();background.setColor(Color.WHITE);background.setCornerRadius(dp(14));view.setBackground(background);LinearLayout.LayoutParams layout=new LinearLayout.LayoutParams(-1,-2);layout.bottomMargin=dp(14);body.addView(view,layout);return view;}
    private Button button(String title,boolean primary,View.OnClickListener listener){Button view=new Button(this);view.setText(title);view.setContentDescription(title);view.setAllCaps(false);view.setTextSize(14);view.setTextColor(primary?Color.WHITE:ink);GradientDrawable background=new GradientDrawable();background.setColor(primary?accent:Color.rgb(233,243,239));background.setCornerRadius(dp(10));view.setBackground(background);view.setOnClickListener(listener);view.setEnabled(!busy);LinearLayout.LayoutParams layout=new LinearLayout.LayoutParams(-1,dp(46));layout.topMargin=dp(8);view.setLayoutParams(layout);return view;}
    private TextView text(String value,int size,int color,boolean bold){TextView view=new TextView(this);view.setText(value);view.setTextSize(size);view.setTextColor(color);view.setPadding(0,dp(4),0,dp(4));if(bold)view.setTypeface(null,Typeface.BOLD);return view;}
    private void gap(LinearLayout parent,int size){View view=new View(this);parent.addView(view,new LinearLayout.LayoutParams(1,dp(size)));}
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
    private void toast(String value){Toast.makeText(this,value,Toast.LENGTH_LONG).show();}
}
