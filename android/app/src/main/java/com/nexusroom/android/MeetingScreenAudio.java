package com.nexusroom.android;

import android.content.Context;
import android.Manifest;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.os.Process;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.function.Consumer;

/** Explicit MediaProjection playback consent, independent of the microphone. */
final class MeetingScreenAudio implements AutoCloseable {
    static final int RATE=48000,PACKET_BYTES=1920;
    private final AudioRecord record;
    private final Context context;
    private final Consumer<byte[]> packets;
    private final Consumer<String> failure;
    private volatile boolean closed;
    private volatile double rms;
    private volatile long capturedPackets;
    private Thread reader;

    MeetingScreenAudio(Context context,MediaProjection projection,Consumer<byte[]> packets,Consumer<String> failure) {
        this.context=context;this.packets=packets;this.failure=failure;
        if(context.checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED)
            throw new SecurityException("共享设备声音需要录音权限");
        // Never send received meeting audio or another NexusRoom playback back
        // into the room. Only applications permitting media/game capture enter.
        AudioPlaybackCaptureConfiguration capture=new AudioPlaybackCaptureConfiguration.Builder(projection)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA).addMatchingUsage(AudioAttributes.USAGE_GAME)
            .excludeUid(Process.myUid()).build();
        AudioFormat format=new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_IN_MONO).build();
        int minimum=AudioRecord.getMinBufferSize(RATE,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT);
        try{record=new AudioRecord.Builder().setAudioFormat(format).setAudioPlaybackCaptureConfig(capture)
            .setBufferSizeInBytes(Math.max(PACKET_BYTES*4,minimum)).build();}
        catch(SecurityException revoked){throw new IllegalStateException("录音权限已被系统撤销，请重新允许共享设备声音",revoked);}
    }
    void start(){
        try {
            if(context.checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED)
                throw new SecurityException("录音权限已被系统撤销，请重新允许共享设备声音");
            if(record.getState()!=AudioRecord.STATE_INITIALIZED)throw new IllegalStateException("系统不支持播放声音捕获");
            record.startRecording();
            if(record.getRecordingState()!=AudioRecord.RECORDSTATE_RECORDING)throw new IllegalStateException("播放声音捕获未开始");
            reader=new Thread(()->{
                Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO);
                byte[] pcm=new byte[PACKET_BYTES];int used=0;
                try{while(!closed){int read=record.read(pcm,used,pcm.length-used,AudioRecord.READ_BLOCKING);if(closed)break;if(read<0)throw new IllegalStateException("录音设备错误 "+read);if(read==0)continue;used+=read;if(used==pcm.length){double power=0;for(int i=0;i<pcm.length;i+=2){short sample=(short)((pcm[i]&255)|(pcm[i+1]<<8));power+=(double)sample*sample;}rms=Math.sqrt(power/(pcm.length/2))/32768.0;capturedPackets++;ByteBuffer packet=ByteBuffer.allocate(8+pcm.length).order(ByteOrder.BIG_ENDIAN);packet.putInt(0x4e524131).putInt(RATE).put(pcm);packets.accept(packet.array());used=0;}}}
                catch(Exception error){if(!closed)failure.accept(error.getMessage()==null?"系统停止声音捕获":error.getMessage());}
            },"NexusRoom-MeetingPlaybackCapture");reader.setDaemon(true);reader.start();
        }catch(RuntimeException error){close();throw error;}
    }
    double rms(){return rms;}
    long capturedPackets(){return capturedPackets;}
    @Override public synchronized void close(){
        if(closed)return;closed=true;
        try{record.stop();}catch(IllegalStateException ignored){}
        if(reader!=null&&reader!=Thread.currentThread())try{reader.join(500);}catch(InterruptedException error){Thread.currentThread().interrupt();}
        record.release();
    }
}
