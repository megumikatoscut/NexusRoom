package com.nexusroom.android;

public final class VoiceVadTest {
    private static void require(boolean value,String label){if(!value)throw new AssertionError(label);}
    public static void main(String[] args){
        VoiceVad vad=new VoiceVad();float[] quiet=new float[320],speech=new float[320];for(int i=0;i<320;i++)speech[i]=(float)(.1*Math.sin(i*.2));
        for(int i=0;i<340;i++)vad.accept(quiet);require(!vad.hasSpeech(),"silence must not become speech");require(!vad.ended(),"silence must not produce command endpoint");require(!vad.timedOut(),"before no-speech timeout");
        for(int i=0;i<10;i++)vad.accept(quiet);require(vad.timedOut(),"7-second no-speech timeout");
        vad.reset();for(int i=0;i<20;i++)vad.accept(speech);require(vad.hasSpeech(),"speech detected");for(int i=0;i<54;i++)vad.accept(quiet);require(!vad.ended(),"silence shorter than 1.1 seconds");vad.accept(quiet);require(vad.ended(),"speech endpoint after 1.1 seconds");
        require(VoiceVad.stripWakeWord("Hi Nexus, 打开电脑文档").equals("打开电脑文档"),"wake prefix stripped");require(VoiceVad.stripWakeWord("打开手机相册").equals("打开手机相册"),"unrelated prefix retained");
        require(VoiceVad.stripWakeWord("HIGH NEXT IS ON THIS COMPUTER").equals("ON THIS COMPUTER"),"recognized phonetic wake stripped");require(VoiceVad.stripWakeWord("NEXUS 打开手机相册").equals("打开手机相册"),"standalone wake tail stripped");
        System.out.println("PASS VoiceVad: silence, speech endpoint, timeout, wake prefix");
    }
}
