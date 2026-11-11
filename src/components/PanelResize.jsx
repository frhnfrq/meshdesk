import {useEffect,useRef,useState} from 'react';
export function usePanelWidth(){
 const [width,setWidth]=useState(()=>{try{return Number(localStorage.getItem('codex-panel-width'))||420;}catch{return 420;}});
 const limit=()=>Math.max(300,Math.min(800,window.innerWidth-(window.innerWidth>1000?560:24)));
 const [max,setMax]=useState(limit);
 useEffect(()=>{const resize=()=>setMax(limit());window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
 const update=value=>{const next=Math.max(300,Math.min(max,value));setWidth(next);try{localStorage.setItem('codex-panel-width',String(next));}catch{}};
 return {width:Math.min(Math.max(300,width),max),max,update};
}
export default function PanelResize({width,max,onResize}){
 const drag=useRef(null);
 return <div className="panel-resizer" role="separator" tabIndex={0} aria-label="Resize chat panel" aria-orientation="vertical" aria-valuemin={300} aria-valuemax={max} aria-valuenow={Math.round(width)} title="Drag to resize · Arrow keys to adjust"
 onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();drag.current={x:e.clientX,width};e.currentTarget.setPointerCapture(e.pointerId);}}
 onPointerMove={e=>{if(drag.current)onResize(drag.current.width+drag.current.x-e.clientX);}}
 onPointerUp={e=>{drag.current=null;e.currentTarget.releasePointerCapture(e.pointerId);}}
 onLostPointerCapture={()=>{drag.current=null;}}
 onKeyDown={e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();onResize(e.key==='Home'?300:e.key==='End'?max:width+(e.key==='ArrowLeft'?24:-24));}}}><span/></div>;
}
