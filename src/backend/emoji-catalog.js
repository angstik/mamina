function hex(bytes){let s='';for(const b of bytes)s+=b.toString(16).padStart(2,'0');return s}
export async function sha256Hex(bytes){const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength))))}
export function codepointsToString(unified=''){return String(unified).split('-').filter(Boolean).map(x=>String.fromCodePoint(parseInt(x,16))).join('')}

async function descriptorFromJpeg(raw){
  const bmp=await createImageBitmap(new Blob([raw],{type:'image/jpeg'}))
  const c=document.createElement('canvas');c.width=64;c.height=64
  const ctx=c.getContext('2d',{willReadFrequently:true});ctx.fillStyle='#fff';ctx.fillRect(0,0,64,64);ctx.drawImage(bmp,0,0,64,64);bmp.close?.()
  const px=ctx.getImageData(0,0,64,64).data,out=new Uint8Array(192);let k=0
  for(let gy=0;gy<8;gy++)for(let gx=0;gx<8;gx++){
    let r=0,g=0,b=0
    for(let y=0;y<8;y++)for(let x=0;x<8;x++){const i=((gy*8+y)*64+(gx*8+x))*4;r+=px[i];g+=px[i+1];b+=px[i+2]}
    out[k++]=Math.round(r/64);out[k++]=Math.round(g/64);out[k++]=Math.round(b/64)
  }
  c.width=1;c.height=1;return out
}

export class EmojiResolver{
  constructor({shaJson=null,catalogJson=null,catalogBin=null,set='apple',threshold=.999}={}){
    this.shaEntries=new Map(Object.entries(shaJson?.entries||{}));this.catalogJson=catalogJson;this.catalogBin=catalogBin instanceof Uint8Array?catalogBin:(catalogBin?new Uint8Array(catalogBin):null);this.set=set;this.threshold=threshold
    this.indices=[]
    if(catalogJson?.entries&&this.catalogBin){for(let i=0;i<catalogJson.entries.length;i++)if(!set||catalogJson.entries[i].s===set)this.indices.push(i)}
  }
  async resolve(raw){
    const sha=await sha256Hex(raw),known=this.shaEntries.get(sha)
    if(known)return {char:codepointsToString(known.u),unified:known.u,via:'sha256',set:known.set||this.set,sha256:sha,sim:1}
    if(!this.catalogJson||!this.catalogBin)throw new Error(`A9_EMOJI_UNKNOWN:${sha}`)
    const d=await descriptorFromJpeg(raw);let mean=0;for(const x of d)mean+=x;mean/=d.length;let norm=0;const q=new Float64Array(d.length);for(let i=0;i<d.length;i++){q[i]=d[i]-mean;norm+=q[i]*q[i]}norm=Math.sqrt(norm);if(!norm)throw new Error('A9_EMOJI_DESCRIPTOR_ZERO')
    let best=-Infinity,bestIndex=-1
    for(const idx of this.indices){const off=idx*192;let m=0;for(let j=0;j<192;j++)m+=this.catalogBin[off+j];m/=192;let dot=0,n=0;for(let j=0;j<192;j++){const v=this.catalogBin[off+j]-m;dot+=(q[j]/norm)*v;n+=v*v}if(!n)continue;const sim=dot/Math.sqrt(n);if(sim>best){best=sim;bestIndex=idx}}
    if(bestIndex<0||best<this.threshold)throw new Error(`A9_EMOJI_UNKNOWN:${sha}:sim=${best.toFixed(6)}`)
    const ent=this.catalogJson.entries[bestIndex],result={u:ent.u,set:ent.s||this.set,ext:'jpeg',bytes:raw.byteLength,sim:best}
    this.shaEntries.set(sha,result)
    return {char:codepointsToString(ent.u),unified:ent.u,via:'descriptor',set:ent.s||this.set,sha256:sha,sim:best}
  }
  exportShaJson(){return {version:1,count:this.shaEntries.size,entries:Object.fromEntries(this.shaEntries)}}
}
