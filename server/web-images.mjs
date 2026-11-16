import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Finding and downloading pictures from the web for the moodboard. Search terms and the addresses being fetched
 * are the only things that leave the machine. Downloads refuse addresses on this computer or the local network,
 * so an agent cannot be steered into reading private services.
 */
const AGENT='Mozilla/5.0 (compatible; Meshdesk/1.0)';
const MAX_BYTES=25*1024*1024;

/** Width and height from a PNG, JPEG or WebP header, or null when the bytes are none of those. */
export function imageInfo(bytes){
 if(!bytes||bytes.length<24)return null;
 if(bytes.toString('latin1',1,4)==='PNG')return {extension:'.png',width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
 if(bytes.toString('latin1',0,4)==='RIFF'&&bytes.toString('latin1',8,12)==='WEBP'){
  const kind=bytes.toString('latin1',12,16);
  if(kind==='VP8X'&&bytes.length>=30)return {extension:'.webp',width:1+bytes.readUIntLE(24,3),height:1+bytes.readUIntLE(27,3)};
  if(kind==='VP8 '&&bytes.length>=30)return {extension:'.webp',width:bytes.readUInt16LE(26)&0x3fff,height:bytes.readUInt16LE(28)&0x3fff};
  if(kind==='VP8L'&&bytes.length>=25){const bits=bytes.readUInt32LE(21);return {extension:'.webp',width:(bits&0x3fff)+1,height:((bits>>14)&0x3fff)+1};}
  return {extension:'.webp',width:0,height:0};
 }
 if(bytes[0]===0xff&&bytes[1]===0xd8){
  let at=2;
  while(at+9<bytes.length){
   if(bytes[at]!==0xff){at++;continue;}
   const marker=bytes[at+1];
   if(marker===0xd8||marker===0x01||(marker>=0xd0&&marker<=0xd7)||marker===0xff){at+=marker===0xff?1:2;continue;}
   const length=bytes.readUInt16BE(at+2);
   if(marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker))return {extension:'.jpg',width:bytes.readUInt16BE(at+7),height:bytes.readUInt16BE(at+5)};
   at+=2+length;
  }
  return {extension:'.jpg',width:0,height:0};
 }
 return null;
}

function privateAddress(address){
 if(net.isIPv4(address)){const [a,b]=address.split('.').map(Number);return a===0||a===10||a===127||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||a>=224;}
 const lower=address.toLowerCase();
 if(lower.startsWith('::ffff:'))return privateAddress(lower.slice(7));
 return lower==='::'||lower==='::1'||/^f[cd]/.test(lower)||/^fe[89ab]/.test(lower);
}
async function publicUrl(value,lookup){
 let url;try{url=new URL(String(value));}catch{throw Error('That is not a web address. Give a full https:// link to an image.');}
 if(!['http:','https:'].includes(url.protocol))throw Error('Only http and https links can be downloaded.');
 const host=url.hostname.replace(/^\[|\]$/g,'');
 const addresses=net.isIP(host)?[{address:host}]:await lookup(host,{all:true}).catch(()=>{throw Error('Could not find the site '+host+'.');});
 if(!addresses.length||addresses.some(entry=>privateAddress(entry.address)))throw Error('Links to this computer or the local network cannot be downloaded.');
 return url;
}
/** Throws unless the address is an http(s) link to somewhere on the public internet. */
export const assertPublicUrl=(value,lookup=dns.lookup)=>publicUrl(value,lookup);
async function body(response,limit){
 const reader=response.body?.getReader();if(!reader)return Buffer.alloc(0);
 const chunks=[];let size=0;
 for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel().catch(()=>{});throw Error('That file is larger than '+Math.round(limit/1024/1024)+' MB.');}chunks.push(value);}
 return Buffer.concat(chunks);
}
async function get(value,{signal,fetcher,lookup,limit,accept}){
 let url=await publicUrl(value,lookup);
 const timeout=AbortSignal.timeout(30000),both=signal?AbortSignal.any([signal,timeout]):timeout;
 for(let hop=0;hop<5;hop++){
  const response=await fetcher(url,{redirect:'manual',signal:both,headers:{'User-Agent':AGENT,Accept:accept}});
  if(response.status>=300&&response.status<400&&response.headers.get('location')){url=await publicUrl(new URL(response.headers.get('location'),url),lookup);continue;}
  if(!response.ok)throw Error('The site answered '+response.status+' for '+url.hostname+'.');
  return {url,type:String(response.headers.get('content-type')||''),bytes:await body(response,limit)};
 }
 throw Error('Too many redirects.');
}

