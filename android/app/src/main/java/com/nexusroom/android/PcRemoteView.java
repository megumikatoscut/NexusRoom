package com.nexusroom.android;

import android.app.Activity;
import android.content.*;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.*;
import android.graphics.drawable.GradientDrawable;
import android.os.*;
import android.text.InputType;
import android.text.Editable;
import android.text.Selection;
import android.text.SpannableStringBuilder;
import android.view.*;
import android.view.inputmethod.BaseInputConnection;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import android.widget.*;
import org.json.JSONObject;

/** Native remote desktop: fitted coordinates, explicit Unicode input and bounded local playback. */
@android.annotation.SuppressLint("ViewConstructor") // Created only after selecting an authenticated room; never inflated from XML.
final class PcRemoteView extends FrameLayout implements PcRemoteSession.Listener {
 private final Activity activity;
 private final Runnable dismissed;
 private final PcRemoteSession session;
 private final DesktopCanvas desktop;
 private final TextView status;
 private final Button sound;
 private final Button phoneKeyboard,orientation,moreKeys;
 private final TextView title,help;
 private final HorizontalScrollView keys;
 private final int previousOrientation;
 private final LinearLayout editor;
 private final EditText input;
 private final java.util.List<Button> sessionButtons=new java.util.ArrayList<>();
 private final java.util.List<Button> controlButtons=new java.util.ArrayList<>(),clipboardButtons=new java.util.ArrayList<>();
 private Button exitButton;
 private boolean audioOn,closed,sessionEnded,controlAllowed,clipboardAllowed,directKeyboard,expandedKeys;
 private long editorRevision;
 private final int accent=Color.rgb(17,139,119);
 PcRemoteView(Activity activity,RoomService.RoomLink link,Runnable dismissed){super(activity);this.activity=activity;this.dismissed=dismissed;previousOrientation=activity.getRequestedOrientation();session=new PcRemoteSession(activity,link,this);setBackgroundColor(0xff102422);setContentDescription("安卓远程控制电脑");setFocusableInTouchMode(true);
  LinearLayout layout=new LinearLayout(activity);layout.setOrientation(LinearLayout.VERTICAL);layout.setPadding(dp(10),dp(8),dp(10),dp(8));addView(layout,new FrameLayout.LayoutParams(-1,-1));
  title=label("控制电脑 · "+link.config.hostName,17);title.setSingleLine(true);title.setEllipsize(android.text.TextUtils.TruncateAt.END);layout.addView(title);
  status=label("正在请求电脑确认…",12);status.setContentDescription("电脑远程控制状态");status.setPadding(dp(4),dp(3),dp(4),dp(3));status.setMaxLines(2);layout.addView(status);
  desktop=new DesktopCanvas();desktop.setContentDescription("电脑远程桌面；单击点击，长按右击，滑动拖动，双指滚动或缩放");layout.addView(desktop,new LinearLayout.LayoutParams(-1,0,1));
  help=label("点击电脑输入框，再点「手机键盘」直接输入 · 长按右击 · 双指滚动 / 缩放",11);help.setPadding(dp(2),dp(5),dp(2),dp(5));layout.addView(help);
  HorizontalScrollView tools=new HorizontalScrollView(activity);tools.setHorizontalScrollBarEnabled(false);LinearLayout actions=row();tools.addView(actions);layout.addView(tools);
  phoneKeyboard=controlButton("手机键盘",v->togglePhoneKeyboard());phoneKeyboard.setContentDescription("手机键盘直接输入电脑");actions.addView(phoneKeyboard);
  actions.addView(controlButton("文字输入",v->toggleEditor()));
  orientation=button("横屏",v->toggleOrientation());orientation.setContentDescription("切换远程桌面横竖屏");actions.addView(orientation);
  exitButton=button("退出",v->closeView());actions.addView(exitButton);
  sound=button("声音：静音",v->session.setAudioEnabled(!audioOn));sound.setContentDescription("电脑音频播放开关");actions.addView(sound);
  actions.addView(button("适应屏幕",v->desktop.resetZoom()));actions.addView(controlButton("右击",v->desktop.clickCenter("right")));actions.addView(controlButton("滚动↑",v->send("scroll",object("deltaY",120))));actions.addView(controlButton("滚动↓",v->send("scroll",object("deltaY",-120))));
  moreKeys=button("更多按键",v->{expandedKeys=!expandedKeys;updateLayoutMode();});actions.addView(moreKeys);
  actions.addView(button("切换手机键盘",v->keyboardManager().showInputMethodPicker()));
  keys=new HorizontalScrollView(activity);keys.setHorizontalScrollBarEnabled(false);LinearLayout shortcuts=row();keys.addView(shortcuts);layout.addView(keys);
  for(String key:new String[]{"Enter","Backspace","Tab","Escape","Ctrl+A","Ctrl+C","Ctrl+V","Ctrl+X","Home","End","ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Delete"})shortcuts.addView(controlButton(key,v->key(key)));
  shortcuts.addView(clipboardButton("复制电脑剪贴板",v->{if(!clipboardAllowed){status("请在电脑允许此房间使用剪贴板");return;}session.input("clipboard_get",new JSONObject(),result->{String text=result.optString("text");((ClipboardManager)activity.getSystemService(Context.CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("NexusRoom 电脑",text));status("电脑剪贴板已复制到手机");});}));
  shortcuts.addView(clipboardButton("发送手机剪贴板",v->{if(!clipboardAllowed){status("请在电脑允许此房间使用剪贴板");return;}ClipboardManager manager=(ClipboardManager)activity.getSystemService(Context.CLIPBOARD_SERVICE);ClipData clip=manager.getPrimaryClip();if(clip==null||clip.getItemCount()==0||clip.getItemAt(0).getText()==null){status("手机剪贴板没有文本");return;}String text=clip.getItemAt(0).getText().toString();if(text.length()>65536){status("剪贴板文本超过 65536 字符");return;}session.input("clipboard_set",object("text",text),r->status("手机文本已发送到电脑剪贴板"));}));
  editor=new LinearLayout(activity);editor.setOrientation(LinearLayout.VERTICAL);editor.setVisibility(GONE);layout.addView(editor);
  input=new EditText(activity);input.setHint("先点击电脑输入框，再输入文字并发送");input.setContentDescription("发送到电脑的文字输入框");input.setTextColor(Color.WHITE);input.setHintTextColor(0xffa9bbb8);input.setTextSize(14);input.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_MULTI_LINE|InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);input.setMinLines(1);input.setMaxLines(3);editor.addView(input,new LinearLayout.LayoutParams(-1,-2));
  input.addTextChangedListener(new android.text.TextWatcher(){public void beforeTextChanged(CharSequence s,int start,int count,int after){}public void onTextChanged(CharSequence s,int start,int before,int count){editorRevision++;}public void afterTextChanged(Editable value){}});
  LinearLayout editActions=row();editActions.addView(controlButton("发送文字",v->{if(!controlAllowed){status("电脑屏幕可查看；请在电脑开启此房间的输入控制权限");return;}String value=input.getText().toString();if(value.isEmpty())return;if(value.length()>8192){status("每次输入最多 8192 字符");return;}long revision=editorRevision;session.input("text",object("text",value),r->{if(editorRevision==revision)input.setText("");status("文字已发送到电脑");});}),new LinearLayout.LayoutParams(0,-2,1));editActions.addView(controlButton("回车",v->key("Enter")));editActions.addView(button("切换键盘",v->((InputMethodManager)activity.getSystemService(Context.INPUT_METHOD_SERVICE)).showInputMethodPicker()));editActions.addView(button("收起键盘",v->hideEditor()));editor.addView(editActions);
  requestFocus();updateLayoutMode();session.start();
 }
 private JSONObject object(String key,Object value){try{return new JSONObject().put(key,value);}catch(Exception e){return new JSONObject();}}
 private JSONObject point(String action,String button,float x,float y){try{return new JSONObject().put("action",action).put("button",button).put("x",x).put("y",y);}catch(Exception e){return new JSONObject();}}
 private boolean send(String tool,JSONObject args){if(closed||sessionEnded)return false;if(!controlAllowed){status("电脑屏幕可查看；请在电脑开启此房间的输入控制权限");return false;}return session.input(tool,args);}
 private boolean key(String key){if(directKeyboard){boolean accepted=desktop.ime.key(key);desktop.syncPreedit();if(accepted&&!key.equals("Enter")&&!key.equals("Backspace")&&!key.equals("Delete"))desktop.discardPreedit();return accepted;}return send("key",object("key",key));}
 @Override public void status(String value){if(closed||sessionEnded)return;status.setText(value);}
 @Override public void connected(JSONObject welcome){JSONObject permissions=welcome.optJSONObject("permissions");controlAllowed=permissions!=null&&permissions.optBoolean("control");clipboardAllowed=permissions!=null&&permissions.optBoolean("clipboard");for(Button button:controlButtons)button.setEnabled(controlAllowed);for(Button button:clipboardButtons)button.setEnabled(clipboardAllowed);desktop.remoteWidth=welcome.optInt("width");desktop.remoteHeight=welcome.optInt("height");desktop.invalidate();status(controlAllowed?"电脑正在工作 · 手机键盘可直接输入 · 音频默认静音":"电脑正在工作 · 当前为仅观看模式 · 音频默认静音");}
 @Override public void frame(Bitmap bitmap,long pts){if(closed||sessionEnded){bitmap.recycle();return;}desktop.frame(bitmap);}
 @Override public void audioEnabled(boolean enabled){if(closed)return;audioOn=enabled&&!sessionEnded;sound.setText(audioOn?"声音：播放":"声音：静音");}
 @Override public void ended(String reason){if(closed||sessionEnded)return;sessionEnded=true;controlAllowed=clipboardAllowed=false;audioEnabled(false);hidePhoneKeyboard();desktop.cancelGestures();desktop.stop();hideEditor();input.setEnabled(false);for(Button button:sessionButtons)if(button!=exitButton){button.setEnabled(false);button.setAlpha(.45f);}status.setText(activity.getString(R.string.pc_remote_session_ended,reason));}
 private InputMethodManager keyboardManager(){return (InputMethodManager)activity.getSystemService(Context.INPUT_METHOD_SERVICE);}
 private void togglePhoneKeyboard(){if(directKeyboard){hidePhoneKeyboard();return;}if(!controlAllowed){status("请先在电脑允许此房间使用输入控制");return;}hideEditor();expandedKeys=false;directKeyboard=true;phoneKeyboard.setText("收起手机键盘");desktop.ime.restart();desktop.requestFocus();keyboardManager().restartInput(desktop);desktop.post(()->{if(directKeyboard&&!closed&&!sessionEnded)keyboardManager().showSoftInput(desktop,InputMethodManager.SHOW_IMPLICIT);});updateLayoutMode();status("手机键盘直接输入电脑 · 点击电脑输入框后输入");}
 private void hidePhoneKeyboard(){directKeyboard=false;phoneKeyboard.setText("手机键盘");desktop.invalidateInputConnection();desktop.ime.stop();desktop.syncPreedit();keyboardManager().hideSoftInputFromWindow(desktop.getWindowToken(),0);keyboardManager().restartInput(desktop);updateLayoutMode();}
 private void toggleOrientation(){desktop.cancelGestures();desktop.discardPreedit();boolean landscape=getResources().getConfiguration().orientation==Configuration.ORIENTATION_LANDSCAPE;activity.setRequestedOrientation(landscape?ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT:ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);}
 @Override protected void onConfigurationChanged(Configuration config){super.onConfigurationChanged(config);desktop.cancelGestures();desktop.discardPreedit();updateLayoutMode();}
 @Override protected void onMeasure(int widthMeasureSpec,int heightMeasureSpec){
  // The weighted canvas is measured after these rows. Changing GONE rows in
  // onSizeChanged/onLayout would leave its already assigned height too large.
  int availableHeight=MeasureSpec.getMode(heightMeasureSpec)==MeasureSpec.UNSPECIFIED?0:MeasureSpec.getSize(heightMeasureSpec);
  applyLayoutMode(availableHeight);super.onMeasure(widthMeasureSpec,heightMeasureSpec);
 }
 private void updateLayoutMode(){requestLayout();}
 private void applyLayoutMode(int availableHeight){
  if(title==null||keys==null)return;
  boolean landscape=getResources().getConfiguration().orientation==Configuration.ORIENTATION_LANDSCAPE;
  boolean compact=landscape||(availableHeight>0&&availableHeight<dp(430));
  title.setVisibility(compact?GONE:VISIBLE);help.setVisibility(compact?GONE:VISIBLE);
  int lines=compact?1:2;if(status.getMaxLines()!=lines)status.setMaxLines(lines);
  // IME height varies by vendor and font scale. Always reserve a visible
  // desktop above the primary tool row; a stale expanded row must not eat it.
  int minimumDesktop=Math.max(80,dp(24)),primaryBudget=dp(16+48);
  int statusHeight=status.getLineHeight()+status.getCompoundPaddingTop()+status.getCompoundPaddingBottom();
  boolean showStatus=!compact||availableHeight<=0||availableHeight-primaryBudget-statusHeight>=minimumDesktop;
  status.setVisibility(showStatus?VISIBLE:GONE);
  boolean roomForKeys=availableHeight<=0||availableHeight-primaryBudget-(showStatus?statusHeight:0)-dp(48)>=minimumDesktop;
  if(compact&&expandedKeys&&!roomForKeys)expandedKeys=false;
  keys.setVisibility(!compact||expandedKeys?VISIBLE:GONE);
  String keysLabel=expandedKeys?"收起按键":"更多按键",directionLabel=landscape?"竖屏":"横屏";
  if(!keysLabel.contentEquals(moreKeys.getText()))moreKeys.setText(keysLabel);
  if(!directionLabel.contentEquals(orientation.getText()))orientation.setText(directionLabel);
 }
 private void toggleEditor(){if(closed||sessionEnded||!controlAllowed)return;if(editor.getVisibility()==VISIBLE){hideEditor();return;}if(directKeyboard)hidePhoneKeyboard();editor.setVisibility(VISIBLE);input.requestFocus();input.post(()->{if(!closed&&!sessionEnded&&controlAllowed&&editor.getVisibility()==VISIBLE&&input.hasFocus()&&input.isAttachedToWindow())keyboardManager().showSoftInput(input,InputMethodManager.SHOW_IMPLICIT);});}
 private void hideEditor(){((InputMethodManager)activity.getSystemService(Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(input.getWindowToken(),0);editor.setVisibility(GONE);input.clearFocus();requestFocus();}
 boolean back(){if(editor.getVisibility()==VISIBLE){hideEditor();return true;}if(directKeyboard){hidePhoneKeyboard();return true;}closeView();return true;}
 void closeView(){if(closed)return;desktop.cancelGestures();closed=true;desktop.invalidateInputConnection();desktop.ime.stop();session.close();desktop.clear();keyboardManager().hideSoftInputFromWindow(getWindowToken(),0);activity.setRequestedOrientation(previousOrientation);dismissed.run();}
 @Override public boolean dispatchKeyEvent(KeyEvent event){if(!closed&&!sessionEnded&&!input.hasFocus()&&event.getKeyCode()!=KeyEvent.KEYCODE_BACK){if(handleRemoteKey(event))return true;}return super.dispatchKeyEvent(event);}
 private boolean handleRemoteKey(KeyEvent event){if(!controlAllowed||closed||sessionEnded)return false;String value=hardwareKey(event);if(value!=null){if(event.getAction()==KeyEvent.ACTION_DOWN)key(value);return true;}if(event.getAction()==KeyEvent.ACTION_MULTIPLE&&event.getCharacters()!=null){if(directKeyboard)desktop.ime.commitText(event.getCharacters());else send("text",object("text",event.getCharacters()));desktop.syncPreedit();return true;}if(event.getAction()==KeyEvent.ACTION_DOWN&&!event.isCtrlPressed()&&!event.isAltPressed()){int unicode=event.getUnicodeChar();if(unicode>0&&!Character.isISOControl(unicode)){String text=new String(Character.toChars(unicode));if(directKeyboard)desktop.ime.commitText(text);else send("text",object("text",text));desktop.syncPreedit();return true;}}return false;}
 private String hardwareKey(KeyEvent event){String base;switch(event.getKeyCode()){case KeyEvent.KEYCODE_ENTER:base="Enter";break;case KeyEvent.KEYCODE_DEL:base="Backspace";break;case KeyEvent.KEYCODE_FORWARD_DEL:base="Delete";break;case KeyEvent.KEYCODE_TAB:base="Tab";break;case KeyEvent.KEYCODE_ESCAPE:base="Escape";break;case KeyEvent.KEYCODE_MOVE_HOME:base="Home";break;case KeyEvent.KEYCODE_MOVE_END:base="End";break;case KeyEvent.KEYCODE_DPAD_LEFT:base="ArrowLeft";break;case KeyEvent.KEYCODE_DPAD_RIGHT:base="ArrowRight";break;case KeyEvent.KEYCODE_DPAD_UP:base="ArrowUp";break;case KeyEvent.KEYCODE_DPAD_DOWN:base="ArrowDown";break;default:if(event.isCtrlPressed()&&(event.getKeyCode()==KeyEvent.KEYCODE_A||event.getKeyCode()==KeyEvent.KEYCODE_C||event.getKeyCode()==KeyEvent.KEYCODE_V||event.getKeyCode()==KeyEvent.KEYCODE_X))return "Ctrl+"+KeyEvent.keyCodeToString(event.getKeyCode()).replace("KEYCODE_","");return null;}return event.isCtrlPressed()?"Ctrl+"+base:base;}
 private TextView label(String text,int size){TextView view=new TextView(activity);view.setText(text);view.setTextSize(size);view.setTextColor(0xffe6f2ef);return view;}
 private Button controlButton(String text,View.OnClickListener action){Button button=button(text,action);controlButtons.add(button);button.setEnabled(false);return button;}
 private Button clipboardButton(String text,View.OnClickListener action){Button button=button(text,action);clipboardButtons.add(button);button.setEnabled(false);return button;}
 private Button button(String text,View.OnClickListener action){Button button=new Button(activity);sessionButtons.add(button);button.setText(text);button.setContentDescription(text);button.setTextColor(Color.WHITE);button.setTextSize(12);button.setAllCaps(false);button.setFocusable(false);button.setMinWidth(dp(62));button.setMinHeight(dp(42));button.setPadding(dp(9),0,dp(9),0);GradientDrawable background=new GradientDrawable();background.setColor(accent);background.setCornerRadius(dp(7));button.setBackground(background);button.setOnClickListener(action);LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-2,dp(42));params.setMargins(dp(3),dp(3),dp(3),dp(3));button.setLayoutParams(params);return button;}
 private LinearLayout row(){LinearLayout row=new LinearLayout(activity);row.setOrientation(LinearLayout.HORIZONTAL);row.setGravity(Gravity.CENTER_VERTICAL);return row;}
 private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}

