package com.nexusroom.android;

import java.util.ArrayList;
import java.util.List;

public final class PcImeStateTest {
 private static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
 private static void equal(Object expected,Object actual){if(!expected.equals(actual))throw new AssertionError("Expected "+expected+", got "+actual);}
 private static final class Output implements PcImeState.Sink {
  final List<String> events=new ArrayList<>();boolean available=true;
  public boolean text(String value){if(!available)return false;events.add("text:"+value);return true;}
  public boolean key(String key,int count){if(!available)return false;events.add(key+":"+count);return true;}
 }
 public static void main(String[] args){
  Output output=new Output();PcImeState ime=new PcImeState(output);
  check(!ime.commitText("inactive")&&!ime.setComposingText("inactive")&&!ime.deleteSurroundingText(1,0,true),"An inactive editor rejects input");
  ime.restart();long first=ime.generation();check(ime.current(first),"New connection is current");
  for(String value:new String[]{"n","ni","nih","nihao"})check(ime.setComposingText(value),"Pinyin pre-edit accepted");
  check(output.events.isEmpty(),"Pinyin must stay in the phone IME");
  check(ime.commitText("你好"),"Chinese candidate committed");check(ime.finishComposingText(),"Finishing committed candidate is harmless");
  equal(List.of("text:你好"),output.events);equal("",ime.composing());
  ime.setComposingText("hello");ime.finishComposingText();ime.finishComposingText();
  equal(List.of("text:你好","text:hello"),output.events);
  ime.setComposingText("你😀a");ime.deleteSurroundingText(1,0,true);equal("你😀",ime.composing());ime.deleteSurroundingText(1,0,true);equal("你",ime.composing());
  ime.setComposingText("你😀");ime.deleteSurroundingText(1,0,false);equal("你",ime.composing());
  check(output.events.size()==2,"Deleting local pre-edit never deletes Windows text");
  ime.setComposingText("ab😀cd");check(ime.setSelection(2,4),"Whole emoji can be selected");ime.deleteSurroundingText(1,1,true);equal("ad",ime.composing());
  ime.setComposingText("😀");check(!ime.setSelection(1,1),"Selection cannot split a surrogate pair");ime.deleteSurroundingText(64,64,true);equal("",ime.composing());
  check(output.events.size()==2,"Deletion beyond pre-edit does not erase unknown remote context");
  ime.deleteSurroundingText(3,2,true);equal(List.of("Backspace:3","Delete:2"),output.events.subList(2,4));
  check(!ime.deleteSurroundingText(-1,0,true)&&!ime.deleteSurroundingText(65,0,false)&&!ime.deleteSurroundingText(0,65,true),"Deletion is bounded and rejects invalid lengths");
  int count=output.events.size();
  check(!ime.setComposingText(null)&&!ime.commitText("x".repeat(8193))&&!ime.commitText("\ud800")&&!ime.setComposingText("\udc00"),"Invalid UTF-16 and oversized input are rejected");
  check(!ime.key("Ctrl+Z")&&!ime.key(null),"Unsupported editor actions are rejected");equal(count,output.events.size());
  ime.commitText("🚀\n第二行");equal("text:🚀\n第二行",output.events.get(output.events.size()-1));
  ime.setComposingText("letter");output.available=false;check(!ime.commitText("candidate"),"Failed transport does not consume composition");equal("letter",ime.composing());output.available=true;
  ime.key("Enter");equal(List.of("text:letter","Enter:1"),output.events.subList(output.events.size()-2,output.events.size()));
  ime.setComposingText("old_focus");ime.key("Ctrl+A");ime.finishComposingText();equal("Ctrl+A:1",output.events.get(output.events.size()-1));
  ime.setComposingText("stale");ime.discard();check(!ime.current(first),"Discard invalidates an old InputConnection");
  ime.restart();long second=ime.generation();ime.setComposingText("new_focus");ime.invalidate();check(!ime.current(second),"A restarted Android input connection cannot submit late callbacks");
  ime.restart();equal("",ime.composing());check(!ime.current(second),"Old connection cannot clear a new editor");
  ime.setComposingText("closing");ime.stop();count=output.events.size();check(!ime.finishComposingText()&&!ime.key("Enter")&&!ime.commitText("late"),"Session close never flushes stale composition");equal(count,output.events.size());
  System.out.println("Android direct IME: composition, Chinese commit once, emoji deletion, key counts, invalid input, focus generations and teardown passed.");
 }
}
