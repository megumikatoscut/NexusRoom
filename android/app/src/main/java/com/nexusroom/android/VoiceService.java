package com.nexusroom.android;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;

/** Started only by an explicit action while MainActivity is foreground. Never sticky. */
public final class VoiceService extends Service {
    static volatile VoiceService instance;
    private static final int NOTIFICATION=701;
    @Override public void onCreate(){super.onCreate();instance=this;
        VoiceController voice=VoiceController.get(this);
        if(!voice.hasBackgroundPermissions()||!voice.backgroundEnabled()){stopSelf();return;}
        NotificationManager manager=getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("nexusroom-voice","离线语音唤醒",NotificationManager.IMPORTANCE_LOW));
        try{startForeground(NOTIFICATION,notification("正在本地监听 Hi Nexus"),Build.VERSION.SDK_INT>=30?ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE:0);voice.backgroundStarted();}
        catch(RuntimeException e){voice.background(false);stopSelf();}
    }
    @Override public int onStartCommand(Intent intent,int flags,int startId){if(intent!=null&&"stop".equals(intent.getAction())){VoiceController.get(this).stopFromNotification();stopSelf();}return START_NOT_STICKY;}
    private Notification notification(String message){
        VoiceController voice=VoiceController.get(this);
        PendingIntent open=PendingIntent.getActivity(this,701,voice.openIntent(),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop=PendingIntent.getService(this,702,new Intent(this,VoiceService.class).setAction("stop"),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this,"nexusroom-voice").setSmallIcon(R.drawable.ic_nexus).setContentTitle("NexusRoom · 离线语音").setContentText(message).setContentIntent(open).setOngoing(true).addAction(new Notification.Action.Builder(null,"停止监听",stop).build()).build();
    }
    void status(String message){try{getSystemService(NotificationManager.class).notify(NOTIFICATION,notification(message));}catch(SecurityException ignored){}}
    @Override public void onDestroy(){instance=null;VoiceController.get(this).backgroundStopped();super.onDestroy();}
    @Override public IBinder onBind(Intent intent){return null;}
}
