/**
 * Splits a turnaround sheet (several views of one character side by side) into separate pictures, in the browser.
 * It finds the background colour from the corners, marks every pixel that differs from it, and looks for columns of the
 * sheet that are empty: the figures are the runs of columns between them. Within each figure it keeps the tallest
 * band of content, which drops a caption written above or below. Clean sheets with a plain background work; busy
 * backgrounds or overlapping figures do not, and the result can be corrected by hand.
 */
const loadImage=src=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(Error('That picture could not be read.'));image.src=src;});

/** The usual order of views on a sheet with this many figures, left to right. A guess, so the dialog lets it be changed. */
export const SHEET_ORDER={2:['front','back'],3:['front','right','back'],4:['front','right','left','back']};

/** Runs of true values, merging runs separated by gaps shorter than minGap, dropping runs shorter than minRun. */
export function runs(flags,minGap,minRun){
 const found=[];let start=-1;
 for(let i=0;i<=flags.length;i++){if(i<flags.length&&flags[i]){if(start<0)start=i;}else if(start>=0){found.push([start,i]);start=-1;}}
 const merged=[];for(const run of found){const last=merged.at(-1);if(last&&run[0]-last[1]<minGap)last[1]=run[1];else merged.push([...run]);}
 return merged.filter(([a,b])=>b-a>=minRun);
}

/**
 * Finds the figures in a picture. Returns [{x, y, w, h}] in the picture's own pixels, left to right, or [] when it is
 * not a sheet (one figure or none).
 */
export function findFigures(pixels,width,height){
 const at=(x,y)=>(y*width+x)*4,corner=[];
 for(const [cx,cy] of [[0,0],[width-8,0],[0,height-8],[width-8,height-8]])for(let y=cy;y<cy+8;y++)for(let x=cx;x<cx+8;x++)corner.push(at(Math.max(0,x),Math.max(0,y)));
 const transparent=corner.filter(i=>pixels[i+3]<128).length>corner.length/2;
 const median=channel=>{const values=corner.map(i=>pixels[i+channel]).sort((a,b)=>a-b);return values[values.length>>1];};
 const bg=[median(0),median(1),median(2)];
 const solid=new Uint8Array(width*height);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=at(x,y),alpha=pixels[i+3];
  solid[y*width+x]=transparent?alpha>24:alpha>24&&(Math.abs(pixels[i]-bg[0])+Math.abs(pixels[i+1]-bg[1])+Math.abs(pixels[i+2]-bg[2])>60);}
 // Guide lines, borders and underlines are thin horizontal strokes that would join the figures together. Keep only
 // pixels that are part of a vertical stretch of content several pixels tall: figures are, lines are not.
 const stroke=Math.max(4,Math.round(height*0.008)),tall=new Uint8Array(width*height);
 for(let x=0;x<width;x++){let start=-1;for(let y=0;y<=height;y++){const on=y<height&&solid[y*width+x];if(on&&start<0)start=y;else if(!on&&start>=0){if(y-start>=stroke)for(let k=start;k<y;k++)tall[k*width+x]=1;start=-1;}}}
 const columns=Array.from({length:width},(_,x)=>{let count=0;for(let y=0;y<height;y++)count+=tall[y*width+x];return count>height*0.02;});
 const spans=runs(columns,Math.max(2,Math.round(width*0.012)),Math.round(width*0.04));
 if(spans.length<2)return [];
 return spans.map(([x0,x1])=>{
  const rows=Array.from({length:height},(_,y)=>{let count=0;for(let x=x0;x<x1;x++)count+=tall[y*width+x];return count>(x1-x0)*0.01;});
  const bands=runs(rows,Math.round(height*0.015),Math.round(height*0.05));if(!bands.length)return null;
  const [y0,y1]=bands.reduce((best,band)=>band[1]-band[0]>best[1]-best[0]?band:best);
  let left=x1,right=x0;for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)if(tall[y*width+x]){if(x<left)left=x;if(x>right)right=x;}
  return {x:left,y:y0,w:right-left+1,h:y1-y0};
 }).filter(Boolean);
}

/**
 * Splits a sheet given as a data URL. Returns {views: [{slot, data}], count} with each view as a PNG data URL, or null
 * when the picture is a single figure. At most four figures are kept: the largest, in their left-to-right order.
 */
export async function splitSheet(src){
 const image=await loadImage(src),scale=Math.min(1,1400/image.naturalWidth),width=Math.max(1,Math.round(image.naturalWidth*scale)),height=Math.max(1,Math.round(image.naturalHeight*scale));
 const probe=document.createElement('canvas');probe.width=width;probe.height=height;const ctx=probe.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0,width,height);
 let figures=findFigures(ctx.getImageData(0,0,width,height).data,width,height);
 if(figures.length<2)return null;
 if(figures.length>4)figures=[...figures].sort((a,b)=>b.w*b.h-a.w*a.h).slice(0,4).sort((a,b)=>a.x-b.x);
 const order=SHEET_ORDER[figures.length],views=figures.map((f,index)=>{
  const pad=Math.round(Math.max(f.w,f.h)*0.06),x=Math.max(0,f.x-pad),y=Math.max(0,f.y-pad),w=Math.min(width-x,f.w+pad*2),h=Math.min(height-y,f.h+pad*2);
  const sx=x/scale,sy=y/scale,sw=w/scale,sh=h/scale,out=Math.min(1,1024/Math.max(sw,sh)),canvas=document.createElement('canvas');
  canvas.width=Math.round(sw*out);canvas.height=Math.round(sh*out);canvas.getContext('2d').drawImage(image,sx,sy,sw,sh,0,0,canvas.width,canvas.height);
  return {slot:order[index],data:canvas.toDataURL('image/png')};
 });
 return {views,count:figures.length};
}