 private final class DesktopCanvas extends View {
  private Bitmap bitmap;
  private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG|Paint.FILTER_BITMAP_FLAG);
  private final RectF bounds=new RectF();
  private PcViewport viewport=PcViewport.fit(0,0,0,0,1,0,0);
  private final GestureDetector gestures;
  private long inputGeneration;
  private final SpannableStringBuilder preedit=new SpannableStringBuilder();
  private final PcImeState ime=new PcImeState(new PcImeState.Sink(){
   public boolean text(String value){return directKeyboard&&send("text",object("text",value));}
   public boolean key(String key,int count){try{return directKeyboard&&send("key",new JSONObject().put("key",key).put("count",count));}catch(Exception e){return false;}}
  });
  private float zoom=1,offsetX,offsetY,downX,downY,lastX,lastY,lastDistance;
  private float[] accessibilityClick,downPoint,lastRemotePoint;
  private long cancelledBefore;
  private boolean downInside,dragging,multiple,scaling,stopped,doubleTapping;
  int remoteWidth,remoteHeight;
  DesktopCanvas(){super(activity);setBackgroundColor(0xff071311);setClickable(true);setFocusable(true);setFocusableInTouchMode(true);gestures=new GestureDetector(activity,new GestureDetector.SimpleOnGestureListener(){
   @Override public boolean onDown(MotionEvent e){return true;}
   @Override public boolean onSingleTapUp(MotionEvent e){if(e.getDownTime()>cancelledBefore&&!multiple&&!dragging&&!doubleTapping){accessibilityClick=map(e.getX(),e.getY());if(accessibilityClick!=null)performClick();accessibilityClick=null;}return true;}
   @Override public boolean onDoubleTap(MotionEvent e){doubleTapping=true;float[] point=map(e.getX(),e.getY());if(point!=null){if(directKeyboard)discardPreedit();send("click",point("","left",point[0],point[1]));}return true;}
   @Override public void onLongPress(MotionEvent e){if(multiple||dragging)return;float[] point=map(e.getX(),e.getY());if(point!=null){send("click",point("","right",point[0],point[1]));downInside=false;}}
  });}
  void syncPreedit(){BaseInputConnection.removeComposingSpans(preedit);preedit.replace(0,preedit.length(),ime.composing());Selection.setSelection(preedit,ime.selectionStart(),ime.selectionEnd());if(preedit.length()>0)BaseInputConnection.setComposingSpans(preedit);keyboardManager().updateSelection(this,ime.selectionStart(),ime.selectionEnd(),preedit.length()>0?0:-1,preedit.length()>0?preedit.length():-1);}
  void invalidateInputConnection(){inputGeneration++;ime.invalidate();}
  void discardPreedit(){invalidateInputConnection();ime.discard();syncPreedit();if(directKeyboard)keyboardManager().restartInput(this);}
  @Override public boolean onCheckIsTextEditor(){return directKeyboard&&controlAllowed&&!closed&&!sessionEnded;}
  @Override public InputConnection onCreateInputConnection(EditorInfo info){
   if(!onCheckIsTextEditor())return null;
   final long generation=++inputGeneration;
   info.inputType=InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_MULTI_LINE|InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS;
   info.imeOptions=EditorInfo.IME_ACTION_NONE|EditorInfo.IME_FLAG_NO_EXTRACT_UI|EditorInfo.IME_FLAG_NO_FULLSCREEN|EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING;
   info.initialSelStart=info.initialSelEnd=0;info.hintText="直接输入电脑当前光标位置";
   ime.restart();final long imeGeneration=ime.generation();syncPreedit();
   return new BaseInputConnection(this,true){
    private boolean usable(){return generation==inputGeneration&&ime.current(imeGeneration)&&onCheckIsTextEditor();}
    @Override public Editable getEditable(){return usable()?preedit:null;}
    @Override public boolean setComposingText(CharSequence text,int cursor){if(!usable())return false;boolean accepted=ime.setComposingText(text);syncPreedit();return accepted;}
    @Override public boolean commitText(CharSequence text,int cursor){if(!usable())return false;boolean accepted=ime.commitText(text);syncPreedit();return accepted;}
    @Override public boolean finishComposingText(){if(!usable())return false;boolean accepted=ime.finishComposingText();syncPreedit();return accepted;}
    @Override public boolean deleteSurroundingText(int before,int after){if(!usable())return false;boolean accepted=ime.deleteSurroundingText(before,after,false);syncPreedit();return accepted;}
    @Override public boolean deleteSurroundingTextInCodePoints(int before,int after){if(!usable())return false;boolean accepted=ime.deleteSurroundingText(before,after,true);syncPreedit();return accepted;}
    @Override public boolean setSelection(int start,int end){if(!usable())return false;boolean accepted=ime.setSelection(start,end);syncPreedit();return accepted;}
    @Override public boolean setComposingRegion(int start,int end){return usable()&&start==0&&end==preedit.length();}
    @Override public boolean sendKeyEvent(KeyEvent event){return usable()&&handleRemoteKey(event);}
    @Override public boolean performEditorAction(int action){if(!usable())return false;boolean accepted=ime.key("Enter");syncPreedit();return accepted;}
    @Override public boolean performContextMenuAction(int id){if(!usable())return false;String key=id==android.R.id.selectAll?"Ctrl+A":id==android.R.id.cut?"Ctrl+X":id==android.R.id.copy?"Ctrl+C":id==android.R.id.paste?"Ctrl+V":null;return key!=null&&PcRemoteView.this.key(key);}
    @Override public void closeConnection(){if(usable()){invalidateInputConnection();ime.discard();syncPreedit();}super.closeConnection();}
   };
  }
  @Override protected void onSizeChanged(int w,int h,int oldw,int oldh){super.onSizeChanged(w,h,oldw,oldh);if(oldw>0&&oldh>0&&(w!=oldw||h!=oldh))cancelGestures();}
  void frame(Bitmap value){Bitmap old=bitmap;if(remoteWidth!=value.getWidth()||remoteHeight!=value.getHeight())cancelGestures();bitmap=value;remoteWidth=value.getWidth();remoteHeight=value.getHeight();if(old!=null&&!old.isRecycled())old.recycle();invalidate();}
  void clear(){Bitmap old=bitmap;bitmap=null;if(old!=null&&!old.isRecycled())old.recycle();}
  void stop(){stopped=true;clear();invalidate();}
  void resetZoom(){cancelGestures();zoom=1;offsetX=offsetY=0;invalidate();}
  private void updateBounds(){viewport=PcViewport.fit(remoteWidth,remoteHeight,getWidth(),getHeight(),zoom,offsetX,offsetY);offsetX=viewport.offsetX;offsetY=viewport.offsetY;bounds.set(viewport.left,viewport.top,viewport.left+viewport.width,viewport.top+viewport.height);}
  @Override protected void onDraw(Canvas canvas){super.onDraw(canvas);updateBounds();if(bitmap!=null&&!bitmap.isRecycled())canvas.drawBitmap(bitmap,null,bounds,paint);else{paint.setColor(0xffa7bdb8);paint.setTextSize(dp(14));paint.setTextAlign(Paint.Align.CENTER);canvas.drawText(stopped?"会话已停止，请退出后重新请求":"等待电脑共享画面",getWidth()/2f,getHeight()/2f,paint);}}
  private float[] map(float x,float y){updateBounds();return viewport.map(x,y,false);}
  private float[] clamp(float x,float y){updateBounds();return viewport.map(x,y,true);}
  void clickCenter(String button){if(directKeyboard)discardPreedit();float[] point=map(getWidth()/2f,getHeight()/2f);if(point!=null)send("click",point("",button,point[0],point[1]));}
  @Override public boolean performClick(){super.performClick();float[] point=accessibilityClick==null?map(getWidth()/2f,getHeight()/2f):accessibilityClick;if(point!=null){if(directKeyboard)discardPreedit();send("click",point("","left",point[0],point[1]));}return true;}
  void releasePointer(){if(dragging){float[] point=lastRemotePoint;if(point!=null)session.input("pointer",point("up","left",point[0],point[1]));dragging=false;lastRemotePoint=null;}}
  void cancelGestures(){releasePointer();cancelledBefore=SystemClock.uptimeMillis();downInside=false;downPoint=accessibilityClick=null;multiple=scaling=false;MotionEvent cancel=MotionEvent.obtain(cancelledBefore,cancelledBefore,MotionEvent.ACTION_CANCEL,0,0,0);gestures.onTouchEvent(cancel);cancel.recycle();}
  @android.annotation.SuppressLint("ClickableViewAccessibility") // Single taps call performClick on finger-up before subsequent keyboard commits.
  @Override public boolean onTouchEvent(MotionEvent event){if(closed||sessionEnded)return true;int action=event.getActionMasked();
   if(action==MotionEvent.ACTION_DOWN){releasePointer();multiple=scaling=doubleTapping=false;downX=lastX=event.getX();downY=lastY=event.getY();downPoint=map(downX,downY);downInside=downPoint!=null;if(directKeyboard&&downInside){discardPreedit();requestFocus();}}
   if(action!=MotionEvent.ACTION_DOWN&&event.getDownTime()<=cancelledBefore)return true;
   if(action==MotionEvent.ACTION_POINTER_DOWN&&event.getPointerCount()>=2){releasePointer();multiple=true;lastX=(event.getX(0)+event.getX(1))/2;lastY=(event.getY(0)+event.getY(1))/2;lastDistance=distance(event);MotionEvent cancel=MotionEvent.obtain(event);cancel.setAction(MotionEvent.ACTION_CANCEL);gestures.onTouchEvent(cancel);cancel.recycle();return true;}
   if(event.getPointerCount()>=2&&action==MotionEvent.ACTION_MOVE){float x=(event.getX(0)+event.getX(1))/2,y=(event.getY(0)+event.getY(1))/2,distance=distance(event);float ratio=lastDistance>0?distance/lastDistance:1;if(Math.abs(ratio-1)>.025f)scaling=true;
    if(scaling){float old=zoom;zoom=Math.max(1,Math.min(4,zoom*ratio));offsetX=(offsetX+(getWidth()/2f-x))*(zoom/old)-(getWidth()/2f-x);offsetY=(offsetY+(getHeight()/2f-y))*(zoom/old)-(getHeight()/2f-y);invalidate();}
    else if(zoom>1.05f){offsetX+=x-lastX;offsetY+=y-lastY;invalidate();}
    else try{float deltaY=(y-lastY)*120/dp(45),deltaX=(lastX-x)*120/dp(45);float[] point=map(x,y);if(point!=null&&Math.abs(deltaY)+Math.abs(deltaX)>1){send("pointer",point("move","left",point[0],point[1]));send("scroll",new JSONObject().put("deltaX",Math.round(deltaX)).put("deltaY",Math.round(deltaY)));}}catch(Exception ignored){}
    lastX=x;lastY=y;lastDistance=distance;return true;
   }
   if(action==MotionEvent.ACTION_MOVE&&!multiple&&downInside){lastX=event.getX();lastY=event.getY();float[] current=clamp(lastX,lastY);if(current!=null){if(!dragging&&Math.hypot(lastX-downX,lastY-downY)>ViewConfiguration.get(activity).getScaledTouchSlop()){if(downPoint!=null){send("pointer",point("down","left",downPoint[0],downPoint[1]));dragging=true;lastRemotePoint=downPoint;}}if(dragging){lastRemotePoint=current;send("pointer",point("move","left",current[0],current[1]));}}}
   if(action==MotionEvent.ACTION_UP||action==MotionEvent.ACTION_CANCEL){boolean wasDragging=dragging;releasePointer();if(wasDragging||multiple||!downInside){MotionEvent cancel=MotionEvent.obtain(event);cancel.setAction(MotionEvent.ACTION_CANCEL);gestures.onTouchEvent(cancel);cancel.recycle();return true;}}
   if(!multiple&&!dragging)gestures.onTouchEvent(event);return true;
  }
  private float distance(MotionEvent event){return (float)Math.hypot(event.getX(1)-event.getX(0),event.getY(1)-event.getY(0));}
 }
}
