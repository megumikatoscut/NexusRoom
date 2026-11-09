package com.nexusroom.android;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.*;
import android.os.*;
import org.json.JSONObject;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.*;
import okio.ByteString;

/** An explicitly requested, foreground-only Windows control session. */
final class PcRemoteSession implements AutoCloseable {
 interface Listener {
  void status(String text);
  void connected(JSONObject welcome);
  void frame(Bitmap bitmap,long pts);
  void audioEnabled(boolean enabled);
  void ended(String reason);
 }
 interface Result { void receive(JSONObject result); }
 private final android.content.Context context;
 final RoomService.RoomLink link;
 private final RoomService service;
 private final Listener listener;
 private final Handler main=new Handler(Looper.getMainLooper());
 private final ExecutorService work=Executors.newSingleThreadExecutor(),pictures=Executors.newSingleThreadExecutor();
 private final ConcurrentHashMap<String,Result> results=new ConcurrentHashMap<>();
 private final AtomicReference<byte[]> latestPicture=new AtomicReference<>();
 private final AtomicReference<DecodedFrame> latestDecoded=new AtomicReference<>();
 private final java.util.concurrent.atomic.AtomicBoolean presenting=new java.util.concurrent.atomic.AtomicBoolean();
 private final java.util.concurrent.atomic.AtomicBoolean decoding=new java.util.concurrent.atomic.AtomicBoolean();
 private final ArrayBlockingQueue<AudioPacket> audioQueue=new ArrayBlockingQueue<>(6);
 private volatile boolean closed,connected,audioEnabled,audioAvailable;
 private volatile WebSocket socket;
 private volatile String sessionId="";
 private volatile long lastPong=SystemClock.elapsedRealtime(),latestVideoPts;
 private long nextId;
 private volatile AudioTrack audioTrack;
 private boolean loggedFrame,loggedAudio;
 private final AudioManager audioManager;
 private volatile AudioFocusRequest audioFocus;
 private final Thread audioWorker;
 private static final class AudioPacket { final byte[] bytes;final int rate,channels;final long pts,received;
  AudioPacket(byte[] bytes,int rate,int channels,long pts){this.bytes=bytes;this.rate=rate;this.channels=channels;this.pts=pts;received=SystemClock.elapsedRealtime();}}
 private static final class DecodedFrame {final Bitmap bitmap;final long pts;DecodedFrame(Bitmap bitmap,long pts){this.bitmap=bitmap;this.pts=pts;}}
 PcRemoteSession(android.content.Context context,RoomService.RoomLink link,Listener listener) {
  this.context=context.getApplicationContext();this.link=link;service=RoomService.instance;this.listener=listener;
  audioManager=(AudioManager)context.getSystemService(android.content.Context.AUDIO_SERVICE);
  audioWorker=new Thread(this::playAudio,"NexusRoom-PC-Audio");audioWorker.start();
 }
 private boolean valid(){return !closed&&RoomService.instance==service&&service!=null&&service.links.get(link.config.deviceId)==link&&link.online&&!link.closed&&!link.config.leaving;}
 void start(){status("正在检查电脑授权…");work.execute(()->{
  try {
   require();JSONObject status=request("/device/pc/status",null);JSONObject permissions=status.optJSONObject("permissions");
   if(permissions==null||!permissions.optBoolean("screen"))throw new Exception("请先在电脑的房间设置中允许安卓访问电脑屏幕");
   require();JSONObject started=request("/device/pc/start",new JSONObject().put("maxSize",1600).put("fps",15).put("quality",75).put("audio",true));
   sessionId=started.getString("sessionId");
   if(closed){stopRemote();return;}
   status("等待电脑确认本次远程会话…");main.post(poll);
  }catch(Exception e){fail(message(e));}
 });}
 private void require()throws Exception{if(!valid())throw new Exception("房间连接已结束，请重新连接电脑");}
 private JSONObject request(String path,JSONObject body)throws Exception{
  Request.Builder request=link.request(path);
  if(body!=null)request.post(RequestBody.create(body.toString(),MediaType.get("application/json; charset=utf-8")));
  OkHttpClient bounded=link.client.newBuilder().callTimeout(10,TimeUnit.SECONDS).readTimeout(8,TimeUnit.SECONDS).writeTimeout(8,TimeUnit.SECONDS).build();
  try(Response response=bounded.newCall(request.build()).execute()){
   String raw=response.body()==null?"":response.peekBody(256*1024+1).string();JSONObject value;
   if(raw.getBytes(java.nio.charset.StandardCharsets.UTF_8).length>256*1024)throw new Exception("电脑响应过大，已停止远程会话");
   try{value=new JSONObject(raw);}catch(Exception e){throw new Exception("电脑响应异常（HTTP "+response.code()+"）");}
   if(!response.isSuccessful())throw new Exception(value.optString("title",value.optString("error","请求失败（HTTP "+response.code()+"）")));
   return value;
  }
 }
 private final Runnable poll=new Runnable(){public void run(){
  if(closed)return;
  if(!valid()){fail("房间已离线，远程会话已停止");return;}
  if(connected){if(SystemClock.elapsedRealtime()-lastPong>20000){fail("电脑响应超时，远程会话已停止");return;}send(new JSONObject(),"ping");main.postDelayed(this,5000);return;}
  try{work.execute(()->{
   try {
    require();JSONObject value=request("/device/pc/status",null),session=value.optJSONObject("session");
    if(session==null||!sessionId.equals(session.optString("sessionId")))throw new Exception("电脑已结束此会话，请退出后重新请求");
    String state=session.optString("state");
    if(state.equals("approved")||state.equals("streaming")){openSocket();return;}
    if(!state.equals("pending"))throw new Exception(session.optString("error","电脑已拒绝或停止本次远程会话"));
    main.postDelayed(this,1000);
   }catch(Exception e){fail(message(e));}
  });}catch(RejectedExecutionException ignored){}
 }};
 private final Runnable handshakeTimeout=()->{if(!closed&&!connected)fail("电脑画面连接超时，请退出后重新请求");};
 private void openSocket()throws Exception{
  require();status("电脑已确认，正在连接画面…");
  main.postDelayed(handshakeTimeout,10000);
  socket=link.client.newWebSocket(link.request("/device/pc/ws?sessionId="+java.net.URLEncoder.encode(sessionId,"UTF-8")).build(),new WebSocketListener(){
   @Override public void onOpen(WebSocket ws,Response response){if(!valid()||ws!=socket){ws.cancel();return;}lastPong=SystemClock.elapsedRealtime();}
   @Override public void onMessage(WebSocket ws,String text){if(closed||ws!=socket)return;if(text.length()>256*1024){fail("电脑消息过大，已停止远程会话");return;}try{
    JSONObject value=new JSONObject(text);String type=value.optString("type");
    if(type.equals("welcome")){if(connected)throw new Exception("电脑重复初始化远程会话");if(!sessionId.equals(value.optString("sessionId")))throw new Exception("电脑会话标识不匹配");connected=true;main.removeCallbacks(handshakeTimeout);lastPong=SystemClock.elapsedRealtime();audioAvailable=value.optBoolean("audio");main.post(()->{if(!closed)listener.connected(value);});main.postDelayed(poll,5000);}
    else if(type.equals("pong")||type.equals("heartbeat")){lastPong=SystemClock.elapsedRealtime();}
    else if(type.equals("audio_status")){audioAvailable=value.optBoolean("enabled");if(!audioAvailable){setAudioEnabled(false);String error=value.optString("error");if(!error.isEmpty())status(error);}}
    else if(type.equals("result")){Result callback=results.remove(value.optString("id"));String error=value.optString("error");if(!error.isEmpty())status(error);else if(callback!=null){JSONObject result=value.optJSONObject("result");main.post(()->{if(!closed)callback.receive(result==null?new JSONObject():result);});}}
    else if(type.equals("stopped")||type.equals("revoked")||type.equals("error"))fail(value.optString("error",value.optString("reason","电脑已停止远程会话")));
   }catch(Exception e){fail(message(e));}}
   @Override public void onMessage(WebSocket ws,ByteString data){if(!valid()||ws!=socket||data.size()<24||data.size()>4*1024*1024)return;
    byte[] bytes=data.toByteArray();ByteBuffer packet=ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN);
    if(packet.getInt()!=0x4e525033)return;int type=packet.getInt();long pts=packet.getLong();int first=packet.getInt(),second=packet.getInt();
    if(type==1&&first>0&&second>0&&(long)first*second<=16_000_000L){latestVideoPts=pts;latestPicture.set(bytes);decodeLatest();}
    else if(type==2&&audioEnabled&&audioAvailable&&bytes.length<=256*1024&&(first>=8000&&first<=192000)&&(second==1||second==2)&&(bytes.length-24)%(second*2)==0){byte[] pcm=java.util.Arrays.copyOfRange(bytes,24,bytes.length);AudioPacket audio=new AudioPacket(pcm,first,second,pts);if(!audioQueue.offer(audio)){audioQueue.poll();audioQueue.offer(audio);}}
   }
   @Override public void onFailure(WebSocket ws,Throwable error,Response response){if(!closed&&ws==socket)fail(response==null?"电脑连接断开，请退出后重新请求":"电脑拒绝连接（HTTP "+response.code()+"）");}
   @Override public void onClosing(WebSocket ws,int code,String reason){ws.close(code,reason);if(!closed&&ws==socket)fail(reason.isEmpty()?"电脑已停止远程会话":reason);}
   @Override public void onClosed(WebSocket ws,int code,String reason){if(!closed&&ws==socket)fail("电脑已停止远程会话");}
  });
 }
 private void decodeLatest(){if(!decoding.compareAndSet(false,true))return;try{pictures.execute(()->{
  try{while(!closed){byte[] packet=latestPicture.getAndSet(null);if(packet==null)break;BitmapFactory.Options options=new BitmapFactory.Options();options.inJustDecodeBounds=true;BitmapFactory.decodeByteArray(packet,24,packet.length-24,options);if(options.outWidth<=0||options.outHeight<=0||(long)options.outWidth*options.outHeight>16_000_000L)continue;options.inJustDecodeBounds=false;Bitmap bitmap=BitmapFactory.decodeByteArray(packet,24,packet.length-24,options);if(bitmap==null)continue;if(!loggedFrame){loggedFrame=true;android.util.Log.i("NexusRoom.PC","First desktop JPEG decoded: "+bitmap.getWidth()+"x"+bitmap.getHeight());}long pts=ByteBuffer.wrap(packet,8,8).order(ByteOrder.BIG_ENDIAN).getLong();synchronized(PcRemoteSession.this){if(closed){bitmap.recycle();break;}DecodedFrame previous=latestDecoded.getAndSet(new DecodedFrame(bitmap,pts));if(previous!=null)previous.bitmap.recycle();}presentLatest();}}
  catch(Exception | OutOfMemoryError e){status("电脑画面解码失败，请降低电脑分辨率");}
  finally{decoding.set(false);if(!closed&&latestPicture.get()!=null)decodeLatest();}
 });}catch(RejectedExecutionException ignored){decoding.set(false);}}
 private void presentLatest(){if(!presenting.compareAndSet(false,true))return;main.post(()->{DecodedFrame frame=latestDecoded.getAndSet(null);presenting.set(false);if(frame!=null){if(closed)frame.bitmap.recycle();else listener.frame(frame.bitmap,frame.pts);}if(latestDecoded.get()!=null)presentLatest();});}
 boolean input(String tool,JSONObject arguments){return input(tool,arguments,null);}
 synchronized boolean input(String tool,JSONObject arguments,Result result){
  if(!connected||!valid())return false;try{if(nextId>=9007199254740991L){fail("远程输入序号已用尽，请重新建立会话");return false;}long sequence=++nextId;String id="pc-"+sequence;if(result!=null&&results.size()<32){results.put(id,result);main.postDelayed(()->results.remove(id),10000);}return send(new JSONObject().put("id",id).put("seq",sequence).put("tool",tool).put("arguments",arguments),"input");}catch(Exception ignored){return false;}
 }
 private boolean send(JSONObject object,String type){try{WebSocket active=socket;if(closed||active==null)return false;if(active.queueSize()>=256*1024||!active.send(object.put("type",type).toString())){fail("电脑连接拥塞，已停止控制以释放鼠标和按键");return false;}return true;}catch(Exception e){fail("电脑输入连接失败，已停止远程控制");return false;}}
 void setAudioEnabled(boolean value){main.post(()->{
  if(closed||(value==audioEnabled&&(value||audioFocus==null)))return;if(value&&!audioAvailable){status("电脑未开启音频共享，或当前系统没有可用音频设备");return;}
  if(value){if(audioManager==null)return;AudioFocusRequest requested=new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build()).setOnAudioFocusChangeListener(change->{if(change<0)setAudioEnabled(false);},main).build();audioFocus=requested;int granted;try{granted=audioManager.requestAudioFocus(requested);}catch(Exception e){granted=AudioManager.AUDIOFOCUS_REQUEST_FAILED;}if(closed||granted!=AudioManager.AUDIOFOCUS_REQUEST_GRANTED){audioManager.abandonAudioFocusRequest(requested);if(audioFocus==requested)audioFocus=null;status("当前无法获得音频播放焦点");return;}}
  audioEnabled=value;audioQueue.clear();if(!value){releaseAudio();if(audioFocus!=null&&audioManager!=null)audioManager.abandonAudioFocusRequest(audioFocus);audioFocus=null;}listener.audioEnabled(value);
 });}
 private void playAudio(){int rate=0,channels=0;
  while(!closed)try{AudioPacket packet=audioQueue.poll(500,TimeUnit.MILLISECONDS);if(packet==null||!audioEnabled)continue;
   if(SystemClock.elapsedRealtime()-packet.received>150||(latestVideoPts>0&&packet.pts+200000<latestVideoPts))continue;
   synchronized(this){if(closed||!audioEnabled)continue;if(audioTrack==null||rate!=packet.rate||channels!=packet.channels){releaseAudio();rate=packet.rate;channels=packet.channels;int mask=channels==2?AudioFormat.CHANNEL_OUT_STEREO:AudioFormat.CHANNEL_OUT_MONO;int buffer=Math.max(rate*channels*2/10,AudioTrack.getMinBufferSize(rate,mask,AudioFormat.ENCODING_PCM_16BIT));audioTrack=new AudioTrack.Builder().setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build()).setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate).setChannelMask(mask).build()).setBufferSizeInBytes(buffer).setTransferMode(AudioTrack.MODE_STREAM).build();audioTrack.play();}}
   AudioTrack track=audioTrack;int offset=0;
   while(track!=null&&track==audioTrack&&audioEnabled&&!closed&&offset<packet.bytes.length&&SystemClock.elapsedRealtime()-packet.received<=150){
    int written=track.write(packet.bytes,offset,packet.bytes.length-offset,AudioTrack.WRITE_NON_BLOCKING);if(written<0)throw new IllegalStateException("音频输出失败");
    if(written>0){offset+=written;if(!loggedAudio){loggedAudio=true;android.util.Log.i("NexusRoom.PC","First desktop PCM playback accepted: "+(written/(packet.channels*2))+" samples, "+packet.rate+" Hz, "+packet.channels+" channels");}}
    else Thread.sleep(3);
   }
  }catch(InterruptedException e){Thread.currentThread().interrupt();break;}catch(Exception e){releaseAudio();audioEnabled=false;audioQueue.clear();main.post(()->{if(!closed){if(audioFocus!=null&&audioManager!=null)audioManager.abandonAudioFocusRequest(audioFocus);audioFocus=null;listener.audioEnabled(false);listener.status("音频播放失败，画面和控制仍可使用");}});}
 }
 private synchronized void releaseAudio(){AudioTrack track=audioTrack;audioTrack=null;if(track!=null){try{track.pause();track.flush();track.release();}catch(Exception ignored){}}}
 private void stopRemote(){String id=sessionId;if(!id.isEmpty())try{request("/device/pc/stop",new JSONObject().put("sessionId",id));}catch(Exception ignored){}}
 private void fail(String text){closeWithReason(text);}
 private void status(String text){main.post(()->{if(!closed)listener.status(text);});}
 private static String message(Exception error){String text=error.getMessage();return text==null||text.isEmpty()?"电脑连接失败，请重试":text;}
 @Override public void close(){closeWithReason("远程会话已停止");}
 private synchronized void closeWithReason(String reason){if(closed)return;closed=true;connected=false;main.removeCallbacks(poll);main.removeCallbacks(handshakeTimeout);latestPicture.set(null);DecodedFrame decoded=latestDecoded.getAndSet(null);if(decoded!=null)decoded.bitmap.recycle();results.clear();audioEnabled=false;main.post(()->listener.ended(reason));audioQueue.clear();audioWorker.interrupt();releaseAudio();if(audioFocus!=null&&audioManager!=null)audioManager.abandonAudioFocusRequest(audioFocus);audioFocus=null;WebSocket active=socket;socket=null;if(active!=null)active.cancel();pictures.shutdownNow();try{work.execute(this::stopRemote);}catch(RejectedExecutionException ignored){}work.shutdown();}
}
