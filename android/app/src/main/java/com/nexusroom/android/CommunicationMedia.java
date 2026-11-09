package com.nexusroom.android;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.hardware.display.DisplayManager;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaRecorder;
import android.media.projection.MediaProjection;
import android.os.Build;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Display;
import android.view.WindowManager;
import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.*;
import org.webrtc.audio.JavaAudioDeviceModule;
import org.webrtc.audio.AudioProcessingComponentOptions;
import org.webrtc.audio.AudioProcessingMode;
import org.webrtc.audio.AudioProcessingOptions;
import org.webrtc.audio.AudioProcessingOptionsResult;
import org.webrtc.audio.AudioProcessingState;
import java.nio.ByteBuffer;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** One physical-device media session, with one Unified Plan connection per participant. */
final class CommunicationMedia {
    static final class Video {
        final String deviceId,label,kind;final VideoTrack track;
        Video(String deviceId,String kind,String label,VideoTrack track){this.deviceId=deviceId;this.label=label;this.kind=kind;this.track=track;}
    }
    private static boolean initialized;
    private static final ExecutorService RTC_WORK=Executors.newSingleThreadExecutor(r->{Thread thread=new Thread(r,"NexusRoom-RTC");thread.setDaemon(true);return thread;});
    final CommunicationClient client;
    final String sessionId,selfId;
    final boolean call;
    private final RoomService service;
    private final ExecutorService work=RTC_WORK;
    private final LinkedHashMap<String,Peer> peers=new LinkedHashMap<>();
    private final LinkedHashMap<String,Video> videos=new LinkedHashMap<>();
    private final IdentityHashMap<VideoSink,VideoTrack> sinks=new IdentityHashMap<>();
    private final LinkedHashMap<String,String> names=new LinkedHashMap<>();
    private final AudioManager audio;
    private int previousAudioMode;
    private boolean previousSpeaker,audioRouteOwned;
    private AudioFocusRequest audioFocus;
    private EglBase egl;
    private PeerConnectionFactory factory;
    private JavaAudioDeviceModule adm;
    private AudioSource audioSource;private AudioTrack audioTrack;
    private VideoSource cameraSource,screenSource;
    private VideoTrack cameraTrack,screenTrack;
    private VideoCapturer cameraCapturer;
    private ScreenCapturerAndroid screenCapturer;
    private SurfaceTextureHelper cameraHelper,screenHelper;
    private long cameraGeneration,screenGeneration;
    private DisplayManager.DisplayListener screenDisplayListener;
    private int screenWidth,screenHeight;
    private boolean screenContentSized;
    private MeetingScreenAudio screenAudioCapture;
    private final AtomicBoolean screenAudioPacketQueued=new AtomicBoolean();
    private long screenAudioBytes;
    private boolean platformVoiceAec;
    volatile boolean microphone,camera,screen,screenAudio,speaker,closed;
    volatile String status="正在建立加密媒体连接",statistics="";
    private long lastStats;

