import path from 'node:path';
export function resolveLibraryFile(root,relative){if(typeof relative!=='string'||path.isAbsolute(relative))throw new Error('Invalid library path.');const resolved=path.resolve(root,relative);if(!resolved.startsWith(path.resolve(root)+path.sep))throw new Error('Invalid library path.');return resolved;}
export function validateMessage(body){
 if(!body||typeof body.text!=='string'||!body.text.trim()||body.text.length>12000)throw new Error('Write a message between 1 and 12,000 characters.');
 if(typeof body.requestId!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId))throw new Error('Invalid message ID.');
 const refs=body.refIds??body.modelIds;
 if(refs!==undefined&&(!Array.isArray(refs)||refs.length>8||refs.some(id=>typeof id!=='string'||!/^([a-f0-9]{12})$/.test(id))))throw new Error('Reference up to 8 items from the library.');
 if(body.focusId!==undefined&&body.focusId!==null&&body.focusId!==''&&(typeof body.focusId!=='string'||!/^[a-f0-9]{12}$/.test(body.focusId)))throw new Error('Invalid preview item.');
 if(body.versionId!==undefined&&(typeof body.versionId!=='string'||!(/^(original|current|[a-f0-9-]{36})$/).test(body.versionId)))throw new Error('Invalid preview version.');
 const refIds=[...new Set(refs||[])];
 let image=null;
 if(body.snapshot){if(typeof body.snapshot!=='string')throw new Error('Invalid screenshot.');const match=body.snapshot.match(/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/);if(!match)throw new Error('Screenshot must be a JPEG or PNG.');const bytes=Buffer.from(match[2],'base64');if(bytes.length>3*1024*1024)throw new Error('Screenshot is too large.');if(match[1]==='png'&&!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Invalid PNG screenshot.');if(match[1]==='jpeg'&&(bytes[0]!==255||bytes[1]!==216||bytes[2]!==255))throw new Error('Invalid JPEG screenshot.');image={bytes,extension:match[1]==='jpeg'?'jpg':'png'};}
 const view={};if(body.view){for(const field of ['camera','target']){const value=body.view[field];if(Array.isArray(value)&&value.length===3&&value.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<1e6))view[field]=value;}if(['material','clay','wire'].includes(body.view.mode))view.mode=body.view.mode;if(typeof body.view.palette==='string'&&(body.view.palette===''||/^[a-f0-9]{12}$/.test(body.view.palette)||['Kolkata Level Texture.jpg','Texture 2.png'].includes(body.view.palette)))view.palette=body.view.palette;}
 return {text:body.text.trim(),requestId:body.requestId,image,view,refIds,modelIds:refIds,focusId:body.focusId||null,versionId:body.versionId};
}
export function sameLocalOrigin(req,port){const allowed=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);if(!allowed.has(req.headers.host))return false;if(req.method==='GET'&&['/','/06_Preview/'].includes(req.path)&&req.headers['sec-fetch-mode']==='navigate')return true;const origin=req.headers.origin;if(origin){try{const u=new URL(origin);if(u.protocol!=='http:'||!allowed.has(u.host))return false;}catch{return false;}}if(req.headers['sec-fetch-site']==='cross-site')return false;return true;}
