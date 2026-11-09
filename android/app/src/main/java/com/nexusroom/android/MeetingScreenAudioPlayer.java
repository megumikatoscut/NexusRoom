package com.nexusroom.android;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

/** Bounded, low latency PCM playback for another Android participant. */
final class MeetingScreenAudioPlayer implements AutoCloseable {
    private static final class Packet { final byte[] pcm;final long at=SystemClock.elapsedRealtime();Packet(byte[] pcm){this.pcm=pcm;} }
    private final ArrayBlockingQueue<Packet> pending=new ArrayBlockingQueue<>(3);
    private volatile boolean enabled,closed;
    private volatile AudioTrack output;
    private Thread thread;
    private volatile long receivedBytes;
    private volatile double rms;
    synchronized void setEnabled(boolean value){enabled=value;if(!value){pending.clear();AudioTrack current=output;if(current!=null)try{current.setVolume(0);current.pause();current.flush();}catch(IllegalStateException ignored){}}}
    synchronized boolean packet(ByteBuffer incoming){
        if(closed||!enabled)return false;
        ByteBuffer data=incoming.duplicate().order(ByteOrder.BIG_ENDIAN);
        if(data.remaining()!=8+MeetingScreenAudio.PACKET_BYTES||data.getInt()!=0x4e524131||data.getInt()!=MeetingScreenAudio.RATE)return false;
        byte[] pcm=new byte[data.remaining()];data.get(pcm);Packet packet=new Packet(pcm);
        double power=0;for(int i=0;i<pcm.length;i+=2){short sample=(short)((pcm[i]&255)|(pcm[i+1]<<8));power+=(double)sample*sample;}rms=Math.sqrt(power/(pcm.length/2))/32768.0;
        if(!pending.offer(packet)){pending.poll();pending.offer(packet);}
        receivedBytes+=pcm.length;
        if(thread==null){thread=new Thread(this::play,"NexusRoom-MeetingSharedAudio");thread.setDaemon(true);thread.start();}
        return true;
    }
    long receivedBytes(){return receivedBytes;}
    double rms(){return rms;}
    private void play(){
        Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO);
        try{
            AudioAttributes attributes=new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).setAllowedCapturePolicy(AudioAttributes.ALLOW_CAPTURE_BY_NONE).build();
            int minimum=AudioTrack.getMinBufferSize(MeetingScreenAudio.RATE,AudioFormat.CHANNEL_OUT_MONO,AudioFormat.ENCODING_PCM_16BIT);
            AudioTrack track=new AudioTrack.Builder().setAudioAttributes(attributes).setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(MeetingScreenAudio.RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build()).setBufferSizeInBytes(Math.max(minimum,MeetingScreenAudio.PACKET_BYTES*2)).setTransferMode(AudioTrack.MODE_STREAM).build();
            output=track;
            while(!closed){Packet packet=pending.poll(100,TimeUnit.MILLISECONDS);if(packet==null||!enabled||SystemClock.elapsedRealtime()-packet.at>100)continue;track.setVolume(1);if(track.getPlayState()!=AudioTrack.PLAYSTATE_PLAYING)track.play();int offset=0;while(!closed&&enabled&&offset<packet.pcm.length){int written=track.write(packet.pcm,offset,packet.pcm.length-offset,AudioTrack.WRITE_NON_BLOCKING);if(written<0)throw new IllegalStateException("共享声音播放错误 "+written);if(written==0)break;offset+=written;}}
        }catch(InterruptedException ignored){Thread.currentThread().interrupt();}catch(RuntimeException error){Log.w("NexusRoom.RTC","Shared audio playback stopped",error);}
        finally{AudioTrack current=output;output=null;if(current!=null)try{current.pause();current.flush();current.release();}catch(IllegalStateException ignored){}}
    }
    @Override public void close(){Thread worker;synchronized(this){if(closed)return;closed=true;enabled=false;pending.clear();worker=thread;}if(worker!=null){worker.interrupt();try{worker.join(500);}catch(InterruptedException error){Thread.currentThread().interrupt();}}}
}
