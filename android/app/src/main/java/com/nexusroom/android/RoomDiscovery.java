package com.nexusroom.android;

import android.content.Context;
import android.net.*;
import android.net.nsd.*;
import android.net.wifi.WifiManager;
import org.json.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;
import okhttp3.*;

final class RoomDiscovery {
 private static final long SEARCH_MS=7000;
 static final class TrustedServer {
  final String server,roomId,roomName,hostName;
  final Network network;
  TrustedServer(String server,Network network,JSONObject room){this.server=server;this.network=network;roomId=room.optString("roomId",room.optString("id"));roomName=room.optString("name");hostName=room.optString("hostName");}
 }
 private static final class Candidate {
  final String server,fingerprint;
  final Network network;
  Candidate(String server,String fingerprint,Network network){this.server=server;this.fingerprint=fingerprint;this.network=network;}
 }

 static void scan(Context context,Consumer<JSONObject> found,Runnable done){
  new Thread(()->{
   try(Discovery session=new Discovery(context,"",6500)){
    Candidate candidate;
    while((candidate=session.next())!=null){
     OkHttpClient client=null;
     try{
      RoomConfig identity=new RoomConfig();identity.server=candidate.server;identity.fingerprint=candidate.fingerprint;
      client=probeClient(identity,candidate.network);
      try(Response response=client.newCall(new Request.Builder().url(candidate.server+"/device/discovery").build()).execute()){
       if(!response.isSuccessful()||response.body()==null)continue;
       JSONArray rooms=new JSONArray(response.body().string());
       for(int n=0;n<Math.min(rooms.length(),32);n++){
        JSONObject room=rooms.getJSONObject(n);
        if(candidate.fingerprint.equalsIgnoreCase(room.optString("fingerprint"))&&room.optBoolean("open",true))found.accept(room.put("server",candidate.server));
       }
      }
     }catch(Exception ignored){}finally{dispose(client);}
    }
   }finally{done.run();}
  },"NexusRoomDiscovery").start();
 }

 // Advertisements only identify possible addresses. A saved room may move only
 // after its original certificate AND membership token authenticate that room.
 static TrustedServer findTrusted(Context context,RoomConfig saved){
  try(Discovery session=new Discovery(context,saved.fingerprint,SEARCH_MS)){
   Candidate candidate;
   while((candidate=session.next())!=null){
    TrustedServer trusted=verifyTrusted(saved,candidate.server,candidate.network);
    if(trusted!=null)return trusted;
   }
  }catch(Exception ignored){}
  return null;
 }

 static TrustedServer verifyTrusted(RoomConfig saved,String server,Network network){
  OkHttpClient client=null;
  try{
   RoomConfig identity=new RoomConfig();identity.server=server;identity.fingerprint=saved.fingerprint;
   client=probeClient(identity,network);
   try(Response response=client.newCall(new Request.Builder().url(server+"/device/room").header("Authorization","Bearer "+saved.token).build()).execute()){
    if(!response.isSuccessful()||response.body()==null)return null;
    JSONObject room=new JSONObject(response.body().string());
    String id=room.optString("roomId",room.optString("id"));
    if(id.isEmpty()||(!saved.roomId.isEmpty()&&!saved.roomId.equals(id)))return null;
    if(room.has("fingerprint")&&!saved.fingerprint.equalsIgnoreCase(room.optString("fingerprint")))return null;
    if(!room.optBoolean("hostOnline",false))return null;
    return new TrustedServer(server,network,room);
   }
  }catch(Exception ignored){return null;}finally{dispose(client);}
 }

 private static OkHttpClient probeClient(RoomConfig config,Network network)throws Exception{
  return config.client(network).newBuilder().connectTimeout(2,TimeUnit.SECONDS).readTimeout(2,TimeUnit.SECONDS).writeTimeout(2,TimeUnit.SECONDS).callTimeout(3,TimeUnit.SECONDS).build();
 }
 private static void dispose(OkHttpClient client){if(client!=null){client.dispatcher().cancelAll();client.connectionPool().evictAll();client.dispatcher().executorService().shutdown();}}