    CommunicationMedia(CommunicationClient client,JSONObject session) {
        this.client=client;service=client.service;sessionId=session.optString("id");selfId=client.link.config.deviceId;call=session.optString("kind").equals("call");
        audio=service.getSystemService(AudioManager.class);speaker=!call;
        work.execute(()->{
            if(closed)return;
            try {
                synchronized(CommunicationMedia.class){if(!initialized){PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(service).createInitializationOptions());initialized=true;}}
                acquireAudioRoute();
                egl=EglBase.create();
                // Vendor AEC is not reliable on every speaker route. Use WebRTC's
                // software canceller, whose reference is the actual RTC output.
                // Voice usage also prevents meetings re-entering playback capture.
                AudioAttributes attributes=new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).setAllowedCapturePolicy(AudioAttributes.ALLOW_CAPTURE_BY_NONE).build();
                adm=JavaAudioDeviceModule.builder(service).setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION).setAudioAttributes(attributes).setUseHardwareAcousticEchoCanceler(false).setUseHardwareNoiseSuppressor(false).setStopRecordingOnMute(true).createAudioDeviceModule();
                adm.setMicrophoneMute(true);
                factory=PeerConnectionFactory.builder().setAudioDeviceModule(adm)
                    .setVideoEncoderFactory(new DefaultVideoEncoderFactory(egl.getEglBaseContext(),true,true))
                    .setVideoDecoderFactory(new DefaultVideoDecoderFactory(egl.getEglBaseContext())).createPeerConnectionFactory();
                if(closed)return;
                audioFocus=new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(attributes).setOnAudioFocusChangeListener(change->{if(change==AudioManager.AUDIOFOCUS_LOSS||change==AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)setMicrophone(false);}).build();
                audio.requestAudioFocus(audioFocus);
                updateNow(session);
            }catch(Exception e){error("媒体初始化失败",e);}
        });
    }
    EglBase.Context eglContext(){EglBase current=egl;return current==null?null:current.getEglBaseContext();}
    List<Video> videos(){synchronized(videos){return new ArrayList<>(videos.values());}}
    void attachSink(Video video,VideoSink sink){synchronized(sinks){if(closed)return;try{video.track.addSink(sink);sinks.put(sink,video.track);}catch(IllegalStateException ignored){}}}
    void detachSink(VideoSink sink){synchronized(sinks){VideoTrack track=sinks.remove(sink);if(track!=null)try{track.removeSink(sink);}catch(IllegalStateException ignored){}}}
    private void detachTrack(VideoTrack track){synchronized(sinks){for(VideoSink sink:new ArrayList<>(sinks.keySet()))if(sinks.get(sink)==track){sinks.remove(sink);try{track.removeSink(sink);}catch(IllegalStateException ignored){}}}}
    private void changed(){service.handler.post(()->RoomService.changed(service));}
    private void error(String prefix,Exception e){if(closed)return;status=prefix+"："+(e.getMessage()==null?e.getClass().getSimpleName():e.getMessage());Log.w("NexusRoom.RTC",prefix,e);changed();}
    private void submit(Runnable task){if(closed)return;try{work.execute(()->{if(!closed)try{task.run();}catch(Exception e){error("媒体处理失败",e);}});}catch(java.util.concurrent.RejectedExecutionException ignored){}}
    // Native observers outlive removePeer/close. Their work runs on the same
    // queue as disposal and only the current Peer may touch native objects.
    private void submit(Peer peer,Runnable task){submit(()->{if(peers.get(peer.id)==peer)task.run();});}
    void update(JSONObject session){submit(()->updateNow(session));}
    private void updateNow(JSONObject session) {
        if(closed||factory==null)return;
        JSONArray people=session.optJSONArray("participants");Set<String> present=new LinkedHashSet<>();
        if(people!=null)for(int i=0;i<people.length();i++){
            JSONObject person=people.optJSONObject(i);if(person==null)continue;String id=person.optString("deviceId");names.put(id,person.optString("name","设备"));
            if(!id.equals(selfId)&&!id.isEmpty()){present.add(id);if(!peers.containsKey(id))createPeer(id);Peer peer=peers.get(id);if(peer!=null){boolean sharedSound=person.optBoolean("screen")&&person.optBoolean("screenAudio");peer.screenAudioPlayer.setEnabled(sharedSound);if(!sharedSound)peer.receivesPcmAudio=false;if(peer.remoteScreenAudio!=null)peer.remoteScreenAudio.setEnabled(sharedSound);}}
        }
        for(String id:new ArrayList<>(peers.keySet()))if(!present.contains(id))removePeer(id);
        if(microphone)try{configureVoiceProcessing();}catch(Exception e){error("回声处理更新失败",e);setMicrophone(false);}
        changed();
    }
    private void createPeer(String id) {
        Peer peer=new Peer(id);PeerConnection.RTCConfiguration config=new PeerConnection.RTCConfiguration(Collections.emptyList());config.sdpSemantics=PeerConnection.SdpSemantics.UNIFIED_PLAN;config.bundlePolicy=PeerConnection.BundlePolicy.MAXBUNDLE;
        peer.pc=factory.createPeerConnection(config,peer);
        if(peer.pc==null){status="当前设备无法建立 WebRTC 连接";changed();return;}
        peers.put(id,peer);
        // Both platforms use exactly this order, even for audio-only calls.
        if(selfId.compareTo(id)<0){configureTransceivers(peer,true);if(!call){DataChannel.Init data=new DataChannel.Init();data.ordered=false;data.maxRetransmits=0;peer.setAudioChannel(peer.pc.createDataChannel("nr-screen-audio",data));}}
        tracks(peer);peer.pc.setBitrate(64000,600000,1800000);
        if(selfId.compareTo(id)<0)peer.pc.createOffer(peer.offer(),new MediaConstraints());
    }
    private void configureTransceivers(Peer peer,boolean create){
        // Android's getTransceivers() disposes its previous Java wrappers,
        // including their senders. Read it once and retain this one snapshot.
        List<RtpTransceiver> slots=create?Collections.emptyList():peer.pc.getTransceivers();
        if(!create&&(slots.size()!=4||slots.get(0).getMediaType()!=MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO||slots.get(1).getMediaType()!=MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO||slots.get(2).getMediaType()!=MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO||slots.get(3).getMediaType()!=MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO))throw new IllegalStateException("媒体轨道顺序无效");
        peer.senders.clear();
        for(int i=0;i<4;i++){
            MediaStreamTrack.MediaType type=i==0||i==3?MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO:MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO;
            String streamId=i==0?"audio":i==1?"camera":i==2?"screen":"screenAudio";
            RtpTransceiver.RtpTransceiverDirection direction=call&&i>0?RtpTransceiver.RtpTransceiverDirection.INACTIVE:RtpTransceiver.RtpTransceiverDirection.SEND_RECV;
            RtpTransceiver transceiver=create?peer.pc.addTransceiver(type,new RtpTransceiver.RtpTransceiverInit(direction,Collections.singletonList(streamId))):slots.get(i);
            transceiver.setDirection(direction);transceiver.getSender().setStreams(Collections.singletonList(streamId));
            peer.senders.add(transceiver.getSender());
        }
    }
    private void tracks(Peer peer){if(peer.senders.size()!=4)return;peer.senders.get(0).setTrack(microphone?audioTrack:null,false);peer.senders.get(1).setTrack(camera?cameraTrack:null,false);peer.senders.get(2).setTrack(screen?screenTrack:null,false);}
    private void tracks(){for(Peer peer:peers.values())tracks(peer);}
    private void removePeer(String id){Peer peer=peers.remove(id);synchronized(videos){Video camera=videos.remove(id+":camera"),screen=videos.remove(id+":screen");if(camera!=null)detachTrack(camera.track);if(screen!=null)detachTrack(screen.track);}if(peer!=null){peer.screenAudioPlayer.close();if(peer.screenAudioChannel!=null){peer.screenAudioChannel.unregisterObserver();peer.screenAudioChannel.close();peer.screenAudioChannel.dispose();peer.screenAudioChannel=null;}peer.pc.close();peer.pc.dispose();}}
    void signal(JSONObject message){submit(()->{
        if(!sessionId.equals(message.optString("sessionId")))return;
        Peer peer=peers.get(message.optString("fromId"));JSONObject signal=message.optJSONObject("signal");if(peer==null||signal==null)return;
        try {
            String type=signal.optString("type");
            if(type.equals("ice")) {
                JSONObject value=signal.optJSONObject("candidate");if(value==null||value.optString("candidate").isEmpty())return;
                IceCandidate candidate=new IceCandidate(value.optString("sdpMid",null),value.optInt("sdpMLineIndex"),value.getString("candidate"));
                if(peer.remoteSet)peer.pc.addIceCandidate(candidate);else if(peer.ice.size()<256)peer.ice.add(candidate);
            } else if(type.equals("offer")||type.equals("answer")) {
                if((type.equals("offer")&&selfId.compareTo(peer.id)<0)||(type.equals("answer")&&selfId.compareTo(peer.id)>0))throw new Exception("收到不符合协商顺序的媒体请求");
                if(peer.remoteSet||peer.remotePending)return;
                SessionDescription description=new SessionDescription(type.equals("offer")?SessionDescription.Type.OFFER:SessionDescription.Type.ANSWER,signal.getString("sdp"));
                peer.remotePending=true;
                peer.pc.setRemoteDescription(new Sdp(peer){@Override public void onSetSuccess(){submit(peer,()->{peer.remotePending=false;peer.remoteSet=true;for(IceCandidate candidate:peer.ice)peer.pc.addIceCandidate(candidate);peer.ice.clear();if(type.equals("offer")){if(peer.senders.isEmpty())configureTransceivers(peer,false);tracks(peer);peer.pc.createAnswer(peer.answer(),new MediaConstraints());}});}},description);
            }
        }catch(Exception e){error("媒体协商失败",e);}
    });}
    void setMicrophone(boolean enabled){submit(()->{
        try {
            if(microphone==enabled)return;
            if(enabled){require(Manifest.permission.RECORD_AUDIO,"请允许麦克风权限");service.communicationMediaForeground(this,true,camera,screen);if(audioTrack==null){MediaConstraints voice=new MediaConstraints();voice.optional.add(new MediaConstraints.KeyValuePair("googEchoCancellation","true"));voice.optional.add(new MediaConstraints.KeyValuePair("googNoiseSuppression","true"));voice.optional.add(new MediaConstraints.KeyValuePair("googAutoGainControl","true"));audioSource=factory.createAudioSource(voice);audioTrack=factory.createAudioTrack("audio-"+selfId,audioSource);}configureVoiceProcessing();audioTrack.setEnabled(true);adm.setMicrophoneMute(false);microphone=true;}
            else {microphone=false;if(audioTrack!=null)audioTrack.setEnabled(false);adm.setMicrophoneMute(true);}
            tracks();service.communicationMediaForeground(this,microphone,camera,screen);publish();
        }catch(Exception e){microphone=false;if(adm!=null)adm.setMicrophoneMute(true);error("麦克风未开启",e);publish();}
    });}
    private void configureVoiceProcessing()throws Exception{
        if(audioTrack==null||adm==null)return;
        boolean externalPlayback=false;for(Peer peer:peers.values())if(peer.receivesPcmAudio)externalPlayback=true;
        boolean platform=externalPlayback&&adm.getPlatformAudioProcessingState().echoCancellation.isAvailable;
        AudioProcessingComponentOptions software=new AudioProcessingComponentOptions(true,AudioProcessingMode.SOFTWARE);
        AudioProcessingOptions options=new AudioProcessingOptions(new AudioProcessingComponentOptions(true,platform?AudioProcessingMode.PLATFORM:AudioProcessingMode.SOFTWARE),software,software,software);
        AudioProcessingOptionsResult applied=audioTrack.setAudioProcessingOptions(options);if(!applied.isSuccess())throw new Exception("回声消除未初始化："+applied.message);
        // The SDK's software reference covers its RTP mixer. PCM from another
        // Android plays outside that mixer, so use the platform's system output
        // reference for this case instead of pretending software AEC covers it.
        if(platform!=platformVoiceAec||!microphone){boolean ready=microphone?adm.requestStartRecording(options):adm.prewarmRecording(options);if(!ready)throw new Exception("录音声路未就绪");platformVoiceAec=platform;Log.i("NexusRoom.RTC","session="+sessionId+" voiceProcessing="+applied.code+" aecMode="+(platform?"PLATFORM":"SOFTWARE")+" pcmReference="+externalPlayback);}
        if(externalPlayback&&!platform&&speaker){speaker=false;routeSpeaker();status="共享声音已切换听筒 / 耳机，避免扬声器回声";changed();}
    }
    void setCamera(boolean enabled){submit(()->{
        try {
            if(call&&enabled)throw new Exception("私人电话仅支持音频");if(camera==enabled)return;
            if(enabled){require(Manifest.permission.CAMERA,"请允许摄像头权限");service.communicationMediaForeground(this,microphone,true,screen);
                CameraEnumerator enumerator=Camera2Enumerator.isSupported(service)?new Camera2Enumerator(service):new Camera1Enumerator(true);String selected="";
                for(String device:enumerator.getDeviceNames())if(enumerator.isFrontFacing(device)){selected=device;break;}if(selected.isEmpty()&&enumerator.getDeviceNames().length>0)selected=enumerator.getDeviceNames()[0];if(selected.isEmpty())throw new Exception("未找到可用摄像头");
                long attempt=++cameraGeneration;
                cameraCapturer=enumerator.createCapturer(selected,new CameraVideoCapturer.CameraEventsHandler(){public void onCameraError(String error){submit(()->{if(attempt!=cameraGeneration||cameraCapturer==null)return;stopCamera();status="摄像头已停止："+error;publish();});}public void onCameraDisconnected(){submit(()->{if(attempt!=cameraGeneration||cameraCapturer==null)return;stopCamera();status="摄像头已断开";publish();});}public void onCameraFreezed(String error){onCameraError(error);}public void onCameraOpening(String name){}public void onFirstFrameAvailable(){}public void onCameraClosed(){}});
                if(cameraCapturer==null)throw new Exception("摄像头无法初始化");cameraSource=factory.createVideoSource(false);cameraHelper=SurfaceTextureHelper.create("NexusRoom-Camera",egl.getEglBaseContext());cameraCapturer.initialize(cameraHelper,service,cameraSource.getCapturerObserver());cameraTrack=factory.createVideoTrack("camera-"+selfId,cameraSource);camera=true;cameraCapturer.startCapture(640,480,20);synchronized(videos){videos.put(selfId+":camera",new Video(selfId,"camera","我的摄像头",cameraTrack));}
            }else stopCamera();
            tracks();service.communicationMediaForeground(this,microphone,camera,screen);publish();
        }catch(Exception e){stopCamera();error("摄像头未开启",e);publish();}
    });}
    private void stopCamera(){++cameraGeneration;camera=false;tracks();synchronized(videos){videos.remove(selfId+":camera");}VideoCapturer previous=cameraCapturer;cameraCapturer=null;if(previous!=null){try{previous.stopCapture();}catch(Exception ignored){}previous.dispose();}if(cameraTrack!=null){detachTrack(cameraTrack);cameraTrack.dispose();cameraTrack=null;}if(cameraSource!=null){cameraSource.dispose();cameraSource=null;}if(cameraHelper!=null){cameraHelper.dispose();cameraHelper=null;}}
    void startScreen(Intent consent,boolean includeAudio){submit(()->{
        try {
            if(call)throw new Exception("私人电话仅支持音频");if(screen)return;
            service.communicationMediaForeground(this,microphone,camera,true);
            long attempt=++screenGeneration;screenContentSized=false;
            screenSource=factory.createVideoSource(true);screenHelper=SurfaceTextureHelper.create("NexusRoom-Screen",egl.getEglBaseContext());
            screenCapturer=new ScreenCapturerAndroid(consent,new MediaProjection.Callback(){@Override public void onStop(){submit(()->{if(attempt==screenGeneration&&screen){stopScreenNow();status="系统已停止会议屏幕共享";publish();}});}@Override public void onCapturedContentResize(int width,int height){submit(()->{if(attempt!=screenGeneration||!screen)return;screenContentSized=true;resizeScreen(width,height);});}});
            screenCapturer.initialize(screenHelper,service,screenSource.getCapturerObserver());screenTrack=factory.createVideoTrack("screen-"+selfId,screenSource);screen=true;
            DisplayMetrics metrics=screenMetrics();int[] dimensions=screenDimensions(metrics.widthPixels,metrics.heightPixels);screenWidth=dimensions[0];screenHeight=dimensions[1];
            screenCapturer.startCapture(screenWidth,screenHeight,15);watchScreenDisplay(attempt);tracks();synchronized(videos){videos.put(selfId+":screen",new Video(selfId,"screen","我的共享屏幕",screenTrack));}if(includeAudio)try{startScreenAudioNow();}catch(Exception audioError){stopScreenAudioNow();error("屏幕已共享，但设备声音未开启",audioError);}publish();
        }catch(Exception e){stopScreenNow();error("屏幕共享未开启",e);publish();}
    });}
    void stopScreen(){submit(()->{stopScreenNow();publish();});}
    void setScreenAudio(boolean enabled){submit(()->{if(!screen)return;try{if(enabled)startScreenAudioNow();else stopScreenAudioNow();}catch(Exception e){stopScreenAudioNow();error("设备声音未共享",e);}publish();});}
    private void startScreenAudioNow()throws Exception{
        if(screenAudio)return;require(Manifest.permission.RECORD_AUDIO,"共享设备声音需要录音权限");
        if(!screen||screenCapturer==null||screenCapturer.getMediaProjection()==null)throw new Exception("请先共享屏幕");
        long attempt=screenGeneration;
        MeetingScreenAudio started=new MeetingScreenAudio(service,screenCapturer.getMediaProjection(),packet->{
            if(closed||!screenAudio||attempt!=screenGeneration||!screenAudioPacketQueued.compareAndSet(false,true))return;
            work.execute(()->{try{if(closed||!screenAudio||attempt!=screenGeneration)return;for(Peer peer:peers.values()){DataChannel channel=peer.screenAudioChannel;if(channel!=null&&channel.state()==DataChannel.State.OPEN&&channel.bufferedAmount()<3840&&channel.send(new DataChannel.Buffer(ByteBuffer.wrap(packet),true)))screenAudioBytes+=packet.length;}}finally{screenAudioPacketQueued.set(false);}});
        },failure->submit(()->{if(attempt!=screenGeneration||screenAudioCapture==null)return;stopScreenAudioNow();status="设备声音共享已停止："+failure;publish();}));
        started.start();screenAudioCapture=started;screenAudio=true;
        Log.i("NexusRoom.RTC","session="+sessionId+" screenAudio=true format=PCM16LE/48000/mono excludeOwnUid=true");
    }
    private void stopScreenAudioNow(){screenAudio=false;MeetingScreenAudio previous=screenAudioCapture;screenAudioCapture=null;if(previous!=null)previous.close();}
    private DisplayMetrics screenMetrics(){DisplayMetrics metrics=new DisplayMetrics();((WindowManager)service.getSystemService(Context.WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(metrics);return metrics;}
    private static int[] screenDimensions(int width,int height){double ratio=Math.min(1.0,1280.0/Math.max(1,Math.max(width,height)));return new int[]{Math.max(2,((int)(width*ratio)/2)*2),Math.max(2,((int)(height*ratio)/2)*2)};}
    private void resizeScreen(int width,int height){if(width<=0||height<=0||screenCapturer==null)return;int[] dimensions=screenDimensions(width,height);if(screenWidth==dimensions[0]&&screenHeight==dimensions[1])return;screenCapturer.changeCaptureFormat(dimensions[0],dimensions[1],15);screenWidth=dimensions[0];screenHeight=dimensions[1];}
    private void watchScreenDisplay(long attempt){
        DisplayManager manager=service.getSystemService(DisplayManager.class);if(manager==null)return;
        screenDisplayListener=new DisplayManager.DisplayListener(){public void onDisplayAdded(int id){}public void onDisplayRemoved(int id){}public void onDisplayChanged(int id){if(id!=Display.DEFAULT_DISPLAY)return;submit(()->{if(attempt!=screenGeneration||!screen||screenContentSized)return;DisplayMetrics metrics=screenMetrics();resizeScreen(metrics.widthPixels,metrics.heightPixels);});}};
        manager.registerDisplayListener(screenDisplayListener,service.handler);
    }
    private void stopScreenNow(){++screenGeneration;stopScreenAudioNow();screen=false;tracks();synchronized(videos){videos.remove(selfId+":screen");}if(screenDisplayListener!=null){DisplayManager manager=service.getSystemService(DisplayManager.class);if(manager!=null)manager.unregisterDisplayListener(screenDisplayListener);screenDisplayListener=null;}ScreenCapturerAndroid previous=screenCapturer;screenCapturer=null;if(previous!=null){try{previous.stopCapture();}catch(Exception ignored){}previous.dispose();}if(screenTrack!=null){detachTrack(screenTrack);screenTrack.dispose();screenTrack=null;}if(screenSource!=null){screenSource.dispose();screenSource=null;}if(screenHelper!=null){screenHelper.dispose();screenHelper=null;}screenWidth=screenHeight=0;screenContentSized=false;}
    void setSpeaker(boolean enabled){submit(()->{speaker=enabled;routeSpeaker();if(microphone)try{configureVoiceProcessing();}catch(Exception e){error("回声处理更新失败",e);setMicrophone(false);}changed();});}
    private void acquireAudioRoute(){
        // Every media lifecycle uses RTC_WORK. Capture this baseline after the
        // preceding session's queued cleanup, so consecutive calls restore the
        // original system mode rather than inheriting MODE_IN_COMMUNICATION.
        previousAudioMode=audio.getMode();previousSpeaker=audio.isSpeakerphoneOn();audioRouteOwned=true;
        audio.setMode(AudioManager.MODE_IN_COMMUNICATION);routeSpeaker();
    }
    private void releaseAudioRoute(){if(!audioRouteOwned)return;audioRouteOwned=false;if(Build.VERSION.SDK_INT>=31)audio.clearCommunicationDevice();else audio.setSpeakerphoneOn(previousSpeaker);if(audio.getMode()==AudioManager.MODE_IN_COMMUNICATION)audio.setMode(previousAudioMode);}
    private void routeSpeaker(){if(Build.VERSION.SDK_INT>=31){if(speaker){for(AudioDeviceInfo device:audio.getAvailableCommunicationDevices())if(device.getType()==AudioDeviceInfo.TYPE_BUILTIN_SPEAKER){audio.setCommunicationDevice(device);return;}}else audio.clearCommunicationDevice();}else audio.setSpeakerphoneOn(speaker);}
    private void require(String permission,String message)throws Exception{if(service.checkSelfPermission(permission)!=PackageManager.PERMISSION_GRANTED)throw new Exception(message);if(factory==null)throw new Exception("媒体尚未初始化");}
    private void publish(){try{service.communicationMediaForeground(this,microphone,camera,screen);}catch(Exception ignored){}client.media(sessionId,microphone,camera,screen,screenAudio);changed();}
    void tick(){
        long now=android.os.SystemClock.elapsedRealtime();if(closed||now-lastStats<2500)return;lastStats=now;
        submit(()->{for(Peer peer:peers.values())peer.pc.getStats(report->submit(peer,()->{
            long sent=0,received=0,decoded=0,cameraFrames=0,screenFrames=0,screenRtpAudioBytes=0,screenRtpAudioPackets=0;
            double screenRtpAudioEnergy=0;boolean screenRtpAudioEnergyAvailable=false;
            for(RTCStats value:report.getStatsMap().values()){
                Map<String,Object> members=value.getMembers();
                if(value.getType().equals("outbound-rtp"))sent+=number(members.get("bytesSent"));
                if(value.getType().equals("inbound-rtp")){
                    received+=number(members.get("bytesReceived"));long frames=number(members.get("framesDecoded"));decoded+=frames;
                    String mid=String.valueOf(members.get("mid"));
                    if(mid.equals("1"))cameraFrames+=frames;else if(mid.equals("2"))screenFrames+=frames;
                    else if(mid.equals("3")){screenRtpAudioBytes+=number(members.get("bytesReceived"));screenRtpAudioPackets+=number(members.get("packetsReceived"));Object energy=members.get("totalAudioEnergy");if(energy instanceof Number){screenRtpAudioEnergy+=((Number)energy).doubleValue();screenRtpAudioEnergyAvailable=true;}}
                }
            }
            statistics="发送 "+sent+" B / 接收 "+received+" B / 视频 "+decoded+" 帧";
            AudioProcessingState processing=factory.getAudioProcessingState();
            JavaAudioDeviceModule.PlatformAudioProcessingState platform=adm.getPlatformAudioProcessingState();
            Log.i("NexusRoom.RTC","session="+sessionId+" peer="+peer.id+" "+statistics+" cameraFrames="+cameraFrames+" screenFrames="+screenFrames+" screenRtpAudioBytes="+screenRtpAudioBytes+" screenRtpAudioPackets="+screenRtpAudioPackets+" screenRtpAudioEnergy="+screenRtpAudioEnergy+" screenRtpAudioEnergyAvailable="+screenRtpAudioEnergyAvailable+" screenAudio="+screenAudio+" screenAudioBytes="+screenAudioBytes+" screenAudioCapturePackets="+(screenAudioCapture==null?0:screenAudioCapture.capturedPackets())+" screenAudioCaptureRms="+(screenAudioCapture==null?0:screenAudioCapture.rms())+" screenAudioReceivedBytes="+peer.screenAudioPlayer.receivedBytes()+" screenAudioRms="+peer.screenAudioPlayer.rms()+" aecSoftware="+processing.echoCancellation.isSoftwareActive+" aecEffective="+processing.echoCancellation.effective+" aecPlatform="+platform.echoCancellation.isActive);changed();
        }));});
    }
    private static long number(Object value){return value instanceof Number?((Number)value).longValue():0;}
    void close(){if(closed)return;closed=true;work.execute(()->{for(String id:new ArrayList<>(peers.keySet()))removePeer(id);microphone=false;if(adm!=null)adm.setMicrophoneMute(true);stopCamera();stopScreenNow();if(audioTrack!=null)audioTrack.dispose();if(audioSource!=null)audioSource.dispose();if(factory!=null)factory.dispose();if(adm!=null)adm.release();if(egl!=null)egl.release();if(audioFocus!=null)audio.abandonAudioFocusRequest(audioFocus);releaseAudioRoute();synchronized(videos){videos.clear();}Log.i("NexusRoom.RTC","session="+sessionId+" released microphone="+microphone+" camera="+camera+" screen="+screen+" audioMode="+audio.getMode());changed();});}

    private class Sdp implements SdpObserver {
        private final Peer owner;
        Sdp(Peer owner){this.owner=owner;}
        public void onCreateSuccess(SessionDescription description){}
        public void onSetSuccess(){}
        public void onCreateFailure(String error){submit(owner,()->{status="媒体协商失败："+error;changed();});}
        public void onSetFailure(String error){submit(owner,()->{owner.remotePending=false;status="媒体描述失败："+error;changed();});}
    }
    private final class Peer implements PeerConnection.Observer {
        final String id;PeerConnection pc;DataChannel screenAudioChannel;AudioTrack remoteScreenAudio;final MeetingScreenAudioPlayer screenAudioPlayer=new MeetingScreenAudioPlayer();final ArrayList<RtpSender> senders=new ArrayList<>();final ArrayList<IceCandidate> ice=new ArrayList<>();volatile boolean receivesPcmAudio;boolean remoteSet,remotePending;
        Peer(String id){this.id=id;}
        Sdp offer(){return description("offer");}Sdp answer(){return description("answer");}
        Sdp description(String type){return new Sdp(this){@Override public void onCreateSuccess(SessionDescription description){submit(Peer.this,()->pc.setLocalDescription(new Sdp(Peer.this){@Override public void onSetSuccess(){submit(Peer.this,()->{try{client.signal(sessionId,id,new JSONObject().put("type",type).put("sdp",description.description));}catch(Exception ignored){}});}},description));}};}
        public void onSignalingChange(PeerConnection.SignalingState state){}
        public void onIceConnectionChange(PeerConnection.IceConnectionState state){}
        public void onConnectionChange(PeerConnection.PeerConnectionState state){submit(this,()->{status=state==PeerConnection.PeerConnectionState.CONNECTED?"加密媒体已连接":state==PeerConnection.PeerConnectionState.FAILED?"媒体连接失败，请检查同一局域网是否允许设备直连":"正在连接媒体";changed();});}
        public void onIceConnectionReceivingChange(boolean receiving){}
        public void onIceGatheringChange(PeerConnection.IceGatheringState state){}
        public void onIceCandidate(IceCandidate candidate){submit(this,()->{try{client.signal(sessionId,id,new JSONObject().put("type","ice").put("candidate",new JSONObject().put("sdpMid",candidate.sdpMid).put("sdpMLineIndex",candidate.sdpMLineIndex).put("candidate",candidate.sdp)));}catch(Exception ignored){}});}
        public void onIceCandidatesRemoved(IceCandidate[] candidates){}
        public void onAddStream(MediaStream stream){}
        public void onRemoveStream(MediaStream stream){}
        void setAudioChannel(DataChannel channel){if(channel==null)return;screenAudioChannel=channel;channel.registerObserver(new DataChannel.Observer(){public void onBufferedAmountChange(long previous){}public void onStateChange(){}public void onMessage(DataChannel.Buffer message){if(closed||!message.binary)return;if(screenAudioPlayer.packet(message.data)&&!receivesPcmAudio){receivesPcmAudio=true;submit(Peer.this,()->{if(microphone)try{configureVoiceProcessing();}catch(Exception e){error("共享声音回声处理失败",e);setMicrophone(false);}});}}});}
        public void onDataChannel(DataChannel channel){submit(this,()->{if(!call&&channel.label().equals("nr-screen-audio")&&screenAudioChannel==null)setAudioChannel(channel);else{channel.close();channel.dispose();}});}
        public void onRenegotiationNeeded(){}
        // Unified Plan fires both callbacks. Browser stream IDs are opaque UUIDs,
        // so the legacy callback cannot distinguish MID1 from the empty MID2.
        // Only onTrack may assign a receiver to a camera/screen display slot.
        public void onAddTrack(RtpReceiver receiver,MediaStream[] streams){}
        public void onTrack(RtpTransceiver transceiver){submit(this,()->{MediaStreamTrack track=transceiver.getReceiver().track();String mid=transceiver.getMid();if(track instanceof AudioTrack&&"3".equals(mid)){remoteScreenAudio=(AudioTrack)track;JSONObject state=client.state;JSONArray sessions=state.optJSONArray("sessions");boolean enabled=false;if(sessions!=null)for(int i=0;i<sessions.length();i++){JSONObject session=sessions.optJSONObject(i);if(session==null||!sessionId.equals(session.optString("id")))continue;JSONArray people=session.optJSONArray("participants");if(people!=null)for(int p=0;p<people.length();p++){JSONObject person=people.optJSONObject(p);if(person!=null&&id.equals(person.optString("deviceId")))enabled=person.optBoolean("screen")&&person.optBoolean("screenAudio");}}remoteScreenAudio.setEnabled(enabled);return;}if(!(track instanceof VideoTrack)||!("1".equals(mid)||"2".equals(mid)))return;remoteVideo("2".equals(mid)?"screen":"camera",(VideoTrack)track);});}
        private void remoteVideo(String kind,VideoTrack track){synchronized(videos){videos.put(id+":"+kind,new Video(id,kind,(names.getOrDefault(id,"设备"))+(kind.equals("screen")?" · 共享屏幕":" · 摄像头"),track));}changed();}
    }
}
