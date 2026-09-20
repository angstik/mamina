const latin1 = new TextDecoder('latin1')

function bytesToLatin1(bytes) { return latin1.decode(bytes) }
function num(v){ const n=Number(v); return Number.isFinite(n)?n:0 }

async function inflate(bytes) {
  const ds=new DecompressionStream('deflate')
  const stream=new Blob([bytes]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function parseDictText(header='') {
  const out={}
  const width=header.match(/\/Width\s+(\d+)/); if(width)out.width=Number(width[1])
  const height=header.match(/\/Height\s+(\d+)/); if(height)out.height=Number(height[1])
  const filter=header.match(/\/Filter\s*(?:\[\s*)?\/(\w+)/); if(filter)out.filter=filter[1]
  const length=header.match(/\/Length\s+(\d+)/); if(length)out.length=Number(length[1])
  const subtype=header.match(/\/Subtype\s*\/(\w+)/); if(subtype)out.subtype=subtype[1]
  return out
}

function parseObjects(bytes) {
  const text=bytesToLatin1(bytes)
  const re=/(?:^|\n|\r)(\d+)\s+0\s+obj\b/g
  const starts=[]
  let m
  while((m=re.exec(text))) starts.push({id:Number(m[1]),start:m.index+(m[0].length-m[0].trimStart().length),bodyStart:re.lastIndex})
  const map=new Map()
  for(let i=0;i<starts.length;i++){
    const cur=starts[i], next=starts[i+1]?.start ?? text.length
    const chunkText=text.slice(cur.bodyStart,next)
    const streamPos=chunkText.indexOf('stream')
    let header=chunkText, stream=null
    if(streamPos>=0){
      header=chunkText.slice(0,streamPos)
      const info=parseDictText(header)
      let abs=cur.bodyStart+streamPos+'stream'.length
      if(bytes[abs]===13&&bytes[abs+1]===10)abs+=2
      else if(bytes[abs]===10||bytes[abs]===13)abs+=1
      if(info.length!=null) stream=bytes.slice(abs,abs+info.length)
      else {
        const end=text.indexOf('endstream',abs)
        if(end>=0)stream=bytes.slice(abs,end)
      }
    }
    map.set(cur.id,{id:cur.id,header,stream,info:parseDictText(header)})
  }
  return {text,map}
}

function parseRef(text,key){
  const m=text.match(new RegExp(`\\/${key}\\s+(\\d+)\\s+0\\s+R`)); return m?Number(m[1]):null
}
function parseBox(text,key='MediaBox'){
  const m=text.match(new RegExp(`\\/${key}\\s*\\[\\s*([-.\\d]+)\\s+([-.\\d]+)\\s+([-.\\d]+)\\s+([-.\\d]+)\\s*\\]`))
  return m?[num(m[1]),num(m[2]),num(m[3]),num(m[4])]:null
}
function parseNameRefMap(text,section){
  const marker=new RegExp(`\\/${section}\\s*<<([\\s\\S]*?)>>`).exec(text)
  const out=new Map(); if(!marker)return out
  const re=/\/(\w+)\s+(\d+)\s+0\s+R/g; let m
  while((m=re.exec(marker[1])))out.set(m[1],Number(m[2]))
  return out
}

function mul(a,b){
  return [
    a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
    a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
    a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5],
  ]
}
function pt(m,x,y){return [m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]]}
function boundsFromRect(m,x,y,w,h,pageH){
  const pts=[pt(m,x,y),pt(m,x+w,y),pt(m,x,y+h),pt(m,x+w,y+h)]
  const xs=pts.map(p=>p[0]), ys=pts.map(p=>p[1])
  const x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys)
  return {x0,top:pageH-y1,x1,bottom:pageH-y0,width:x1-x0,height:y1-y0}
}
function colorFrom(stack){return stack.slice(-3).map(Number)}

function tokenizeContent(s){
  return s.match(/\/(?:[^\s<>\[\]()]+)|[-+]?(?:\d+\.?\d*|\.\d+)|[A-Za-z*]+|\[|\]|\(|\)|<|>/g)||[]
}

