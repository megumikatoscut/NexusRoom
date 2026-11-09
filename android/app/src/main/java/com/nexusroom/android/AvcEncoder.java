package com.nexusroom.android;

import android.media.*;
import android.util.Log;
import android.view.Surface;
import java.util.*;

/** Negotiates a surface encoder; advertised capability checks alone are unreliable on vendor codecs. */
final class AvcEncoder {
 static final class Opened {
  final MediaCodec codec; final Surface surface; final int width,height;
  Opened(MediaCodec codec,Surface surface,int width,int height){this.codec=codec;this.surface=surface;this.width=width;this.height=height;}
 }
 static Opened open(int screenWidth,int screenHeight,int maxSize,int fps,int bitrate,java.util.function.BooleanSupplier cancelled)throws Exception {
  List<MediaCodecInfo> candidates=new ArrayList<>();
  for(MediaCodecInfo info:new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos()) {
   if(info.isEncoder()&&Arrays.asList(info.getSupportedTypes()).contains(MediaFormat.MIMETYPE_VIDEO_AVC))candidates.add(info);
  }
  candidates.sort(Comparator.comparingInt(info->info.isHardwareAccelerated()?0:1));
  Exception last=null;
  for(MediaCodecInfo info:candidates) {
   MediaCodecInfo.CodecCapabilities capabilities;
   try { capabilities=info.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC); }
   catch(RuntimeException e){last=e;continue;}
   if(Arrays.stream(capabilities.colorFormats).noneMatch(c->c==MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface))continue;
   MediaCodecInfo.VideoCapabilities video=capabilities.getVideoCapabilities();
   Set<String> attempted=new HashSet<>();
   for(int limit:new int[]{maxSize,Math.min(maxSize,960),Math.min(maxSize,640)}) {
    // First prefer conservative 16-pixel block alignment, then advertised alignment.
    for(int alignment:new int[]{16,2}) {
     int[] size=VideoSize.fit(screenWidth,screenHeight,limit,Math.max(alignment,video.getWidthAlignment()),Math.max(alignment,video.getHeightAlignment()));
     if(!video.isSizeSupported(size[0],size[1]))continue;
     for(boolean baseline:new boolean[]{true,false}) {
      if(cancelled.getAsBoolean())throw new java.util.concurrent.CancellationException("共享请求已取消");
      String attempt=size[0]+"x"+size[1]+(baseline?" baseline":" default");
      if(!attempted.add(attempt))continue;
      MediaCodec codec=null;Surface surface=null;
      try {
       MediaFormat format=MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC,size[0],size[1]);
       format.setInteger(MediaFormat.KEY_COLOR_FORMAT,MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
       format.setInteger(MediaFormat.KEY_BIT_RATE,video.getBitrateRange().clamp(bitrate*1000000));
       double supportedRate=video.getSupportedFrameRatesFor(size[0],size[1]).getUpper();
       format.setInteger(MediaFormat.KEY_FRAME_RATE,Math.max(1,Math.min(fps,(int)supportedRate)));
       format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL,1);
       if(baseline)format.setInteger(MediaFormat.KEY_PROFILE,MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline);
       // Do not force optional max-bframes/latency keys: some vendor OMX encoders reject them.
       Log.i("NexusRoom.Media","Trying "+info.getName()+" "+attempt);
       codec=MediaCodec.createByCodecName(info.getName());
       codec.configure(format,null,null,MediaCodec.CONFIGURE_FLAG_ENCODE);
       surface=codec.createInputSurface();codec.start();
       Log.i("NexusRoom.Media","Encoder started: "+info.getName()+" "+attempt);
       return new Opened(codec,surface,size[0],size[1]);
      }catch(Exception e) {
       last=e;Log.w("NexusRoom.Media","Encoder rejected "+info.getName()+" "+attempt,e);
       if(surface!=null)try{surface.release();}catch(Exception ignored){}
       if(codec!=null)try{codec.release();}catch(Exception ignored){}
      }
     }
    }
   }
  }
  throw new Exception("设备无法启动 H.264 编码器（已尝试兼容尺寸和备用编码器）"+(last==null?"":": "+last.getMessage()),last);
 }
}
