import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url'
import { articleKey } from './protocol.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

async function getTextContentCompat(page, params = {}) {
  // Safari 26.x: PDF.js getTextContent() uses `for await...of` on the
  // ReadableStream returned by streamTextContent(). Some Safari versions
  // expose getReader() but not ReadableStream[Symbol.asyncIterator], which
  // makes getTextContent() throw `undefined is not a function`.
  // Consume the same stream through the reader API instead.
  const stream = page.streamTextContent(params)
  const reader = stream.getReader()
  const textContent = { items: [], styles: Object.create(null), lang: null }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      if (textContent.lang == null && value.lang != null) textContent.lang = value.lang
      if (value.styles) Object.assign(textContent.styles, value.styles)
      if (Array.isArray(value.items)) textContent.items.push(...value.items)
    }
  } finally {
    reader.releaseLock?.()
  }

  return textContent
}

function slugify(s='') {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'gazette'
}
function isoFromText(s='') {
  const months={janvier:1,fevrier:2,mars:3,avril:4,mai:5,juin:6,juillet:7,aout:8,septembre:9,octobre:10,novembre:11,decembre:12}
  const n=s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
  const m=n.match(/\b(\d{1,2})\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\s+(20\d{2})\b/)
  if(!m)return null
  return `${m[3]}-${String(months[m[2]]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`
}
async function sha256Hex(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...h].map(x=>x.toString(16).padStart(2,'0')).join('')
}
function itemY(item){return Number(item?.transform?.[5] ?? 0)}
function isDateText(s){return /^le\s+\d{1,2}\s+/i.test(String(s).trim())}
function inferSlots(textContent, pageHeight) {
  const items=textContent.items.filter(x=>x.str && x.transform).map(x=>({s:String(x.str),y:itemY(x),x:Number(x.transform[4]||0)})).sort((a,b)=>b.y-a.y||a.x-b.x)
  const lines=[]
  for(const it of items){
    let line=lines.find(l=>Math.abs(l.y-it.y)<=3)
    if(!line){line={y:it.y,parts:[]};lines.push(line)}
    line.parts.push(it)
  }
  const dates=lines.filter(l=>isDateText(l.parts.sort((a,b)=>a.x-b.x).map(x=>x.s).join(' '))).map(l=>l.y)
  if(dates.length<2)return ['p']
  const mid=pageHeight/2
  return dates.some(y=>y>mid)&&dates.some(y=>y<=mid) ? ['h','b'] : ['p']
}
export class FamileoPdf {
  constructor(bytes, doc, magazine, pagePlans) { this.bytes=bytes; this.doc=doc; this.magazine=magazine; this.pagePlans=pagePlans }

  static async load(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(await input.arrayBuffer())
    const sha256 = await sha256Hex(bytes)
    const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
    const metadata = await doc.getMetadata().catch(()=>({info:{},metadata:null}))
    const title = metadata?.info?.Title || metadata?.metadata?.get?.('dc:title') || 'Gazette Famileo'
    const cover = await doc.getPage(1)
    const coverTc = await getTextContentCompat(cover)
    const coverText = coverTc.items.map(x=>x.str||'').join(' ')
    const issueMatch = coverText.match(/N[°º]\s*(\d+)/i)
    const issue = issueMatch ? Number(issueMatch[1]) : null
    const date = isoFromText(coverText) || (metadata?.info?.CreationDate ? null : null)
    const magazineKey = `famileo:${slugify(title)}:${issue?`n${issue}`:'n0'}:${date||'date-unknown'}`
    const magazineId = `${magazineKey}:sha256-${sha256.slice(0,12)}`
    const pagePlans=[]
    for(let pageNo=2;pageNo<doc.numPages;pageNo++){
      const page=await doc.getPage(pageNo)
      const viewport=page.getViewport({scale:1})
      const tc=await getTextContentCompat(page)
      const slots=inferSlots(tc, viewport.height)
      const text=tc.items.map(x=>x.str||'').join(' ').trim()
      pagePlans.push({page:pageNo,slots,text})
    }
    const magazine={title,issue,date,sha256,magazineKey,magazineId,pageCount:doc.numPages}
    return new FamileoPdf(bytes,doc,magazine,pagePlans)
  }

  articles() {
    const out=[]
    for(const plan of this.pagePlans) for(const slot of plan.slots) out.push({
      magazineId:this.magazine.magazineId,
      articleKey:articleKey(this.magazine.magazineId,plan.page,slot),
      page:plan.page, slot, pageText:plan.text,
    })
    return out
  }

  async renderArticle(article, scale=1.8) {
    const page=await this.doc.getPage(article.page)
    const viewport=page.getViewport({scale})
    const canvas=document.createElement('canvas')
    canvas.width=Math.ceil(viewport.width); canvas.height=Math.ceil(viewport.height)
    await page.render({canvas,viewport}).promise
    const W=canvas.width,H=canvas.height
    const x=Math.floor(W*0.035), w=Math.floor(W*0.93)
    let y,h
    if(article.slot==='h'){y=Math.floor(H*0.015);h=Math.floor(H*0.475)}
    else if(article.slot==='b'){y=Math.floor(H*0.495);h=Math.floor(H*0.465)}
    else {y=Math.floor(H*0.015);h=Math.floor(H*0.945)}
    const out=document.createElement('canvas');out.width=w;out.height=h
    out.getContext('2d').drawImage(canvas,x,y,w,h,0,0,w,h)
    return out
  }
}
