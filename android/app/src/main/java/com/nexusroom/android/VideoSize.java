package com.nexusroom.android;

final class VideoSize {
 static int[] fit(int screenWidth,int screenHeight,int maxSize,int widthAlignment,int heightAlignment) {
  if(screenWidth<=0||screenHeight<=0||maxSize<=0)throw new IllegalArgumentException("屏幕尺寸无效");
  double scale=Math.min(1d,(double)maxSize/Math.max(screenWidth,screenHeight));
  int wa=Math.max(2,widthAlignment),ha=Math.max(2,heightAlignment);
  return new int[]{Math.max(wa,(int)(screenWidth*scale)/wa*wa),Math.max(ha,(int)(screenHeight*scale)/ha*ha)};
 }
}
