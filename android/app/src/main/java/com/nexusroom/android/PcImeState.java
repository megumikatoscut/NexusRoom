package com.nexusroom.android;

/**
 * Only IME pre-edit text lives here. Windows owns the committed text and caret;
 * treating this buffer as Windows surrounding text would delete unrelated input.
 */
final class PcImeState {
 interface Sink { boolean text(String value); boolean key(String key,int count); }
 private final Sink sink;
 private boolean active;
 private long generation;
 private String composing="";
 private int selectionStart,selectionEnd;
 PcImeState(Sink sink){this.sink=sink;}
 void restart(){generation++;active=true;clear();}
 void stop(){generation++;active=false;clear();}
 void discard(){generation++;clear();}
 void invalidate(){generation++;}
 long generation(){return generation;}
 boolean current(long value){return active&&generation==value;}
 String composing(){return composing;}
 int selectionStart(){return selectionStart;}
 int selectionEnd(){return selectionEnd;}
 boolean setComposingText(CharSequence value){
  if(!active||!valid(value))return false;
  composing=value.toString();selectionStart=selectionEnd=composing.length();return true;
 }
 boolean setSelection(int start,int end){
  if(!active||start<0||end<0||start>composing.length()||end>composing.length()
    ||splitsPair(start)||splitsPair(end))return false;
  selectionStart=start;selectionEnd=end;return true;
 }
 boolean commitText(CharSequence value){
  if(!active||!valid(value))return false;
  String text=value.toString();
  if(!text.isEmpty()&&!sink.text(text))return false;
  clear();return true;
 }
 boolean finishComposingText(){return active&&commitText(composing);}
 boolean deleteSurroundingText(int before,int after,boolean codePoints){
  if(!active||before<0||after<0||before>64||after>64)return false;
  if(!composing.isEmpty()){
   int left=Math.min(selectionStart,selectionEnd),right=Math.max(selectionStart,selectionEnd);
   if(codePoints){left=composing.offsetByCodePoints(left,-Math.min(before,composing.codePointCount(0,left)));right=composing.offsetByCodePoints(right,Math.min(after,composing.codePointCount(right,composing.length())));}
   else {left=Math.max(0,left-before);right=Math.min(composing.length(),right+after);if(splitsPair(left))left--;if(splitsPair(right))right++;}
   composing=composing.substring(0,left)+composing.substring(right);selectionStart=selectionEnd=left;return true;
  }
  // No local committed context is retained: these are relative Windows keys.
  if(before>0&&!sink.key("Backspace",before))return false;
  return after==0||sink.key("Delete",after);
 }
 boolean key(String key){
  if(!active||key==null)return false;
  if(key.equals("Backspace"))return deleteSurroundingText(1,0,true);
  if(key.equals("Delete"))return deleteSurroundingText(0,1,true);
  if(key.equals("Enter")){if(!finishComposingText())return false;return sink.key(key,1);}
  if(key.equals("Tab")||key.equals("Escape")||key.equals("Home")||key.equals("End")
    ||key.equals("ArrowLeft")||key.equals("ArrowRight")||key.equals("ArrowUp")||key.equals("ArrowDown")
    ||key.matches("Ctrl\\+(A|C|V|X|Enter|Backspace|Delete|Tab|Escape|Home|End|ArrowLeft|ArrowRight|ArrowUp|ArrowDown)")){
   // Navigation changes Windows focus/caret. Never finish an old pre-edit there.
   clear();return sink.key(key,1);
  }
  return false;
 }
 private boolean splitsPair(int position){return position>0&&position<composing.length()&&Character.isHighSurrogate(composing.charAt(position-1))&&Character.isLowSurrogate(composing.charAt(position));}
 private static boolean valid(CharSequence value){
  if(value==null||value.length()>8192)return false;
  for(int i=0;i<value.length();i++){
   char c=value.charAt(i);if(Character.isHighSurrogate(c)){if(++i>=value.length()||!Character.isLowSurrogate(value.charAt(i)))return false;}
   else if(Character.isLowSurrogate(c))return false;
  }
  return true;
 }
 private void clear(){composing="";selectionStart=selectionEnd=0;}
}
