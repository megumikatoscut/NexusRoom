package com.nexusroom.android;

/** Pure coordinate geometry, shared by drawing and authenticated input mapping. */
final class PcViewport {
 final float left,top,width,height,offsetX,offsetY;
 private PcViewport(float left,float top,float width,float height,float offsetX,float offsetY){this.left=left;this.top=top;this.width=width;this.height=height;this.offsetX=offsetX;this.offsetY=offsetY;}
 static PcViewport fit(int remoteWidth,int remoteHeight,int viewWidth,int viewHeight,float zoom,float offsetX,float offsetY){
  if(remoteWidth<=0||remoteHeight<=0||viewWidth<=0||viewHeight<=0)return new PcViewport(0,0,0,0,0,0);
  float scale=Math.min(viewWidth/(float)remoteWidth,viewHeight/(float)remoteHeight)*Math.max(1,Math.min(4,zoom));
  float width=remoteWidth*scale,height=remoteHeight*scale,maxX=Math.max(0,(width-viewWidth)/2),maxY=Math.max(0,(height-viewHeight)/2);
  float x=Math.max(-maxX,Math.min(maxX,offsetX)),y=Math.max(-maxY,Math.min(maxY,offsetY));
  return new PcViewport((viewWidth-width)/2+x,(viewHeight-height)/2+y,width,height,x,y);
 }
 float[] map(float x,float y,boolean clamp){
  if(width<=0||height<=0||!Float.isFinite(x)||!Float.isFinite(y))return null;
  if(!clamp&&(x<left||x>left+width||y<top||y>top+height))return null;
  return new float[]{Math.max(0,Math.min(1,(x-left)/width)),Math.max(0,Math.min(1,(y-top)/height))};
 }
}
