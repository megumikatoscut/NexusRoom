package android.media;

/** JVM test only. Keeping this fixture in AudioManager's package permits its
 * package-private platform constructor; Unsafe skips that constructor at run time. */
public final class RecordingAudioManager extends AudioManager {
    public int mode;
    public boolean speaker;
    public RecordingAudioManager(){super();}
    @Override public int getMode(){return mode;}
    @Override public void setMode(int value){mode=value;}
    @Override public boolean isSpeakerphoneOn(){return speaker;}
    @Override public void setSpeakerphoneOn(boolean value){speaker=value;}
    @Override public void clearCommunicationDevice(){}
}
