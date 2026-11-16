/**
 * AI texture generation through the OpenAI Images API. This is the one place Meshdesk sends data
 * to an outside service on the agent's behalf: only the text prompt leaves the machine.
 */
const SIZES=new Set(['1024x1024','1536x1024','1024x1536']);
export function imageConfig(config={},env=process.env){return {apiKey:env.OPENAI_API_KEY||config.imageApiKey||'',model:env.MESHDESK_IMAGE_MODEL||config.imageModel||'gpt-image-1',endpoint:config.imageEndpoint||'https://api.openai.com/v1/images/generations'};}
export function texturePrompt({prompt,tileable=true,context='',concept=false}){
 const style=concept?'Concept art or mood reference image for a game. No text, no borders, no watermark.':tileable?'Seamless, tileable game texture seen straight on. Even flat lighting, no shadows, no perspective, no vignette, no text, no borders; edges must wrap cleanly.':'Game texture image. Even lighting, no text, no borders.';
 return [style,context?'Art direction for the project: '+context.slice(0,1500):'',String(prompt).slice(0,3000)].filter(Boolean).join('\n');
}
export async function generateTexture({prompt,tileable=true,concept=false,size='1024x1024',context='',config,signal,fetcher=fetch}){
 if(!config?.apiKey)throw Error('AI image generation is not set up. Add an OpenAI API key as "imageApiKey" in config.local.json (or the OPENAI_API_KEY environment variable) and restart Meshdesk.');
 if(typeof prompt!=='string'||!prompt.trim())throw Error('Describe the texture to generate.');
 if(!SIZES.has(size))size='1024x1024';
 const limit=AbortSignal.timeout(180000),response=await fetcher(config.endpoint,{method:'POST',signal:signal?AbortSignal.any([signal,limit]):limit,headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.apiKey},body:JSON.stringify({model:config.model,prompt:texturePrompt({prompt,tileable,context,concept}),size,n:1})});
 const body=await response.json().catch(()=>({}));
 if(!response.ok)throw Error('Texture generation failed: '+String(body.error?.message||response.status).slice(0,300));
 const encoded=body.data?.[0]?.b64_json;if(!encoded)throw Error('Texture generation returned no image.');
 const bytes=Buffer.from(encoded,'base64'),png=bytes.toString('latin1',1,4)==='PNG',jpeg=bytes[0]===0xff&&bytes[1]===0xd8;
 if(!png&&!jpeg)throw Error('Texture generation returned an unsupported image.');
 return {bytes,extension:png?'.png':'.jpg',size};
}