function parseContentGeometry(content,pageH,xobjects){
  const t=tokenizeContent(content), stack=[], gsStack=[]
  let ctm=[1,0,0,1,0,0], fill=null, stroke=null, pendingRects=[]
  const rects=[], images=[]
  for(let i=0;i<t.length;i++){
    const tok=t[i]
    if(/^[-+.]?\d/.test(tok)){stack.push(Number(tok));continue}
    if(tok.startsWith('/')){stack.push(tok);continue}
    if(tok==='q'){gsStack.push({ctm:[...ctm],fill:fill&&[...fill],stroke:stroke&&[...stroke]});continue}
    if(tok==='Q'){const g=gsStack.pop();if(g){ctm=g.ctm;fill=g.fill;stroke=g.stroke}continue}
    if(tok==='cm'&&stack.length>=6){const vals=stack.splice(-6);ctm=mul(ctm,vals);continue}
    if(tok==='rg'&&stack.length>=3){fill=colorFrom(stack);stack.splice(-3);continue}
    if(tok==='RG'&&stack.length>=3){stroke=colorFrom(stack);stack.splice(-3);continue}
    if(tok==='re'&&stack.length>=4){const [x,y,w,h]=stack.splice(-4);pendingRects.push(boundsFromRect(ctm,x,y,w,h,pageH));continue}
    if(['f','F','f*','S','s','B','B*','b','b*'].includes(tok)){
      const doFill=['f','F','f*','B','B*','b','b*'].includes(tok)
      const doStroke=['S','s','B','B*','b','b*'].includes(tok)
      for(const r of pendingRects)rects.push({...r,fill:doFill,stroke:doStroke,fillColor:doFill&&fill?[...fill]:null,strokeColor:doStroke&&stroke?[...stroke]:null})
      pendingRects=[];continue
    }
    if(tok==='n'){pendingRects=[];continue}
    if(tok==='Do'&&stack.length){
      const name=String(stack.pop()).replace(/^\//,'')
      const ref=xobjects.get(name)
      if(ref){
        const b=boundsFromRect(ctm,0,0,1,1,pageH)
        images.push({...b,name,ref})
      }
      continue
    }
    // Most other operators consume operands, but we only care about a small
    // geometry subset. Clear stale operands at common boundaries.
    if(['BT','ET','m','l','c','v','y','h','W','W*','Tf','Td','TD','Tm','Tj','TJ','w','J','j','d','G','g'].includes(tok)) stack.length=0
  }
  return {rects,images}
}

export class RawPdfIndex {
  constructor(bytes,objects,pages,xobjects){this.bytes=bytes;this.objects=objects;this.pages=pages;this.xobjects=xobjects;this.imageCache=new Map()}
  static async load(input){
    const bytes=input instanceof Uint8Array?input:new Uint8Array(input)
    const {map}=parseObjects(bytes)
    let resourcesText=''
    const pages=[]
    for(const obj of map.values()){
      if(/\/Type\s*\/Page\b/.test(obj.header)){
        const mb=parseBox(obj.header)||[0,0,595.276,841.89]
        const resRef=parseRef(obj.header,'Resources')
        if(resRef&&map.get(resRef))resourcesText=map.get(resRef).header
        pages.push({objectId:obj.id,contentRef:parseRef(obj.header,'Contents'),resourcesRef:resRef,width:mb[2]-mb[0],height:mb[3]-mb[1]})
      }
    }
    pages.sort((a,b)=>a.objectId-b.objectId) // TCPDF emits pages in object order
    const xobjects=parseNameRefMap(resourcesText,'XObject')
    return new RawPdfIndex(bytes,map,pages,xobjects)
  }
  imageInfo(ref){
    if(this.imageCache.has(ref))return this.imageCache.get(ref)
    const obj=this.objects.get(ref); if(!obj)return null
    const info={xref:ref,srcWidth:obj.info.width||0,srcHeight:obj.info.height||0,filter:obj.info.filter||null,raw:obj.stream||new Uint8Array()}
    this.imageCache.set(ref,info);return info
  }
  async pageGeometry(pageNumber){
    const p=this.pages[pageNumber-1]; if(!p)throw new Error(`RAW_PAGE_MISSING:${pageNumber}`)
    const obj=this.objects.get(p.contentRef); if(!obj?.stream)throw new Error(`RAW_CONTENT_MISSING:${pageNumber}`)
    let bytes=obj.stream
    if(obj.info.filter==='FlateDecode')bytes=await inflate(bytes)
    const content=bytesToLatin1(bytes)
    const g=parseContentGeometry(content,p.height,this.xobjects)
    g.images=g.images.map(im=>({...im,...this.imageInfo(im.ref)}))
    return {...g,width:p.width,height:p.height}
  }
}
