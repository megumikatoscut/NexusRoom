package com.nexusroom.android;

import android.content.Context;
import android.net.Network;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import org.json.JSONArray;
import java.util.ArrayList;
import java.util.List;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.net.URI;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import okhttp3.OkHttpClient;

final class RoomConfig {
    String server = "", fingerprint = "", deviceId = "", token = "", hostName = "", roomName = "", roomId="";
    boolean control,files,clipboard,agent,audio,screenAllowed,leaving;
    JSONObject json() throws Exception {return new JSONObject().put("server",server).put("fingerprint",fingerprint).put("deviceId",deviceId).put("token",token).put("hostName",hostName).put("roomName",roomName).put("roomId",roomId).put("control",control).put("files",files).put("clipboard",clipboard).put("agent",agent).put("audio",audio).put("screenAllowed",screenAllowed).put("leaving",leaving);}
    static synchronized List<RoomConfig> all(Context c) {
        List<RoomConfig> result=new ArrayList<>();
        try {
            String encrypted = ReleaseStorage.preferences(c, "vault").getString("connection", "");
            if (encrypted.isEmpty()) return result;
            String[] parts = encrypted.split(":");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            JSONObject j = new JSONObject(new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), java.nio.charset.StandardCharsets.UTF_8));
            JSONArray rooms=j.optJSONArray("rooms");if(rooms==null)rooms=new JSONArray().put(j);
            for(int i=0;i<rooms.length();i++){JSONObject item=rooms.getJSONObject(i);RoomConfig config=new RoomConfig();
            config.server = item.getString("server"); config.fingerprint = item.getString("fingerprint"); config.deviceId = item.getString("deviceId"); config.token = item.getString("token"); config.hostName = item.optString("hostName"); config.roomName = item.optString("roomName");config.roomId=item.optString("roomId");
            config.control=item.optBoolean("control");config.files=item.optBoolean("files");config.clipboard=item.optBoolean("clipboard");config.agent=item.optBoolean("agent");config.audio=item.optBoolean("audio");config.screenAllowed=item.optBoolean("screenAllowed");config.leaving=item.optBoolean("leaving");result.add(config);}
        } catch (Exception ignored) { ReleaseStorage.preferences(c, "vault").edit().clear().apply(); }
        return result;
    }
    static RoomConfig load(Context c){String selected=ReleaseStorage.preferences(c,"ui").getString("room","");List<RoomConfig> all=all(c);for(RoomConfig r:all)if(!r.leaving&&r.deviceId.equals(selected))return r;for(RoomConfig r:all)if(!r.leaving)return r;return new RoomConfig();}
    static void select(Context c,String id){ReleaseStorage.preferences(c,"ui").edit().putString("room",id).apply();}
    static String physicalId(Context c){String id=ReleaseStorage.preferences(c,"ui").getString("physicalId","");if(id.isEmpty()){id=java.util.UUID.randomUUID().toString();ReleaseStorage.preferences(c,"ui").edit().putString("physicalId",id).commit();}return id;}
    void save(Context c) throws Exception {synchronized(RoomConfig.class){List<RoomConfig> all=all(c);int index=-1;for(int i=0;i<all.size();i++)if(all.get(i).deviceId.equals(deviceId))index=i;if(index<0)all.add(this);else all.set(index,this);write(c,all);}}
    static synchronized void remove(Context c,String id)throws Exception{List<RoomConfig> all=all(c);all.removeIf(r->r.deviceId.equals(id));write(c,all);}
    private static void write(Context c,List<RoomConfig> rooms)throws Exception{
        JSONArray array=new JSONArray();for(RoomConfig r:rooms)array.put(r.json());JSONObject j=new JSONObject().put("rooms",array);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        String encrypted = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(cipher.doFinal(j.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)), Base64.NO_WRAP);
        if(!ReleaseStorage.preferences(c, "vault").edit().putString("connection", encrypted).commit())throw new Exception("无法保存房间配置");
    }
    static void clear(Context c) { ReleaseStorage.preferences(c, "vault").edit().clear().apply(); }
    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias("NexusRoomConnection")) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder("NexusRoomConnection", KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build()); generator.generateKey();
        }
        return (SecretKey) store.getKey("NexusRoomConnection", null);
    }
    static void validate(String server, String fingerprint) throws Exception {
        URI uri = new URI(server);
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null || (uri.getPath() != null && !uri.getPath().isEmpty() && !"/".equals(uri.getPath()))) throw new Exception("请输入 HTTPS 主机地址，例如 https://192.168.1.10:17891");
        if (uri.getPort() < -1 || uri.getPort() == 0 || uri.getPort() > 65535) throw new Exception("电脑端口无效");
        String host = uri.getHost();
        if (!host.matches("\\d{1,3}(\\.\\d{1,3}){3}")) throw new Exception("请输入局域网 IPv4 地址");
        String[] p = host.split("\\."); int a = Integer.parseInt(p[0]), b = Integer.parseInt(p[1]);
        for (String part : p) if (Integer.parseInt(part) > 255) throw new Exception("IP 地址无效");
        if (!(a == 10 || a == 127 || (a == 192 && b == 168) || (a == 172 && b >= 16 && b <= 31) || (a == 169 && b == 254))) throw new Exception("只支持局域网地址");
        if (!fingerprint.matches("[a-fA-F0-9]{64}")) throw new Exception("请填写完整的 64 位证书指纹");
    }
    OkHttpClient client() throws Exception { return client(null); }
    OkHttpClient client(Network network) throws Exception {
        validate(server, fingerprint);
        final String expected = fingerprint.toLowerCase(java.util.Locale.ROOT);
        X509TrustManager trust = new X509TrustManager() {
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            public void checkClientTrusted(X509Certificate[] chain, String auth) throws java.security.cert.CertificateException { throw new java.security.cert.CertificateException("Client certificates unsupported"); }
            public void checkServerTrusted(X509Certificate[] chain, String auth) throws java.security.cert.CertificateException {
                try { if (chain.length == 0) throw new Exception(); chain[0].checkValidity(); String actual = hex(MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded())); if (!MessageDigest.isEqual(actual.getBytes(java.nio.charset.StandardCharsets.UTF_8), expected.getBytes(java.nio.charset.StandardCharsets.UTF_8))) throw new Exception(); }
                catch (Exception e) { throw new java.security.cert.CertificateException("NexusRoom 证书指纹不匹配"); }
            }
        };
        SSLContext ssl = SSLContext.getInstance("TLS"); ssl.init(null, new TrustManager[]{trust}, null);
        String expectedHost = new URI(server).getHost();
        OkHttpClient.Builder builder = new OkHttpClient.Builder().sslSocketFactory(ssl.getSocketFactory(), trust).hostnameVerifier((host, session) -> host.equals(expectedHost)).followRedirects(false).followSslRedirects(false).connectTimeout(8, TimeUnit.SECONDS).readTimeout(130, TimeUnit.SECONDS).writeTimeout(130, TimeUnit.SECONDS).pingInterval(15, TimeUnit.SECONDS);
        // Keep LAN traffic on Wi-Fi/Ethernet even when Android chooses cellular
        // as its default route because the local network has no Internet.
        if (network != null) builder.socketFactory(network.getSocketFactory());
        return builder.build();
    }
    static String hex(byte[] bytes) { StringBuilder s = new StringBuilder(); for (byte b : bytes) s.append(String.format(java.util.Locale.ROOT, "%02x", b & 255)); return s.toString(); }
}
