package com.nexusroom.android;

import android.content.Context;
import android.graphics.Color;
import android.util.Log;
import android.view.View;
import android.widget.FrameLayout;
import org.webrtc.RendererCommon;
import org.webrtc.SurfaceViewRenderer;

/** Keeps the Surface itself at the video aspect, including in exact-size parents. */
final class AspectFitVideoFrame extends FrameLayout implements RendererCommon.RendererEvents {
    private final SurfaceViewRenderer renderer;
    private int frameWidth,frameHeight;
    private String previousLayout="";
    AspectFitVideoFrame(Context context,SurfaceViewRenderer renderer){
        super(context);this.renderer=renderer;setBackgroundColor(Color.BLACK);
        addView(renderer,new FrameLayout.LayoutParams(LayoutParams.WRAP_CONTENT,LayoutParams.WRAP_CONTENT));
    }
    @Override protected void onMeasure(int widthSpec,int heightSpec){
        int width=View.MeasureSpec.getSize(widthSpec),height=View.MeasureSpec.getSize(heightSpec);
        setMeasuredDimension(View.resolveSize(width,widthSpec),View.resolveSize(height,heightSpec));
        // WebRTC's FIT calculation is overridden when either dimension is
        // EXACTLY. Bound the child using AT_MOST in both axes; its own frame
        // resolution callback requests a fresh layout on rotation/resizing.
        renderer.measure(View.MeasureSpec.makeMeasureSpec(Math.max(0,getMeasuredWidth()-getPaddingLeft()-getPaddingRight()),View.MeasureSpec.AT_MOST),View.MeasureSpec.makeMeasureSpec(Math.max(0,getMeasuredHeight()-getPaddingTop()-getPaddingBottom()),View.MeasureSpec.AT_MOST));
    }
    @Override protected void onLayout(boolean changed,int left,int top,int right,int bottom){
        int width=right-left-getPaddingLeft()-getPaddingRight(),height=bottom-top-getPaddingTop()-getPaddingBottom();
        int videoWidth=renderer.getMeasuredWidth(),videoHeight=renderer.getMeasuredHeight();
        int x=getPaddingLeft()+(width-videoWidth)/2,y=getPaddingTop()+(height-videoHeight)/2;
        renderer.layout(x,y,x+videoWidth,y+videoHeight);
        String layout="frame="+frameWidth+"x"+frameHeight+" viewport="+width+"x"+height+" surface="+videoWidth+"x"+videoHeight;
        if(!layout.equals(previousLayout)){previousLayout=layout;Log.i("NexusRoom.RTC","videoFit "+layout);}
    }
    public void onFirstFrameRendered(){Log.i("NexusRoom.RTC","videoFirstFrameRendered");}
    public void onFrameResolutionChanged(int width,int height,int rotation){post(()->{boolean swap=rotation==90||rotation==270;frameWidth=swap?height:width;frameHeight=swap?width:height;requestLayout();});}
}
