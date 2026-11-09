package com.nexusroom.android;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.*;
import android.content.pm.PackageManager;
import android.media.*;
import android.os.*;
import com.k2fsa.sherpa.onnx.*;
import org.json.JSONObject;
import okhttp3.*;
import java.io.IOException;
import java.util.UUID;
import java.util.concurrent.*;

/** One microphone owner for both push-to-talk and optional offline wake listening. */
final class VoiceController {
    interface Listener {
        void state(String message,boolean recording);
        void manualText(String member,String text);
        void automaticResult(String member,String text,JSONObject result);
    }
    @SuppressLint("StaticFieldLeak") // Constructor retains the application context; UI listeners are explicitly unbound.
    private static volatile VoiceController instance;
    static VoiceController get(Context context){if(instance==null)synchronized(VoiceController.class){if(instance==null)instance=new VoiceController(context.getApplicationContext());}return instance;}
    private final Context context;
    private final SharedPreferences prefs;
    private final Handler main=new Handler(Looper.getMainLooper());
    private final ThreadPoolExecutor network=new ThreadPoolExecutor(1,1,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(4));
    private volatile Listener listener;
    private volatile boolean foreground,backgroundRunning,manualRequested,manualActive,manualCancelled,recording;
    private volatile String member="",profile="",workspace="",message="离线语音就绪";
    private volatile String recordingMember="";
    private volatile String presentedWake="",presentedMember="";
    private volatile long presentedAt;
    private volatile AudioRecord recorder;
    private volatile long manualReleaseAt;
    private volatile long manualSamples;
    private volatile int configuration;
    private Thread worker;
    private boolean wakeDisabledAfterError;
    private final Runnable retry=()->{wakeDisabledAfterError=false;ensureWorker();};
    private final Runnable health=new Runnable(){public void run(){
        if(wakeEnabled()){
            if(!hasPermission()){stopRecorder();if(backgroundRunning)stopBackground();state("麦克风权限已撤销，语音监听已暂停",false);}
            else ensureWorker();
        }
        main.postDelayed(this,3000);
    }};
    private VoiceController(Context context){this.context=context;prefs=ReleaseStorage.preferences(context,"voice");main.post(health);}
    boolean enabled(){return prefs.getBoolean("enabled",true);}
    boolean wakeEnabled(){return enabled()&&prefs.getBoolean("wake",false);}
    boolean backgroundEnabled(){return wakeEnabled()&&prefs.getBoolean("background",false);}
    boolean hasPermission(){return context.checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED;}
    boolean hasBackgroundPermissions(){return hasPermission()&&(Build.VERSION.SDK_INT<33||context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED);}
    boolean microphoneActive(){AudioRecord active=recorder;return active!=null&&active.getRecordingState()==AudioRecord.RECORDSTATE_RECORDING;}
    boolean recording(String source){return recording&&source.equals(recordingMember);}
    boolean localWake(String source,String event){return source.equals(presentedMember)&&event.equals(presentedWake)&&SystemClock.elapsedRealtime()-presentedAt<65000;}
    Intent openIntent(){return presentedWake.isEmpty()?new Intent(context,MainActivity.class):VoiceWakeUi.intent(context,presentedMember,presentedWake);}
    long manualSamplesRead(){return manualSamples;}
    void bind(Listener listener,String member,String profile,String workspace){this.listener=listener;configure(member,profile,workspace);listener.state(message,recording);}
    void unbind(Listener owner){if(listener==owner)listener=null;}
    void configure(String member,String profile,String workspace){boolean changed=!this.member.equals(member)||!this.profile.equals(profile)||!this.workspace.equals(workspace);this.member=member;this.profile=profile;this.workspace=workspace;if(changed){configuration++;manualCancelled=true;manualRequested=false;stopRecorder();}ensureWorker();}
    void foreground(boolean value){foreground=value;if(!value){manualCancelled=true;manualRequested=false;}ensureWorker();}
    void enabled(boolean value){prefs.edit().putBoolean("enabled",value).apply();if(!value){manualCancelled=true;manualRequested=false;stopBackground();}ensureWorker();}
    void wake(boolean value){prefs.edit().putBoolean("wake",value).apply();wakeDisabledAfterError=false;if(!value)stopBackground();ensureWorker();}
    void background(boolean value){prefs.edit().putBoolean("background",value).apply();if(value&&foreground&&hasBackgroundPermissions()&&wakeEnabled()){
        try{context.startForegroundService(new Intent(context,VoiceService.class));}
        catch(RuntimeException e){prefs.edit().putBoolean("background",false).apply();state("系统未允许启动麦克风前台服务，请回到前台重试",false);}
    }else stopBackground();ensureWorker();}
    void backgroundStarted(){backgroundRunning=true;ensureWorker();}
    void backgroundStopped(){backgroundRunning=false;ensureWorker();}
    void stopFromNotification(){prefs.edit().putBoolean("wake",false).putBoolean("background",false).apply();backgroundRunning=false;manualRequested=false;ensureWorker();}
    private void stopBackground(){backgroundRunning=false;context.stopService(new Intent(context,VoiceService.class));}
    void beginManual(){
        if(!enabled()){state("请先开启离线语音输入",false);return;}
        if(!foreground||!hasPermission()){state("请授予麦克风权限后再次长按",false);return;}
        if(communicationUsesMicrophone()){state("通话或会议正在使用麦克风，请先关闭通话麦克风",false);return;}
        manualCancelled=false;manualReleaseAt=0;manualSamples=0;manualRequested=true;wakeDisabledAfterError=false;ensureWorker();
    }
    void endManual(boolean cancel){manualReleaseAt=SystemClock.elapsedRealtime();manualCancelled=cancel;manualRequested=false;if(manualActive)state(cancel?"录音已取消":"本地转写中…",false);}
    private boolean communicationUsesMicrophone(){RoomService service=RoomService.instance;return service!=null&&service.communicationMicrophoneActive();}
    private RoomService.RoomLink room(){RoomService service=RoomService.instance;return service==null?null:service.links.get(member);}
    private boolean canWake(){RoomService.RoomLink link=room();return !wakeDisabledAfterError&&wakeEnabled()&&hasPermission()&&(foreground||backgroundRunning)&&link!=null&&link.online&&link.config.agent&&!link.config.leaving&&!communicationUsesMicrophone();}
    private boolean needed(){return enabled()&&hasPermission()&&(manualRequested||(manualActive&&!manualCancelled&&foreground)||canWake());}
    private synchronized void ensureWorker(){
        if(!needed()){stopRecorder();return;}
        if(worker!=null)return;
        worker=new Thread(this::capture,"NexusRoom Offline Voice");worker.start();
    }
    private void stopRecorder(){AudioRecord value=recorder;if(value!=null)try{value.stop();}catch(IllegalStateException ignored){}if(recording)state("录音已停止",false);}
    private void state(String message,boolean recording){this.message=message;this.recording=recording;main.post(()->{Listener current=listener;if(current!=null)current.state(message,recording);VoiceService service=VoiceService.instance;if(service!=null)service.status(message);});}
    // A delayed Room response must never clear the indicator for a newer local capture.
    private void report(String message){main.post(()->{if(!recording)state(message,false);});}
    private static final class Wake {
        final RoomService.RoomLink link;final String eventId=UUID.randomUUID().toString(),profile,workspace;final int configuration;
        volatile String wakeId="";volatile boolean cancelled;volatile Exception failure;
        Wake(RoomService.RoomLink link,String profile,String workspace,int configuration){this.link=link;this.profile=profile;this.workspace=workspace;this.configuration=configuration;}
    }
    private boolean enqueue(Runnable work,Wake wake,boolean showError){try{network.execute(work);return true;}catch(RejectedExecutionException e){if(wake!=null)wake.cancelled=true;if(showError){wakeDisabledAfterError=true;state("语音网络请求过多，监听暂停 12 秒，请检查房间连接",false);main.postDelayed(retry,12000);}return false;}}
    private void claim(Wake wake){enqueue(()->{
        try{JSONObject result=request(wake.link,"/device/voice/wake",new JSONObject().put("eventId",wake.eventId).put("profileId",wake.profile).put("workspacePath",wake.workspace));
            wake.wakeId=result.optString("wakeId");if(!result.optBoolean("capture",false)||wake.wakeId.isEmpty())wake.cancelled=true;
            if(wake.cancelled&&!wake.wakeId.isEmpty())cancel(wake);
            else if(!wake.cancelled)main.post(()->{
                if(wake.configuration!=configuration||wake.cancelled||!wakeEnabled()||!wake.link.online||wake.link.config.leaving)return;
                presentedMember=wake.link.config.deviceId;presentedWake=wake.eventId;presentedAt=SystemClock.elapsedRealtime();
                if(foreground||VoiceWakeUi.canOpenFromBackground(context)){
                    try{VoiceWakeUi.open(context,presentedMember,presentedWake);}catch(RuntimeException ignored){VoiceService service=VoiceService.instance;if(service!=null)service.status("已唤醒 · 点击打开 Agent");}
                }else {VoiceService service=VoiceService.instance;if(service!=null)service.status("已唤醒 · 点击打开 Agent；自动打开需后台授权");}
            });
        }catch(Exception e){wake.failure=e;wake.cancelled=true;report("语音唤醒未提交："+safe(e));}
    },wake,true);}
    private void finish(Wake wake,String text){enqueue(()->{
        if(wake.cancelled||wake.configuration!=configuration||text.isEmpty()||wake.wakeId.isEmpty()){wake.cancelled=true;cancel(wake);return;}
        try{
            if(!wake.link.online||!wake.link.config.agent||wake.link.config.leaving)throw new Exception("房间离线或 Agent 权限已关闭");
            JSONObject result=request(wake.link,"/device/voice/submit",new JSONObject().put("wakeId",wake.wakeId).put("eventId",wake.eventId).put("text",text));
            String status=result.optString("status"),runId=result.optString("runId");JSONObject run=result.optJSONObject("run");if(runId.isEmpty()&&run!=null)runId=run.optString("id");
            if((!"started".equals(status)&&!"duplicate".equals(status))||runId.isEmpty())throw new Exception(result.optString("error","语音任务尚未启动（"+status+"），请检查房间任务状态"));
            prefs.edit().putString("last-target:"+wake.link.config.deviceId,result.optString("targetId")).apply();
            main.post(()->{Listener current=listener;if(current!=null&&wake.configuration==configuration&&member.equals(wake.link.config.deviceId))current.automaticResult(wake.link.config.deviceId,text,result);});
            report("duplicate".equals(result.optString("status"))?"该语音已由房间设备提交，已合并":"语音任务已交给 Agent");
        }catch(Exception e){report("语音任务未提交："+safe(e));}
    },wake,true);}
    private void cancel(Wake wake){if(wake.wakeId.isEmpty())return;try{request(wake.link,"/device/voice/cancel",new JSONObject().put("wakeId",wake.wakeId).put("eventId",wake.eventId));}catch(Exception ignored){}}
    private JSONObject request(RoomService.RoomLink link,String path,JSONObject body)throws Exception{
        Request request=link.request(path).post(RequestBody.create(body.toString(),MediaType.get("application/json"))).build();
        for(int attempt=0;;attempt++)try(Response response=link.client.newBuilder().callTimeout(18,TimeUnit.SECONDS).build().newCall(request).execute()){
            String raw=response.body()==null?"{}":response.body().string();JSONObject result=new JSONObject(raw);
            if(!response.isSuccessful())throw new Exception(result.optString("title","房间请求失败"));return result;
        }catch(IOException e){if(attempt>=1)throw e;}
    }
    private static String safe(Throwable error){return error.getMessage()==null?"请检查麦克风权限和本地模型":error.getMessage();}
    private void capture(){
        KeywordSpotter kws=null;OnlineStream kwsStream=null,stream=null;OnlineRecognizer asr=null;AudioRecord audio=null;
        boolean manual=false;Wake wake=null;VoiceVad vad=new VoiceVad();String captureMember="";long cooldown=0;final int epoch=configuration;
        try{
            if(context.checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED)throw new SecurityException("麦克风权限未授予");
            int minimum=AudioRecord.getMinBufferSize(16000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT);
            if(minimum<=0)throw new Exception("当前设备不支持 16 kHz 单声道麦克风");
            // A six-second native ring prevents model creation from dropping the beginning of a sentence.
            audio=new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION,16000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT,Math.max(minimum*4,192000));
            if(audio.getState()!=AudioRecord.STATE_INITIALIZED)throw new Exception("麦克风不可用，可能被其他应用占用");
            recorder=audio;audio.startRecording();long audioStarted=SystemClock.elapsedRealtime(),readSamples=0;short[] block=new short[320];int emptyReads=0;
            float[] preRoll=new float[6400];int preAt=0,preCount=0;
            while(needed()||stream!=null){
                if(epoch!=configuration||!hasPermission()||communicationUsesMicrophone()||(!foreground&&!backgroundRunning)){manualCancelled=true;break;}
                if(stream==null&&manualRequested){manual=true;manualActive=true;captureMember=member;recordingMember=captureMember;vad.reset();state("正在录音 · 松开完成转写",true);asr=VoiceModels.asr(context.getAssets());stream=asr.createStream("");}
                else if(stream==null&&canWake()&&kws==null){state("加载本地唤醒模型…",false);kws=VoiceModels.kws(context.getAssets());kwsStream=kws.createStream("");state("正在本地监听 Hi Nexus",false);}
                if(stream!=null&&!manual&&manualRequested){Wake previous=wake;previous.cancelled=true;enqueue(()->cancel(previous),previous,false);stream.release();stream=null;asr.release();asr=null;wake=null;continue;}
                if(stream!=null&&((manual&&!manualRequested)||(!manual&&(wake.cancelled||!canWake())))){
                    if(manual&&manualCancelled){stream.release();stream=null;asr.release();asr=null;manual=false;manualActive=false;state("录音已取消",false);continue;}
                    if(!manual&&(wake.cancelled||!canWake())){Wake previous=wake;previous.cancelled=true;enqueue(()->cancel(previous),previous,false);stream.release();stream=null;asr.release();asr=null;wake=null;state("正在本地监听 Hi Nexus",false);continue;}
                    // Loading the native ASR can outlast a short hold. Drain only
                    // frames recorded before release, rather than flushing an empty stream.
                    if(manual){long release=manualReleaseAt==0?SystemClock.elapsedRealtime():manualReleaseAt;long pending=Math.min(96000,Math.max(0,(release-audioStarted)*16-readSamples));
                        while(pending>0){int count=audio.read(block,0,(int)Math.min(block.length,pending),AudioRecord.READ_NON_BLOCKING);if(count<=0)break;float[] pcm=new float[count];for(int i=0;i<count;i++)pcm[i]=block[i]/32768f;stream.acceptWaveform(pcm,16000);while(asr.isReady(stream))asr.decode(stream);vad.accept(pcm);pending-=count;readSamples+=count;manualSamples+=count;}
                    }
                    complete(asr,stream,manual,wake,captureMember,vad,epoch);stream.release();stream=null;asr.release();asr=null;manual=false;wake=null;cooldown=SystemClock.elapsedRealtime()+1400;if(kws!=null)kws.reset(kwsStream);continue;
                }
                int count=audio.read(block,0,block.length,AudioRecord.READ_BLOCKING);
                if(count<0){if(epoch!=configuration||!needed())break;throw new Exception("麦克风录音中断（"+count+"）");}
                if(count==0){if(++emptyReads>30)throw new Exception("麦克风没有音频数据");continue;}emptyReads=0;
                readSamples+=count;float[] pcm=new float[count];for(int i=0;i<count;i++)pcm[i]=block[i]/32768f;
                for(float sample:pcm){preRoll[preAt]=sample;preAt=(preAt+1)%preRoll.length;preCount=Math.min(preRoll.length,preCount+1);}
                if(stream!=null){if(manual)manualSamples+=count;stream.acceptWaveform(pcm,16000);while(asr.isReady(stream))asr.decode(stream);vad.accept(pcm);
                    if(!manual&&(vad.ended()||(vad.hasSpeech()&&asr.isEndpoint(stream))||vad.timedOut())){
                        complete(asr,stream,false,wake,captureMember,vad,epoch);stream.release();stream=null;asr.release();asr=null;wake=null;cooldown=SystemClock.elapsedRealtime()+1400;if(kws!=null)kws.reset(kwsStream);
                    }else if(manual&&vad.timedOut()){manualRequested=false;}
                }else if(kws!=null&&canWake()&&SystemClock.elapsedRealtime()>=cooldown){
                    kwsStream.acceptWaveform(pcm,16000);while(kws.isReady(kwsStream)){kws.decode(kwsStream);if(!kws.getResult(kwsStream).getKeyword().isEmpty()){
                        kws.reset(kwsStream);RoomService.RoomLink link=room();if(link==null)break;wake=new Wake(link,profile,workspace,epoch);claim(wake);
                        captureMember=member;recordingMember=captureMember;manual=false;vad.reset();state("Hi Nexus 已唤醒 · 请说出任务",true);asr=VoiceModels.asr(context.getAssets());stream=asr.createStream("");
                        float[] prior=new float[preCount];for(int i=0;i<preCount;i++)prior[i]=preRoll[(preAt-preCount+i+preRoll.length)%preRoll.length];stream.acceptWaveform(prior,16000);while(asr.isReady(stream))asr.decode(stream);break;
                    }}
                }
            }
        }catch(Throwable error){
            manualRequested=false;if(epoch==configuration){wakeDisabledAfterError=true;state("离线语音暂停："+safe(error),false);if(wakeEnabled()&&hasPermission())main.postDelayed(retry,12000);}
        }finally{
            if(wake!=null){Wake cancelled=wake;cancelled.cancelled=true;enqueue(()->cancel(cancelled),cancelled,false);}
            if(stream!=null)stream.release();if(asr!=null)asr.release();if(kwsStream!=null)kwsStream.release();if(kws!=null)kws.release();
            recorder=null;if(audio!=null){try{audio.stop();}catch(IllegalStateException ignored){}audio.release();}
            state(message,false);manualActive=false;synchronized(this){worker=null;}
            main.post(()->{if(needed())ensureWorker();else if(!wakeDisabledAfterError)state(enabled()?"离线语音就绪":"离线语音已关闭",false);});
        }
    }
    private void complete(OnlineRecognizer asr,OnlineStream stream,boolean manual,Wake wake,String captureMember,VoiceVad vad,int epoch){
        state("本地转写中…",false);
        stream.acceptWaveform(new float[6400],16000);stream.inputFinished();while(asr.isReady(stream))asr.decode(stream);
        String text=asr.getResult(stream).getText().trim();if(!manual)text=VoiceVad.stripWakeWord(text);
        // Ignore the KWS pre-roll when nobody speaks a command after waking.
        if(!manual&&!vad.hasSpeech())text="";
        final String result=text;
        if(manual){manualRequested=false;manualActive=false;if(!manualCancelled&&!text.isEmpty())main.post(()->{Listener current=listener;if(current!=null&&epoch==configuration&&member.equals(captureMember))current.manualText(captureMember,result);});state(text.isEmpty()?"没有识别到语音，请再次长按":"转写完成 · 请确认后自行发送",false);}
        else if(wake!=null){state(text.isEmpty()?"没有识别到任务，继续监听":"正在选择目标设备…",false);finish(wake,text);}
    }
}
