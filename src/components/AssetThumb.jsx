import {useEffect,useRef,useState} from 'react';
import {Box,Image} from 'lucide-react';
import {modelThumbnail} from '../thumbnails.js';

/** Library row preview: a rendered thumbnail for models, the picture itself for images. Falls back to an icon. */
export default function AssetThumb({base,asset}){
  const host=useRef(null),[visible,setVisible]=useState(false),[src,setSrc]=useState(''),model=asset.type==='model';
  useEffect(()=>{const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){setVisible(true);observer.disconnect();}},{rootMargin:'200px'});observer.observe(host.current);return()=>observer.disconnect();},[]);
  useEffect(()=>{if(!visible)return;if(!model){setSrc(base+'/library/'+asset.id+'?revision='+(asset.revision||0));return;}let cancelled=false;modelThumbnail(base,asset).then(url=>{if(!cancelled)setSrc(url);},()=>{if(!cancelled)setSrc('');});return()=>{cancelled=true;};},[visible,base,asset.id,asset.revision,asset.currentVersion,model]);
  return <span ref={host} className={'asset-kind'+(src?' has-preview':'')}>{src?<img src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={()=>setSrc('')}/>:model?<Box size={15}/>:<Image size={15}/>}</span>;
}
