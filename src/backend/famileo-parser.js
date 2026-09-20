import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url'
import {RawPdfIndex} from './pdf-raw.js'
import {sha256Hex} from './emoji-catalog.js'
pdfjsLib.GlobalWorkerOptions.workerSrc=workerSrc

const NAVY=[.192157,.384314,.525490], CYAN=[.431373,.745098,.850980]
const MONTHS={janvier:1,fevrier:2,mars:3,avril:4,mai:5,juin:6,juillet:7,aout:8,septembre:9,octobre:10,novembre:11,decembre:12,janv:1,fevr:2,avr:4,juil:7,sept:9,oct:10,nov:11,dec:12}
function stripAccents(s){return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'')}
export function monthNumber(s){return MONTHS[stripAccents(String(s).toLowerCase()).replace(/\.$/,'')]??null}
export function codepoints(unified){return String(unified).split('-').map(x=>String.fromCodePoint(parseInt(x,16))).join('')}
function compact(s){return String(s).replace(/\s+/g,' ').trim()}
function approx(a,b,t=.3){return Math.abs(Number(a)-Number(b))<t}
function colorClose(a,b,t=.02){return Array.isArray(a)&&a.length>=3&&b.every((x,i)=>Math.abs(Number(a[i])-x)<=t)}
function style(font=''){const base=String(font).split('+').pop();return base.includes('-')?base.slice(base.indexOf('-')+1):'Regular'}
function inside(o,b,pad=2){const [x0,top,w,h]=b;return o.x0>=x0-pad&&o.x1<=x0+w+pad&&o.top>=top-pad&&o.bottom<=top+h+pad}
function assert(cond,code,detail=''){if(!cond)throw new Error(`${code}${detail?':'+detail:''}`)}
function round2(n){return Math.round(Number(n)*100)/100}

