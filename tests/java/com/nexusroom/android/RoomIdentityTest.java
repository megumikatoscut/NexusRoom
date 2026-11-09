package com.nexusroom.android;

import com.sun.net.httpserver.HttpsConfigurator;
import com.sun.net.httpserver.HttpsServer;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import org.json.JSONObject;

// Exercise the actual Android trust manager and rediscovery identity probe
// against real HTTPS listeners. No Android device or real user data is needed.
public final class RoomIdentityTest {
 private static final String TOKEN="fixture-membership";
 private static final String ROOM="654321";
 private static int passed;

 private static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
 private static void pass(String message){passed++;System.out.println("PASS "+message);}
 private static final class Host implements AutoCloseable {
  final HttpsServer server;
  final ExecutorService workers=Executors.newCachedThreadPool();
  final String address,fingerprint;
  final AtomicReference<String> body=new AtomicReference<>("{}");
  final AtomicInteger status=new AtomicInteger(200),requests=new AtomicInteger(),invalidTokens=new AtomicInteger();
  volatile String redirect="";
  Host(Path path)throws Exception{
   KeyStore keys=KeyStore.getInstance("PKCS12");try(InputStream stream=Files.newInputStream(path)){keys.load(stream,"fixture-only".toCharArray());}
   fingerprint=RoomConfig.hex(MessageDigest.getInstance("SHA-256").digest(keys.getCertificate("server").getEncoded()));
   KeyManagerFactory manager=KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());manager.init(keys,"fixture-only".toCharArray());
   SSLContext tls=SSLContext.getInstance("TLS");tls.init(manager.getKeyManagers(),null,null);
   server=HttpsServer.create(new InetSocketAddress("127.0.0.1",0),0);server.setHttpsConfigurator(new HttpsConfigurator(tls));server.setExecutor(workers);
   server.createContext("/device/room",exchange->{
    requests.incrementAndGet();if(!("Bearer "+TOKEN).equals(exchange.getRequestHeaders().getFirst("Authorization")))invalidTokens.incrementAndGet();
    byte[] value=body.get().getBytes(StandardCharsets.UTF_8);
    if(!redirect.isEmpty())exchange.getResponseHeaders().set("Location",redirect);
    exchange.getResponseHeaders().set("Content-Type","application/json");exchange.sendResponseHeaders(status.get(),value.length);exchange.getResponseBody().write(value);exchange.close();
   });
   server.start();address="https://127.0.0.1:"+server.getAddress().getPort();
  }
  JSONObject room()throws Exception{return new JSONObject().put("roomId",ROOM).put("id",ROOM).put("name","Saved room").put("hostName","Fixture PC").put("hostOnline",true).put("fingerprint",fingerprint).put("open",false);}
  public void close(){server.stop(0);workers.shutdownNow();}
 }
 public static void main(String[] args)throws Exception{
  try(Host original=new Host(Path.of(args[0]));Host stranger=new Host(Path.of(args[1]))){
   RoomConfig saved=new RoomConfig();saved.server="https://127.0.0.1:1";saved.fingerprint=original.fingerprint;saved.roomId=ROOM;saved.deviceId="fixture-member";saved.token=TOKEN;saved.control=true;
   original.body.set(original.room().toString());
   RoomDiscovery.TrustedServer verified=RoomDiscovery.verifyTrusted(saved,original.address,null);
   check(verified!=null&&verified.server.equals(original.address)&&verified.roomId.equals(ROOM),"Moved trusted host was rejected");
   check(saved.server.equals("https://127.0.0.1:1")&&saved.deviceId.equals("fixture-member")&&saved.token.equals(TOKEN)&&saved.control,"Probe changed saved credentials or permissions");
   check(original.invalidTokens.get()==0,"Existing membership token did not authenticate the probe");
   pass("old unreachable address recovers using original TLS identity, room and membership; paused joining remains reconnectable");

   stranger.body.set(stranger.room().put("fingerprint",original.fingerprint).toString());
   check(RoomDiscovery.verifyTrusted(saved,stranger.address,null)==null,"Different certificate impersonated saved PC");
   check(stranger.requests.get()==0,"Membership token was sent before certificate authentication");
   pass("forged fingerprint advertisement cannot move the room or receive its token");

   original.body.set(original.room().put("roomId","123456").put("id","123456").toString());
   check(RoomDiscovery.verifyTrusted(saved,original.address,null)==null,"Another room on the same PC was accepted");
   pass("same certificate with wrong room identity is rejected");

   original.body.set(original.room().toString());
   for(int code:new int[]{401,403,404}){original.status.set(code);check(RoomDiscovery.verifyTrusted(saved,original.address,null)==null,"Unauthorized endpoint accepted for status "+code);}
   original.status.set(200);
   check(saved.token.equals(TOKEN)&&saved.roomId.equals(ROOM),"Failed rediscovery erased saved membership");
   pass("revoked or unavailable membership is rejected without erasing saved state during discovery");

   original.body.set(original.room().put("fingerprint",stranger.fingerprint).toString());
   check(RoomDiscovery.verifyTrusted(saved,original.address,null)==null,"Conflicting identity metadata was accepted");
   original.body.set(original.room().put("hostOnline",false).toString());
   check(RoomDiscovery.verifyTrusted(saved,original.address,null)==null,"Offline metadata was accepted");
   original.body.set(new JSONObject().put("hostOnline",true).toString());
   check(RoomDiscovery.verifyTrusted(saved,original.address,null)==null,"Missing room identity was accepted");
   pass("missing, offline or conflicting authenticated room metadata is rejected");

   original.body.set(original.room().toString());original.status.set(302);original.redirect=stranger.address+"/device/room";
   check(RoomDiscovery.verifyTrusted(saved,original.address,null)==null,"Redirect was followed");
   check(stranger.requests.get()==0,"Redirect leaked membership to another host");original.status.set(200);original.redirect="";
   pass("HTTPS rediscovery redirects cannot forward membership credentials");

   original.body.set(new JSONObject().put("id",ROOM).put("name","Fixture room").put("hostOnline",true).toString());
   check(RoomDiscovery.verifyTrusted(saved,original.address,null)!=null,"Room response without optional fingerprint was rejected");
   pass("authenticated room response accepts an omitted optional fingerprint");

   for(String address:new String[]{"https://127.0.0.1:0","https://127.0.0.1:65536","https://8.8.8.8:17891","http://127.0.0.1:17891","https://user@127.0.0.1:17891","https://127.0.0.1:17891/device/room"}){
    boolean rejected=false;try{RoomConfig.validate(address,saved.fingerprint);}catch(Exception expected){rejected=true;}check(rejected,"Invalid rediscovery endpoint accepted");
   }
   check(RoomDiscovery.sameSubnet(InetAddress.getByName("192.168.2.1"),23,InetAddress.getByName("192.168.3.254")),"/23 LAN route rejected");
   check(!RoomDiscovery.sameSubnet(InetAddress.getByName("192.168.2.1"),24,InetAddress.getByName("192.168.3.1")),"Different subnet accepted");
   check(!RoomDiscovery.sameSubnet(InetAddress.getByName("192.168.2.1"),33,InetAddress.getByName("192.168.2.1")),"Invalid prefix accepted");
   pass("discovery validates LAN address and port; route matching handles subnet boundaries on Android 10+");
  }
  System.out.println(passed+" real HTTPS identity regression checks passed");
 }
}
