package com.nexusroom.android;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.*;
import android.os.*;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import org.json.*;
import java.util.*;
import java.util.concurrent.*;
import okhttp3.*;
import okio.ByteString;

public final class RoomService extends Service {
 static volatile RoomService instance;
 public static final String UPDATE="com.nexusroom.android.UPDATE";
 final ConcurrentHashMap<String,RoomLink> links=new ConcurrentHashMap<>();
 final Handler handler=new Handler(Looper.getMainLooper());
 final ExecutorService fileWork=Executors.newFixedThreadPool(2), commands=Executors.newSingleThreadExecutor();
 final ExecutorService discoveryWork=Executors.newFixedThreadPool(2);
 private long leaseUntil;private volatile boolean stopped;
 private ConnectivityManager networks;private ConnectivityManager.NetworkCallback networkCallback;private String networkSignature="";
 private final Runnable networkChanged=()->{if(stopped)return;String current=RoomDiscovery.networkSignature(this);if(current.equals(networkSignature))return;networkSignature=current;for(RoomLink link:links.values())link.networkChanged();};
 private void watchNetworks(){networks=getSystemService(ConnectivityManager.class);if(networks==null)return;networkSignature=RoomDiscovery.networkSignature(this);networkCallback=new ConnectivityManager.NetworkCallback(){private void changed(){handler.removeCallbacks(networkChanged);handler.postDelayed(networkChanged,600);} @Override public void onAvailable(Network network){changed();} @Override public void onLost(Network network){changed();} @Override public void onLinkPropertiesChanged(Network network,LinkProperties properties){changed();}};try{networks.registerNetworkCallback(new NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET).build(),networkCallback);}catch(SecurityException ignored){networkCallback=null;}}
 volatile ScreenCapture capture;
 volatile CommunicationMedia communicationMedia;
 private volatile boolean communicationMic,communicationCamera,communicationScreen;
 boolean communicationMicrophoneActive(){return communicationMic;}
 private final Set<String> communicationNotices=new HashSet<>();
 volatile AgentEngine agentEngine;
 volatile String owner="",leaseId="",pendingProjection="",lastNotice="";
 private ClipboardManager clip;private ClipboardManager.OnPrimaryClipChangedListener listener;
 @Override public void onCreate(){super.onCreate();instance=this;agentEngine=new AgentEngine(this);getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("nexusroom","房间连接与屏幕共享",NotificationManager.IMPORTANCE_LOW));foreground(false);clip=getSystemService(ClipboardManager.class);listener=()->{RoomLink link=links.get(owner);if(link!=null)link.publishClipboard();};clip.addPrimaryClipChangedListener(listener);watchNetworks();reload();handler.post(tick);}
 @Override public int onStartCommand(Intent intent,int flags,int startId){
  if(intent!=null&&"stop".equals(intent.getAction())){stopSelf();return START_NOT_STICKY;}
  if(intent!=null&&"project".equals(intent.getAction())){
   String id=intent.getStringExtra("member"),consentLease=intent.getStringExtra("lease");RoomLink link=links.get(id);
   Intent data=Build.VERSION.SDK_INT>=33?intent.getParcelableExtra("data",Intent.class):intent.getParcelableExtra("data");
   try{if(link==null||!link.config.screenAllowed||!link.config.control||data==null||!pendingProjection.equals(id))throw new Exception("共享请求已结束");requireOwner(link,consentLease);foreground(true);
    commands.execute(()->{
     ScreenCapture started=null;
     try {
      synchronized(RoomService.this){requireOwner(link,consentLease);if(capture!=null)return;started=new ScreenCapture(this,link);capture=started;link.captureStatus("starting","encoder","");}
      started.start(intent.getIntExtra("resultCode",-1),data);
      synchronized(RoomService.this){requireOwner(link,consentLease);if(capture!=started||!link.config.screenAllowed||!link.config.control)throw new Exception("屏幕共享已取消");pendingProjection="";link.captureStatus("starting","frames","");}
      // Permission heartbeat must precede binary media; early format/config packets were being discarded.
      heartbeat();started.activate();notice("屏幕正在共享给 "+link.config.roomName);
     }catch(Exception e){
      android.util.Log.e("NexusRoom.Media","Projection startup failed",e);
      if(started!=null)started.close();
      synchronized(RoomService.this){if(owner.equals(id)&&leaseId.equals(consentLease)){Throwable cause=e instanceof ExecutionException&&e.getCause()!=null?e.getCause():e;String error="共享未开始："+cause.getClass().getSimpleName()+": "+cause.getMessage();link.captureStatus("error",started==null?"projection":started.stage(),error);release(id,consentLease);notice(error);}}
     }
    });
   }catch(Exception e){if(link!=null&&owner.equals(id)&&leaseId.equals(consentLease)){link.captureStatus("error","projection","共享未开始："+e.getMessage());release(id,consentLease);}notice("共享未开始："+e.getMessage());}
  }
  else reload();return START_STICKY;
 }
 synchronized void reload(){if(stopped)return;for(RoomConfig config:RoomConfig.all(this)){RoomLink link=links.get(config.deviceId);if(link==null){try{link=new RoomLink(config);links.put(config.deviceId,link);link.connect();}catch(Exception e){notice("房间配置异常，可退出后重新加入");}}}heartbeat();}
 RoomLink selected(){return links.get(RoomConfig.load(this).deviceId);}
 private void foreground(boolean screen){CommunicationMedia media=communicationMedia;Intent open=media==null?new Intent(this,MainActivity.class):new Intent(this,CommunicationActivity.class).putExtra("member",media.client.link.config.deviceId);open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP);PendingIntent content=PendingIntent.getActivity(this,0,open,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);PendingIntent stop=PendingIntent.getService(this,1,new Intent(this,RoomService.class).setAction("stop"),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);Notification n=new Notification.Builder(this,"nexusroom").setSmallIcon(R.drawable.ic_nexus).setContentTitle(media!=null?"NexusRoom · 通话 / 会议进行中":screen?"NexusRoom · 正在远程共享":"NexusRoom · 多房间在线").setContentText(media!=null?"点击管理麦克风、摄像头与会议；可立即断开全部":pendingProjection.isEmpty()?"点击管理房间和权限；可立即断开所有会话":"电脑请求共享屏幕，点击确认").setContentIntent(content).setOngoing(true).addAction(new Notification.Action.Builder(null,"断开全部",stop).build()).build();int types=ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;if(screen||communicationScreen)types|=ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;if(Build.VERSION.SDK_INT>=30){if(communicationMic)types|=ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;if(communicationCamera)types|=ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;}if(Build.VERSION.SDK_INT>=29)startForeground(7,n,types);else startForeground(7,n);}
 private final Runnable tick=new Runnable(){public void run(){if(stopped)return;synchronized(RoomService.this){if(!owner.isEmpty()&&SystemClock.elapsedRealtime()>leaseUntil)release(owner,leaseId);}for(RoomLink link:links.values()){link.tick();link.communication.tick();}CommunicationMedia media=communicationMedia;if(media!=null)media.tick();heartbeat();handler.postDelayed(this,5000);}};
 synchronized void acquire(RoomLink link,String lease)throws Exception{if(lease==null||lease.isEmpty()||lease.length()>64)throw new Exception("控制会话标识无效");if(!link.online||link.config.leaving)throw new Exception("设备离线或正在退出房间");if(!owner.isEmpty()&&!owner.equals(link.config.deviceId))throw new Exception("设备忙碌，正在其他房间工作");if(!owner.isEmpty()&&!leaseId.equals(lease))throw new Exception("当前房间已有控制会话");owner=link.config.deviceId;leaseId=lease;leaseUntil=SystemClock.elapsedRealtime()+45000;heartbeat();}
 synchronized void requireOwner(RoomLink link,String lease)throws Exception{if(link.config.leaving||!link.online||!owner.equals(link.config.deviceId)||!leaseId.equals(lease)||SystemClock.elapsedRealtime()>leaseUntil)throw new Exception("控制会话已失效或被其他房间占用");}
 synchronized void release(String id,String lease){if(!owner.equals(id)||!leaseId.equals(lease))return;if(agentEngine!=null)agentEngine.cancelForLease(id,lease);owner="";leaseId="";pendingProjection="";stopCapture();heartbeat();}
 void stopCapture(){ScreenCapture previous=capture;capture=null;if(previous!=null)previous.close();for(RoomLink l:links.values())if(l.captureState.equals("starting")||l.captureState.equals("streaming")||l.captureState.equals("requested"))l.captureStatus("idle","","");if(!stopped)handler.post(()->{if(!stopped)foreground(capture!=null);});heartbeat();}
 void captureStopped(ScreenCapture source,String reason,boolean error){handler.post(()->{synchronized(RoomService.this){if(capture!=source)return;RoomLink link=links.get(owner);if(link!=null)link.captureStatus(error?"error":"stopped",source.stage(),reason);release(owner,leaseId);notice(reason);}});}
 void consentCancelled(String id){if(owner.equals(id)){release(owner,leaseId);notice("已取消屏幕共享请求");}}
 synchronized void consentCancelled(String id,String lease){if(owner.equals(id)&&leaseId.equals(lease)){release(id,lease);notice("已取消屏幕共享请求");}}
 void requestProjection(RoomLink link)throws Exception{if(communicationScreen)throw new Exception("请先停止会议屏幕共享，再开启远控投屏");if(!link.config.screenAllowed)throw new Exception("请先在手机允许此房间请求屏幕共享");pendingProjection=link.config.deviceId;link.captureStatus("requested","consent","");handler.post(()->{foreground(capture!=null);changed(this);});}
 void heartbeat(){for(RoomLink link:links.values())link.heartbeat();changed(this);}
 static void changed(Context context){context.sendBroadcast(new Intent(UPDATE).setPackage(context.getPackageName()));}
 void notice(String text){lastNotice=text;changed(this);}
 @Override public IBinder onBind(Intent i){return null;}
 @Override public void onDestroy(){stopped=true;if(networks!=null&&networkCallback!=null)try{networks.unregisterNetworkCallback(networkCallback);}catch(Exception ignored){}handler.removeCallbacksAndMessages(null);stopCommunicationMedia();stopCapture();if(agentEngine!=null)agentEngine.close();for(RoomLink l:links.values())l.close();links.clear();clip.removePrimaryClipChangedListener(listener);fileWork.shutdownNow();commands.shutdownNow();discoveryWork.shutdownNow();instance=null;changed(this);super.onDestroy();}

 void communicationMediaForeground(CommunicationMedia source,boolean mic,boolean camera,boolean screen)throws Exception {
  onMain(()->{if(stopped||communicationMedia!=source||source.closed||!source.client.online)throw new Exception("通信会话已结束");if(screen&&(capture!=null||!pendingProjection.isEmpty()))throw new Exception("请先停止远控投屏，再共享会议屏幕");communicationMic=mic;communicationCamera=camera;communicationScreen=screen;foreground(capture!=null);return new JSONObject().put("ok",true);});
 }
 private void stopCommunicationMedia(){CommunicationMedia previous=communicationMedia;communicationMedia=null;communicationMic=communicationCamera=communicationScreen=false;if(previous!=null)previous.close();if(!stopped)foreground(capture!=null);}
 void communicationDisconnected(CommunicationClient source){CommunicationMedia media=communicationMedia;if(media!=null&&media.client==source)stopCommunicationMedia();clearCommunicationNotices(source.link.config.deviceId,Collections.emptySet());}
 void communicationSignal(CommunicationClient source,JSONObject message){CommunicationMedia media=communicationMedia;if(media!=null&&media.client==source&&!media.closed)media.signal(message);}
 void communicationUpdated(CommunicationClient source){
  if(stopped||links.get(source.link.config.deviceId)!=source.link)return;
  JSONObject state=source.state;String own=state.optString("selfId",source.link.config.deviceId);String active=state.optString("activeSessionId");JSONArray sessions=state.optJSONArray("sessions");JSONObject joined=null;Set<String> notices=new HashSet<>();
  if(sessions!=null)for(int i=0;i<sessions.length();i++){JSONObject session=sessions.optJSONObject(i);if(session==null)continue;String id=session.optString("id");if(session.optString("kind").equals("call")&&session.optString("status").equals("ringing")&&own.equals(session.optString("calleeId"))){String key=source.link.config.deviceId+":"+id;notices.add(key);notifyCommunication(source,key,"私人音频来电",communicationDeviceLabel(state,session.optString("callerId"))+" 请求与你通话");}if(id.equals(active)&&session.optString("status").equals("active")){JSONArray people=session.optJSONArray("participants");if(people!=null)for(int p=0;p<people.length();p++){JSONObject person=people.optJSONObject(p);if(person!=null&&own.equals(person.optString("deviceId")))joined=session;}}}
  JSONArray invitations=state.optJSONArray("invitations");if(invitations!=null)for(int i=0;i<invitations.length();i++){JSONObject invite=invitations.optJSONObject(i);if(invite==null)continue;String key=source.link.config.deviceId+":"+invite.optString("id");notices.add(key);notifyCommunication(source,key,"会议邀请",invite.optString("hostName","房间设备")+" 邀请你加入「"+invite.optString("title","视频会议")+"」");}
  clearCommunicationNotices(source.link.config.deviceId,notices);
  CommunicationMedia media=communicationMedia;
  if(joined==null){if(media!=null&&media.client==source)stopCommunicationMedia();}
  else if(media==null){communicationMedia=new CommunicationMedia(source,joined);foreground(capture!=null);}
  else if(media.client==source){if(!media.sessionId.equals(active)){stopCommunicationMedia();communicationMedia=new CommunicationMedia(source,joined);foreground(capture!=null);}else media.update(joined);}
  changed(this);
 }
 static String communicationDeviceLabel(JSONObject state,String id){JSONArray devices=state.optJSONArray("devices");if(devices!=null)for(int i=0;i<devices.length();i++){JSONObject device=devices.optJSONObject(i);if(device==null||!id.equals(device.optString("id")))continue;String name=device.optString("name","房间设备").trim(),model=device.optString("model").trim();if(name.isEmpty())name="房间设备";return model.isEmpty()||model.equals(name)?name:name+"（"+model+"）";}return "房间设备";}
 private void notifyCommunication(CommunicationClient source,String key,String title,String message){
  if(!communicationNotices.add(key))return;
  NotificationManager manager=getSystemService(NotificationManager.class);manager.createNotificationChannel(new NotificationChannel("nexusroom-communication","通话和会议邀请",NotificationManager.IMPORTANCE_HIGH));
  Intent open=new Intent(this,CommunicationActivity.class).putExtra("member",source.link.config.deviceId).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TOP);int id=10000+(key.hashCode()&0x3fffffff);PendingIntent pending=PendingIntent.getActivity(this,id,open,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
  try{manager.notify(id,new Notification.Builder(this,"nexusroom-communication").setSmallIcon(R.drawable.ic_nexus).setContentTitle(title).setContentText(message).setContentIntent(pending).setAutoCancel(true).build());}catch(SecurityException ignored){}
 }
 private void clearCommunicationNotices(String member,Set<String> live){for(String key:new HashSet<>(communicationNotices))if(key.startsWith(member+":")&&!live.contains(key)){communicationNotices.remove(key);getSystemService(NotificationManager.class).cancel(10000+(key.hashCode()&0x3fffffff));}}

 final class RoomLink {
  final RoomConfig config;volatile boolean online,connecting,leavingNow,closed;private int generation;volatile long retryAt,lastPong;
  final CommunicationClient communication;
 volatile String status="正在连接…",clipboardLast="";volatile WebSocket socket;volatile OkHttpClient client;private Network clientNetwork;private boolean discovering,discoveryAgain;private long rediscoveryAt;
  int attempts;int maxSize=1280,fps=30,bitrate=6;
  volatile String captureState="idle",captureStage="",captureError="",encoderName="";volatile int videoWidth,videoHeight;
  void captureStatus(String state,String stage,String error){captureState=state;captureStage=stage;captureError=error==null?"":error;heartbeat();changed(RoomService.this);}
  JSONObject captureInfo()throws Exception{return new JSONObject().put("state",captureState).put("stage",captureStage).put("error",captureError).put("encoder",encoderName).put("width",videoWidth).put("height",videoHeight);}
  RoomLink(RoomConfig config)throws Exception{this.config=config;clientNetwork=RoomDiscovery.preferredNetwork(RoomService.this,config.server);client=config.client(clientNetwork);communication=new CommunicationClient(RoomService.this,this);}
  void save(){synchronized(RoomService.this){synchronized(this){if(closed||stopped||links.get(config.deviceId)!=this)return;try{config.save(RoomService.this);}catch(Exception e){notice("房间配置保存失败");}}heartbeat();}}
  Request.Builder request(String path){return new Request.Builder().url(config.server+path).header("Authorization","Bearer "+config.token);}
  // Lifecycle changes always take the service lock before the link lock. The
  // source check and owner/membership cleanup share that same service boundary.
  private boolean current(int attempt,WebSocket source){return !closed&&!stopped&&attempt==generation&&source==socket&&links.get(config.deviceId)==this;}
  void connect(){synchronized(RoomService.this){
   boolean failed=false;
   synchronized(this){
    if(stopped||closed||connecting||online||links.get(config.deviceId)!=this)return;
    if(config.leaving){fileWork.execute(this::leaveRemote);return;}
    try{Network network=RoomDiscovery.preferredNetwork(RoomService.this,config.server);if(!Objects.equals(network,clientNetwork))replaceClient(config.server,network);}catch(Exception ignored){failed=true;}
    if(!failed){final int attempt=++generation;connecting=true;retryAt=SystemClock.elapsedRealtime()+15000;status="正在连接…";socket=client.newWebSocket(request("/device/ws").build(),new WebSocketListener(){
     @Override public void onOpen(WebSocket ws,Response response){synchronized(RoomService.this){synchronized(RoomLink.this){if(!current(attempt,ws)||config.leaving){ws.cancel();return;}connecting=false;online=true;attempts=0;rediscoveryAt=SystemClock.elapsedRealtime()+45000;lastPong=SystemClock.elapsedRealtime();status="电脑在线 · 安全连接";}heartbeat();communication.connect();}}
     @Override public void onMessage(WebSocket ws,String message){try{
      JSONObject j=new JSONObject(message);String type=j.optString("type");
      if(type.equals("revoked")){removed(j.optString("reason","房间成员资格已撤销"),attempt,ws,null);return;}
      synchronized(RoomService.this){
       boolean dirty=false;
       synchronized(RoomLink.this){
        if(!current(attempt,ws)||config.leaving)return;
        if(type.equals("welcome")||type.equals("heartbeat")){lastPong=SystemClock.elapsedRealtime();if(j.has("roomId")){dirty=!config.roomId.equals(j.optString("roomId"))||!config.roomName.equals(j.optString("roomName"));config.roomId=j.optString("roomId");config.roomName=j.optString("roomName");}}
       }
       if(type.equals("welcome")||type.equals("heartbeat")){if(dirty)save();if(owner.equals(config.deviceId)&&leaseId.equals(j.optString("lease")))leaseUntil=SystemClock.elapsedRealtime()+45000;return;}
       if(type.equals("command")){String tool=j.optString("tool");if(tool.equals("agent_start")||tool.equals("agent_cancel")||tool.equals("agent_approve")){commands.execute(()->executeAgent(ws,j));}else{(tool.equals("receive_file")||tool.equals("export_photo")?fileWork:commands).execute(()->execute(ws,j));}}
      }
     }catch(Exception ignored){}}
     @Override public void onFailure(WebSocket ws,Throwable error,Response response){if(response!=null&&(response.code()==401||response.code()==403||response.code()==404)){removed("已被移出或房间已解散，可重新加入",attempt,ws,null);return;}lost(attempt,ws);}
     @Override public void onClosing(WebSocket ws,int code,String reason){ws.close(code,reason);lost(attempt,ws);}
     @Override public void onClosed(WebSocket ws,int code,String reason){lost(attempt,ws);}
    });}
   }
   if(failed)lost();
  }}
  void tick(){long now=SystemClock.elapsedRealtime();int attempt;WebSocket source;boolean timedOut;
   synchronized(this){if(closed||stopped)return;if(config.leaving){if(!leavingNow&&now>retryAt)fileWork.execute(this::leaveRemote);return;}attempt=generation;source=socket;timedOut=(connecting&&now>retryAt)||(online&&now-lastPong>35000);}
   if(timedOut)lost(attempt,source);if(!online){rediscover(false);if(!connecting&&now>retryAt)connect();}else if(now>rediscoveryAt)rediscover(false);
  }
  void lost(){lost(-1,null);}
  void lost(int attempt,WebSocket source){synchronized(RoomService.this){synchronized(this){if(closed||stopped||links.get(config.deviceId)!=this||(attempt>=0&&!current(attempt,source)))return;++generation;if(online)rediscoveryAt=0;online=false;connecting=false;WebSocket old=socket;socket=null;if(old!=null)old.cancel();communication.disconnect();status="电脑离线 · 正在寻找已保存房间";retryAt=SystemClock.elapsedRealtime()+Math.min(30000,2000L*(++attempts));}if(owner.equals(config.deviceId))release(owner,leaseId);}changed(RoomService.this);rediscover(false);}
  void networkChanged(){synchronized(RoomService.this){synchronized(this){if(closed||stopped||links.get(config.deviceId)!=this)return;rediscoveryAt=0;discoveryAgain=discovering;}lost();synchronized(this){retryAt=SystemClock.elapsedRealtime();}}rediscover(true);}
  private void replaceClient(String server,Network network)throws Exception{
   RoomConfig identity=new RoomConfig();identity.server=server;identity.fingerprint=config.fingerprint;
   OkHttpClient replacement=identity.client(network),previous=client;client=replacement;clientNetwork=network;config.server=server;
   // TLS socket close may perform I/O; keep pool disposal off the main thread.
   try{discoveryWork.execute(()->{previous.dispatcher().cancelAll();previous.connectionPool().evictAll();previous.dispatcher().executorService().shutdown();});}catch(RejectedExecutionException ignored){previous.dispatcher().cancelAll();previous.dispatcher().executorService().shutdown();}
  }
  void rediscover(boolean immediate){
   synchronized(this){if(closed||stopped||discovering||(!immediate&&SystemClock.elapsedRealtime()<rediscoveryAt))return;discovering=true;rediscoveryAt=SystemClock.elapsedRealtime()+(online?45000:10000);}
   try{discoveryWork.execute(()->{
    boolean retry=false;
    try{
     RoomDiscovery.TrustedServer found=RoomDiscovery.findTrusted(RoomService.this,config);
     if(found==null)return;
     boolean changedAddress;
     synchronized(RoomService.this){synchronized(this){
      if(closed||stopped||links.get(config.deviceId)!=this)return;changedAddress=!found.server.equals(config.server)||!Objects.equals(found.network,clientNetwork);
      if(changedAddress){++generation;online=false;connecting=false;WebSocket old=socket;socket=null;if(old!=null)old.cancel();replaceClient(found.server,found.network);}
      if(!found.roomId.isEmpty())config.roomId=found.roomId;if(!found.roomName.isEmpty())config.roomName=found.roomName;if(!found.hostName.isEmpty())config.hostName=found.hostName;
     }
     if(changedAddress&&owner.equals(config.deviceId))release(owner,leaseId);
     save();if(config.leaving)fileWork.execute(this::leaveRemote);else connect();}
    }catch(Exception ignored){}finally{synchronized(this){discovering=false;retry=discoveryAgain;discoveryAgain=false;}if(retry)rediscover(true);}
   });}catch(RejectedExecutionException ignored){synchronized(this){discovering=false;}}
  }
  void close(){synchronized(RoomService.this){synchronized(this){closeLocked();}}}
  private void closeLocked(){
   if(closed)return;
   closed=true;++generation;online=false;connecting=false;communication.close();
   WebSocket old=socket;socket=null;if(old!=null)old.cancel();
   // Service teardown runs on Android's main thread. OkHttp's connection pool
   // eviction can synchronously close TLS sockets and trigger
   // NetworkOnMainThreadException, so only cancel queued calls here. The
   // process-owned client is discarded with the service and any pool cleanup
   // is already performed by the background rediscovery path.
   client.dispatcher().cancelAll();
   client.dispatcher().executorService().shutdown();
  }
  private void removed(String reason,int attempt,WebSocket source,OkHttpClient leavingClient){synchronized(RoomService.this){
   synchronized(this){
    if(closed||stopped||attempt!=generation||links.get(config.deviceId)!=this)return;
    if(leavingClient==null?source!=socket:!config.leaving||leavingClient!=client)return;
    closeLocked();
   }
   if(!links.remove(config.deviceId,this))return;
   if(owner.equals(config.deviceId))release(owner,leaseId);
   try{RoomConfig.remove(RoomService.this,config.deviceId);}catch(Exception ignored){}
   notice(reason);
  }}
  void leave(){synchronized(RoomService.this){synchronized(this){if(closed||stopped||links.get(config.deviceId)!=this)return;config.leaving=true;++generation;online=false;connecting=false;retryAt=0;WebSocket old=socket;socket=null;if(old!=null)old.cancel();}save();if(owner.equals(config.deviceId))release(owner,leaseId);}fileWork.execute(this::leaveRemote);notice("已停止此房间访问，正在同步退出");}
  void leaveRemote(){final int attempt;final OkHttpClient source;final Request leaveRequest;
   synchronized(RoomService.this){synchronized(this){if(closed||leavingNow||stopped||!config.leaving||links.get(config.deviceId)!=this)return;leavingNow=true;retryAt=SystemClock.elapsedRealtime()+10000;attempt=generation;source=client;leaveRequest=request("/device/leave").post(RequestBody.create("{}",MediaType.get("application/json"))).build();}}
   try(Response response=source.newCall(leaveRequest).execute()){if(response.isSuccessful()||response.code()==401||response.code()==404)removed("已同步退出房间",attempt,null,source);else rediscover(false);}catch(Exception ignored){rediscover(false);}finally{leavingNow=false;}
  }
  JSONObject permissions()throws Exception{return new JSONObject().put("screen",capture!=null&&capture.isReady()&&owner.equals(config.deviceId)).put("screenAllowed",config.screenAllowed).put("control",config.control&&ControlService.instance!=null).put("files",config.files).put("clipboard",config.clipboard).put("agent",config.agent).put("audio",config.audio&&checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED);}
  String activity(){return !online?"offline":owner.isEmpty()?"online":owner.equals(config.deviceId)?"working":"busy";}
  void heartbeat(){synchronized(RoomService.this){if(!online)return;try{DisplayMetrics m=new DisplayMetrics();((WindowManager)getSystemService(Context.WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(m);Intent battery=registerReceiver(null,new IntentFilter(Intent.ACTION_BATTERY_CHANGED));int level=battery==null?-1:battery.getIntExtra(BatteryManager.EXTRA_LEVEL,-1),scale=battery==null?100:battery.getIntExtra(BatteryManager.EXTRA_SCALE,100);RoomLink owning=links.get(owner);send(new JSONObject().put("type","heartbeat").put("protocol",2).put("model",Build.MODEL).put("manufacturer",Build.MANUFACTURER).put("battery",level<0?-1:level*100/Math.max(1,scale)).put("charging",battery!=null&&battery.getIntExtra(BatteryManager.EXTRA_PLUGGED,0)!=0).put("width",m.widthPixels).put("height",m.heightPixels).put("activity",activity()).put("ownerRoom",owning==null?"":owning.config.roomName).put("serverHost",new java.net.URI(config.server).getHost()).put("capture",captureInfo()).put("permissions",permissions()));}catch(Exception ignored){}}}
  void send(JSONObject object){WebSocket s=socket;if(s!=null)s.send(object.toString());}
  boolean sendFrame(byte[] data){WebSocket s=socket;return online&&owner.equals(config.deviceId)&&s!=null&&s.queueSize()<2*1024*1024&&s.send(ByteString.of(data));}
  boolean publishClipboard(){if(!config.clipboard||!online||(!owner.isEmpty()&&!owner.equals(config.deviceId)))return false;try{if(!clip.hasPrimaryClip())return false;ClipData data=clip.getPrimaryClip();if(data==null||data.getItemCount()==0)return false;CharSequence value=data.getItemAt(0).getText();if(value==null||value.length()>65536)return false;String text=value.toString();if(text.equals(clipboardLast))return false;WebSocket active=socket;if(active==null||!active.send(new JSONObject().put("type","clipboard").put("text",text).toString()))return false;clipboardLast=text;return true;}catch(Exception ignored){return false;}}
  private void executeAgent(WebSocket source,JSONObject message){String id=message.optString("id"),tool=message.optString("tool"),lease=message.optString("lease");JSONObject args=message.optJSONObject("arguments");if(args==null)args=new JSONObject();try{
   if(source!=socket||!online||config.leaving)throw new Exception("房间连接已失效");
   if(agentEngine==null)throw new Exception("Agent 引擎未启动");
   requireOwner(this,lease);
   JSONObject result;
   if(tool.equals("agent_start"))result=agentEngine.start(this,source,lease,args);
   else if(tool.equals("agent_cancel"))result=agentEngine.cancel(this,lease,args.optString("taskId"));
   else if(tool.equals("agent_approve"))result=agentEngine.approve(this,lease,args);
   else throw new Exception("不支持的 Agent 命令");
   source.send(new JSONObject().put("type","result").put("id",id).put("result",result).toString());
  }catch(Exception e){try{source.send(new JSONObject().put("type","result").put("id",id).put("error",e.getMessage()==null?"Agent 操作失败":e.getMessage()).toString());}catch(Exception ignored){}}}
  private void execute(WebSocket source,JSONObject message){String id=message.optString("id"),tool=message.optString("tool"),lease=message.optString("lease");JSONObject args=message.optJSONObject("arguments");if(args==null)args=new JSONObject();try{
   if(source!=socket||!online||config.leaving)throw new Exception("房间连接已失效");boolean agent=args.optBoolean("agent");if(agent&&!config.agent)throw new Exception("Agent 权限已关闭");boolean file=tool.equals("receive_file")||tool.equals("recent_photos")||tool.equals("export_photo");
   String fileTaskId=args.optString("taskId","");
   if(!fileTaskId.isEmpty()&&(!file||!agent||!fileTaskId.matches("[A-Za-z0-9_-]{8,80}")))throw new Exception("Agent 文件任务标识无效");
   FileExchange.TransferGuard fileGuard=null;
   if(!fileTaskId.isEmpty())fileGuard=()->{AgentEngine engine=agentEngine;if(engine==null)throw new Exception("Agent 任务已结束");engine.requireTaskRunning(this,lease,fileTaskId);};
   Object result;
   if(tool.equals("control_acquire")){acquire(this,args.getString("leaseId"));result=new JSONObject().put("ok",true);}
   else if(tool.equals("control_release")){release(config.deviceId,args.getString("leaseId"));result=new JSONObject().put("ok",true);}
   else {if(!file||agent)requireOwner(this,lease);switch(tool){
    case "stream_start":if(!config.control||ControlService.instance==null)throw new Exception("请在手机允许远程控制");maxSize=Math.max(640,Math.min(1920,args.optInt("maxSize",1280)));fps=Math.max(15,Math.min(60,args.optInt("fps",30)));bitrate=Math.max(1,Math.min(16,args.optInt("bitrate",6)));if(capture==null)requestProjection(this);else capture.settings(maxSize,fps,bitrate);result=new JSONObject().put("started",capture!=null).put("requiresConsent",capture==null);break;
    case "stream_stop":pendingProjection="";stopCapture();result=new JSONObject().put("ok",true);break;
    case "stream_keyframe":if(capture!=null)capture.keyframe();result=new JSONObject().put("ok",true);break;
    case "receive_file":result=new FileExchange(RoomService.this,this,agent?lease:null,fileTaskId,fileGuard).receive(args);break;
    case "recent_photos":result=new FileExchange(RoomService.this,this,agent?lease:null,fileTaskId,fileGuard).photos(args.optInt("count",3),agent);break;
    case "export_photo":result=new FileExchange(RoomService.this,this,agent?lease:null,fileTaskId,fileGuard).export(args.getString("photoId"),agent);break;
    case "clipboard_set":if(!config.clipboard)throw new Exception("剪贴板权限未开启");String text=args.getString("text");if(text.length()>65536)throw new Exception("文本过长");clipboardLast=text;final String value=text;result=onMain(()->{requireOwner(this,lease);if(!config.clipboard)throw new Exception("剪贴板权限已关闭");clip.setPrimaryClip(ClipData.newPlainText("NexusRoom",value));return new JSONObject().put("ok",true);});break;
    case "clipboard_get":if(!config.clipboard)throw new Exception("剪贴板权限未开启");result=onMain(()->{requireOwner(this,lease);if(!config.clipboard)throw new Exception("剪贴板权限已关闭");try{ClipData data=clip.getPrimaryClip();if(data!=null&&data.getItemCount()>0&&data.getItemAt(0).getText()!=null){String current=data.getItemAt(0).getText().toString();if(current.length()>65536)throw new Exception("剪贴板文本过长");clipboardLast=current;return new JSONObject().put("text",current).put("source","system_fresh");}}catch(SecurityException e){if(!NexusClipboardInputMethod.isSelected(RoomService.this))throw new Exception("Android 限制后台读取剪贴板。请在系统键盘设置中启用并设为默认「NexusRoom 剪贴板桥」，再重试；切回常用键盘后后台读取会停止");}if(!NexusClipboardInputMethod.isSelected(RoomService.this))throw new Exception("Android 当前不允许读取剪贴板。请在系统键盘设置中启用并设为默认「NexusRoom 剪贴板桥」，再重试");throw new Exception("当前剪贴板没有可读取的文本");});break;
    case "launch_app":if(!config.control)throw new Exception("远程控制权限已关闭");String pkg=args.getString("package");if(!pkg.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+"))throw new Exception("包名无效");Intent launch=pkg.equals("com.android.settings")?new Intent(android.provider.Settings.ACTION_SETTINGS):getPackageManager().getLaunchIntentForPackage(pkg);if(launch==null)throw new Exception("未找到 App");launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);launchExternalActivity(launch);result=new JSONObject().put("ok",true);break;
    case "list_apps":JSONArray apps=new JSONArray();for(android.content.pm.ResolveInfo app:getPackageManager().queryIntentActivities(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER),0))apps.put(new JSONObject().put("package",app.activityInfo.packageName).put("name",app.loadLabel(getPackageManager()).toString()));result=apps;break;
    default:result=ControlService.execute(tool,args,this,lease);
   }}if(source==socket)source.send(new JSONObject().put("type","result").put("id",id).put("result",result).toString());
  }catch(Exception e){try{String error=e.getCause()!=null?e.getCause().getMessage():e.getMessage();source.send(new JSONObject().put("type","result").put("id",id).put("error",error==null?"Android 操作失败":error).toString());}catch(Exception ignored){}}}
 }
 interface MainAction{JSONObject run()throws Exception;}
 JSONObject onMain(MainAction action)throws Exception{CompletableFuture<JSONObject> result=new CompletableFuture<>();handler.post(()->{try{result.complete(action.run());}catch(Exception e){result.completeExceptionally(e);}});return result.get(8,TimeUnit.SECONDS);}
 private static int nextLaunchRequestCode;
 private void launchExternalActivity(Intent target)throws Exception {
  ComponentName component=target.resolveActivity(getPackageManager());
  String packageName=component==null?"":component.getPackageName();
  onMain(()->{
   Intent proxy=new Intent(this,ActivityLaunchProxy.class).putExtra(ActivityLaunchProxy.EXTRA_TARGET,target).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TOP);
   int flags=PendingIntent.FLAG_UPDATE_CURRENT|(Build.VERSION.SDK_INT>=23?PendingIntent.FLAG_IMMUTABLE:0);
   PendingIntent pending=PendingIntent.getActivity(this,nextLaunchRequestCode++&0x7fffffff,proxy,flags);
   try { pending.send(); } finally { pending.cancel(); }
   return new JSONObject().put("sent",true);
  });
  if(!packageName.isEmpty()&&!packageName.equals(getPackageName())) {
   long deadline=SystemClock.uptimeMillis()+5000L;
   while(SystemClock.uptimeMillis()<deadline) {
    if(ControlService.instance!=null&&onMain(()->new JSONObject().put("visible",ControlService.instance.hasVisiblePackage(packageName))).optBoolean("visible"))return;
    SystemClock.sleep(100L);
   }
   throw new Exception("ActivityLaunchFailed: 目标应用未成为前台页面");
  }
 }
}
