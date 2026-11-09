package com.nexusroom.android;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.*;
import android.hardware.display.*;
import android.media.*;
import android.media.projection.*;
import android.opengl.*;
import android.os.*;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.*;
import java.io.ByteArrayOutputStream;
import java.nio.*;
import java.util.concurrent.*;

final class ScreenCapture {
 private static final String TAG="NexusRoom.Media";
 private final RoomService service;private final RoomService.RoomLink link;
 private final HandlerThread thread=new HandlerThread("NexusRoom Video");private final Handler handler;
 private final ExecutorService jpegWork=Executors.newSingleThreadExecutor();private volatile boolean jpegBusy,closed;
 private MediaProjection projection;private VirtualDisplay display;private SurfaceTexture texture;private Surface source,encoderSurface;
 private MediaCodec encoder;private AudioRecord audio;private Thread audioThread;
 private EGLDisplay egl;private EGLContext context;private EGLConfig config;private EGLSurface window;
 private int program,textureId,width,height,rotation=-1,maxSize=1280,fps=30,bitrate=6;
 private long lastFrame,lastJpeg,startedAt;private byte[] codecConfig;private boolean needKey=true,hasFrame;
 private volatile boolean ready,activated;private volatile String stage="projection";
 private static final class AgentSnapshot {
  final byte[] jpeg;final long capturedAt;
  AgentSnapshot(byte[] jpeg,long capturedAt){this.jpeg=jpeg;this.capturedAt=capturedAt;}
 }
 private volatile AgentSnapshot agentSnapshot;
 boolean isReady(){return ready&&!closed;}
 byte[] agentFrame(RoomService.RoomLink requester){
  AgentSnapshot snapshot=agentSnapshot;
  return requester==link&&isReady()&&snapshot!=null&&SystemClock.elapsedRealtime()-snapshot.capturedAt<3000?snapshot.jpeg:null;
 }
 String stage(){return stage;}
 private final float[] transform=new float[16];
 private final FloatBuffer vertices=ByteBuffer.allocateDirect(16*4).order(ByteOrder.nativeOrder()).asFloatBuffer();
 ScreenCapture(RoomService service,RoomService.RoomLink link){
  this.service=service;this.link=link;maxSize=link.maxSize;fps=link.fps;bitrate=link.bitrate;thread.start();handler=new Handler(thread.getLooper());
 }
 void start(int result,Intent data)throws Exception{
  try {
  Log.i(TAG,"projection init result="+result);projection=((MediaProjectionManager)service.getSystemService(Context.MEDIA_PROJECTION_SERVICE)).getMediaProjection(result,data);if(projection==null)throw new Exception("投屏授权已失效");
  projection.registerCallback(new MediaProjection.Callback(){@Override public void onStop(){if(!closed)service.captureStopped(ScreenCapture.this,"系统已停止屏幕共享，请重新确认共享",false);}},handler);
  CompletableFuture<Void> initialized=new CompletableFuture<>();handler.post(()->{try{stage="egl";initGl();configure();initialized.complete(null);}catch(Exception e){Log.e(TAG,"capture init failed at "+stage,e);initialized.completeExceptionally(e);}});
  initialized.get(25,TimeUnit.SECONDS);if(closed)throw new Exception("共享请求已取消");ready=true;
  }catch(Exception e){close();throw e;}
 }
 void activate(){handler.post(()->{if(closed)return;activated=true;startedAt=SystemClock.elapsedRealtime();sendFormat();startAudio();handler.post(poll);});}
 private void initGl(){egl=EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);int[] v=new int[2];if(egl==EGL14.EGL_NO_DISPLAY||!EGL14.eglInitialize(egl,v,0,v,1))throw new IllegalStateException("EGL 初始化失败");int[] attributes={EGL14.EGL_RED_SIZE,8,EGL14.EGL_GREEN_SIZE,8,EGL14.EGL_BLUE_SIZE,8,EGL14.EGL_ALPHA_SIZE,8,EGL14.EGL_RENDERABLE_TYPE,EGL14.EGL_OPENGL_ES2_BIT,0x3142,1,EGL14.EGL_NONE};EGLConfig[] configs=new EGLConfig[1];int[] count=new int[1];if(!EGL14.eglChooseConfig(egl,attributes,0,configs,0,1,count,0)||count[0]==0)throw new IllegalStateException("GPU 编码表面不可用");config=configs[0];context=EGL14.eglCreateContext(egl,config,EGL14.EGL_NO_CONTEXT,new int[]{EGL14.EGL_CONTEXT_CLIENT_VERSION,2,EGL14.EGL_NONE},0);if(context==EGL14.EGL_NO_CONTEXT)throw new IllegalStateException("EGL 上下文创建失败");vertices.put(new float[]{-1,-1,0,0,1,-1,1,0,-1,1,0,1,1,1,1,1}).position(0);Log.i(TAG,"EGL ready "+v[0]+"x"+v[1]);}
 private int shader(int type,String text){int shader=GLES20.glCreateShader(type);GLES20.glShaderSource(shader,text);GLES20.glCompileShader(shader);int[] status=new int[1];GLES20.glGetShaderiv(shader,GLES20.GL_COMPILE_STATUS,status,0);if(status[0]==0)throw new IllegalStateException("GPU 着色器编译失败: "+GLES20.glGetShaderInfoLog(shader));return shader;}
 private void setupTexture(){int[] ids=new int[1];GLES20.glGenTextures(1,ids,0);textureId=ids[0];GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,textureId);GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,GLES20.GL_TEXTURE_MIN_FILTER,GLES20.GL_LINEAR);GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,GLES20.GL_TEXTURE_MAG_FILTER,GLES20.GL_LINEAR);GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,GLES20.GL_TEXTURE_WRAP_S,GLES20.GL_CLAMP_TO_EDGE);GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,GLES20.GL_TEXTURE_WRAP_T,GLES20.GL_CLAMP_TO_EDGE);texture=new SurfaceTexture(textureId);texture.setOnFrameAvailableListener(t->{hasFrame=true;draw();},handler);source=new Surface(texture);program=GLES20.glCreateProgram();GLES20.glAttachShader(program,shader(GLES20.GL_VERTEX_SHADER,"attribute vec2 p;attribute vec2 uv;uniform mat4 transform;varying vec2 tex;void main(){gl_Position=vec4(p,0.,1.);tex=(transform*vec4(uv,0.,1.)).xy;}"));GLES20.glAttachShader(program,shader(GLES20.GL_FRAGMENT_SHADER,"#extension GL_OES_EGL_image_external : require\nprecision mediump float;uniform samplerExternalOES image;varying vec2 tex;void main(){gl_FragColor=texture2D(image,tex);}"));GLES20.glLinkProgram(program);int[] linked=new int[1];GLES20.glGetProgramiv(program,GLES20.GL_LINK_STATUS,linked,0);if(linked[0]==0)throw new IllegalStateException("GPU 着色程序连接失败");}
 private void configure()throws Exception{
  DisplayMetrics m=new DisplayMetrics();Display screen=((WindowManager)service.getSystemService(Context.WINDOW_SERVICE)).getDefaultDisplay();screen.getRealMetrics(m);rotation=screen.getRotation();
  if(display!=null)display.setSurface(null);if(encoder!=null){encoder.stop();encoder.release();encoder=null;}if(window!=null){EGL14.eglMakeCurrent(egl,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_CONTEXT);EGL14.eglDestroySurface(egl,window);}if(encoderSurface!=null)encoderSurface.release();
  stage="encoder";AvcEncoder.Opened opened=AvcEncoder.open(m.widthPixels,m.heightPixels,maxSize,fps,bitrate,()->closed);
  encoder=opened.codec;encoderSurface=opened.surface;width=opened.width;height=opened.height;
  if(closed)throw new Exception("共享请求已取消");
  stage="egl-surface";window=EGL14.eglCreateWindowSurface(egl,config,encoderSurface,new int[]{EGL14.EGL_NONE},0);if(window==EGL14.EGL_NO_SURFACE||!EGL14.eglMakeCurrent(egl,window,window,context))throw new Exception("无法连接 GPU 编码表面");if(texture==null)setupTexture();texture.setDefaultBufferSize(width,height);
  stage="display";if(display==null)display=projection.createVirtualDisplay("NexusRoom",width,height,m.densityDpi,DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,source,null,handler);else{display.resize(width,height,m.densityDpi);display.setSurface(source);}if(display==null)throw new Exception("VirtualDisplay 创建失败");codecConfig=null;needKey=true;lastFrame=0;hasFrame=false;startedAt=SystemClock.elapsedRealtime();sendFormat();link.encoderName=encoder.getName();link.videoWidth=width;link.videoHeight=height;stage="frames";Log.i(TAG,"virtual display ready");
 }
 private void sendFormat(){ByteBuffer header=ByteBuffer.allocate(12).order(ByteOrder.BIG_ENDIAN);header.putInt(0x80000000).putInt(width).putInt(height);link.sendFrame(header.array());}
 private void draw(){if(closed||!activated||!hasFrame)return;try{texture.updateTexImage();long now=SystemClock.elapsedRealtime();if(now-lastFrame<1000/Math.max(1,fps))return;lastFrame=now;texture.getTransformMatrix(transform);GLES20.glViewport(0,0,width,height);GLES20.glUseProgram(program);int p=GLES20.glGetAttribLocation(program,"p"),uv=GLES20.glGetAttribLocation(program,"uv");vertices.position(0);GLES20.glVertexAttribPointer(p,2,GLES20.GL_FLOAT,false,16,vertices);GLES20.glEnableVertexAttribArray(p);vertices.position(2);GLES20.glVertexAttribPointer(uv,2,GLES20.GL_FLOAT,false,16,vertices);GLES20.glEnableVertexAttribArray(uv);GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(program,"transform"),1,false,transform,0);GLES20.glActiveTexture(GLES20.GL_TEXTURE0);GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,textureId);GLES20.glUniform1i(GLES20.glGetUniformLocation(program,"image"),0);GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP,0,4);
   if(now-lastJpeg>1000&&!jpegBusy){lastJpeg=now;jpegBusy=true;int w=width,h=height;ByteBuffer pixels=ByteBuffer.allocateDirect(w*h*4);GLES20.glReadPixels(0,0,w,h,GLES20.GL_RGBA,GLES20.GL_UNSIGNED_BYTE,pixels);jpegWork.execute(()->{try{int[] colors=new int[w*h];for(int y=0;y<h;y++)for(int x=0;x<w;x++){int pos=(y*w+x)*4;colors[(h-1-y)*w+x]=0xff000000|((pixels.get(pos)&255)<<16)|((pixels.get(pos+1)&255)<<8)|(pixels.get(pos+2)&255);}Bitmap b=Bitmap.createBitmap(colors,w,h,Bitmap.Config.ARGB_8888);ByteArrayOutputStream bytes=new ByteArrayOutputStream();b.compress(Bitmap.CompressFormat.JPEG,65,bytes);b.recycle();if(!closed){byte[] jpeg=bytes.toByteArray();agentSnapshot=new AgentSnapshot(jpeg,now);link.sendFrame(jpeg);}}finally{jpegBusy=false;}});}
  EGLExt.eglPresentationTimeANDROID(egl,window,System.nanoTime());if(!EGL14.eglSwapBuffers(egl,window))throw new IllegalStateException("GPU 画面提交失败");drain();
 }catch(Exception e){fail(e);}}
 private void drain(){if(encoder==null)return;MediaCodec.BufferInfo info=new MediaCodec.BufferInfo();for(int i=0;i<12;i++){int index=encoder.dequeueOutputBuffer(info,0);if(index==MediaCodec.INFO_OUTPUT_FORMAT_CHANGED){MediaFormat f=encoder.getOutputFormat();ByteBuffer a=f.getByteBuffer("csd-0"),b=f.getByteBuffer("csd-1");byte[] value=new byte[(a==null?0:a.remaining())+(b==null?0:b.remaining())];int n=0;if(a!=null){n=a.remaining();a.get(value,0,n);}if(b!=null)b.get(value,n,b.remaining());codecConfig=value;packet(0x40,0,value);continue;}if(index<0)break;ByteBuffer buffer=encoder.getOutputBuffer(index);if(buffer!=null&&info.size>0){byte[] bytes=new byte[info.size];buffer.position(info.offset);buffer.limit(info.offset+info.size);buffer.get(bytes);boolean config=(info.flags&MediaCodec.BUFFER_FLAG_CODEC_CONFIG)!=0,key=(info.flags&MediaCodec.BUFFER_FLAG_KEY_FRAME)!=0;if(config){codecConfig=bytes;packet(0x40,0,bytes);}else if(!needKey||key){if(key){sendFormat();if(codecConfig!=null)packet(0x40,0,codecConfig);needKey=false;if(!link.captureState.equals("streaming"))link.captureStatus("streaming","frames","");}if(!packet(key?0x20:0,info.presentationTimeUs,bytes)){needKey=true;keyframe();}}}encoder.releaseOutputBuffer(index,false);}}
 private boolean packet(int flags,long pts,byte[] bytes){ByteBuffer out=ByteBuffer.allocate(12+bytes.length).order(ByteOrder.BIG_ENDIAN);out.putLong(pts|((long)flags<<56)).putInt(bytes.length).put(bytes);return link.sendFrame(out.array());}
 private final Runnable poll=new Runnable(){public void run(){if(closed)return;try{int current=((WindowManager)service.getSystemService(Context.WINDOW_SERVICE)).getDefaultDisplay().getRotation();if(current!=rotation)configure();if(hasFrame&&SystemClock.elapsedRealtime()-lastFrame>1000)draw();drain();if(!hasFrame&&startedAt>0&&SystemClock.elapsedRealtime()-startedAt>15000)throw new IllegalStateException("系统未提供屏幕帧，请保持手机解锁并重新确认共享");}catch(Exception e){fail(e);return;}handler.postDelayed(this,12);}};
 void keyframe(){handler.post(()->{if(encoder!=null&&!closed){Bundle b=new Bundle();b.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME,0);try{encoder.setParameters(b);lastFrame=0;draw();}catch(Exception ignored){}}});}
 void settings(int max,int rate,int bit){maxSize=Math.max(640,Math.min(1920,max));fps=Math.max(15,Math.min(60,rate));bitrate=Math.max(1,Math.min(16,bit));handler.post(()->{try{configure();}catch(Exception e){fail(e);}});}
 private void startAudio(){if(!link.config.audio||service.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED)return;try{AudioPlaybackCaptureConfiguration capture=new AudioPlaybackCaptureConfiguration.Builder(projection).addMatchingUsage(AudioAttributes.USAGE_MEDIA).addMatchingUsage(AudioAttributes.USAGE_GAME).addMatchingUsage(AudioAttributes.USAGE_UNKNOWN).build();AudioFormat format=new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(48000).setChannelMask(AudioFormat.CHANNEL_IN_MONO).build();audio=new AudioRecord.Builder().setAudioFormat(format).setBufferSizeInBytes(Math.max(19200,AudioRecord.getMinBufferSize(48000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT))).setAudioPlaybackCaptureConfig(capture).build();audio.startRecording();audioThread=new Thread(()->{byte[] data=new byte[1920];while(!closed&&link.config.audio){int n=audio.read(data,0,data.length);if(n<0)break;if(n>0){ByteBuffer packet=ByteBuffer.allocate(12+n).order(ByteOrder.BIG_ENDIAN);packet.putInt(0x10000000).putInt(48000).putInt(1).put(data,0,n);link.sendFrame(packet.array());}}},"NexusRoom Audio");audioThread.start();}catch(Exception e){service.notice("当前系统不支持播放音频捕获，屏幕共享仍可使用");}}
 private void fail(Exception error){if(!closed){Log.e(TAG,"capture failed at "+stage,error);service.captureStopped(this,"画面处理失败（"+stage+"）："+error.getMessage(),true);close();}}
 private void dispose(Runnable action){try{action.run();}catch(Exception e){Log.w(TAG,"cleanup",e);}}
  synchronized void close(){if(closed)return;closed=true;ready=false;agentSnapshot=null;handler.post(()->{
  handler.removeCallbacksAndMessages(null);
  if(audio!=null)dispose(()->audio.stop());
  if(audioThread!=null)try{audioThread.join(500);}catch(InterruptedException e){Thread.currentThread().interrupt();}
  if(audio!=null)dispose(()->audio.release());
  if(display!=null)dispose(()->display.release());
  if(egl!=null&&egl!=EGL14.EGL_NO_DISPLAY)dispose(()->EGL14.eglMakeCurrent(egl,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_CONTEXT));
  if(window!=null&&window!=EGL14.EGL_NO_SURFACE)dispose(()->EGL14.eglDestroySurface(egl,window));
  if(encoder!=null){dispose(()->encoder.stop());dispose(()->encoder.release());}
  if(source!=null)dispose(()->source.release());if(texture!=null)dispose(()->texture.release());if(encoderSurface!=null)dispose(()->encoderSurface.release());
  if(egl!=null&&egl!=EGL14.EGL_NO_DISPLAY){if(context!=null)dispose(()->EGL14.eglDestroyContext(egl,context));dispose(()->EGL14.eglTerminate(egl));}
  if(projection!=null)dispose(()->projection.stop());
  jpegWork.shutdownNow();thread.quitSafely();
 });}
}
