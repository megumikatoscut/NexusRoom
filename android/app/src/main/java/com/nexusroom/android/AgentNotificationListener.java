package com.nexusroom.android;

import android.app.Notification;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.text.TextUtils;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;

/** Optional system listener. It keeps a bounded metadata cache and never forwards notification attachments. */
public final class AgentNotificationListener extends NotificationListenerService {
    static volatile AgentNotificationListener instance;
    private static final Object LOCK=new Object();
    private static final ArrayDeque<Item> ITEMS=new ArrayDeque<>();
    @Override public void onListenerConnected(){synchronized(LOCK){ITEMS.clear();instance=this;}try{StatusBarNotification[] active=getActiveNotifications();if(active!=null)for(StatusBarNotification item:active)onNotificationPosted(item);}catch(Exception ignored){}}
    @Override public void onListenerDisconnected(){disconnect();}
    @Override public void onNotificationPosted(StatusBarNotification sbn){
        if(sbn==null||sbn.getNotification()==null)return;
        Notification n=sbn.getNotification();CharSequence title=n.extras.getCharSequence(Notification.EXTRA_TITLE),text=n.extras.getCharSequence(Notification.EXTRA_TEXT);
        synchronized(LOCK){
            if(instance!=this)return;
            String key=sbn.getKey();ITEMS.removeIf(item->item.key.equals(key));
            ITEMS.addFirst(new Item(key,sbn.getPackageName(),title==null?"":title.toString(),text==null?"":text.toString(),sbn.getPostTime(),(n.flags&Notification.FLAG_ONGOING_EVENT)!=0,n.category==null?"":n.category));
            while(ITEMS.size()>150)ITEMS.removeLast();
        }
    }
    @Override public void onNotificationRemoved(StatusBarNotification sbn){if(sbn==null)return;synchronized(LOCK){if(instance==this)ITEMS.removeIf(item->item.key.equals(sbn.getKey()));}}
    @Override public void onDestroy(){disconnect();super.onDestroy();}
    private void disconnect(){synchronized(LOCK){if(instance==this){instance=null;ITEMS.clear();}}}
    static JSONObject snapshot(JSONObject args)throws Exception {
        String query=args.optString("query","").trim().toLowerCase(Locale.ROOT),pkg=args.optString("packageName","").trim(),category=args.optString("category","").trim();long now=System.currentTimeMillis(),since=args.optLong("sinceTime",now-7L*86400000L),until=args.optLong("untilTime",now+60000L);boolean includeOngoing=args.optBoolean("includeOngoing",true);JSONArray out=new JSONArray();
        if(since<0||until<since||until>now+86400000L)throw new Exception("InvalidArguments: 通知时间范围无效");
        synchronized(LOCK){if(instance==null)throw new Exception("PermissionDenied: NexusRoom 通知读取服务已断开");for(Item item:ITEMS){if(item.time<since||item.time>until)continue;if(!includeOngoing&&item.ongoing)continue;if(!pkg.isEmpty()&&!pkg.equals(item.packageName))continue;if(!category.isEmpty()&&!category.equals(item.category))continue;String hay=(item.title+" "+item.text).toLowerCase(Locale.ROOT);if(!query.isEmpty()&&!hay.contains(query))continue;out.put(item.json());if(out.length()>=50)break;}}
        return new JSONObject().put("notifications",out).put("count",out.length()).put("source","NotificationListenerService");
    }
    private static final class Item {
        final String key,packageName,title,text,category;final long time;final boolean ongoing;
        Item(String k,String p,String t,String x,long time,boolean o){this(k,p,t,x,time,o,"");}
        Item(String k,String p,String t,String x,long time,boolean o,String c){key=k;packageName=p;title=clip(t);text=clip(x);this.time=time;ongoing=o;category=c;}
        JSONObject json()throws Exception{return new JSONObject().put("packageName",packageName).put("title",title).put("text",text).put("postedAt",time).put("ongoing",ongoing).put("category",category);}
        static String clip(String value){return value.length()<=1000?value:value.substring(0,1000)+"...";}
    }
}
