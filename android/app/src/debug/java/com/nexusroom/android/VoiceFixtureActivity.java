package com.nexusroom.android;

import android.app.Activity;
import android.content.Intent;
import android.os.*;
import android.widget.TextView;
import com.k2fsa.sherpa.onnx.*;
import org.json.JSONObject;
import java.io.*;
import java.nio.*;
import okhttp3.*;

/** Debug APK only. Exercises the real packaged JNI, KWS and ASR with local PCM WAV. */
public final class VoiceFixtureActivity extends Activity {
    @Override public void onCreate(Bundle state){super.onCreate(state);TextView text=new TextView(this);text.setText("正在验证本地语音模型…");text.setPadding(30,50,30,30);setContentView(text);
        if(getIntent().getBooleanExtra("lifecycle",false)){lifecycle(text);return;}
        if(getIntent().getBooleanExtra("earlyRelease",false)){earlyRelease(text);return;}
        if(getIntent().getBooleanExtra("overlayCancel",false)){overlayCancel(text);return;}
        if(getIntent().getBooleanExtra("wakePresentation",false)){wakePresentation(text);return;}
        if(getIntent().hasExtra("setupRoom")){setupRoom(text);return;}
        if(getIntent().getBooleanExtra("cleanupRoom",false)){cleanupRoom(text);return;}
        new Thread(()->{JSONObject result=new JSONObject();KeywordSpotter kws=null;OnlineRecognizer asr=null;OnlineStream ks=null,rs=null;
            try{
                long started=SystemClock.elapsedRealtime();kws=VoiceModels.kws(getAssets());ks=kws.createStream("");
                ks.acceptWaveform(new float[32000],16000);while(kws.isReady(ks))kws.decode(ks);
                if(!kws.getResult(ks).getKeyword().isEmpty())throw new Exception("Silence triggered wake word");
                result.put("silenceKws",true).put("kwsLoadMs",SystemClock.elapsedRealtime()-started);kws.reset(ks);
                String filename=getIntent().getStringExtra("wav");float[] pcm=filename==null?new float[16000]:wave(new File(filename));
                boolean keyword=false;long decodeStart=SystemClock.elapsedRealtime();
                for(int at=0;at<pcm.length;at+=320){float[] frame=java.util.Arrays.copyOfRange(pcm,at,Math.min(pcm.length,at+320));ks.acceptWaveform(frame,16000);while(kws.isReady(ks)){kws.decode(ks);if(!kws.getResult(ks).getKeyword().isEmpty()){keyword=true;kws.reset(ks);}}}
                ks.acceptWaveform(new float[16000],16000);while(kws.isReady(ks)){kws.decode(ks);if(!kws.getResult(ks).getKeyword().isEmpty())keyword=true;}
                result.put("keywordDetected",keyword).put("kwsDecodeMs",SystemClock.elapsedRealtime()-decodeStart);
                started=SystemClock.elapsedRealtime();asr=VoiceModels.asr(getAssets());rs=asr.createStream("");result.put("asrLoadMs",SystemClock.elapsedRealtime()-started);
                decodeStart=SystemClock.elapsedRealtime();for(int at=0;at<pcm.length;at+=320){rs.acceptWaveform(java.util.Arrays.copyOfRange(pcm,at,Math.min(pcm.length,at+320)),16000);while(asr.isReady(rs))asr.decode(rs);}
                rs.acceptWaveform(new float[6400],16000);rs.inputFinished();while(asr.isReady(rs))asr.decode(rs);
                String transcript=asr.getResult(rs).getText();result.put("text",transcript).put("audioSeconds",pcm.length/16000.0).put("asrDecodeMs",SystemClock.elapsedRealtime()-decodeStart);
                if(filename!=null&&transcript.isBlank())throw new Exception("ASR returned no text");
                if(getIntent().getBooleanExtra("expectWake",false)&&!keyword)throw new Exception("Expected Hi Nexus was not detected");
                result.put("ok",true);
            }catch(Throwable error){try{result.put("ok",false).put("error",String.valueOf(error));}catch(Exception ignored){}
            }finally{if(ks!=null)ks.release();if(kws!=null)kws.release();if(rs!=null)rs.release();if(asr!=null)asr.release();}
            try{File output=new File(getFilesDir(),"voice-test-result.json");try(FileOutputStream file=new FileOutputStream(output)){file.write(result.toString(2).getBytes(java.nio.charset.StandardCharsets.UTF_8));}}catch(Exception ignored){}
            android.util.Log.i("NexusRoom.VoiceFixture",result.toString());runOnUiThread(()->text.setText(result.toString()));
        },"Voice Fixture").start();
    }
    private void lifecycle(TextView text){
        VoiceController voice=VoiceController.get(this);JSONObject result=new JSONObject();
        voice.configure("voice-qa","","");voice.enabled(true);voice.foreground(true);voice.beginManual();
        Handler handler=new Handler(Looper.getMainLooper());
        handler.postDelayed(()->{try{
            boolean granted=voice.hasPermission(),active=voice.microphoneActive();result.put("permissionGranted",granted).put("microphoneStarted",active);
            if(granted&&!active)throw new Exception("Granted foreground microphone did not start");if(!granted&&active)throw new Exception("Denied microphone was opened");
            voice.endManual(true);voice.foreground(false);
            handler.postDelayed(()->{try{boolean released=!voice.microphoneActive();result.put("microphoneReleasedOnPause",released);if(!released)throw new Exception("Microphone remains active after pause");
                if(granted){voice.foreground(true);voice.wake(true);voice.background(true);
                    handler.postDelayed(()->{try{result.put("foregroundServiceStarted",VoiceService.instance!=null);if(VoiceService.instance==null)throw new Exception("Microphone foreground service did not start");voice.background(false);voice.wake(false);voice.foreground(false);handler.postDelayed(()->{try{result.put("foregroundServiceStopped",VoiceService.instance==null).put("ok",VoiceService.instance==null);}catch(Exception ignored){}writeResult(result,text);},700);}catch(Throwable error){failed(result,error,text);}},1000);
                }else{result.put("ok",true);writeResult(result,text);}
            }catch(Throwable error){failed(result,error,text);}},1000);
        }catch(Throwable error){voice.endManual(true);voice.foreground(false);failed(result,error,text);}},4000);
    }
    private void earlyRelease(TextView text){VoiceController voice=VoiceController.get(this);JSONObject result=new JSONObject();voice.configure("voice-qa","","");voice.enabled(true);voice.foreground(true);voice.beginManual();Handler handler=new Handler(Looper.getMainLooper());
        handler.postDelayed(()->voice.endManual(false),300);
        handler.postDelayed(()->{try{result.put("samplesRecordedBeforeRelease",voice.manualSamplesRead()).put("microphoneReleased",!voice.microphoneActive()).put("ok",voice.manualSamplesRead()>0&&!voice.microphoneActive());}catch(Exception ignored){}voice.foreground(false);writeResult(result,text);},4000);
    }
    /** Exercise production overlay cancellation with the real AudioRecord, without a room or model key. */
    private void overlayCancel(TextView text){VoiceController voice=VoiceController.get(this);JSONObject result=new JSONObject();android.widget.FrameLayout root=new android.widget.FrameLayout(this);setContentView(root);AgentOverlay overlay=new AgentOverlay(this,root);Handler handler=new Handler(Looper.getMainLooper());
        try{java.lang.reflect.Field member=AgentOverlay.class.getDeclaredField("member"),visible=AgentOverlay.class.getDeclaredField("visible");member.setAccessible(true);visible.setAccessible(true);member.set(overlay,"voice-qa");visible.setBoolean(overlay,true);java.lang.reflect.Method open=AgentOverlay.class.getDeclaredMethod("setOpen",boolean.class);open.setAccessible(true);open.invoke(overlay,true);}catch(Throwable error){overlay.destroy();failed(result,error,text);return;}
        voice.enabled(true);voice.wake(false);voice.background(false);overlay.resume();
        try{result.put("manualResultAcceptedWhileOpen",manualResultAccepted(overlay));}catch(Throwable error){overlay.destroy();failed(result,error,text);return;}voice.beginManual();
        handler.postDelayed(()->{try{
            if(!voice.microphoneActive())throw new Exception("Overlay cancellation test microphone did not start");
            android.view.View dot=(android.view.View)overlayField(overlay,"recordingDot");if(dot.getVisibility()!=android.view.View.VISIBLE||overlayField(overlay,"recordingBlink")==null)throw new Exception("Actual manual capture did not display the blinking recording dot");result.put("recordingDotVisibleAndAnimated",true);
            java.lang.reflect.Field scopedMember=AgentOverlay.class.getDeclaredField("member");scopedMember.setAccessible(true);scopedMember.set(overlay,"other-member");java.lang.reflect.Method update=AgentOverlay.class.getDeclaredMethod("updateRecordingIndicator");update.setAccessible(true);update.invoke(overlay);if(dot.getVisibility()!=android.view.View.GONE)throw new Exception("Another membership displayed this recorder");result.put("otherMemberRecordingDotHidden",true);scopedMember.set(overlay,"voice-qa");update.invoke(overlay);
            java.lang.reflect.Method close=AgentOverlay.class.getDeclaredMethod("setOpen",boolean.class);close.setAccessible(true);close.invoke(overlay,false);
            if(dot.getVisibility()!=android.view.View.GONE||overlayField(overlay,"recordingBlink")!=null)throw new Exception("Collapse retained the dot animation");result.put("recordingDotRemovedOnCollapse",true);
            handler.postDelayed(()->{try{
                boolean closed=!voice.microphoneActive();result.put("microphoneReleasedOnCollapse",closed);if(!closed)throw new Exception("Collapsed overlay retained microphone");result.put("lateManualResultIgnoredOnCollapse",lateManualIgnored(overlay,false));java.lang.reflect.Method reopen=AgentOverlay.class.getDeclaredMethod("setOpen",boolean.class);reopen.setAccessible(true);reopen.invoke(overlay,true);result.put("manualResultAcceptedAfterReopen",manualResultAccepted(overlay));voice.beginManual();
                handler.postDelayed(()->{try{
                    if(!voice.microphoneActive())throw new Exception("Second overlay microphone did not start");overlay.setOccluded(true);
                    handler.postDelayed(()->{try{boolean occluded=!voice.microphoneActive();result.put("microphoneReleasedOnOcclusion",occluded);if(!occluded)throw new Exception("Occluded overlay retained microphone");result.put("lateManualResultIgnoredOnOcclusion",lateManualIgnored(overlay,true)).put("ok",true);overlay.destroy();setContentView(text);writeResult(result,text);}catch(Throwable error){overlay.destroy();setContentView(text);failed(result,error,text);}},700);
                }catch(Throwable error){overlay.destroy();setContentView(text);failed(result,error,text);}},2500);
            }catch(Throwable error){overlay.destroy();setContentView(text);failed(result,error,text);}},700);
        }catch(Throwable error){overlay.destroy();setContentView(text);failed(result,error,text);}},4000);
    }
    private Object overlayField(AgentOverlay overlay,String name)throws Exception{java.lang.reflect.Field field=AgentOverlay.class.getDeclaredField(name);field.setAccessible(true);return field.get(overlay);}
    /** Native launch from Home using a local-event fixture, without a remote room/model. */
    private void wakePresentation(TextView text){JSONObject result=new JSONObject();Handler handler=new Handler(Looper.getMainLooper());
        try{
            RoomConfig config=new RoomConfig();config.server="https://127.0.0.1:9";config.fingerprint="0".repeat(64);config.roomId="654321";config.roomName="Voice UI QA";config.deviceId="voice-ui-qa";config.token="debug-local-fixture";config.agent=true;config.save(this);RoomConfig.select(this,config.deviceId);
            startForegroundService(new Intent(this,RoomService.class));
            handler.postDelayed(()->{try{
                RoomService service=RoomService.instance;if(service==null)throw new Exception("Room service did not start");RoomService.RoomLink link=service.links.get(config.deviceId);if(link==null)throw new Exception("Fixture membership not loaded");link.online=true;
                VoiceController voice=VoiceController.get(this);voice.configure(config.deviceId,"","");voice.wake(false);String event=java.util.UUID.randomUUID().toString();
                for(String name:new String[]{"presentedMember","presentedWake","presentedAt"}){java.lang.reflect.Field field=VoiceController.class.getDeclaredField(name);field.setAccessible(true);if(name.equals("presentedAt"))field.setLong(voice,SystemClock.elapsedRealtime());else field.set(voice,name.equals("presentedMember")?config.deviceId:event);}
                startActivity(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                handler.postDelayed(()->{try{link.online=true;VoiceWakeUi.open(this,config.deviceId,event);result.put("ok",true).put("localEventFixture",true).put("backgroundOpenRequested",true).put("overlayPermission",android.provider.Settings.canDrawOverlays(this));writeResult(result,text);}catch(Throwable error){failed(result,error,text);}},1200);
            }catch(Throwable error){failed(result,error,text);}},1500);
        }catch(Throwable error){failed(result,error,text);}
    }
    private boolean manualResultAccepted(AgentOverlay overlay)throws Exception{if(!(Boolean)overlayField(overlay,"visible")||!(Boolean)overlayField(overlay,"open")||(Boolean)overlayField(overlay,"occluded"))throw new Exception("Positive-control overlay is not open and visible");android.widget.EditText input=(android.widget.EditText)overlayField(overlay,"input");String draft=input.getText().toString(),transcript="positive control transcript";((VoiceController.Listener)overlayField(overlay,"voiceListener")).manualText((String)overlayField(overlay,"member"),transcript);String expected=draft.isBlank()?transcript:draft+"\n"+transcript;if(!expected.equals(input.getText().toString()))throw new Exception("Open overlay did not accept matching-member manual transcript");return true;}
    private boolean lateManualIgnored(AgentOverlay overlay,boolean expectedOpen)throws Exception{if(!(Boolean)overlayField(overlay,"visible"))throw new Exception("Cancellation test must not be masked by a hidden room");android.widget.EditText input=(android.widget.EditText)overlayField(overlay,"input");String draft=input.getText().toString();((VoiceController.Listener)overlayField(overlay,"voiceListener")).manualText((String)overlayField(overlay,"member"),"late cancelled transcript");if(!draft.equals(input.getText().toString())||(Boolean)overlayField(overlay,"open")!=expectedOpen)throw new Exception("Late cancelled transcript changed draft or reopened overlay");return true;}
    /** Only test metadata is read; the model key arrives through the existing pinned WSS agent_start command. */
    private void setupRoom(TextView text){new Thread(()->{
        JSONObject result=new JSONObject();File metadata=null;OkHttpClient client=null;
        try{
            metadata=new File(getIntent().getStringExtra("setupRoom"));String base=getFilesDir().getCanonicalPath()+File.separator;
            if(!metadata.getCanonicalPath().startsWith(base))throw new Exception("Setup metadata must be in this debug app's private files directory");
            JSONObject invitation=new JSONObject(new String(java.nio.file.Files.readAllBytes(metadata.toPath()),java.nio.charset.StandardCharsets.UTF_8));
            if(invitation.has("apiKey")||invitation.has("token"))throw new Exception("Setup accepts invitation metadata only");
            RoomConfig config=new RoomConfig();config.server=invitation.getString("server").replaceAll("/+$","");config.fingerprint=invitation.getString("fingerprint");config.roomId=invitation.getString("roomId");
            RoomConfig.validate(config.server,config.fingerprint);if(!config.roomId.matches("[0-9]{6}"))throw new Exception("Invalid room ID");
            client=config.client(RoomDiscovery.preferredNetwork(this,config.server));
            JSONObject join=new JSONObject().put("roomId",config.roomId).put("password",invitation.getString("password")).put("name",invitation.optString("name","NexusRoom Voice QA Emulator")).put("version",Build.VERSION.RELEASE).put("physicalId",RoomConfig.physicalId(this));
            try(Response response=client.newCall(new Request.Builder().url(config.server+"/device/join").post(RequestBody.create(join.toString(),MediaType.get("application/json"))).build()).execute()){
                if(!response.isSuccessful())throw new Exception("Test room join HTTP "+response.code());
                if(response.body()==null)throw new Exception("Test room join returned no body");JSONObject membership=new JSONObject(response.body().string());
                config.deviceId=membership.getString("deviceId");config.token=membership.getString("token");config.hostName=membership.getString("hostName");config.roomName=membership.optString("roomName");
            }
            config.agent=true;config.save(this);RoomConfig.select(this,config.deviceId);
            final RoomConfig joined=config;runOnUiThread(()->{startForegroundService(new Intent(this,RoomService.class));waitForRoom(joined,text,SystemClock.elapsedRealtime()+30000);});
        }catch(Throwable error){try{result.put("ok",false).put("errorType",error.getClass().getSimpleName());}catch(Exception ignored){}runOnUiThread(()->writeRoomResult(result,text));}
        finally{if(metadata!=null)metadata.delete();if(client!=null){client.connectionPool().evictAll();client.dispatcher().executorService().shutdown();}}
    },"Voice Room QA Setup").start();}
    private void waitForRoom(RoomConfig config,TextView text,long deadline){RoomService service=RoomService.instance;RoomService.RoomLink link=service==null?null:service.links.get(config.deviceId);
        if(link!=null&&link.online){JSONObject result=new JSONObject();try{result.put("ok",true).put("online",true).put("agentAuthorized",link.config.agent).put("deviceId",config.deviceId).put("roomId",config.roomId).put("model",Build.MODEL).put("androidVersion",Build.VERSION.RELEASE);}catch(Exception ignored){}writeRoomResult(result,text);return;}
        if(SystemClock.elapsedRealtime()>=deadline){JSONObject result=new JSONObject();try{result.put("ok",false).put("online",false).put("errorType","RoomConnectionTimeout").put("deviceId",config.deviceId);}catch(Exception ignored){}writeRoomResult(result,text);return;}
        new Handler(Looper.getMainLooper()).postDelayed(()->waitForRoom(config,text,deadline),400);
    }
    private void cleanupRoom(TextView text){String id=getIntent().getStringExtra("member");JSONObject result=new JSONObject();try{
        if(id==null||id.isBlank())throw new Exception("Test member ID required");RoomConfig.remove(this,id);RoomService service=RoomService.instance;if(service!=null){RoomService.RoomLink link=service.links.get(id);if(link!=null){link.close();service.links.remove(id,link);}}RoomConfig.select(this,"");result.put("ok",true).put("removed",true);
    }catch(Throwable error){try{result.put("ok",false).put("errorType",error.getClass().getSimpleName());}catch(Exception ignored){}}writeRoomResult(result,text);}
    private void writeRoomResult(JSONObject result,TextView text){try{try(FileOutputStream output=new FileOutputStream(new File(getFilesDir(),"voice-room-ready.json"))){output.write(result.toString(2).getBytes(java.nio.charset.StandardCharsets.UTF_8));}}catch(Exception ignored){}android.util.Log.i("NexusRoom.VoiceRoomFixture",result.toString());text.setText(result.toString());}
    private void failed(JSONObject result,Throwable error,TextView text){try{result.put("ok",false).put("error",String.valueOf(error));}catch(Exception ignored){}writeResult(result,text);}
    private void writeResult(JSONObject result,TextView text){try{try(FileOutputStream output=new FileOutputStream(new File(getFilesDir(),"voice-test-result.json"))){output.write(result.toString(2).getBytes(java.nio.charset.StandardCharsets.UTF_8));}}catch(Exception ignored){}android.util.Log.i("NexusRoom.VoiceFixture",result.toString());text.setText(result.toString());}
    private static float[] wave(File file)throws Exception{
        byte[] bytes=java.nio.file.Files.readAllBytes(file.toPath());ByteBuffer data=ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        if(data.getInt()!=0x46464952)throw new Exception("WAV RIFF required");data.getInt();if(data.getInt()!=0x45564157)throw new Exception("WAV WAVE required");
        int channels=0,rate=0,bits=0,format=0;while(data.remaining()>=8){int kind=data.getInt(),size=data.getInt(),end=data.position()+size;if(size<0||end>data.limit())throw new Exception("Truncated WAV");
            if(kind==0x20746d66){format=data.getShort();channels=data.getShort();rate=data.getInt();data.getInt();data.getShort();bits=data.getShort();}
            else if(kind==0x61746164){if(format!=1||channels!=1||rate!=16000||bits!=16)throw new Exception("Expected 16 kHz mono PCM16 WAV");float[] pcm=new float[size/2];for(int i=0;i<pcm.length;i++)pcm[i]=data.getShort()/32768f;return pcm;}
            data.position(end+(size&1));
        }throw new Exception("WAV has no PCM data");
    }
}
