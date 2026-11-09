package com.nexusroom.android;
import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.text.InputType;
import android.util.Log;
import android.view.*;
import android.widget.*;
import com.google.zxing.integration.android.*;
import org.json.*;
import java.util.*;
import java.util.concurrent.*;
import okhttp3.*;

public final class MainActivity extends Activity {
 private final int ink=Color.rgb(22,45,43),muted=Color.rgb(108,128,124),accent=Color.rgb(17,139,119);
 private LinearLayout body,found;private ScrollView scroll;private EditText serverInput,roomInput,passwordInput,fingerprintInput,nameInput;private FrameLayout root;private AgentOverlay agentOverlay;private PcRemoteView pcRemote;
 private final ExecutorService io=Executors.newCachedThreadPool();private final Handler handler=new Handler(Looper.getMainLooper());
 private TextView pcStateLabel;private String pcStatusMember="",pcStatusText="";private boolean pcStatusLoading;
 private final Runnable pcStatusPoll=new Runnable(){public void run(){if(!registered)return;refreshPcStatus();handler.postDelayed(this,3000);}};
 private AlertDialog consentDialog;
 private AlertDialog roomActionDialog;
 private RoomActionContext roomActionContext;
 private ProjectionRequest projectionRequest,projectionInFlight;
 private static final class ProjectionRequest {
  final String member,lease;final RoomService service;final RoomService.RoomLink link;
  ProjectionRequest(RoomService service,RoomService.RoomLink link){this.service=service;this.link=link;member=link.config.deviceId;lease=service.leaseId;}
  boolean valid(){return RoomService.instance==service&&service.links.get(member)==link&&link.online&&!link.closed&&!link.config.leaving&&member.equals(service.pendingProjection)&&member.equals(service.owner)&&lease.equals(service.leaseId)&&link.config.screenAllowed&&link.config.control;}
 }
 private static final class RoomActionContext {
  final String member, roomId, fingerprint;
  final RoomService service;
  final RoomService.RoomLink link;
  RoomActionContext(RoomConfig config, RoomService sourceService, RoomService.RoomLink source) {
   member=config.deviceId;roomId=config.roomId;fingerprint=config.fingerprint;service=sourceService;link=source;
  }
 }
 private boolean adding,registered,joining,scanning,projectionDialog,invitationPending;private String pendingControl="",pendingAudio="",projectMember="",projectLease="",fileMember="",signature="";
 private String invitedServer="",invitedRoom="",invitedPassword="",invitedFingerprint="";
 private final BroadcastReceiver changes=new BroadcastReceiver(){public void onReceive(Context c,Intent i){resumeControl();render();offerProjection();}};
 @Override public void onCreate(Bundle state){super.onCreate(state);getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);root=new FrameLayout(this);setContentView(root);agentOverlay=new AgentOverlay(this,root);if(Build.VERSION.SDK_INT>=35)getWindow().getDecorView().setOnApplyWindowInsetsListener((v,insets)->{android.graphics.Insets bars=insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());v.setPadding(bars.left,bars.top,bars.right,bars.bottom);return insets;});render();if(!RoomConfig.all(this).isEmpty())startForegroundService(new Intent(this,RoomService.class));if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},10);handleIntent(getIntent());}
 @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);setIntent(intent);handleIntent(intent);offerProjection();}
 private void handleIntent(Intent intent){
  if(intent!=null&&VoiceWakeUi.ACTION.equals(intent.getAction())){
   String member=intent.getStringExtra(VoiceWakeUi.MEMBER),event=intent.getStringExtra(VoiceWakeUi.EVENT);
   if(member==null||event==null)return;
   RoomService service=RoomService.instance;RoomService.RoomLink link=service==null?null:service.links.get(member);
   if(member==null||event==null||link==null||!link.online||link.closed||link.config.leaving||!link.config.agent||!VoiceController.get(this).localWake(member,event))return;
   RoomConfig.select(this,member);adding=false;closePcRemote();signature="";render();agentOverlay.openForWake(member);return;
  }
  Uri data=intent==null?null:intent.getData();
  if(data==null||!"nexusroom".equalsIgnoreCase(data.getScheme())||!"join".equalsIgnoreCase(data.getHost()))return;
  adding=true;signature="";render();
  String payload=invitationPayload(data);
  Log.d("NexusRoom.Join", "join intent received; payload="+(payload==null?"missing":"present"));
  if(payload==null||payload.trim().isEmpty()){toast("邀请链接缺少房间信息，请重新扫码");return;}
  fillInvitation(payload);
 }
 private String invitationPayload(Uri data){
  try{String value=data.getQueryParameter("payload");if(value!=null&&!value.isEmpty())return value;}catch(Exception e){Log.w("NexusRoom.Join","query parameter decode failed",e);}
  String query=data.getEncodedQuery();if(query==null)return null;
  for(String item:query.split("&")){int split=item.indexOf('=');if(split<0)continue;try{String key=java.net.URLDecoder.decode(item.substring(0,split),"UTF-8");if(!"payload".equals(key))continue;return java.net.URLDecoder.decode(item.substring(split+1),"UTF-8");}catch(Exception e){Log.w("NexusRoom.Join","encoded invitation decode failed",e);return null;}}
  return null;
 }
 @Override protected void onResume(){super.onResume();if(!registered){androidx.core.content.ContextCompat.registerReceiver(this,changes,new IntentFilter(RoomService.UPDATE),androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED);registered=true;}resumeControl();if(serverInput==null)signature="";render();offerProjection();agentOverlay.resume();handler.removeCallbacks(pcStatusPoll);handler.post(pcStatusPoll);}
 @Override protected void onPause(){handler.removeCallbacks(pcStatusPoll);closePcRemote();dismissRoomAction();if(registered){unregisterReceiver(changes);registered=false;}agentOverlay.pause();super.onPause();}
 private void refreshPcStatus(){RoomService.RoomLink link=selected();if(adding||link==null||!link.online){if(pcStateLabel!=null)pcStateLabel.setText("电脑状态 · 离线");return;}if(pcStatusLoading)return;pcStatusLoading=true;String member=link.config.deviceId;io.execute(()->{String text;try{JSONObject value=request(link,"/device/pc/status",new JSONObject(),"GET").getJSONObject("data");String state=value.optString("activity","online");JSONObject permissions=value.optJSONObject("permissions");text="电脑状态 · "+label(state)+(permissions!=null&&permissions.optBoolean("screen")?" · 已允许屏幕访问":" · 等待电脑开启屏幕授权");}catch(Exception e){text="电脑状态 · 连接中";}final String value=text;runOnUiThread(()->{pcStatusLoading=false;RoomService.RoomLink current=selected();if(current==link&&current.online&&!adding){pcStatusMember=member;pcStatusText=value;if(pcStateLabel!=null)pcStateLabel.setText(value);}});});}
 private RoomService.RoomLink selected(){return RoomService.instance==null?null:RoomService.instance.selected();}
 private void resumeControl(){RoomService s=RoomService.instance;if(s!=null&&!pendingControl.isEmpty()&&ControlService.instance!=null){RoomService.RoomLink link=s.links.get(pendingControl);pendingControl="";if(link!=null){link.config.control=true;link.save();}}}
 private void render(){
  if(roomActionContext!=null&&!validRoomAction(roomActionContext))dismissRoomAction();
  // Keep values entered in the join form when Android recreates the view on resume.
  // An invitation callback can run immediately before onResume(), which otherwise
  // rebuilt the form and silently discarded the decoded QR payload.
  if(!invitationPending&&adding&&serverInput!=null){invitedServer=serverInput.getText().toString();invitedRoom=roomInput.getText().toString();invitedPassword=passwordInput.getText().toString();invitedFingerprint=fingerprintInput.getText().toString();}
  RoomConfig saved=RoomConfig.load(this);RoomService s=RoomService.instance;RoomService.RoomLink link=selected();RoomConfig c=link==null?saved:link.config;String sig=adding?"join":c.deviceId+(s==null?"paused":s.owner+s.pendingProjection+s.lastNotice)+(link==null?"":link.online+link.status+link.activity()+link.captureState+link.captureError)+c.control+c.files+c.clipboard+c.agent+c.audio+c.screenAllowed+(s!=null&&s.capture!=null)+RoomConfig.all(this).size();if(scroll!=null&&signature.equals(sig))return;signature=sig;int oldScroll=scroll==null?0:scroll.getScrollY();if(scroll!=null)root.removeView(scroll);scroll=new ScrollView(this);scroll.setFillViewport(true);scroll.setBackgroundColor(Color.rgb(245,248,247));body=new LinearLayout(this);body.setOrientation(LinearLayout.VERTICAL);body.setPadding(dp(22),dp(24),dp(22),dp(90));scroll.addView(body);root.addView(scroll,0,new FrameLayout.LayoutParams(-1,-1));body.addView(text("N  /  NexusRoom · "+BuildConfig.VERSION_NAME,22,ink,true));gap(body,18);
  List<RoomConfig> rooms=RoomConfig.all(this);if(!rooms.isEmpty()){LinearLayout chooser=panel();body.addView(chooser);chooser.addView(text("我的房间",17,ink,true));for(RoomConfig r:rooms){RoomService.RoomLink live=s==null?null:s.links.get(r.deviceId);String state=r.leaving?"退出待同步":live==null?"离线":label(live.activity());Button b=button((r.deviceId.equals(c.deviceId)&&!adding?"● ":"")+r.roomName+" · "+state,false,v->{if(r.leaving){toast("此房间已停止访问，电脑恢复在线后会自动同步退出");return;}RoomConfig.select(this,r.deviceId);adding=false;signature="";render();});chooser.addView(b);gap(chooser,5);}gap(body,12);}
  body.addView(button(adding?"返回我的房间":rooms.isEmpty()?"＋ 加入房间":"＋ 加入另一个房间",false,v->{adding=!adding;signature="";render();}));gap(body,18);
  if(adding||c.token.isEmpty())joinView();else {serverInput=roomInput=passwordInput=fingerprintInput=nameInput=null;connected(c,link);}
  if(s!=null&&!s.lastNotice.isEmpty()){gap(body,16);body.addView(text(s.lastNotice,13,accent,false));}
  agentOverlay.bind(link,!adding&&!c.token.isEmpty());
  updateRemoteLayers();
  if(!adding){final ScrollView view=scroll;view.post(()->view.scrollTo(0,oldScroll));}
 }
 private String label(String activity){return activity.equals("working")?"工作":activity.equals("busy")?"忙碌":activity.equals("online")?"在线":"离线";}
 private void joinView(){body.addView(text("加入同一网络的工作空间",25,ink,true));gap(body,12);LinearLayout row=row();row.addView(button("扫码加入",true,v->new IntentIntegrator(this).setOrientationLocked(false).setBeepEnabled(false).setPrompt("扫描电脑房间二维码").initiateScan()),weighted());row.addView(button("发现附近房间",false,v->discover()),weighted());body.addView(row);found=new LinearLayout(this);found.setOrientation(LinearLayout.VERTICAL);body.addView(found);gap(body,16);LinearLayout form=panel();body.addView(form);serverInput=field(form,"电脑地址","https://192.168.1.10:17891",InputType.TYPE_CLASS_TEXT);roomInput=field(form,"Room ID","6 位房间号",InputType.TYPE_CLASS_NUMBER);passwordInput=field(form,"房间密码","电脑上显示的密码",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);fingerprintInput=field(form,"证书指纹 SHA-256","扫码或发现后自动填写",InputType.TYPE_CLASS_TEXT);nameInput=field(form,"设备名称",Build.MODEL,InputType.TYPE_CLASS_TEXT);nameInput.setText(Build.MODEL);if(!invitedServer.isEmpty())serverInput.setText(invitedServer);if(!invitedRoom.isEmpty())roomInput.setText(invitedRoom);if(!invitedPassword.isEmpty())passwordInput.setText(invitedPassword);if(!invitedFingerprint.isEmpty())fingerprintInput.setText(invitedFingerprint);invitationPending=false;gap(form,12);form.addView(button("加入房间",true,v->join()));gap(body,12);body.addView(text("每个房间单独授权；只有一个房间可以占用屏幕和控制。",13,muted,false));}
 private void connected(RoomConfig config,RoomService.RoomLink link){boolean online=link!=null&&link.online;RoomService s=RoomService.instance;body.addView(text(config.roomName,26,ink,true));gap(body,8);body.addView(text(config.hostName+" · "+(link==null?"离线":label(link.activity())),15,accent,true));body.addView(text(config.server,12,muted,false));if(link!=null&&link.activity().equals("busy"))body.addView(text("另一房间正在工作；你仍可向此房间传输文件。",14,muted,false));if(s==null){body.addView(button("连接已保存房间",true,v->startForegroundService(new Intent(this,RoomService.class))));}
  gap(body,14);Button communication=button("通话与视频会议",true,v->openCommunication(config.deviceId));communication.setEnabled(online);body.addView(communication);
  gap(body,16);LinearLayout computer=panel();body.addView(computer);computer.addView(text("手机控制电脑",18,ink,true));gap(computer,8);pcStateLabel=text(!online?"电脑状态 · 离线":pcStatusMember.equals(config.deviceId)?pcStatusText:"电脑状态 · 正在查询…",13,accent,true);computer.addView(pcStateLabel);gap(computer,8);computer.addView(text("在同一房间查看和操作 Windows 桌面。电脑需先开启房间授权，再确认本次会话；退出页面或切到后台会停止控制。",13,muted,false));gap(computer,10);Button remote=button("远程控制电脑",true,v->{if(link==null||!link.online){toast("请先连接电脑");return;}closePcRemote();pcRemote=new PcRemoteView(this,link,()->{PcRemoteView old=pcRemote;pcRemote=null;if(old!=null)root.removeView(old);signature="";render();refreshPcStatus();});pcRemote.setElevation(dp(24));root.addView(pcRemote,new FrameLayout.LayoutParams(-1,-1));updateRemoteLayers();});remote.setContentDescription("远程控制电脑");remote.setEnabled(online);computer.addView(remote);gap(body,14);
  LinearLayout sharing=panel();body.addView(sharing);sharing.addView(text("电脑控制手机 · 屏幕与声音",18,ink,true));gap(sharing,8);sharing.addView(text("电脑可发起和停止共享。首次开始或共享结束后，Android 会再次要求投屏确认。",13,muted,false));gap(sharing,10);boolean active=s!=null&&s.capture!=null&&s.owner.equals(config.deviceId);Button screen=button(active?"停止屏幕共享":"开始屏幕共享",true,v->{if(link==null)return;if(active){s.release(s.owner,s.leaseId);return;}config.screenAllowed=true;link.save();io.execute(()->{try{request(link,"/device/control/start",new JSONObject().put("maxSize",1280).put("fps",30).put("bitrate",6),"POST");}catch(Exception e){runOnUiThread(()->toast(e.getMessage()));}});});screen.setEnabled(online&&!link.activity().equals("busy"));sharing.addView(screen);if(link!=null&&!link.captureError.isEmpty()){gap(sharing,10);sharing.addView(text(link.captureError,13,Color.rgb(170,55,40),false));}else if(link!=null&&link.captureState.equals("starting")){gap(sharing,10);sharing.addView(text("正在准备画面，请稍候…",13,accent,false));}gap(body,14);
  permission("允许房间屏幕访问",config.screenAllowed,"电脑投屏仍需每次经过 Android 系统确认。Android 11 及以上，已授权的手机 Agent 可通过无障碍服务截取单帧；请求模式会逐项征求批准，自动模式不会。",value->{config.screenAllowed=value;if(!value&&s!=null&&s.owner.equals(config.deviceId))s.release(s.owner,s.leaseId);save(config,link);});
  permission("远程控制",config.control,"允许点击、滑动和输入；需要系统无障碍服务。",value->{if(!value){config.control=false;if(s!=null&&s.owner.equals(config.deviceId))s.release(s.owner,s.leaseId);save(config,link);return;}confirmRoomAction(config,link,"允许此房间远程控制？","该电脑可操作手机。此授权会被记住，你可以随时关闭。","允许并继续",()->{if(ControlService.instance==null){pendingControl=config.deviceId;startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));}else{config.control=true;save(config,link);}});});
  permission("文件传输",config.files,"允许保存电脑文件和发送你选择的文件。",v->{config.files=v;save(config,link);});
  permission("剪贴板同步",config.clipboard,"允许此房间同步文本。Android 10+ 限制后台应用读取剪贴板；要让电脑读取手机退到后台后新复制的内容，还需在系统键盘设置中启用并设为默认「NexusRoom 剪贴板桥」。它不提供文字键盘；切回常用键盘后，后台读取权限会停止。",v->{config.clipboard=v;save(config,link);});
  body.addView(button(NexusClipboardInputMethod.isSelected(this)?"后台剪贴板读取已启用 · 管理系统键盘":"设置后台剪贴板读取键盘",false,v->{try{startActivity(new Intent(Settings.ACTION_INPUT_METHOD_SETTINGS));}catch(Exception e){toast("请在系统设置的键盘/输入法页面启用并设为默认 NexusRoom 剪贴板桥");}}));gap(body,8);
  permission("播放音频共享",config.audio,"仅捕获允许共享的媒体/游戏音频，不采集麦克风。电脑音量单独调节。",v->{config.audio=v;if(v&&checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED){pendingAudio=config.deviceId;requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},12);}save(config,link);if(s!=null&&s.capture!=null)toast("音频设置将在下次开始共享时生效");});
  permission("Agent 操作",config.agent,"允许此房间模型使用已授权内容；任务可从手机或电脑发起。",v->{if(!v){config.agent=false;save(config,link);return;}confirmRoomAction(config,link,"允许 Agent 使用此房间？","任务、所需截图和工具结果会发送到电脑配置的模型服务。Windows 操作还需要电脑授权。请求模式逐步批准；自动模式在已授权范围内连续执行。","允许 Agent",()->{config.agent=true;save(config,link);});});
  body.addView(button("配置房间模型方案",false,v->configureProfile(link)));gap(body,6);body.addView(button("授权 Agent 文件访问",false,v->{Intent intent;if(Build.VERSION.SDK_INT>=30)intent=new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);else intent=new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);intent.setData(Uri.parse("package:"+getPackageName()));try{startActivity(intent);}catch(Exception e){startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getPackageName())));}}));gap(body,6);body.addView(button("授权 Agent 通知读取",false,v->startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))));gap(body,6);body.addView(button("授权 Agent 使用情况",false,v->startActivity(new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))));
  LinearLayout files=panel();body.addView(files);files.addView(text("文件与剪贴板",18,ink,true));gap(files,8);Button send=button("选择文件，发送到电脑",true,v->{fileMember=config.deviceId;startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE),43);});send.setEnabled(online&&config.files);files.addView(send);gap(files,8);files.addView(button("授权照片库",false,v->{if(Build.VERSION.SDK_INT>=34)requestPermissions(new String[]{Manifest.permission.READ_MEDIA_IMAGES,Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED},11);else if(Build.VERSION.SDK_INT>=33)requestPermissions(new String[]{Manifest.permission.READ_MEDIA_IMAGES},11);else requestPermissions(new String[]{Manifest.permission.READ_EXTERNAL_STORAGE},11);}));gap(files,8);Button sync=button("同步当前剪贴板到电脑",false,v->{if(link!=null){link.clipboardLast="";if(link.publishClipboard())toast("当前文本剪贴板已发送到电脑");else toast("未读取到可同步的新文本。Android 10+ 后台读取需将 NexusRoom 剪贴板桥设为默认键盘");}});sync.setEnabled(online&&config.clipboard&&!link.activity().equals("busy"));files.addView(sync);
  gap(body,20);body.addView(button("退出此房间",false,v->confirmRoomAction(config,link,"退出「"+config.roomName+"」？","立即停止此房间访问。电脑离线时会在重连后自动同步退出，其他房间不受影响。","退出房间",()->{if(link!=null)link.leave();else{config.leaving=true;save(config,null);startForegroundService(new Intent(this,RoomService.class));}signature="";render();})));gap(body,10);body.addView(text("指纹 "+config.fingerprint,10,muted,false));}
 private void openCommunication(String member){startActivity(new Intent(this,CommunicationActivity.class).putExtra("member",member));}
 private boolean validRoomAction(RoomActionContext context) {
  if(context.service==null)return validRoomActionLocked(context);
  synchronized(context.service){return validRoomActionLocked(context);}
 }
 private boolean validRoomActionLocked(RoomActionContext context) {
  if(RoomService.instance!=context.service)return false;
  if(isFinishing()||isDestroyed()||adding||context.member.isEmpty())return false;
  RoomConfig current=RoomConfig.load(this);
  if(current.leaving||!context.member.equals(current.deviceId)||!context.roomId.equals(current.roomId)||!context.fingerprint.equals(current.fingerprint))return false;
  RoomService.RoomLink live=context.service==null?null:context.service.selected();
  return live==context.link&&(live==null||!live.closed&&!live.config.leaving);
 }
 private void dismissRoomAction() {
  AlertDialog old=roomActionDialog;
  roomActionDialog=null;roomActionContext=null;
  if(old!=null)old.dismiss();
 }
 private void confirmRoomAction(RoomConfig config, RoomService.RoomLink link, String title, String message, String label, Runnable action) {
  RoomActionContext context=new RoomActionContext(config,RoomService.instance,link);
  if(!validRoomAction(context)){rerender();return;}
  dismissRoomAction();
  roomActionContext=context;
  AlertDialog dialog=new AlertDialog.Builder(this).setTitle(title).setMessage(message)
   .setNegativeButton("取消",(d,w)->rerender()).setOnCancelListener(d->rerender())
   .setPositiveButton(label,(d,w)->{
    // A queued click must still belong to this dialog, room and live connection.
    // Membership removal and this final check/action share the source service
    // lock. Any nested link operation keeps the service-before-link lock order.
    Runnable confirmed=()->{
     if(roomActionContext!=context)return;
     if(!validRoomActionLocked(context)){dismissRoomAction();rerender();return;}
     action.run();
    };
    if(context.service==null)confirmed.run();
    else synchronized(context.service){confirmed.run();}
   }).create();
  roomActionDialog=dialog;
  dialog.setOnDismissListener(d->{if(roomActionDialog==dialog){roomActionDialog=null;roomActionContext=null;}});
  dialog.show();
 }
 private void offerProjection(){
  // A MediaProjection result belongs to exactly one request. A later room or
  // lease must never inherit the previous request's system consent.
  if(projectionInFlight!=null)return;
  RoomService s=RoomService.instance;
  if(s==null||s.pendingProjection.isEmpty()){if(consentDialog!=null){consentDialog.dismiss();consentDialog=null;}projectionDialog=false;projectionRequest=null;return;}
  if(projectionRequest!=null&&!projectionRequest.valid()){if(consentDialog!=null)consentDialog.dismiss();projectionDialog=false;projectionRequest=null;}
  if(projectionDialog||!registered)return;RoomService.RoomLink link=s.links.get(s.pendingProjection);if(link==null)return;
  final ProjectionRequest requested=new ProjectionRequest(s,link);projectionRequest=requested;projectionDialog=true;
  consentDialog=new AlertDialog.Builder(this).setTitle("「"+link.config.roomName+"」请求屏幕共享").setMessage("屏幕将只传送到该房间。其他房间将显示此设备忙碌。")
   .setNegativeButton("拒绝",(d,w)->{projectionDialog=false;projectionRequest=null;s.consentCancelled(requested.member,requested.lease);})
   .setOnCancelListener(d->{projectionDialog=false;projectionRequest=null;s.consentCancelled(requested.member,requested.lease);})
   .setPositiveButton("继续系统确认",(d,w)->{synchronized(s){if(!requested.valid()){projectionDialog=false;projectionRequest=null;toast("共享请求已结束，请重新请求");return;}projectionInFlight=requested;projectionRequest=null;startActivityForResult(((MediaProjectionManager)getSystemService(MEDIA_PROJECTION_SERVICE)).createScreenCaptureIntent(),42);}}).show();
 }
 private void save(RoomConfig config,RoomService.RoomLink link){try{if(link!=null)link.save();else config.save(this);}catch(Exception e){toast("保存失败");}rerender();}
 private void configureProfile(RoomService.RoomLink link){ProfileManager.open(this,link);}
 private void rerender(){signature="";render();}
 private interface Toggle{void change(boolean v);}
 private void permission(String title,boolean value,String description,Toggle change){LinearLayout card=panel();body.addView(card);Switch toggle=new Switch(this);toggle.setText(title);toggle.setTextColor(ink);toggle.setTextSize(16);toggle.setChecked(value);card.addView(toggle);gap(card,5);card.addView(text(description,12,muted,false));toggle.setOnCheckedChangeListener((b,v)->change.change(v));gap(body,10);}
 private void join(){if(joining)return;final String server=serverInput.getText().toString().trim().replaceAll("/+$",""),fp=fingerprintInput.getText().toString().trim().replace(":","").replace(" ",""),room=roomInput.getText().toString().trim(),password=passwordInput.getText().toString(),name=nameInput.getText().toString().trim();try{RoomConfig.validate(server,fp);if(!room.matches("[0-9]{6}")||password.isEmpty()||name.isEmpty())throw new Exception("请完整填写房间信息");for(RoomConfig r:RoomConfig.all(this))if(r.fingerprint.equalsIgnoreCase(fp)&&r.roomId.equals(room)&&!r.leaving)throw new Exception("已经加入此房间，请从上方切换");}catch(Exception e){toast(e.getMessage());return;}new AlertDialog.Builder(this).setTitle("核对电脑身份").setMessage("请与电脑邀请页面核对指纹：\n"+fp).setNegativeButton("取消",null).setPositiveButton("一致，加入",(d,w)->{joining=true;io.execute(()->{try{RoomConfig c=new RoomConfig();c.server=server;c.fingerprint=fp;c.roomId=room;OkHttpClient client=c.client(RoomDiscovery.preferredNetwork(this,server));try(Response response=client.newCall(new Request.Builder().url(server+"/device/join").post(RequestBody.create(new JSONObject().put("roomId",room).put("password",password).put("name",name).put("version",Build.VERSION.RELEASE).put("physicalId",RoomConfig.physicalId(this)).toString(),MediaType.get("application/json"))).build()).execute()){String raw=response.body()==null?"":response.body().string();JSONObject value;try{value=new JSONObject(raw);}catch(Exception parse){throw new Exception(response.isSuccessful()?"电脑返回了无效响应":"加入失败（HTTP "+response.code()+")");}if(!response.isSuccessful())throw new Exception(value.optString("title","加入失败（HTTP "+response.code()+")"));c.deviceId=value.getString("deviceId");c.token=value.getString("token");c.hostName=value.getString("hostName");c.roomName=value.optString("roomName");c.save(this);RoomConfig.select(this,c.deviceId);}finally{client.connectionPool().evictAll();client.dispatcher().executorService().shutdown();}runOnUiThread(()->{adding=false;invitedServer=invitedRoom=invitedPassword=invitedFingerprint="";invitationPending=false;startForegroundService(new Intent(this,RoomService.class));rerender();});}catch(Exception e){runOnUiThread(()->toast("未能加入："+e.getMessage()));}finally{joining=false;}});}).show();}
 private void fillInvitation(String content){
  try{
   String raw=content==null?"":content.trim();
   if(raw.regionMatches(true,0,"nexusroom://",0,11)){
    Uri uri=Uri.parse(raw);
    raw=invitationPayload(uri);
    if(raw==null)throw new Exception("邀请链接缺少房间信息");
   }
   JSONObject j=new JSONObject(raw);
   String server=j.getString("server"),room=j.getString("roomId"),password=j.optString("password"),fp=j.getString("fingerprint");
   RoomConfig.validate(server,fp);
   if(!room.matches("[0-9]{6}")||password.isEmpty())throw new Exception("邀请信息不完整");
   invitedServer=server;invitedRoom=room;invitedPassword=password;invitedFingerprint=fp;
   invitationPending=true;adding=true;signature="";render();
   Log.d("NexusRoom.Join","invitation fields decoded");
  }catch(JSONException e){
   Log.w("NexusRoom.Join","invalid invitation JSON");
   toast("无效的 NexusRoom 邀请二维码：内容无法解析");
  }catch(Exception e){
   Log.w("NexusRoom.Join","invalid invitation "+e.getClass().getSimpleName());
   toast("无效的 NexusRoom 邀请二维码："+e.getMessage());
  }
 }
 private void discover(){if(scanning)return;scanning=true;found.removeAllViews();TextView status=text("正在搜索同一局域网…",13,muted,false);found.addView(status);Set<String> seen=ConcurrentHashMap.newKeySet();RoomDiscovery.scan(this,room->{String key=room.optString("fingerprint")+room.optString("roomId");if(!seen.add(key))return;runOnUiThread(()->{if(found==null)return;found.addView(button(room.optString("name")+" · "+room.optString("host"),false,v->{serverInput.setText(room.optString("server"));roomInput.setText(room.optString("roomId"));fingerprintInput.setText(room.optString("fingerprint"));toast("请核对电脑指纹并输入房间密码");}));});},()->runOnUiThread(()->{scanning=false;status.setText(seen.isEmpty()?"未发现房间。请在电脑检查局域网防火墙，或扫码/输入电脑地址加入。":"发现 "+seen.size()+" 个房间");}));}
 private JSONObject request(RoomService.RoomLink link,String path,JSONObject body,String method)throws Exception{if(link==null)throw new Exception("电脑离线");Request.Builder request=link.request(path);if(!method.equals("GET"))request.method(method,method.equals("DELETE")?null:RequestBody.create(body.toString(),MediaType.get("application/json")));try(Response response=link.client.newCall(request.build()).execute()){String raw=response.body().string();if(!response.isSuccessful())throw new Exception(new JSONObject(raw).optString("title","请求失败"));return new JSONObject().put("data",raw.startsWith("[")?new JSONArray(raw):new JSONObject(raw));}}
 @Override protected void onActivityResult(int request,int result,Intent data){
  IntentResult scan=IntentIntegrator.parseActivityResult(request,result,data);if(scan!=null){if(scan.getContents()!=null)fillInvitation(scan.getContents());return;}
  super.onActivityResult(request,result,data);RoomService s=RoomService.instance;
  if(request==42){
   ProjectionRequest requested=projectionInFlight;projectionInFlight=null;projectionDialog=false;
   if(requested!=null){synchronized(requested.service){
    if(result==RESULT_OK&&data!=null&&requested.valid()){
     projectionRequest=requested;projectionDialog=true;
     startForegroundService(new Intent(this,RoomService.class).setAction("project").putExtra("member",requested.member).putExtra("lease",requested.lease).putExtra("resultCode",result).putExtra("data",data));
    }else{requested.service.consentCancelled(requested.member,requested.lease);if(result==RESULT_OK)toast("原共享请求已结束，此次系统确认不会用于其他房间");}
   }}offerProjection();
  }
  if(request==43&&result==RESULT_OK&&data!=null&&data.getData()!=null&&s!=null){RoomService.RoomLink link=s.links.get(fileMember);Uri uri=data.getData();if(link!=null)s.fileWork.execute(()->{try{new FileExchange(s,link).upload(uri,false);}catch(Exception e){s.notice("发送失败："+e.getMessage());}});}
 }
 @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] results){super.onRequestPermissionsResult(request,permissions,results);if(request==31&&agentOverlay!=null)agentOverlay.voicePermissionResult(results.length>0&&results[0]==PackageManager.PERMISSION_GRANTED);if(request==12&&RoomService.instance!=null){RoomService.RoomLink link=RoomService.instance.links.get(pendingAudio);if(link!=null){link.config.audio=results.length>0&&results[0]==PackageManager.PERMISSION_GRANTED;link.save();}pendingAudio="";rerender();}}
 private TextView text(String value,int size,int color,boolean bold){TextView v=new TextView(this);v.setText(value);v.setTextSize(size);v.setTextColor(color);v.setLineSpacing(dp(3),1);if(bold)v.setTypeface(null,Typeface.BOLD);return v;}
 private Button button(String label,boolean primary,View.OnClickListener listener){Button b=new Button(this);b.setText(label);b.setTextSize(14);b.setAllCaps(false);b.setTextColor(primary?Color.WHITE:accent);b.setMinHeight(dp(46));b.setPadding(dp(12),dp(6),dp(12),dp(6));b.setBackground(background(primary?accent:Color.rgb(231,242,238),12));b.setOnClickListener(listener);return b;}
 private EditText field(LinearLayout group,String label,String hint,int type){gap(group,12);group.addView(text(label,12,muted,true));EditText input=new EditText(this);input.setTextSize(14);input.setTextColor(ink);input.setHint(hint);input.setSingleLine(true);input.setInputType(type);input.setPadding(dp(12),dp(8),dp(12),dp(8));input.setBackground(background(Color.rgb(245,248,247),8));group.addView(input,new LinearLayout.LayoutParams(-1,dp(48)));return input;}
 private LinearLayout panel(){LinearLayout p=new LinearLayout(this);p.setOrientation(LinearLayout.VERTICAL);p.setPadding(dp(16),dp(16),dp(16),dp(16));p.setBackground(background(Color.WHITE,16));return p;}
 private LinearLayout row(){LinearLayout r=new LinearLayout(this);r.setOrientation(LinearLayout.HORIZONTAL);return r;}
 private LinearLayout.LayoutParams weighted(){return new LinearLayout.LayoutParams(0,-2,1);}
 private GradientDrawable background(int color,int radius){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));return d;}
 private int dp(int n){return Math.round(n*getResources().getDisplayMetrics().density);}
 private void gap(LinearLayout p,int n){p.addView(new View(this),new LinearLayout.LayoutParams(1,dp(n)));}
 private void toast(String value){Toast.makeText(this,value,Toast.LENGTH_LONG).show();}
 private void updateRemoteLayers(){boolean active=pcRemote!=null;if(scroll!=null){scroll.setImportantForAccessibility(active?View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS:View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);scroll.setVisibility(active?View.GONE:View.VISIBLE);}if(agentOverlay!=null)agentOverlay.setOccluded(active);if(active){pcRemote.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);pcRemote.bringToFront();}}
 private void closePcRemote(){PcRemoteView remote=pcRemote;if(remote!=null)remote.closeView();}
 @Override public void onBackPressed(){if(pcRemote!=null){pcRemote.back();return;}if(agentOverlay!=null&&agentOverlay.collapse())return;super.onBackPressed();}
 @Override protected void onDestroy(){closePcRemote();dismissRoomAction();if(consentDialog!=null){consentDialog.dismiss();consentDialog=null;}ProjectionRequest requested=projectionInFlight;if(requested!=null)requested.service.consentCancelled(requested.member,requested.lease);projectionInFlight=projectionRequest=null;if(agentOverlay!=null)agentOverlay.destroy();handler.removeCallbacksAndMessages(null);io.shutdownNow();super.onDestroy();}
}
