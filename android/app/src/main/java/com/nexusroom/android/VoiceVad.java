package com.nexusroom.android;

/** Offline, adaptive energy VAD. It supplements the transducer's endpoint rules. */
final class VoiceVad {
    static final int SAMPLE_RATE = 16000;
    private double noise = 0.002;
    private long samples, lastSpeech;
    private int speechFrames;
    void reset() { samples=lastSpeech=0; speechFrames=0; }
    boolean accept(float[] pcm) {
        double sum=0;for(float value:pcm)sum+=value*value;
        double rms=Math.sqrt(sum/Math.max(1,pcm.length));
        boolean voice=rms>Math.max(0.006,noise*3.0);
        samples+=pcm.length;
        if(voice){lastSpeech=samples;speechFrames++;}
        else if(speechFrames==0)noise=noise*.96+Math.min(rms,.009)*.04;
        return voice;
    }
    boolean hasSpeech(){return speechFrames>=5;}
    boolean ended(){return hasSpeech()&&samples-lastSpeech>=SAMPLE_RATE*1.1;}
    boolean timedOut(){return samples>=SAMPLE_RATE*(hasSpeech()?25:7);}
    static String stripWakeWord(String text){return text.trim().replaceFirst("(?i)^[\\p{P}\\s]*(?:(?:hi|high|hey|嗨|嘿|海)[\\p{P}\\s]*)?(?:nexus|next\\s*(?:is|us)|尼克萨斯|奈克萨斯|内克萨斯)[\\p{P}\\s]*","").trim();}
}