 static List<Network> lanNetworks(Context context){
  List<Network> networks=new ArrayList<>();
  ConnectivityManager manager=(ConnectivityManager)context.getSystemService(Context.CONNECTIVITY_SERVICE);
  if(manager==null)return networks;
  try{
   Network active=manager.getActiveNetwork();
   for(Network network:manager.getAllNetworks()){
    NetworkCapabilities capabilities=manager.getNetworkCapabilities(network);
    if(capabilities!=null&&(capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)||capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)))networks.add(network);
   }
   networks.sort(Comparator.comparingInt(network->network.equals(active)?0:1));
  }catch(SecurityException ignored){}
  return networks;
 }
 static Network preferredNetwork(Context context,String server){
  List<Network> networks=lanNetworks(context);
  ConnectivityManager manager=(ConnectivityManager)context.getSystemService(Context.CONNECTIVITY_SERVICE);
  try{
   InetAddress target=InetAddress.getByName(new URI(server).getHost());
   for(Network network:networks){
    LinkProperties properties=manager.getLinkProperties(network);
    if(properties!=null)for(LinkAddress local:properties.getLinkAddresses())if(sameSubnet(local.getAddress(),local.getPrefixLength(),target))return network;
   }
  }catch(Exception ignored){}
  return networks.isEmpty()?null:networks.get(0);
 }
 static boolean sameSubnet(InetAddress local,int prefix,InetAddress target){
  byte[] a=local.getAddress(),b=target.getAddress();if(a.length!=b.length||prefix<0||prefix>a.length*8)return false;
  for(int i=0;i<a.length;i++){int bits=Math.max(0,Math.min(8,prefix-i*8)),mask=bits==0?0:0xff<<(8-bits);if((a[i]&mask)!=(b[i]&mask))return false;}
  return true;
 }
 static String networkSignature(Context context){
  ConnectivityManager manager=(ConnectivityManager)context.getSystemService(Context.CONNECTIVITY_SERVICE);
  List<String> signatures=new ArrayList<>();
  for(Network network:lanNetworks(context)){LinkProperties properties=manager.getLinkProperties(network);signatures.add(network+":"+(properties==null?"":properties.getLinkAddresses()+":"+properties.getRoutes()));}
  Collections.sort(signatures);return signatures.toString();
 }

 private static final class Discovery implements AutoCloseable {
  final Context context;
  final String expectedFingerprint;
  final long deadline;
  final BlockingQueue<Candidate> candidates=new LinkedBlockingQueue<>(48);
  final Set<String> seen=ConcurrentHashMap.newKeySet();
  final List<Thread> workers=new ArrayList<>();
  final List<DatagramSocket> sockets=new CopyOnWriteArrayList<>();
  final NsdManager nsd;
  final Set<String> serviceNames=new HashSet<>();
  final Queue<NsdServiceInfo> services=new ArrayDeque<>();
  boolean resolving,discovering;
  volatile boolean active=true;
  final WifiManager.MulticastLock multicast;
  final NsdManager.DiscoveryListener listener=new NsdManager.DiscoveryListener(){
   public void onDiscoveryStarted(String type){} public void onDiscoveryStopped(String type){}
   public void onStartDiscoveryFailed(String type,int error){} public void onStopDiscoveryFailed(String type,int error){}
   public void onServiceLost(NsdServiceInfo info){}
   public void onServiceFound(NsdServiceInfo info){synchronized(Discovery.this){if(!active||!serviceNames.add(info.getServiceName()))return;services.add(info);resolveNext();}}
  };
  Discovery(Context context,String fingerprint,long duration){
   this.context=context.getApplicationContext();expectedFingerprint=fingerprint;deadline=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(duration);
   WifiManager wifi=(WifiManager)this.context.getSystemService(Context.WIFI_SERVICE);
   multicast=wifi==null?null:wifi.createMulticastLock("NexusRoomDiscovery");
   if(multicast!=null)try{multicast.acquire();}catch(SecurityException ignored){}
   nsd=(NsdManager)this.context.getSystemService(Context.NSD_SERVICE);
   if(nsd!=null)try{nsd.discoverServices("_nexusroom._tcp.",NsdManager.PROTOCOL_DNS_SD,listener);discovering=true;}catch(Exception ignored){}
   List<Network> networks=lanNetworks(this.context);
   if(networks.isEmpty())networks.add(null);
   for(Network network:networks){Thread worker=new Thread(()->udp(network),"NexusRoomUdpDiscovery");workers.add(worker);worker.start();}
  }
  Candidate next(){
   while(active&&!Thread.currentThread().isInterrupted()){
    long remaining=deadline-System.nanoTime();if(remaining<=0)return null;
    try{Candidate candidate=candidates.poll(Math.min(remaining,TimeUnit.MILLISECONDS.toNanos(250)),TimeUnit.NANOSECONDS);if(candidate!=null)return candidate;}catch(InterruptedException ignored){Thread.currentThread().interrupt();return null;}
   }
   return null;
  }
  void offer(String server,String fingerprint,Network network){
   if(!active||(!expectedFingerprint.isEmpty()&&!expectedFingerprint.equalsIgnoreCase(fingerprint)))return;
   try{RoomConfig.validate(server,fingerprint);if(seen.size()<48&&seen.add(server+":"+network))candidates.offer(new Candidate(server,fingerprint,network));}catch(Exception ignored){}
  }
  // Android 10-13 allow one resolve operation at a time. Queue hosts so a
  // second PC is not silently discarded with FAILURE_ALREADY_ACTIVE.
  private synchronized void resolveNext(){
   if(!active||resolving||nsd==null)return;
   NsdServiceInfo info=services.poll();if(info==null)return;
   resolving=true;
   try{nsd.resolveService(info,new NsdManager.ResolveListener(){
    public void onResolveFailed(NsdServiceInfo service,int error){resolved(null);}
    public void onServiceResolved(NsdServiceInfo service){resolved(service);}
   });}catch(Exception ignored){resolving=false;resolveNext();}
  }
  private synchronized void resolved(NsdServiceInfo info){
   if(active&&info!=null){byte[] fingerprint=info.getAttributes().get("fingerprint");InetAddress host=info.getHost();if(fingerprint!=null&&host instanceof Inet4Address){String server="https://"+host.getHostAddress()+":"+info.getPort();offer(server,new String(fingerprint,StandardCharsets.US_ASCII),preferredNetwork(context,server));}}
   resolving=false;resolveNext();
  }
  private void udp(Network network){
   try(DatagramSocket socket=new DatagramSocket()){
    sockets.add(socket);if(network!=null)network.bindSocket(socket);
    socket.setBroadcast(true);socket.setSoTimeout(250);
    Set<InetAddress> targets=new LinkedHashSet<>();targets.add(InetAddress.getByName("255.255.255.255"));
    ConnectivityManager manager=(ConnectivityManager)context.getSystemService(Context.CONNECTIVITY_SERVICE);
    LinkProperties properties=network==null||manager==null?null:manager.getLinkProperties(network);
    for(Enumeration<NetworkInterface> iterator=NetworkInterface.getNetworkInterfaces();iterator.hasMoreElements();){NetworkInterface net=iterator.nextElement();if(!net.isUp()||(properties!=null&&!net.getName().equals(properties.getInterfaceName())))continue;for(InterfaceAddress address:net.getInterfaceAddresses())if(address.getBroadcast()!=null)targets.add(address.getBroadcast());}
    if(properties!=null){
     for(LinkAddress address:properties.getLinkAddresses())if(address.getAddress() instanceof Inet4Address){byte[] raw=address.getAddress().getAddress().clone();int prefix=address.getPrefixLength();for(int i=0;i<4;i++){int bits=Math.max(0,Math.min(8,prefix-8*i));int mask=bits==0?0:0xff<<(8-bits);raw[i]=(byte)((raw[i]&mask)|(0xff&~mask));}targets.add(InetAddress.getByAddress(raw));}
     for(RouteInfo route:properties.getRoutes())if(route.getGateway() instanceof Inet4Address)targets.add(route.getGateway());
    }
    byte[] query="NEXUSROOM_DISCOVER_V1".getBytes(StandardCharsets.US_ASCII);long next=0;
    while(active&&System.nanoTime()<deadline&&!Thread.currentThread().isInterrupted()){
     if(System.nanoTime()>=next){for(InetAddress target:targets)try{socket.send(new DatagramPacket(query,query.length,target,17892));}catch(Exception ignored){}next=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(500);}
     try{DatagramPacket packet=new DatagramPacket(new byte[4096],4096);socket.receive(packet);JSONObject room=new JSONObject(new String(packet.getData(),0,packet.getLength(),StandardCharsets.UTF_8));if(!"nexusroom".equals(room.optString("type")))continue;int port=room.getInt("port");if(port<1||port>65535)continue;offer("https://"+packet.getAddress().getHostAddress()+":"+port,room.getString("fingerprint"),network);}catch(SocketTimeoutException ignored){}catch(Exception ignored){}
    }
   }catch(Exception ignored){}
  }
  public void close(){
   active=false;for(DatagramSocket socket:sockets)socket.close();for(Thread worker:workers)worker.interrupt();
   if(discovering&&nsd!=null)try{nsd.stopServiceDiscovery(listener);}catch(Exception ignored){}
   if(multicast!=null&&multicast.isHeld())try{multicast.release();}catch(Exception ignored){}
  }
 }
}
