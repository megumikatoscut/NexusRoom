package com.nexusroom.android;

public final class PcViewportTest {
 private static void near(float expected,float actual){if(Math.abs(expected-actual)>.0001f)throw new AssertionError("Expected "+expected+", got "+actual);}
 private static void point(PcViewport viewport,float x,float y,float nx,float ny){float[] point=viewport.map(x,y,false);if(point==null)throw new AssertionError("Visible point rejected");near(nx,point[0]);near(ny,point[1]);}
 private static void rejected(PcViewport viewport,float x,float y){if(viewport.map(x,y,false)!=null)throw new AssertionError("Black bar must not send input");}
 public static void main(String[] args){
  PcViewport landscape=PcViewport.fit(1920,1080,1080,1920,1,0,0);
  near(656.25f,landscape.top);near(607.5f,landscape.height);point(landscape,540,960,.5f,.5f);point(landscape,270,808.125f,.25f,.25f);rejected(landscape,540,500);rejected(landscape,540,1500);
  PcViewport portrait=PcViewport.fit(1080,1920,1920,1080,1,0,0);
  near(656.25f,portrait.left);point(portrait,960,540,.5f,.5f);rejected(portrait,500,540);rejected(portrait,1500,540);
  PcViewport zoom=PcViewport.fit(1920,1080,1920,1080,2,0,0);
  point(zoom,0,0,.25f,.25f);point(zoom,1920,1080,.75f,.75f);
  PcViewport pan=PcViewport.fit(1920,1080,1920,1080,2,100000,-100000);
  near(960,pan.offsetX);near(-540,pan.offsetY);point(pan,0,0,0,.5f);point(pan,1920,1080,.5f,1);
  float[] end=landscape.map(-200,4000,true);near(0,end[0]);near(1,end[1]);
  rejected(PcViewport.fit(0,1080,1080,1920,1,0,0),0,0);rejected(PcViewport.fit(1920,1080,0,0,1,0,0),0,0);rejected(landscape,Float.NaN,1000);
  PcViewport changed=PcViewport.fit(2560,1440,1280,720,1,0,0);point(changed,1280,720,1,1);point(changed,640,360,.5f,.5f);
  PcViewport landscapeKeyboard=PcViewport.fit(1920,1080,2340,420,1,0,0);point(landscapeKeyboard,1170,210,.5f,.5f);rejected(landscapeKeyboard,100,210);point(landscapeKeyboard,1170+landscapeKeyboard.width/4,210-landscapeKeyboard.height/4,.75f,.25f);
  PcViewport keyboardZoom=PcViewport.fit(1920,1080,2340,420,2,100000,-100000);float[] keyboardDrag=keyboardZoom.map(-1000,10000,true);near(0,keyboardDrag[0]);near(1,keyboardDrag[1]);
  System.out.println("Android PC viewport: letterbox, black bars, zoom, pan, drag clamp and resize passed.");
 }
}
