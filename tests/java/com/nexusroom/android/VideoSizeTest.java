package com.nexusroom.android;

import java.util.Arrays;
public final class VideoSizeTest {
 private static void check(int[] actual,int width,int height) {
  if(!Arrays.equals(actual,new int[]{width,height}))throw new AssertionError("Expected "+width+"x"+height+", got "+Arrays.toString(actual));
 }
 public static void main(String[] args) {
  // HBN-AL80's 1260x2844 display must fit hardware requiring 16-pixel blocks.
  check(VideoSize.fit(1260,2844,1280,16,16),560,1280);
  check(VideoSize.fit(2844,1260,1280,16,16),1280,560);
  check(VideoSize.fit(1080,2400,960,16,16),432,960);
  check(VideoSize.fit(1280,720,1280,2,2),1280,720);
  check(VideoSize.fit(720,1280,640,8,16),360,640);
  System.out.println("PASS encoder dimensions: tall phone, rotation, fallback size and encoder alignment");
 }
}
