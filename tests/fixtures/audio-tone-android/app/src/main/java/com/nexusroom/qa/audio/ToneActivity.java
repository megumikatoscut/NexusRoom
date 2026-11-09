package com.nexusroom.qa.audio;

import android.app.Activity;
import android.os.Bundle;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.widget.TextView;

// Separate UID and explicit MEDIA capture permission: this fixture distinguishes
// real playback capture from mic/RTP counters, and is never included in the app.
public final class ToneActivity extends Activity {
    private AudioTrack track;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        TextView label = new TextView(this); label.setText("NexusRoom QA · 887 Hz media tone"); label.setTextSize(20); setContentView(label);
        short[] samples = new short[48000];
        for (int i=0;i<samples.length;i++) samples[i]=(short)(Math.sin(2*Math.PI*887*i/48000)*3000);
        track = new AudioTrack.Builder().setAudioAttributes(new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
            .setAllowedCapturePolicy(AudioAttributes.ALLOW_CAPTURE_BY_ALL).build())
            .setAudioFormat(new AudioFormat.Builder().setSampleRate(48000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setTransferMode(AudioTrack.MODE_STATIC).setBufferSizeInBytes(samples.length*2).build();
        track.write(samples,0,samples.length); track.setLoopPoints(0,samples.length,-1); track.play();
    }
    @Override public void onDestroy() { if(track!=null){track.stop();track.release();track=null;} super.onDestroy(); }
}