/**
 * Downloads one picture. A link to a web page is followed to the page's main picture (its og:image) once.
 * Resolves to {bytes, extension, width, height, url} or throws with a reason the agent can act on.
 */
export async function downloadImage(value,{signal,fetcher=fetch,lookup=dns.lookup}={}){
 const options={signal,fetcher,lookup,limit:MAX_BYTES,accept:'image/png,image/jpeg,image/webp,image/*;q=0.8,text/html;q=0.5'};
 let result=await get(value,options),info=imageInfo(result.bytes);
 if(!info&&/html/i.test(result.type)){
  const page=result.bytes.toString('utf8',0,400000),tag=page.match(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*>/i),link=tag?.[0].match(/content=["']([^"']+)["']/i)?.[1];
  if(!link)throw Error('That link is a web page without a main picture. Give the direct link to the image file.');
  result=await get(new URL(link.replaceAll('&amp;','&'),result.url),options);info=imageInfo(result.bytes);
 }
 if(!info)throw Error('That link is not a PNG, JPEG or WebP picture.');
 return {bytes:result.bytes,...info,url:String(result.url)};
}

/** Searches Openverse and Wikimedia Commons, which need no account. Resolves to [{title, url, thumbnail, width, height, page, source}]. */
export async function searchImages(query,{count=8,signal,fetcher=fetch}={}){
 const text=String(query||'').replace(/[\x00-\x1f]/g,' ').trim().slice(0,200);if(!text)throw Error('Say what to search for.');
 const want=Math.min(12,Math.max(1,Math.round(Number(count))||8)),timeout=AbortSignal.timeout(20000),both=signal?AbortSignal.any([signal,timeout]):timeout,headers={'User-Agent':AGENT,Accept:'application/json'};
 const json=async url=>{const response=await fetcher(url,{signal:both,headers});if(!response.ok)throw Error(String(response.status));return response.json();};
 const sources=[
  async()=>{const data=await json('https://api.openverse.org/v1/images/?page_size='+want+'&q='+encodeURIComponent(text));return (data.results||[]).map(r=>({title:String(r.title||'Untitled').slice(0,120),url:r.url,thumbnail:r.thumbnail||r.url,width:r.width||0,height:r.height||0,page:r.foreign_landing_url||'',source:r.source||'openverse'}));},
  async()=>{const data=await json('https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit='+want+'&prop=imageinfo&iiprop=url%7Csize%7Cmime&iiurlwidth=1600&gsrsearch='+encodeURIComponent(text+' filetype:bitmap'));return Object.values(data.query?.pages||{}).sort((a,b)=>(a.index||0)-(b.index||0)).map(p=>({page:p,info:p.imageinfo?.[0]})).filter(({info})=>info&&/^image\/(jpeg|png|webp)$/.test(info.mime||'')).map(({page,info})=>({title:String(page.title||'').replace(/^File:/,'').replace(/\.[a-z]+$/i,'').slice(0,120),url:info.thumburl||info.url,thumbnail:(info.thumburl||info.url).replace(/\/\d+px-/,'/330px-'),width:info.thumbwidth||info.width||0,height:info.thumbheight||info.height||0,page:info.descriptionurl||'',source:'wikimedia'}));}
 ];
 const settled=await Promise.allSettled(sources.map(run=>run())),lists=settled.filter(s=>s.status==='fulfilled').map(s=>s.value.filter(r=>/^https?:\/\//.test(r.url||'')));
 if(!lists.length)throw Error('The image search services could not be reached.');
 const mixed=[],seen=new Set();for(let i=0;mixed.length<want&&lists.some(list=>i<list.length);i++)for(const list of lists){const entry=list[i];if(entry&&!seen.has(entry.url)&&mixed.length<want){seen.add(entry.url);mixed.push(entry);}}
 return mixed;
}
