package com.nexusroom.android;

import java.io.IOException;
import java.lang.management.ManagementFactory;
import java.lang.management.ThreadInfo;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import okio.Timeout;

// Invoke the actual product's listeners and membership/lease cleanup. A monitor
// gate places a reconnect between receipt of a callback and its cleanup, rather
// than testing a copy of the generation predicate. It reproduces the former bug.
public final class RoomSessionTest {
 private static int passed;
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 private static void pass(String message){passed++;System.out.println("PASS "+message);}
 private static final class Socket implements WebSocket {
  final Request request;boolean cancelled;
  Socket(Request request){this.request=request;}
  public Request request(){return request;}
  public long queueSize(){return 0;}
  public boolean send(String text){return !cancelled;}
  public boolean send(ByteString data){return !cancelled;}
  public boolean close(int code,String reason){cancelled=true;return true;}
  public void cancel(){cancelled=true;}
 }
 private static final class Connection {
  final Socket socket;final WebSocketListener listener;
  Connection(Socket socket,WebSocketListener listener){this.socket=socket;this.listener=listener;}
  Response response(int code){return new Response.Builder().request(socket.request).protocol(Protocol.HTTP_1_1).code(code).message("Fixture").build();}
  void open(){listener.onOpen(socket,response(101));}
 }
 private static final class Transport extends OkHttpClient {
  final List<Connection> connections=new ArrayList<>();
  volatile LeaveReply leaveReply;
  @Override public WebSocket newWebSocket(Request request,WebSocketListener listener){Socket socket=new Socket(request);connections.add(new Connection(socket,listener));return socket;}
  @Override public Call newCall(Request request){
   LeaveReply reply=leaveReply;check(reply!=null,"Unexpected HTTP call in the session fixture");
   return new Call(){
    boolean cancelled,executed;
    public Request request(){return request;}
    public Response execute()throws IOException{executed=true;reply.requested.countDown();try{if(!reply.answer.await(2,TimeUnit.SECONDS))throw new IOException("Fixture reply timed out");}catch(InterruptedException e){Thread.currentThread().interrupt();throw new IOException(e);}return new Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(reply.status).message("Fixture").body(ResponseBody.create("{}",null)).build();}
    public void enqueue(Callback callback){throw new UnsupportedOperationException("Synchronous leave fixture");}
    public void cancel(){cancelled=true;}
    public boolean isExecuted(){return executed;}
    public boolean isCanceled(){return cancelled;}
    public Timeout timeout(){return Timeout.NONE;}
    public Call clone(){return Transport.this.newCall(request);}
   };
  }
  Connection latest(){return connections.get(connections.size()-1);}
 }
 private static final class LeaveReply {
  final CountDownLatch requested=new CountDownLatch(1),answer=new CountDownLatch(1);
  final int status;
  LeaveReply(int status){this.status=status;}
 }
 private static final class Fixture implements AutoCloseable {
  final RoomService service=new RoomService();
  final RoomConfig config=new RoomConfig();
  final Transport transport=new Transport();
  final RoomService.RoomLink link;
  final Connection original;
  Fixture()throws Exception{
   // Rediscovery is covered by the HTTPS and emulator tests. Refusing its queued
   // work here lets the real lost() run without opening unrelated network I/O.
   service.discoveryWork.shutdownNow();
   config.server="https://127.0.0.1:17891";config.fingerprint="a".repeat(64);
   config.deviceId="fixture-member";config.roomId="654321";config.roomName="Original room";config.token="fixture-membership";config.agent=true;
   link=service.new RoomLink(config);link.client=transport;service.links.put(config.deviceId,link);
   link.connect();original=transport.latest();original.open();service.acquire(link,"original-lease");
  }
  Connection migrate()throws Exception{
   link.networkChanged();link.connect();Connection fresh=transport.latest();
   check(fresh!=original,"Migration did not establish a new production connection");
   fresh.open();service.acquire(link,"new-lease");return fresh;
  }
  void preserved(Connection fresh){check(service.links.get(config.deviceId)==link,"Old callback removed the new membership");check(!link.closed&&link.online&&link.socket==fresh.socket&&!fresh.socket.cancelled,"Old callback closed the new connection");check(service.owner.equals(config.deviceId)&&service.leaseId.equals("new-lease"),"Old callback released the new control lease");check(config.token.equals("fixture-membership")&&config.agent,"Migration lost identity or permission");}
  public void close(){link.close();service.fileWork.shutdownNow();service.commands.shutdownNow();service.discoveryWork.shutdownNow();transport.dispatcher().executorService().shutdownNow();}
 }
 private static Thread blockedCallback(Object monitor,Runnable action,AtomicReference<Throwable> error)throws Exception{
  Thread callback=new Thread(()->{try{action.run();}catch(Throwable failure){error.set(failure);}},"Delayed product callback");callback.setDaemon(true);callback.start();
  long deadline=System.nanoTime()+2_000_000_000L;
  while(System.nanoTime()<deadline){ThreadInfo info=ManagementFactory.getThreadMXBean().getThreadInfo(callback.getId());if(info!=null&&info.getThreadState()==Thread.State.BLOCKED&&info.getLockInfo()!=null&&info.getLockInfo().getIdentityHashCode()==System.identityHashCode(monitor))return callback;if(!callback.isAlive())throw new AssertionError("Callback never reached the contested production monitor",error.get());Thread.sleep(2);}
  throw new AssertionError("Callback did not reach the production cleanup monitor");
 }
 private static void completed(Thread callback,AtomicReference<Throwable> error)throws Exception{callback.join(2000);check(!callback.isAlive(),"Production lock order deadlocked during reconnect");if(error.get()!=null)throw new AssertionError("Callback failed",error.get());}
 private static void migratedWhileCallbackWaits(String label,java.util.function.Consumer<Connection> action)throws Exception{
  try(Fixture fixture=new Fixture()){
   AtomicReference<Throwable> error=new AtomicReference<>();Thread callback;Connection fresh;
   synchronized(fixture.service){callback=blockedCallback(fixture.service,()->action.accept(fixture.original),error);fresh=fixture.migrate();}
   completed(callback,error);fixture.preserved(fresh);pass(label);
  }
 }
 private static void projectionIdentityChecks()throws Exception{
  Class<?> requestClass=Class.forName("com.nexusroom.android.MainActivity$ProjectionRequest");
  java.lang.reflect.Constructor<?> constructor=requestClass.getDeclaredConstructor(RoomService.class,RoomService.RoomLink.class);constructor.setAccessible(true);
  java.lang.reflect.Method valid=requestClass.getDeclaredMethod("valid");valid.setAccessible(true);
  RoomService previous=RoomService.instance;
  try(Fixture fixture=new Fixture()){
   RoomService.instance=fixture.service;fixture.config.control=true;fixture.config.screenAllowed=true;fixture.service.pendingProjection=fixture.config.deviceId;
   Object original=constructor.newInstance(fixture.service,fixture.link);check((Boolean)valid.invoke(original),"Original consent request was rejected");
   fixture.service.leaseId="replacement-lease";
   check(!(Boolean)valid.invoke(original),"Old MediaProjection consent inherited a newer lease");
   fixture.service.consentCancelled(fixture.config.deviceId,"original-lease");
   check(fixture.service.leaseId.equals("replacement-lease"),"Cancelling the old consent released a newer lease");pass("MediaProjection consent and cancellation remain bound to their original lease");
   fixture.service.owner="another-member";fixture.service.pendingProjection="another-member";
   check(!(Boolean)valid.invoke(original),"Old MediaProjection consent migrated to another room");pass("MediaProjection consent cannot migrate to another room");
   fixture.service.owner=fixture.config.deviceId;fixture.service.pendingProjection=fixture.config.deviceId;fixture.service.leaseId="original-lease";
   RoomService.RoomLink replacement=fixture.service.new RoomLink(fixture.config);replacement.online=true;fixture.service.links.put(fixture.config.deviceId,replacement);
   check(!(Boolean)valid.invoke(original),"Old MediaProjection consent survived membership object replacement");replacement.close();pass("MediaProjection consent rejects a replacement membership object");
   fixture.service.links.put(fixture.config.deviceId,fixture.link);fixture.config.screenAllowed=false;
   check(!(Boolean)valid.invoke(original),"MediaProjection consent survived screen permission withdrawal");pass("MediaProjection consent rechecks current screen and control permission");
  }finally{RoomService.instance=previous;}
 }
 public static void main(String[] args)throws Exception{
  migratedWhileCallbackWaits("delayed old revoked message cannot erase a reconnected member or its new lease",c->c.listener.onMessage(c.socket,"{\"type\":\"revoked\",\"reason\":\"Old connection\"}"));
  for(int code:new int[]{401,403,404})migratedWhileCallbackWaits("delayed old HTTP "+code+" failure cannot revoke the new connection",c->c.listener.onFailure(c.socket,new IOException("Old handshake"),c.response(code)));
  migratedWhileCallbackWaits("delayed old transport failure cannot release the new control lease",c->c.listener.onFailure(c.socket,new IOException("Old transport"),null));
  migratedWhileCallbackWaits("delayed old closing callback cannot close or release the new connection",c->c.listener.onClosing(c.socket,1000,"Old close"));
  migratedWhileCallbackWaits("delayed old closed callback cannot clear the new connection",c->c.listener.onClosed(c.socket,1000,"Old close"));
  try(Fixture fixture=new Fixture()){
   AtomicReference<Throwable> error=new AtomicReference<>();Thread callback;Connection fresh;
   synchronized(fixture.service){
    callback=blockedCallback(fixture.service,()->fixture.original.listener.onMessage(fixture.original.socket,"{\"type\":\"welcome\",\"roomId\":\"123456\",\"roomName\":\"Stale metadata\",\"lease\":\"original-lease\"}"),error);
    check(fixture.config.roomId.equals("654321")&&fixture.config.roomName.equals("Original room"),"Callback modified room metadata outside its lifecycle guard");
    fresh=fixture.migrate();
   }
   completed(callback,error);fixture.preserved(fresh);check(fixture.config.roomId.equals("654321")&&fixture.config.roomName.equals("Original room"),"Old welcome rewrote the current room identity");pass("old welcome metadata is rejected at the same lifecycle boundary");
  }
  try(Fixture fixture=new Fixture()){
   Connection fresh=fixture.migrate();Socket unrelated=new Socket(fresh.socket.request);
   fresh.listener.onOpen(unrelated,fresh.response(101));fixture.preserved(fresh);check(unrelated.cancelled,"Unexpected callback socket was accepted");pass("matching generation with another socket cannot replace the current transport");
   fresh.listener.onMessage(fresh.socket,"{\"type\":\"revoked\",\"reason\":\"Current revocation\"}");
   check(fixture.link.closed&&!fixture.link.online&&fresh.socket.cancelled,"Current revocation did not close its transport");check(!fixture.service.links.containsKey(fixture.config.deviceId),"Current revocation left a member active");check(fixture.service.owner.isEmpty()&&fixture.service.leaseId.isEmpty(),"Current revocation left a control lease active");
   String notice=fixture.service.lastNotice;fixture.link.save();check(fixture.service.lastNotice.equals(notice),"Closed link attempted to save its removed membership");pass("current revocation still removes the member and lease; closed-link save is ignored");
  }
  for(int code:new int[]{401,403,404})try(Fixture fixture=new Fixture()){
   fixture.original.listener.onFailure(fixture.original.socket,new IOException("Current handshake"),fixture.original.response(code));check(fixture.link.closed&&!fixture.service.links.containsKey(fixture.config.deviceId)&&fixture.service.owner.isEmpty(),"Current HTTP "+code+" revocation was lost");pass("current HTTP "+code+" failure still removes unauthorized membership");
  }
  try(Fixture fixture=new Fixture()){
   RoomService.RoomLink replacement=fixture.service.new RoomLink(fixture.config);fixture.service.links.put(fixture.config.deviceId,replacement);
   fixture.original.listener.onMessage(fixture.original.socket,"{\"type\":\"revoked\"}");fixture.link.networkChanged();check(fixture.service.links.get(fixture.config.deviceId)==replacement&&!replacement.closed,"Old link erased a replacement link with the same member ID");check(fixture.service.leaseId.equals("original-lease"),"Obsolete link released its replacement's lease");replacement.close();pass("old link cleanup cannot remove a replacement membership object");
  }
  try(Fixture fixture=new Fixture()){
   fixture.config.leaving=true;LeaveReply old=new LeaveReply(401);fixture.transport.leaveReply=old;
   AtomicReference<Throwable> error=new AtomicReference<>();Thread request=new Thread(()->{try{fixture.link.leaveRemote();}catch(Throwable failure){error.set(failure);}},"Delayed product leave reply");request.setDaemon(true);request.start();check(old.requested.await(2,TimeUnit.SECONDS),"Production leave request was not issued");
   fixture.link.networkChanged();old.answer.countDown();completed(request,error);
   check(fixture.service.links.get(fixture.config.deviceId)==fixture.link&&!fixture.link.closed&&fixture.config.leaving,"Old leave response erased a newer connection generation");pass("old HTTP leave response preserves the current pending membership");
   LeaveReply current=new LeaveReply(401);current.answer.countDown();fixture.transport.leaveReply=current;fixture.link.leaveRemote();
   check(fixture.link.closed&&!fixture.service.links.containsKey(fixture.config.deviceId),"Current acknowledged leave did not remove membership");pass("current HTTP leave response still synchronizes removal");
  }
  projectionIdentityChecks();
  System.out.println(passed+" production room session regression checks passed");
 }
}