async function textContentCompat(page){
  const stream=page.streamTextContent({includeMarkedContent:false}),reader=stream.getReader(),tc={items:[],styles:Object.create(null),lang:null}
  try{for(;;){const {done,value}=await reader.read();if(done)break;if(!value)continue;if(value.styles)Object.assign(tc.styles,value.styles);if(value.items)for(const it of value.items)tc.items.push(it)}}finally{reader.releaseLock?.()}return tc
}
function runs(tc,pageH){
  const out=[]
  for(const it of tc.items||[]){if(!it?.str||!it.transform)continue;const st=tc.styles?.[it.fontName]||{},size=Math.hypot(Number(it.transform[0]||0),Number(it.transform[1]||0))||Number(it.height||0),asc=Number.isFinite(st.ascent)?st.ascent:.8,desc=Number.isFinite(st.descent)?st.descent:-.2,baseY=Number(it.transform[5]||0),top=pageH-baseY-asc*size,bottom=pageH-baseY-desc*size,x0=Number(it.transform[4]||0),x1=x0+Math.abs(Number(it.width||0));out.push({text:String(it.str),size,font:String(st.fontFamily||it.fontName||''),x0,x1,top,bottom,rotated:Math.abs(Number(it.transform[1]||0))>Math.abs(Number(it.transform[0]||0))})}
  return out
}
function pick(cs,size,sty,tol=.3){return cs.filter(c=>approx(c.size,size,tol)&&style(c.font)===sty)}
function makeLines(chars,emoji=[]){
  const buckets=[]
  for(const c of [...chars].sort((a,b)=>a.top-b.top||a.x0-b.x0)){let b=buckets.find(x=>Math.abs(x.top-c.top)<=1);if(!b){b={top:c.top,items:[]};buckets.push(b)}b.items.push(c)}
  buckets.sort((a,b)=>a.top-b.top);const assigned=buckets.map(()=>[])
  for(const e of emoji){const cand=[];for(let i=0;i<buckets.length;i++){const b=buckets[i],h=Math.max(1,b.items[0].bottom-b.items[0].top);if(b.top-.4*h<=e.yCenter&&e.yCenter<=b.top+1.4*h)cand.push([Math.abs(e.yCenter-(b.top+h/2)),i])}if(cand.length){cand.sort((a,b)=>a[0]-b[0]);assigned[cand[0][1]].push(e)}}
  return buckets.map((b,i)=>{const toks=b.items.map(c=>[c.x0,c.text]);for(const e of assigned[i])toks.push([e.x0,e.char]);toks.sort((a,b)=>a[0]-b[0]);return toks.map(x=>x[1]).join('')})
}
function flow(chars,emoji=[]){return compact(makeLines(chars,emoji).join(' '))}
function slotFor(box,pageH){return box[3]>.6*pageH?'full':(box[1]<pageH/2?'top':'bottom')}
export function layoutFor(body,collages,box){if(!collages.length||!body.length)return'text_right';const left=Math.min(...body.map(c=>c.x0)),top=Math.min(...body.map(c=>c.top)),right=Math.max(...collages.map(i=>i.x1)),bottom=Math.max(...collages.map(i=>i.bottom));if(left>=right-2)return'text_right';if(top>=bottom-2)return'text_below';return left>=box[0]+box[2]/2?'text_right':'text_below'}
function dateParts(label){const m=String(label).match(/^(\d{1,2})\s+(.+?)\s+(\d{4})$/);if(!m)return null;return{day:Number(m[1]),month:m[2],year:Number(m[3])}}
function iso(y,m,d){return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`}
export function resolveYears(posts,coverIso){let bound=new Date(`${coverIso}T12:00:00Z`),year=bound.getUTCFullYear();for(let i=posts.length-1;i>=0;i--){const m=String(posts[i].date_label).match(/^le\s+(\d{1,2})\s+(.+)$/i);if(!m){posts[i].date_iso=null;continue}const day=Number(m[1]),mon=monthNumber(m[2]);let d=null;while(year>1900){const x=new Date(Date.UTC(year,mon-1,day,12));if(x.getUTCMonth()===mon-1&&x.getUTCDate()===day&&x<=bound){d=x;break}year--}posts[i].date_iso=d?iso(d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate()):null;if(d)bound=d}return posts}

export class FamileoGeometryParser{
  static async parse(input,{emojiResolver=null,onProgress=null}={}){
    const bytes=input instanceof Uint8Array?input:new Uint8Array(await input.arrayBuffer()),raw=await RawPdfIndex.load(bytes),doc=await pdfjsLib.getDocument({data:bytes.slice()}).promise,metadata=await doc.getMetadata().catch(()=>({info:{}})),info=metadata?.info||{}
    const source={pages:doc.numPages,page_size_pt:[Math.round(raw.pages[0].width*1000)/1000,Math.round(raw.pages[0].height*100)/100],producer:info.Producer||null,title:info.Title||null,created:info.CreationDate||null}
    assert(Math.abs(source.page_size_pt[0]-595.276)<=1&&Math.abs(source.page_size_pt[1]-841.89)<=1,'A1_PAGE_SIZE');assert(String(source.producer||'').startsWith('TCPDF'),'A2_PRODUCER');assert(source.pages>=3,'A3_PAGES')
    const pageData=[]
    for(let p=1;p<=doc.numPages;p++){onProgress?.(`Parsing PDF · page ${p}/${doc.numPages}`);const page=await doc.getPage(p),tc=await textContentCompat(page),geom=await raw.pageGeometry(p);pageData.push({page,chars:runs(tc,geom.height),geom})}
    const c=pageData[0],upright=c.chars.filter(x=>!x.rotated),rot=c.chars.filter(x=>x.rotated)
    const coverLines=makeLines(upright).map(compact).filter(Boolean)

    // Primary path follows the template typography. Fallbacks use the cover
    // geometry/text pattern so PDF.js font metadata differences cannot turn a
    // valid Famileo cover into A11_ISSUE.
    let date_label=flow(pick(upright,13,'Regular'))
    if(!/^\d{1,2}\s+.+\s+\d{4}$/u.test(date_label)){
      // Safari/PDF.js can expose the cyan tile as three typographic lines:
      // "31" / "AOÛT" / "2026", rather than one logical text run.
      date_label=coverLines.find(x=>/^\d{1,2}\s+[\p{L}.]+\s+\d{4}$/u.test(x))||''
      if(!date_label){
        for(let i=0;i<=coverLines.length-3;i++){
          const day=coverLines[i],month=coverLines[i+1],year=coverLines[i+2]
          if(/^\d{1,2}$/.test(day)&&/^[\p{L}.]+$/u.test(month)&&/^\d{4}$/.test(year)&&monthNumber(month)){
            date_label=`${day} ${month} ${year}`
            break
          }
        }
      }
      if(!date_label){
        const tokens=coverLines.flatMap(x=>x.split(/\s+/)).filter(Boolean)
        for(let i=0;i<=tokens.length-3;i++){
          if(/^\d{1,2}$/.test(tokens[i])&&monthNumber(tokens[i+1])&&/^\d{4}$/.test(tokens[i+2])){
            date_label=`${tokens[i]} ${tokens[i+1]} ${tokens[i+2]}`
            break
          }
        }
      }
    }

    let issue_label=flow(pick(upright,25,'Regular'))
    if(!/\d+/.test(issue_label)){
      issue_label=coverLines.find(x=>/^N\s*[°ºo]?\s*\d+$/iu.test(x))||''
    }
    const issueMatch=String(issue_label).match(/\d+/)
    const issue_number=issueMatch?Number(issueMatch[0]):null
    if(Number.isInteger(issue_number)) issue_label=`N°${issue_number}`

    let title=flow(pick(upright,17,'Light'))
    if(!title){
      title=coverLines.find(x=>/^De\s+/iu.test(x))||''
    }

    let client_code=rot.filter(x=>/Open\s*Sans/i.test(x.font)).sort((a,b)=>b.top-a.top).map(x=>x.text).join('').replace(/\D/g,'')
    if(!/^\d{6}$/.test(client_code)){
      client_code=rot.sort((a,b)=>b.top-a.top).map(x=>x.text).join('').replace(/\D/g,'').slice(0,6)
    }
    const _parts=dateParts(date_label)
    const date_iso=_parts&&monthNumber(_parts.month)?iso(_parts.year,monthNumber(_parts.month),_parts.day):null
    const cols=[56.7,181.4,306.1,430.9],rowY=[62.4,187.1,547,671.7],rowN=[0,1,4,5],thumbnails=[]
    for(const im of c.geom.images.filter(x=>x.srcWidth===437&&x.srcHeight===437)){const col=cols.reduce((best,x,i)=>Math.abs(im.x0-x)<Math.abs(im.x0-cols[best])?i:best,0),ri=rowY.reduce((best,y,i)=>Math.abs(im.top-y)<Math.abs(im.top-rowY[best])?i:best,0);thumbnails.push({col,row:rowN[ri],src_px:[437,437]})}thumbnails.sort((a,b)=>a.row-b.row||a.col-b.col)
    assert(Number.isInteger(issue_number),'A11_ISSUE',`lines=${coverLines.join('|')}`);assert(/^\d{6}$/.test(client_code),'A11_CLIENT_CODE',`value=${client_code}`);assert(date_iso,'A12_COVER_DATE',`label=${date_label};lines=${coverLines.join('|')}`)
    const posts=[],geometry={}
    for(let p=2;p<doc.numPages;p++){
      const d=pageData[p-1],boxes=d.geom.rects.filter(r=>r.width>400&&r.height>100).sort((a,b)=>a.top-b.top)
      assert(boxes.length>=1&&boxes.length<=2,'A4_POST_BOX_COUNT',`p${p}:${boxes.length}`)
      for(const rb of boxes){const box=[round2(rb.x0),round2(rb.top),round2(rb.width),round2(rb.height)];assert(Math.abs(box[2]-504.57)<=2&&box[3]>100,'A5_POST_BOX_SIZE',`p${p}`);const chars=d.chars.filter(x=>inside(x,box)),imgs=d.geom.images.filter(x=>inside(x,box)),emojis=[]
        for(const im of imgs.filter(x=>x.srcWidth<=80&&x.srcHeight<=80&&Math.abs(x.width-12.37)<2&&Math.abs(x.height-12.37)<2)){assert(emojiResolver,'A9_EMOJI_CATALOG_REQUIRED');const e=await emojiResolver.resolve(im.raw);assert(e.sim>=.999,'A9_EMOJI_THRESHOLD');emojis.push({x0:im.x0,yCenter:(im.top+im.bottom)/2,...e})}
        const semByStyle=chars.filter(x=>style(x.font)==='SemiBold')
        const regByStyle=chars.filter(x=>style(x.font)==='Regular')
        const exactStylesOK=semByStyle.length>0&&regByStyle.length>0

        // Safari/PDF.js may expose a generic fontFamily (for example
        // "sans-serif") instead of the embedded NotoSans face name. Keep the
        // exact-style path whenever it is available; otherwise use the
        // typographic fallback explicitly recommended by SPEC_v1_CG:
        // author≈14 pt, date≈11 pt, body≈13.3 pt.
        const authorChars=semByStyle.length
          ? semByStyle
          : chars.filter(x=>approx(x.size,14,.45))
        const dateChars=regByStyle.length
          ? regByStyle.filter(x=>approx(x.size,11,.55))
          : chars.filter(x=>approx(x.size,11,.55))
        const body=regByStyle.length
          ? regByStyle.filter(x=>x.size>12)
          : chars.filter(x=>x.size>=12.65&&x.size<=13.70)

        const author=flow(authorChars),date_label=flow(dateChars)
        const fallbackOK=authorChars.length>0&&dateChars.length>0&&body.length>0
        const fontDiag=[...new Set(chars.map(x=>`${Math.round(x.size*10)/10}:${x.font||'?'}`))].join(',')
        assert(exactStylesOK||fallbackOK,'A8_STYLES',`p${p};fonts=${fontDiag}`)
        const lines=makeLines(body,emojis),text=compact(lines.join(' '))
        assert(author&&/^le\s+\d{1,2}\s+[\p{L}]+\.?$/u.test(date_label),'A6_POST_HEADER',`p${p}:${author}/${date_label};fonts=${fontDiag}`)
        const avatar=imgs.find(x=>x.srcWidth===170&&x.srcHeight===170),coll=imgs.filter(x=>x.width>100&&x.srcWidth>500);assert(Boolean(avatar)&&coll.length>=1,'A7_MEDIA',`p${p}`)
        const layout=layoutFor(body,coll,box),slot=slotFor(box,d.geom.height),post={page:p,author,date_label,text,lines,emoji:emojis.map(e=>({char:e.char,unified:e.unified,via:e.via})),slot,box_pt:box,layout,avatar:{src_px:[avatar.srcWidth,avatar.srcHeight]},collages:coll.map(i=>({src_px:[i.srcWidth,i.srcHeight],box_pt:[round2(i.x0),round2(i.top),round2(i.width),round2(i.height)]}))};posts.push(post)
        geometry[`${p}:${slot}`]={avatar_box_pt:[round2(avatar.x0),round2(avatar.top),round2(avatar.width),round2(avatar.height)],body_box_pt:body.length?[round2(Math.min(...body.map(x=>x.x0))),round2(Math.min(...body.map(x=>x.top))),round2(Math.max(...body.map(x=>x.x1))-Math.min(...body.map(x=>x.x0))),round2(Math.max(...body.map(x=>x.bottom))-Math.min(...body.map(x=>x.top)))]:null}
      }
    }
    resolveYears(posts,date_iso);assert(posts.every(p=>!p.date_iso||p.date_iso<=date_iso),'A12_POST_DATE')
    const backD=pageData.at(-1),addrLines=makeLines(backD.chars.filter(x=>approx(x.size,10,.5)&&style(x.font)==='Regular'&&x.x0>250)).map(x=>x.trim()).filter(Boolean),events=[],seen=new Set()
    for(const r of backD.geom.rects){if(Math.abs(r.width-107.7)>=2||Math.abs(r.height-107.7)>=2||!r.fill)continue;const key=`${round2(r.x0)}:${round2(r.top)}`;if(seen.has(key))continue;seen.add(key);const kind=colorClose(r.fillColor,CYAN)?'birthday':colorClose(r.fillColor,NAVY)?'nameday':null;if(!kind)continue;const box=[r.x0,r.top,r.width,r.height],cs=backD.chars.filter(x=>inside(x,box)),name=flow(pick(cs,11,'Bold',.5)),detail=makeLines(pick(cs,11,'SemiBold',.5));let age=null,dl=null;for(const l of detail){const a=l.trim().match(/^(\d+)\s*ans?\b/i);if(a)age=Number(a[1]);if(/^le\s/i.test(l.trim()))dl=l.trim()}if(name)events.push({kind,name,age:kind==='birthday'?age:null,date_label:dl})}
    const back={recipient:{name:addrLines[0]||null,address_lines:addrLines.slice(1)},events,thumbnails:backD.geom.images.filter(x=>x.srcWidth===437&&x.srcHeight===437).map(x=>({src_px:[437,437]}))};assert(back.recipient.name&&back.events.length,'A10_BACK')
    const dates=posts.map(p=>p.date_iso).filter(Boolean),stats={posts:posts.length,chronological:dates.every((d,i)=>i===0||dates[i-1]<=d),date_range:[dates.length?[...dates].sort()[0]:null,dates.length?[...dates].sort().at(-1):null],emoji_occurrences:posts.reduce((n,p)=>n+p.emoji.length,0),contributors:[...new Set(posts.map(p=>p.author.trim()))].sort()}
    const gazette={source,cover:{issue_label,issue_number,date_label,date_parts:_parts,date_iso,title,client_code,thumbnails},posts,back,stats};return {gazette,geometry,sha256:await sha256Hex(bytes),doc,raw}
  }
}
