const string={type:'string'};
const tool=(name,description,properties,required=Object.keys(properties))=>({type:'function',name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
export const editTools=[
 tool('library_list','Find active or removed library assets by name. Use exact returned asset IDs for operations.',{query:string}),
 tool('asset_rename','Rename an asset and its working file, preserving the original and updating the viewer. Supply filename or stem, without folders.',{assetId:string,name:string}),
 tool('asset_remove','Remove an asset from the active library into the recoverable Removed collection. Never permanently deletes originals.',{assetId:string}),
 tool('asset_restore','Restore a removed asset to the active library.',{assetId:string}),
 tool('asset_use_version','Make a saved version current, or use versionId original to revert. Preserves all versions.',{assetId:string,versionId:string}),
 tool('blender_edit','Run Python in Blender on a copy of a model. The scene is ALREADY imported with matched textures; bpy and job_dir are available. Only modify the scene/materials; do not import/reset/export/save yourself. The app exports FBX, BLEND with linked external textures and an embedded GLB preview and publishes a new version automatically. Writes are limited to the disposable job; no network or unrelated files. On failure no version is published. Give a concise label describing the change.',{assetId:string,label:string,script:string})
];
export async function executeEditTool(library,tool,args,signal,onProgress){
 if(signal?.aborted)throw Error('Operation cancelled.');
 if(!args||typeof args!=='object')throw Error('Invalid tool arguments.');
 switch(tool){
 case 'library_list':{const query=String(args.query||'').toLowerCase();return library.public().filter(a=>(a.name+' '+a.path).toLowerCase().includes(query)).map(a=>({id:a.id,name:a.name,path:a.path,type:a.type,removed:!!a.removed,currentVersion:a.currentVersion||'original',versions:a.versions||[]}));}
 case 'asset_rename':return library.rename(args.assetId,args.name,signal);
 case 'asset_remove':return library.remove(args.assetId,signal);
 case 'asset_restore':return library.restore(args.assetId,signal);
 case 'asset_use_version':return library.useVersion(args.assetId,args.versionId,signal);
 case 'blender_edit':return library.edit(args.assetId,args,signal,onProgress);
 default:throw Error('Unknown library tool.');
 }
}
