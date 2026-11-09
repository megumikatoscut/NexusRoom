package com.nexusroom.android;

import android.os.SystemClock;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/** Room-authenticated signaling. It never uses or acquires the remote-control lease. */
final class CommunicationClient {
    interface Result { void complete(JSONObject result, String error); }
    final RoomService service;
    final RoomService.RoomLink link;
    private final ExecutorService requests = Executors.newSingleThreadExecutor();
    private volatile WebSocket socket;
    private volatile boolean closed, connecting;
    volatile boolean online;
    volatile JSONObject state = new JSONObject();
    volatile String status = "通信连接中";
    private volatile int generation;
    private volatile long lastPong, lastPing, retryAt;
    private Call activeRequest;

    CommunicationClient(RoomService service, RoomService.RoomLink link) { this.service=service; this.link=link; }

    synchronized void connect() {
        if(closed || connecting || online || !link.online || link.config.leaving)return;
        connecting=true;
        int attempt=++generation;
        lastPong=SystemClock.elapsedRealtime();
        socket=link.client.newWebSocket(link.request("/device/communication/ws").build(),new WebSocketListener(){
            private boolean current(WebSocket source) { return !closed && attempt==generation && source==socket; }
            @Override public void onOpen(WebSocket source, Response response) {
                synchronized(CommunicationClient.this){if(!current(source)){source.cancel();return;}connecting=false;online=true;lastPong=SystemClock.elapsedRealtime();lastPing=0;status="房间通信在线";}
                service.handler.post(()->RoomService.changed(service));
            }
            @Override public void onMessage(WebSocket source,String raw) {
                if(!current(source))return;
                try {
                    JSONObject message=new JSONObject(raw);
                    String type=message.optString("type");
                    lastPong=SystemClock.elapsedRealtime();
                    service.handler.post(()->{
                        if(!current(source))return;
                        if(type.equals("state")) {
                            JSONObject next=message.optJSONObject("state");
                            if(next!=null){state=next;service.communicationUpdated(CommunicationClient.this);}
                        } else if(type.equals("signal"))service.communicationSignal(CommunicationClient.this,message);
                        else if(type.equals("error")){status=message.optString("message","通信请求失败");RoomService.changed(service);}
                    });
                }catch(Exception ignored){}
            }
            @Override public void onFailure(WebSocket source,Throwable error,Response response) { if(current(source))disconnect(); }
            @Override public void onClosing(WebSocket source,int code,String reason) { source.close(code,reason);if(current(source))disconnect(); }
            @Override public void onClosed(WebSocket source,int code,String reason) { if(current(source))disconnect(); }
        });
    }
    void tick() {
        long now=SystemClock.elapsedRealtime();
        if(closed)return;
        if((online||connecting)&&now-lastPong>40000)disconnect();
        if(online&&now-lastPing>15000){lastPing=now;try{send(new JSONObject().put("type","ping"));}catch(Exception ignored){}}
        if(!online&&!connecting&&link.online&&now>retryAt)connect();
    }
    synchronized void disconnect() {
        int ended=++generation;online=false;connecting=false;retryAt=SystemClock.elapsedRealtime()+3000;
        WebSocket previous=socket;socket=null;if(previous!=null)previous.cancel();
        if(activeRequest!=null)activeRequest.cancel();
        state=new JSONObject();status="通信已断开，正在重连";
        service.handler.post(()->{if(generation!=ended)return;service.communicationDisconnected(this);RoomService.changed(service);});
    }
    synchronized void close() { if(closed)return;closed=true;disconnect();requests.shutdownNow(); }
    boolean send(JSONObject message) { WebSocket current=socket;return online&&current!=null&&current.send(message.toString()); }
    void signal(String sessionId,String targetId,JSONObject signal) {
        try{send(new JSONObject().put("type","signal").put("sessionId",sessionId).put("targetId",targetId).put("signal",signal));}catch(Exception ignored){}
    }
    private boolean requestCurrent(int attempt) {
        return !closed&&attempt==generation&&online&&link.online&&!link.config.leaving
            &&service.links.get(link.config.deviceId)==link;
    }
    private JSONObject request(String path,JSONObject body,int attempt)throws Exception {
        Call call=link.client.newCall(link.request("/device/communication"+path)
            .post(RequestBody.create(body.toString(),MediaType.get("application/json"))).build());
        synchronized(this){if(!requestCurrent(attempt))throw new Exception("通信连接已变更，请重试");activeRequest=call;}
        try(Response response=call.execute()) {
            String raw=response.body()==null?"{}":response.body().string();
            JSONObject result=new JSONObject(raw);
            if(!response.isSuccessful())throw new Exception(result.optString("title",result.optString("message","请求失败（"+response.code()+"）")));
            return result;
        }finally{synchronized(this){if(activeRequest==call)activeRequest=null;}}
    }
    synchronized void action(String path,JSONObject body,Result callback) {
        int attempt=generation;
        if(!requestCurrent(attempt)){complete(callback,null,"房间通信连接已结束",attempt);return;}
        try{requests.execute(()->{
                JSONObject value=null;String error="";
                try{value=request(path,body,attempt);}catch(Exception e){error=e.getMessage()==null?"通信请求失败":e.getMessage();}
                complete(callback,value,error,attempt);
            });
        }catch(RejectedExecutionException ignored){complete(callback,null,"房间通信连接已结束",attempt);}
    }
    private void complete(Result callback,JSONObject result,String error,int attempt) {
        if(callback==null)return;
        service.handler.post(()->{
            if(requestCurrent(attempt))callback.complete(result,error);
            else callback.complete(null,"通信连接已变更，请重试");
        });
    }
    void media(String sessionId,boolean mic,boolean camera,boolean screen,boolean screenAudio) {
        try{action("/sessions/"+sessionId+"/media",new JSONObject().put("microphone",mic).put("camera",camera).put("screen",screen).put("screenAudio",screen&&screenAudio),null);}catch(Exception ignored){}
    }
}
