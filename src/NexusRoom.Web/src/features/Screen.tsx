import { useEffect, useRef, useState, type PointerEvent, type WheelEvent, type KeyboardEvent } from 'react';
import { Smartphone, Maximize2, ArrowLeft, Circle, Square, Volume2, VolumeX, Keyboard } from 'lucide-react';
import { command, api } from '../api';
import { useRoom } from '../context';
import type { Device } from '../types';

export function Screen({device}:{device:Device}) {
 const {notify}=useRoom();
 const [streamError,setStreamError]=useState(''),[retryCount,setRetryCount]=useState(0);
 const [connected,setConnected]=useState(false),[size,setSize]=useState({width:0,height:0}),[focused,setFocused]=useState(false),[audible,setAudible]=useState(false),[volume,setVolume]=useState(.8);
 const stage=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null),ime=useRef<HTMLTextAreaElement>(null);
 const down=useRef<{x:number;y:number;time:number}|null>(null),scrollTime=useRef(0),queue=useRef(Promise.resolve()),composing=useRef(false);
 const audio=useRef<AudioContext|null>(null),gain=useRef<GainNode|null>(null),audioTime=useRef(0),audioEnabled=useRef(false),generation=useRef(0);
 const usable=device.online&&device.activity!=='busy'&&device.permissions.control;
 const latest=useRef({id:device.id,usable});latest.current={id:device.id,usable};
 const input=(tool:string,args:Record<string,unknown>={},copied=false)=>{
  const id=device.id,gen=generation.current;
  queue.current=queue.current.then(async()=>{if(gen!==generation.current||!latest.current.usable||latest.current.id!==id)return;const r=await command(id,tool,args) as {text?:string};if(copied&&r.text!==undefined)await api('/api/clipboard',{text:r.text});}).catch(e=>notify((e as Error).message,true));
 };
 useEffect(()=>{return()=>{generation.current++;void audio.current?.close();audio.current=null;};},[]);
 const sound=async()=>{if(!audio.current){audio.current=new AudioContext({latencyHint:'interactive'});gain.current=audio.current.createGain();gain.current.connect(audio.current.destination);}await audio.current.resume();audioEnabled.current=!audioEnabled.current;gain.current!.gain.value=audioEnabled.current?volume:0;audioTime.current=0;setAudible(audioEnabled.current);};
 useEffect(()=>{if(gain.current)gain.current.gain.value=audible?volume:0;},[volume,audible]);
 useEffect(()=>{if(!device.permissions.audio||!device.permissions.screen){if(gain.current)gain.current.gain.value=0;audioEnabled.current=false;setAudible(false);audioTime.current=0;}},[device.permissions.audio,device.permissions.screen]);
 useEffect(()=>{
  if(!device.online||!device.permissions.screen||device.activity!=='working'){setConnected(false);setStreamError('');return;}
  setStreamError('');
  let active=true,socket:WebSocket|undefined,retry:ReturnType<typeof setTimeout>,decoder:VideoDecoder|undefined;
  let config=new Uint8Array(0),needsKey=true,reported=false,rendered=false;
  let firstFrameTimer:ReturnType<typeof setTimeout>;
  const configure=(bytes:Uint8Array)=>{
   let codec='avc1.42E01E';for(let i=0;i+6<bytes.length;i++)if(bytes[i]===0&&bytes[i+1]===0&&bytes[i+2]===1&&(bytes[i+3]&31)===7){codec='avc1.'+Array.from(bytes.slice(i+4,i+7)).map(v=>v.toString(16).padStart(2,'0')).join('');break;}
   if(decoder?.state!=='closed')decoder?.close();
   decoder=new VideoDecoder({output:frame=>{try{if(!active||!canvas.current)return;const c=canvas.current;if(c.width!==frame.displayWidth||c.height!==frame.displayHeight){c.width=frame.displayWidth;c.height=frame.displayHeight;setSize({width:c.width,height:c.height});}c.getContext('2d',{alpha:false})?.drawImage(frame,0,0);rendered=true;clearTimeout(firstFrameTimer);setStreamError('');setConnected(true);}finally{frame.close();}},error:()=>{if(active){setConnected(false);setStreamError('画面解码失败，正在重新连接');if(!reported){reported=true;notify('画面解码中断，正在重新连接。',true);}socket?.close();}}});
   decoder.configure({codec,optimizeForLatency:true});needsKey=true;
  };
  const connect=()=>{
   if(!('VideoDecoder' in window)){notify('当前浏览器不支持实时解码，请使用 NexusRoom 桌面应用。',true);return;}
   rendered=false;clearTimeout(firstFrameTimer);firstFrameTimer=setTimeout(()=>{if(active&&!rendered){setStreamError('尚未收到可显示的画面，正在重试连接');socket?.close();}},10000);
   socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/devices/${device.id}/mirror/stream?roomId=${encodeURIComponent(device.roomId)}`);socket.binaryType='arraybuffer';
   socket.onmessage=e=>{if(!active)return;try{
    const bytes=new Uint8Array(e.data),view=new DataView(e.data);if(bytes.length<12)return;
    if(bytes[0]===0x10){const ctx=audio.current;if(!ctx||!audioEnabled.current||ctx.state!=='running'||!gain.current)return;const rate=view.getUint32(4),channels=view.getUint32(8);if(rate!==48000||channels!==1||bytes.length>20000||bytes.length%2)return;const count=(bytes.length-12)/2,buffer=ctx.createBuffer(1,count,rate),data=buffer.getChannelData(0);for(let i=0;i<count;i++)data[i]=view.getInt16(12+i*2,true)/32768;if(audioTime.current>ctx.currentTime+.25)return;audioTime.current=Math.max(audioTime.current,ctx.currentTime+.035);const source=ctx.createBufferSource();source.buffer=buffer;source.connect(gain.current);source.onended=()=>source.disconnect();source.start(audioTime.current);audioTime.current+=count/rate;return;}
    if(bytes[0]&0x80){const width=view.getUint32(4),height=view.getUint32(8);if(width<1||height<1||width>4096||height>4096)throw Error('format');setSize({width,height});needsKey=true;return;}
    const data=bytes.slice(12);if(data.length!==view.getUint32(8))return;
    if(bytes[0]&0x40){if(decoder?.state!=='configured'||config.length!==data.length||config.some((v,i)=>v!==data[i]))configure(data);config=data;return;}
    const key=!!(bytes[0]&0x20);if(!decoder||decoder.state!=='configured'||(needsKey&&!key))return;if(decoder.decodeQueueSize>8){socket?.close();return;}
    const payload=key?new Uint8Array(config.length+data.length):data;if(key){payload.set(config);payload.set(data,config.length);needsKey=false;}
    decoder.decode(new EncodedVideoChunk({type:key?'key':'delta',timestamp:Number(view.getBigUint64(0)&((1n<<60n)-1n)),data:payload}));
   }catch(error){setStreamError('画面数据处理失败：'+(error instanceof Error?error.message:'未知错误'));socket?.close();}};
   socket.onclose=()=>{clearTimeout(firstFrameTimer);if(!active)return;setConnected(false);if(decoder?.state!=='closed')decoder?.close();decoder=undefined;needsKey=true;retry=setTimeout(connect,1500);};socket.onerror=()=>socket?.close();
  };
  connect();return()=>{active=false;clearTimeout(retry);clearTimeout(firstFrameTimer);socket?.close();if(decoder?.state!=='closed')decoder?.close();setConnected(false);audioTime.current=0;};
 },[device.id,device.online,device.permissions.screen,device.activity,notify,retryCount]);
 const point=(e:PointerEvent<HTMLElement>|WheelEvent<HTMLElement>)=>{const r=e.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};};
 const release=(e:PointerEvent<HTMLElement>)=>{if(!down.current||!usable)return;const start=down.current,end=point(e);down.current=null;const swipe=Math.hypot(end.x-start.x,end.y-start.y)>.025;input(swipe?'swipe':'tap',swipe?{x:start.x,y:start.y,endX:end.x,endY:end.y,duration:Math.min(3000,Math.max(100,Date.now()-start.time))}:end);};
 const key=(e:KeyboardEvent<HTMLTextAreaElement>)=>{
  if(!usable||e.nativeEvent.isComposing||composing.current)return;
  if(e.ctrlKey||e.metaKey){const action=({a:'selectAll',c:'copy',x:'cut'} as Record<string,string>)[e.key.toLowerCase()];if(action){e.preventDefault();input('edit',{action},action==='copy'||action==='cut');}return;}
  const action=({Backspace:'Backspace',Delete:'Delete',Enter:'Enter',ArrowLeft:'ArrowLeft',ArrowRight:'ArrowRight',Home:'Home',End:'End'} as Record<string,string>)[e.key];
  if(action){e.preventDefault();input('edit',{action});}else if(e.key==='Escape'){e.preventDefault();input('back');}
 };
 return <section className={`screen-panel ${focused?'keyboard-focused':''}`} ref={stage}><div className="screen-header"><span className="inline"><span className={`tiny-dot ${connected?'green':''}`}/>{connected?'实时连接':device.capture?.state==='error'?'共享启动失败':device.permissions.screen?'正在连接画面':'等待屏幕共享'}</span><div className="inline">{focused&&<span className="keyboard-indicator"><Keyboard size={13}/>键盘已连接</span>}<button className="icon-btn" aria-label={audible?'关闭手机声音':'播放手机声音'} disabled={!device.permissions.audio||!device.permissions.screen} onClick={()=>void sound().catch(()=>notify('请再次点击启用声音',true))}>{audible?<Volume2 size={17}/>:<VolumeX size={17}/>}</button>{audible&&<input className="remote-volume" aria-label="手机播放音量" type="range" min={0} max={1} step={.05} value={volume} onChange={e=>setVolume(Number(e.target.value))}/>}<button className="icon-btn" aria-label="全屏预览" onClick={()=>{if(document.fullscreenElement)void document.exitFullscreen();else void stage.current?.requestFullscreen().catch(()=>{});}}><Maximize2 size={17}/></button></div></div>
 <div className="screen-stage"><canvas ref={canvas} className="mirror-canvas" hidden={!connected} style={{aspectRatio:`${size.width||16}/${size.height||9}`}} aria-label={`${device.name} 实时画面，点击连接键盘`} onPointerDown={e=>{if(!usable||e.button!==0)return;e.preventDefault();ime.current?.focus({preventScroll:true});e.currentTarget.setPointerCapture(e.pointerId);down.current={...point(e),time:Date.now()};}} onPointerUp={release} onPointerCancel={()=>{down.current=null;}} onWheel={e=>{if(!usable||Date.now()-scrollTime.current<200)return;scrollTime.current=Date.now();input('scroll',{x:.5,y:e.deltaY>0?.75:.25,delta:e.deltaY});}}/>
 {!connected&&<div className="screen-empty"><Smartphone size={58} strokeWidth={1.1}/><h3>{device.capture?.state==='error'?'屏幕共享启动失败':device.activity==='busy'?'设备正在另一房间工作':device.permissions.screen?'正在接收手机画面':device.online?'开始共享，让手机出现在这里':'设备当前离线'}</h3><p>{device.capture?.error||streamError||(device.permissions.screen?'手机已完成授权，正在等待首帧。':device.online?'点击右侧「开始远程控制」，在手机确认共享。':'在手机打开 NexusRoom，已保存的房间会自动连接。')}</p>{device.permissions.screen&&<button className="btn secondary" onClick={()=>setRetryCount(n=>n+1)}>重新连接画面</button>}</div>}

 <textarea ref={ime} className="remote-ime" aria-label="手机键盘输入" disabled={!usable} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} onFocus={()=>setFocused(true)} onBlur={()=>{setFocused(false);composing.current=false;if(ime.current)ime.current.value='';}} onKeyDown={key} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={e=>{composing.current=false;const value=e.currentTarget.value||e.data;if(value)input('edit',{action:'insert',text:value});e.currentTarget.value='';}} onInput={e=>{if(composing.current||(e.nativeEvent as InputEvent).isComposing)return;const value=e.currentTarget.value;if(value)input('edit',{action:'insert',text:value});e.currentTarget.value='';}} onPaste={e=>{e.preventDefault();const value=e.clipboardData.getData('text/plain');if(value)input('edit',{action:'insert',text:value.slice(0,8192)});}}/>
 </div><div className="screen-toolbar"><span>{size.width?`${size.width} × ${size.height}`:'实时画面'}<small>点击 · 拖动 · 滚轮 · 输入法</small></span><div>{[{key:'back',label:'返回',icon:<ArrowLeft size={18}/>},{key:'home',label:'主页',icon:<Circle size={16}/>},{key:'recents',label:'最近任务',icon:<Square size={15}/>}].map(b=><button key={b.key} className="icon-btn" aria-label={b.label} title={b.label} disabled={!usable} onClick={()=>input(b.key)}>{b.icon}</button>)}</div></div></section>;
}
