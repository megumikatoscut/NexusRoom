package com.nexusroom.android;
import android.app.Activity;
import android.os.Bundle;
import android.media.*;
import android.widget.TextView;

/** Debug APK only: a deterministic media source for playback capture verification. */
public final class AudioFixtureActivity extends Activity {
 private volatile boolean running;private AudioTrack track;private Thread worker;
 @Override public void onCreate(Bundle state){super.onCreate(state);TextView text=new TextView(this);text.setText("NexusRoom QA · 440 Hz 媒体音频\n返回即可停止。仅用于联调，不包含在发布包。");text.setTextSize(24);text.setPadding(40,60,40,40);setContentView(text);
  track=new AudioTrack.Builder().setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).setAllowedCapturePolicy(AudioAttributes.ALLOW_CAPTURE_BY_ALL).build()).setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(48000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build()).setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(19200).build();running=true;track.play();worker=new Thread(()->{short[] block=new short[4800];long sample=0;while(running){for(int i=0;i<block.length;i++)block[i]=(short)(7000*Math.sin(2*Math.PI*440*(sample++)/48000));track.write(block,0,block.length);}},"QA Tone");worker.start();
 }
 @Override protected void onDestroy(){running=false;try{track.stop();worker.join(500);}catch(Exception ignored){}track.release();super.onDestroy();}
}
