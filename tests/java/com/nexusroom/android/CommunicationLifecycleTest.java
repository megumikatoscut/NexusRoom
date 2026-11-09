package com.nexusroom.android;

import java.io.IOException;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import android.media.AudioManager;
import android.media.RecordingAudioManager;
import okhttp3.*;
import okio.ByteString;
import okio.Timeout;
import org.json.JSONObject;
import org.webrtc.*;
import sun.misc.Unsafe;

/** Executes production media methods; JNI wrappers are replaced with the
 * Android SDK's actual invalidate-on-getTransceivers ownership behavior. */
public final class CommunicationLifecycleTest {
    private static int passed;
    private static final Unsafe MEMORY;
    static {try{Field field=Unsafe.class.getDeclaredField("theUnsafe");field.setAccessible(true);MEMORY=(Unsafe)field.get(null);}catch(Exception error){throw new ExceptionInInitializerError(error);}}
    private static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
    private static void pass(String message){passed++;System.out.println("PASS "+message);}
    private static <T>T allocate(Class<T> type)throws Exception{return type.cast(MEMORY.allocateInstance(type));}
    private static void set(Object target,String name,Object value)throws Exception{Field field=target.getClass().getDeclaredField(name);field.setAccessible(true);field.set(target,value);}
    private static Object get(Object target,String name)throws Exception{Field field=target.getClass().getDeclaredField(name);field.setAccessible(true);return field.get(target);}
    private static Method method(Class<?> type,String name,Class<?>...arguments)throws Exception{Method method=type.getDeclaredMethod(name,arguments);method.setAccessible(true);return method;}
    private static final class Queue extends AbstractExecutorService {
        final ArrayDeque<Runnable> tasks=new ArrayDeque<>();boolean stopped;
        public void execute(Runnable task){if(stopped)throw new RejectedExecutionException();tasks.add(task);}
        void drain(){while(!tasks.isEmpty())tasks.remove().run();}
        public void shutdown(){stopped=true;}public List<Runnable> shutdownNow(){stopped=true;return List.of();}public boolean isShutdown(){return stopped;}public boolean isTerminated(){return stopped;}public boolean awaitTermination(long wait,TimeUnit unit){return stopped;}
    }
    private static final class Sender extends RtpSender {
        boolean valid;int tracks;
        Sender(){super(0);}
        private void live(){check(valid,"RtpSender has been disposed by another getTransceivers snapshot");}
        @Override public void setStreams(List<String> streams){live();}
        @Override public boolean setTrack(MediaStreamTrack track,boolean ownership){live();tracks++;return true;}
        @Override public void dispose(){valid=false;}
    }
    private static final class Slot extends RtpTransceiver {
        Sender sender;MediaStreamTrack.MediaType type;String mid;Receiver receiver;
        Slot(){super(0);}
        @Override public MediaStreamTrack.MediaType getMediaType(){return type;}
        @Override public RtpSender getSender(){return sender;}
        @Override public String getMid(){return mid;}
        @Override public RtpReceiver getReceiver(){return receiver;}
        @Override public boolean setDirection(RtpTransceiverDirection direction){sender.live();return true;}
        @Override public void dispose(){sender.dispose();}
    }
    private static final class Receiver extends RtpReceiver {
        MediaStreamTrack value;
        Receiver(){super(0);}
        @Override public MediaStreamTrack track(){return value;}
    }
    private static final class BrowserStream extends MediaStream {
        BrowserStream(){super(0);}
        @Override public String getId(){return "67ae2353-d918-44e8-b110-c993a289284b";}
    }
    private static final class NativeSnapshot extends PeerConnection {
        List<Slot> last;int count=4;boolean disposed,wrongScreenAudioType;
        NativeSnapshot(){super((NativePeerConnectionFactory)null);}
        @Override public List<RtpTransceiver> getTransceivers(){
            if(last!=null)for(Slot slot:last)slot.dispose();last=new ArrayList<>();
            try{for(int i=0;i<count;i++){Slot slot=allocate(Slot.class);slot.sender=allocate(Sender.class);slot.sender.valid=true;slot.type=i==0||(i==3&&!wrongScreenAudioType)?MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO:MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO;last.add(slot);}}
            catch(Exception error){throw new AssertionError(error);}
            return new ArrayList<RtpTransceiver>(last);
        }
        @Override public void close(){}
        @Override public void dispose(){disposed=true;if(last!=null)for(Slot slot:last)slot.dispose();}
        @Override public void setLocalDescription(SdpObserver observer,SessionDescription description){throw new AssertionError("A removed peer touched its disposed native connection");}
    }
    private static final class MediaFixture implements AutoCloseable {
        final RoomService service=new RoomService();final Queue queue=new Queue();final CommunicationMedia media=allocate(CommunicationMedia.class);
        final Class<?> peerType=Class.forName("com.nexusroom.android.CommunicationMedia$Peer");final Object peer;final NativeSnapshot pc=allocate(NativeSnapshot.class);
        final Map<String,Object> peers=new LinkedHashMap<>();
        MediaFixture()throws Exception{
            pc.count=4;set(media,"work",queue);set(media,"service",service);set(media,"sessionId","fixture-session");set(media,"selfId","self");set(media,"peers",peers);set(media,"videos",new LinkedHashMap<>());set(media,"sinks",new IdentityHashMap<>());set(media,"names",new LinkedHashMap<>());set(media,"audio",allocate(RecordingAudioManager.class));media.status="unchanged";
            Constructor<?> constructor=peerType.getDeclaredConstructor(CommunicationMedia.class,String.class);constructor.setAccessible(true);peer=constructor.newInstance(media,"departed");set(peer,"pc",pc);peers.put("departed",peer);
        }
        void configure()throws Exception{method(CommunicationMedia.class,"configureTransceivers",peerType,boolean.class).invoke(media,peer,false);}
        void sendTracks()throws Exception{method(CommunicationMedia.class,"tracks",peerType).invoke(media,peer);}
        void remove()throws Exception{method(CommunicationMedia.class,"removePeer",String.class).invoke(media,"departed");}
        PeerConnection.Observer observer(){return (PeerConnection.Observer)peer;}
        public void close(){queue.shutdown();service.fileWork.shutdownNow();service.commands.shutdownNow();service.discoveryWork.shutdownNow();}
    }
    private static void mediaChecks()throws Exception{
        try(MediaFixture fixture=new MediaFixture()){
            Slot camera=allocate(Slot.class),screen=allocate(Slot.class);
            camera.mid="1";screen.mid="2";camera.receiver=allocate(Receiver.class);screen.receiver=allocate(Receiver.class);
            camera.receiver.value=allocate(VideoTrack.class);screen.receiver.value=allocate(VideoTrack.class);
            MediaStream[] streams={allocate(BrowserStream.class)};
            // Real browser offers use UUID stream IDs. Both native callbacks
            // fire even for the negotiated, inactive screen receiver.
            for(boolean legacyFirst:new boolean[]{true,false}){
                for(Slot slot:new Slot[]{camera,screen}){
                    if(legacyFirst)fixture.observer().onAddTrack(slot.receiver,streams);
                    fixture.observer().onTrack(slot);
                    if(!legacyFirst)fixture.observer().onAddTrack(slot.receiver,streams);
                }
                fixture.queue.drain();
                Map<?,?> videos=(Map<?,?>)get(fixture.media,"videos");
                check(((CommunicationMedia.Video)videos.get("departed:camera")).track==camera.receiver.value,"Legacy screen callback overwrote the browser camera renderer");
                check(((CommunicationMedia.Video)videos.get("departed:screen")).track==screen.receiver.value,"Screen receiver lost its Unified Plan slot");
            }
            pass("browser UUID streams and either native callback order keep camera and screen receivers separate");
        }
        try(MediaFixture fixture=new MediaFixture()){
            fixture.configure();fixture.sendTracks();
            List<?> senders=(List<?>)get(fixture.peer,"senders");check(senders.size()==4,"Unified Plan lost a sender");for(int i=0;i<senders.size();i++){Sender sender=(Sender)senders.get(i);check(sender.valid&&sender.tracks==(i==3?0:1),"A negotiated sender cannot safely replace its track");}pass("answerer retains all four native slots; Android screen audio stays independent of microphone sender");
        }
        try(MediaFixture fixture=new MediaFixture()){
            fixture.pc.count=3;boolean rejected=false;try{fixture.configure();}catch(java.lang.reflect.InvocationTargetException error){rejected=error.getCause() instanceof IllegalStateException;}
            check(rejected,"Incomplete media slots were accepted");pass("invalid remote slot layout fails before storing disposed or missing senders");
        }
        try(MediaFixture fixture=new MediaFixture()){
            fixture.pc.wrongScreenAudioType=true;boolean rejected=false;try{fixture.configure();}catch(java.lang.reflect.InvocationTargetException error){rejected=error.getCause() instanceof IllegalStateException;}
            check(rejected,"Video offered in the shared-audio slot was accepted");pass("fourth slot must be audio before adopting any native senders");
        }
        try(MediaFixture fixture=new MediaFixture()){
            fixture.remove();check(fixture.pc.disposed,"Production removePeer did not dispose its connection");
            MeetingScreenAudioPlayer player=(MeetingScreenAudioPlayer)get(fixture.peer,"screenAudioPlayer");check((boolean)get(player,"closed"),"Removed participant kept its shared-audio player alive");
            fixture.observer().onTrack(null);fixture.observer().onAddTrack(null,new MediaStream[0]);fixture.observer().onConnectionChange(PeerConnection.PeerConnectionState.CONNECTED);
            SdpObserver sdp=(SdpObserver)method(fixture.peerType,"description",String.class).invoke(fixture.peer,"answer");sdp.onCreateSuccess(new SessionDescription(SessionDescription.Type.ANSWER,"v=0\r\n"));sdp.onCreateFailure("late create");sdp.onSetFailure("late set");fixture.queue.drain();
            check(fixture.media.status.equals("unchanged")&&((Map<?,?>)get(fixture.media,"videos")).isEmpty(),"A removed peer's late callback revived video or overwrote current status");pass("removed native peer ignores late track, connection, SDP success and failure callbacks");
        }
        try(MediaFixture fixture=new MediaFixture()){
            fixture.observer().onConnectionChange(PeerConnection.PeerConnectionState.CONNECTED);fixture.queue.drain();check(fixture.media.status.equals("加密媒体已连接"),"Current peer callback was incorrectly dropped");
            fixture.media.status="closed";fixture.media.closed=true;fixture.observer().onTrack(null);fixture.observer().onConnectionChange(PeerConnection.PeerConnectionState.FAILED);fixture.queue.drain();check(fixture.media.status.equals("closed"),"Closed session accepted a late callback");pass("current peer callbacks run and closed sessions ignore further native events");
        }
        try(MediaFixture previous=new MediaFixture();MediaFixture next=new MediaFixture()){
            RecordingAudioManager audio=allocate(RecordingAudioManager.class);audio.mode=AudioManager.MODE_NORMAL;set(previous.media,"audio",audio);set(next.media,"audio",audio);set(next.media,"work",previous.queue);
            Method acquire=method(CommunicationMedia.class,"acquireAudioRoute");acquire.invoke(previous.media);check(audio.mode==AudioManager.MODE_IN_COMMUNICATION,"First session did not acquire audio mode");
            previous.media.close();previous.queue.execute(()->{try{acquire.invoke(next.media);}catch(Exception error){throw new AssertionError(error);}});previous.queue.drain();
            check(audio.mode==AudioManager.MODE_IN_COMMUNICATION,"New session did not reacquire audio after cleanup");next.media.close();previous.queue.drain();
            check(audio.mode==AudioManager.MODE_NORMAL,"Consecutive sessions restored the previous call's communication mode instead of the original system mode");pass("consecutive native media lifecycles restore the original system audio mode");
        }
        try(MediaFixture fixture=new MediaFixture()){
            method(CommunicationMedia.class,"configureVoiceProcessing").invoke(fixture.media);
            fixture.media.screen=true;fixture.media.screenAudio=true;fixture.media.microphone=false;
            method(CommunicationMedia.class,"stopScreenNow").invoke(fixture.media);
            check(!fixture.media.screen&&!fixture.media.screenAudio&&!fixture.media.microphone,"Stopping shared playback changed microphone consent or left sound enabled");
            fixture.media.screen=true;fixture.media.screenAudio=true;fixture.media.close();fixture.queue.drain();
            check(fixture.media.closed&&!fixture.media.screen&&!fixture.media.screenAudio,"Session cleanup left screen sound active");pass("screen stop and session close clear shared sound independently; absent audio SDK state is safe");
        }
    }
    private static ByteBuffer soundPacket(short sample){ByteBuffer bytes=ByteBuffer.allocate(8+MeetingScreenAudio.PACKET_BYTES).order(ByteOrder.BIG_ENDIAN);bytes.putInt(0x4e524131).putInt(MeetingScreenAudio.RATE);bytes.order(ByteOrder.LITTLE_ENDIAN);for(int i=0;i<MeetingScreenAudio.PACKET_BYTES/2;i++)bytes.putShort(sample);bytes.flip();return bytes;}
    private static void sharedAudioChecks()throws Exception{
        MeetingScreenAudioPlayer player=new MeetingScreenAudioPlayer();
        // Exercise production decoder, gate and bounded queue without starting
        // framework AudioTrack. Real device playback is checked separately.
        set(player,"thread",new Thread());
        check(!player.packet(soundPacket((short)16000)),"Unannounced participant audio was played");player.setEnabled(true);
        check(!player.packet(ByteBuffer.allocate(7)),"Truncated shared-audio header was accepted");
        ByteBuffer wrongRate=soundPacket((short)16000);wrongRate.order(ByteOrder.BIG_ENDIAN).putInt(4,44100);check(!player.packet(wrongRate),"Unexpected playback sample rate was accepted");
        ByteBuffer wrongMagic=soundPacket((short)16000);wrongMagic.put(0,(byte)0);check(!player.packet(wrongMagic),"Unknown shared-audio protocol was accepted");
        check(!player.packet(ByteBuffer.allocate(8+MeetingScreenAudio.PACKET_BYTES+2)),"Oversized shared-audio PCM was accepted");
        for(int i=0;i<20;i++)check(player.packet(soundPacket((short)16384)),"A valid sound packet was rejected");
        check(((ArrayBlockingQueue<?>)get(player,"pending")).size()==3,"Slow sound playback accumulated unbounded latency");check(Math.abs(player.rms()-0.5)<0.00001,"PCM16 little-endian RMS measurement is incorrect");
        player.setEnabled(false);check(((ArrayBlockingQueue<?>)get(player,"pending")).isEmpty()&&!player.packet(soundPacket((short)16000)),"Disabling shared audio left pending audio or accepted another packet");
        player.close();player.setEnabled(true);check(!player.packet(soundPacket((short)16000)),"Closed participant playback was revived");pass("shared audio rejects malformed/unauthorized PCM, bounds latency, measures samples, and flushes on disable/close");
    }
    private static final class CaptureRecord extends android.media.AudioRecord {
        boolean released;int starts;
        CaptureRecord(){super(0,48000,16,2,1920);}
        @Override public void startRecording(){starts++;}
        @Override public void stop(){}
        @Override public void release(){released=true;}
    }
    private static void capturePermissionChecks()throws Exception{
        android.content.Context denied=new android.content.ContextWrapper(null){@Override public int checkSelfPermission(String permission){return android.content.pm.PackageManager.PERMISSION_DENIED;}};
        boolean rejected=false;try{new MeetingScreenAudio(denied,null,packet->{},error->{});}catch(SecurityException expected){rejected=true;}
        check(rejected,"Shared audio constructed AudioRecord without current recording consent");
        MeetingScreenAudio revoked=allocate(MeetingScreenAudio.class);CaptureRecord record=allocate(CaptureRecord.class);set(revoked,"context",denied);set(revoked,"record",record);
        rejected=false;try{revoked.start();}catch(SecurityException expected){rejected=true;}
        check(rejected&&record.starts==0&&record.released&&(boolean)get(revoked,"closed"),"Permission revoked before capture did not prevent start and release recording resources");
        pass("playback capture requires current recording consent and releases resources when permission is revoked before start");
    }
    private static final class Socket implements WebSocket {
        final Request request;final WebSocketListener listener;boolean cancelled;
        Socket(Request request,WebSocketListener listener){this.request=request;this.listener=listener;}
        void open(){listener.onOpen(this,new Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(101).message("fixture").build());}
        public Request request(){return request;}public long queueSize(){return 0;}public boolean send(String text){return !cancelled;}public boolean send(ByteString bytes){return !cancelled;}public boolean close(int code,String reason){cancelled=true;return true;}public void cancel(){cancelled=true;}
    }
    private static final class Transport extends OkHttpClient {
        Socket socket;volatile Call pending;final CountDownLatch started=new CountDownLatch(1),reply=new CountDownLatch(1);final AtomicInteger executions=new AtomicInteger();
        @Override public WebSocket newWebSocket(Request request,WebSocketListener listener){socket=new Socket(request,listener);return socket;}
        @Override public Call newCall(Request request){
            Call call=new Call(){volatile boolean cancelled,executed;public Request request(){return request;}public Response execute()throws IOException{executed=true;executions.incrementAndGet();started.countDown();try{if(!reply.await(2,TimeUnit.SECONDS))throw new IOException("fixture timeout");}catch(InterruptedException error){throw new IOException(error);}if(cancelled)throw new IOException("cancelled");return new Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("fixture").body(ResponseBody.create("{}",null)).build();}public void enqueue(Callback callback){throw new UnsupportedOperationException();}public void cancel(){cancelled=true;}public boolean isExecuted(){return executed;}public boolean isCanceled(){return cancelled;}public Timeout timeout(){return Timeout.NONE;}public Call clone(){return Transport.this.newCall(request);}};
            if(pending==null)pending=call;return call;
        }
    }
    private static void requestChecks()throws Exception{
        RoomService service=new RoomService();RoomConfig config=new RoomConfig();config.server="https://127.0.0.1:17891";config.fingerprint="a".repeat(64);config.deviceId="fixture";config.roomId="123456";config.token="fixture-token";
        RoomService.RoomLink link=service.new RoomLink(config);Transport transport=new Transport();link.client=transport;link.online=true;service.links.put(config.deviceId,link);CommunicationClient client=link.communication;
        try{
            client.connect();Socket original=transport.socket;original.open();client.action("/calls",new JSONObject().put("targetId","target"),null);check(transport.started.await(2,TimeUnit.SECONDS),"Production communication request did not execute");
            client.action("/calls",new JSONObject().put("targetId","queued-target"),null);client.disconnect();check(transport.pending.isCanceled(),"Disconnect did not cancel the in-flight HTTP request");client.connect();transport.socket.open();transport.reply.countDown();
            ((ExecutorService)get(client,"requests")).submit(()->{}).get(2,TimeUnit.SECONDS);check(transport.executions.get()==1,"A queued old-generation call executed after reconnection");pass("communication disconnect cancels in-flight HTTP and rejects queued stale mutations");
            original.listener.onFailure(original,new IOException("late old socket"),null);check(client.online&&!transport.socket.cancelled,"A late old socket failure disconnected the new channel");client.close();client.action("/calls",new JSONObject(),null);pass("old socket failure preserves reconnection and actions after executor close are safe");
        }finally{transport.reply.countDown();link.close();service.fileWork.shutdownNow();service.commands.shutdownNow();service.discoveryWork.shutdownNow();transport.dispatcher().executorService().shutdownNow();}
    }
    public static void main(String[] arguments)throws Exception{mediaChecks();sharedAudioChecks();capturePermissionChecks();requestChecks();System.out.println(passed+" production communication lifecycle checks passed");}
}
