import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url'
import { articleKey } from './protocol.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

function asError(err, stage) {
  if (err instanceof Error) {
    const wrapped = new Error(`${stage}: ${err.message || err.name || 'erreur inconnue'}`)
    wrapped.cause = err
    if (err.stack) wrapped.stack = `${wrapped.name}: ${wrapped.message}\nCAUSE\n${err.stack}`
    return wrapped
  }
  let detail
  try { detail = JSON.stringify(err) } catch { detail = String(err) }
  return new Error(`${stage}: rejet PDF.js non-Error (${detail ?? String(err)})`)
}

async function getTextContentCompat(page, params = {}, trace = null, label = '') {
  trace?.('pdf.text', 'Ouverture du flux texte', { label })
  let stream
  let reader

  try {
    stream = page.streamTextContent(params)
    if (!stream || typeof stream.getReader !== 'function') {
      throw new Error('streamTextContent() ne fournit pas de ReadableStream avec getReader().')
    }
    reader = stream.getReader()
  } catch (e) {
    throw asError(e, `Texte ${label} / ouverture du stream`)
  }

  const textContent = { items: [], styles: Object.create(null), lang: null }
  let chunks = 0

  try {
    while (true) {
      let packet
      try {
        packet = await reader.read()
      } catch (e) {
        throw asError(e, `Texte ${label} / reader.read()`)
      }

      if (!packet || packet.done) break
      const value = packet.value
      if (!value) continue
      chunks++

      if (textContent.lang == null && value.lang != null) textContent.lang = value.lang

      if (value.styles && typeof value.styles === 'object') {
        const keys = Object.keys(value.styles)
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i]
          textContent.styles[k] = value.styles[k]
        }
      }

      const incoming = value.items
      if (incoming && typeof incoming.length === 'number') {
        for (let i = 0; i < incoming.length; i++) {
          textContent.items.push(incoming[i])
        }
      }
    }
  } finally {
    try {
      if (reader && typeof reader.releaseLock === 'function') reader.releaseLock()
    } catch {}
  }

  trace?.('pdf.text', 'Flux texte lu', {
    label,
    chunks,
    items: textContent.items.length,
  })
  return textContent
}

function slugify(s='') {
  const value = String(s || '')
  return value.normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/^-|-$/g,'') || 'gazette'
}

function isoFromText(s='') {
  const months={janvier:1,fevrier:2,mars:3,avril:4,mai:5,juin:6,juillet:7,aout:8,septembre:9,octobre:10,novembre:11,decembre:12}
  const n=String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
  const m=n.match(/\b(\d{1,2})\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\s+(20\d{2})\b/)
  if(!m)return null
  return `${m[3]}-${String(months[m[2]]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`
}

async function sha256Hex(bytes) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  const h = new Uint8Array(digest)
  let out = ''
  for (let i = 0; i < h.length; i++) out += h[i].toString(16).padStart(2,'0')
  return out
}

function itemY(item){return Number(item && item.transform ? item.transform[5] : 0)}

function isDateText(s){
  return /^le\s+\d{1,2}\s+/i.test(String(s||'').trim())
}

function inferSlots(textContent, pageHeight) {
  const source = Array.isArray(textContent?.items) ? textContent.items : []
  const items = []

  for (let i = 0; i < source.length; i++) {
    const x = source[i]
    if (!x || !x.str || !x.transform) continue
    items.push({
      s: String(x.str),
      y: itemY(x),
      x: Number(x.transform[4] || 0),
    })
  }

  items.sort((a,b)=>b.y-a.y||a.x-b.x)

  const lines=[]
  for (let i = 0; i < items.length; i++) {
    const it=items[i]
    let line=null
    for (let j = 0; j < lines.length; j++) {
      if (Math.abs(lines[j].y-it.y)<=3) { line=lines[j]; break }
    }
    if(!line){line={y:it.y,parts:[]};lines.push(line)}
    line.parts.push(it)
  }

  const dates=[]
  for (let i = 0; i < lines.length; i++) {
    const l=lines[i]
    l.parts.sort((a,b)=>a.x-b.x)
    let joined=''
    for(let j=0;j<l.parts.length;j++) joined += (j?' ':'') + l.parts[j].s
    if(isDateText(joined)) dates.push(l.y)
  }

  if(dates.length<2)return ['p']
  const mid=pageHeight/2
  let top=false,bottom=false
  for(let i=0;i<dates.length;i++){
    if(dates[i]>mid) top=true
    else bottom=true
  }
  return top&&bottom ? ['h','b'] : ['p']
}


function articleDetails(textContent, pageWidth, pageHeight, slot) {
  const source = Array.isArray(textContent?.items) ? textContent.items : []
  const crop = slot === 'h'
    ? {x0:.035, y0:.015, x1:.965, y1:.490}
    : slot === 'b'
      ? {x0:.035, y0:.495, x1:.965, y1:.960}
      : {x0:.035, y0:.015, x1:.965, y1:.960}

  const selected=[]
  for(let i=0;i<source.length;i++){
    const it=source[i]
    if(!it?.str || !it?.transform) continue
    const x=Number(it.transform[4]||0)
    const pdfY=Number(it.transform[5]||0)
    const topY=pageHeight-pdfY
    const nx=x/pageWidth
    const ny=topY/pageHeight
    if(nx<crop.x0 || nx>crop.x1 || ny<crop.y0 || ny>crop.y1) continue
    // Exclude the Famileo footer/page number.
    if(ny>.955) continue
    selected.push({
      str:String(it.str),
      x,
      y:topY,
      width:Number(it.width||0),
      height:Math.max(8,Number(it.height||Math.abs(it.transform[0])||10)),
    })
  }

  selected.sort((a,b)=>a.y-b.y || a.x-b.x)
  let text=''
  for(let i=0;i<selected.length;i++){
    if(text) text+=' '
    text+=selected[i].str
  }

  if(!selected.length) return {articleText:text.trim(), textBounds:null}

  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity
  for(const it of selected){
    minX=Math.min(minX,it.x)
    minY=Math.min(minY,it.y-it.height)
    maxX=Math.max(maxX,it.x+Math.max(it.width,10))
    maxY=Math.max(maxY,it.y+it.height*.4)
  }

  const cropX=crop.x0*pageWidth
  const cropY=crop.y0*pageHeight
  const cropW=(crop.x1-crop.x0)*pageWidth
  const cropH=(crop.y1-crop.y0)*pageHeight
  const padX=.02, padY=.025

  const articleText=text.trim()
  let authorName='', articleDateLabel='', bodyText=articleText
  const header=articleText.match(/^(.+?)\s+le\s+(\d{1,2}\s+[A-Za-zÀ-ÿ]+)\s+([\s\S]*)$/iu)
  if(header){
    authorName=header[1].replace(/\s+/g,' ').trim()
    articleDateLabel=`le ${header[2].replace(/\s+/g,' ').trim()}`
    bodyText=header[3].trim()
  }

  const textBounds={
    x0:Math.max(0,(minX-cropX)/cropW-padX),
    y0:Math.max(0,(minY-cropY)/cropH-padY),
    x1:Math.min(1,(maxX-cropX)/cropW+padX),
    y1:Math.min(1,(maxY-cropY)/cropH+padY),
  }

  const photoBounds = slot==='h'
    ? {x0:0,y0:0,x1:Math.max(.42,Math.min(.62,textBounds.x0-.015)),y1:1}
    : slot==='b'
      ? {x0:0,y0:0,x1:1,y1:Math.max(.50,Math.min(.76,textBounds.y0-.015))}
      : (textBounds.x0>.48
        ? {x0:0,y0:0,x1:Math.max(.45,textBounds.x0-.015),y1:1}
        : {x0:0,y0:0,x1:1,y1:Math.max(.45,textBounds.y0-.015)})

  const avatarBounds = slot==='h'
    ? {x0:.69,y0:.035,x1:.81,y1:.19}
    : slot==='b'
      ? {x0:.055,y0:.66,x1:.19,y1:.86}
      : {x0:.05,y0:.04,x1:.18,y1:.18}

  return {articleText,authorName,articleDateLabel,bodyText,textBounds,photoBounds,avatarBounds}
}

function textFromContent(tc) {
  const arr = Array.isArray(tc?.items) ? tc.items : []
  let out = ''
  for (let i=0;i<arr.length;i++) {
    const s = arr[i]?.str
    if (!s) continue
    if (out) out += ' '
    out += String(s)
  }
  return out.trim()
}

export class FamileoPdf {
  constructor(bytes, doc, magazine, pagePlans) {
    this.bytes=bytes
    this.doc=doc
    this.magazine=magazine
    this.pagePlans=pagePlans
  }

  static async load(input, { trace = null } = {}) {
    const emit = (scope, message, detail) => {
      try { trace?.(scope, message, detail) } catch {}
    }

    let bytes
    try {
      emit('pdf.load','Normalisation des octets')
      bytes = input instanceof Uint8Array ? input : new Uint8Array(await input.arrayBuffer())
      emit('pdf.load','Octets prêts',{bytes:bytes.byteLength})
    } catch(e) {
      throw asError(e,'PDF / lecture des octets')
    }

    let sha256
    try {
      emit('pdf.load','Calcul SHA-256')
      sha256 = await sha256Hex(bytes)
      emit('pdf.load','SHA-256 calculé',{prefix:sha256.slice(0,12)})
    } catch(e) {
      throw asError(e,'PDF / SHA-256')
    }

    let doc
    try {
      emit('pdf.load','Ouverture PDF.js')
      doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
      emit('pdf.load','PDF.js ouvert',{pages:doc.numPages})
    } catch(e) {
      throw asError(e,'PDF / ouverture PDF.js')
    }

    let metadata
    try {
      emit('pdf.load','Lecture métadonnées')
      metadata = await doc.getMetadata()
      emit('pdf.load','Métadonnées lues',{
        title:metadata?.info?.Title||null,
        producer:metadata?.info?.Producer||null,
      })
    } catch(e) {
      emit('pdf.load','Métadonnées indisponibles',{error:String(e)})
      metadata={info:{},metadata:null}
    }

    const title = String(metadata?.info?.Title || 'Gazette Famileo')

    let coverText=''
    try {
      emit('pdf.load','Lecture couverture')
      const cover = await doc.getPage(1)
      const coverTc = await getTextContentCompat(cover, {}, emit, 'couverture')
      coverText = textFromContent(coverTc)
      emit('pdf.load','Couverture analysée',{chars:coverText.length})
    } catch(e) {
      throw asError(e,'PDF / couverture')
    }

    const issueMatch = coverText.match(/N[°º]\s*(\d+)/i)
    const issue = issueMatch ? Number(issueMatch[1]) : null
    const date = isoFromText(coverText)
    const magazineKey = `famileo:${slugify(title)}:${issue?`n${issue}`:'n0'}:${date||'date-unknown'}`
    const magazineId = `${magazineKey}:sha256-${sha256.slice(0,12)}`

    const pagePlans=[]
    for(let pageNo=2;pageNo<doc.numPages;pageNo++){
      try {
        emit('pdf.page','Lecture page',{page:pageNo})
        const page=await doc.getPage(pageNo)
        const viewport=page.getViewport({scale:1})
        const tc=await getTextContentCompat(page, {}, emit, `page ${pageNo}`)
        const slots=inferSlots(tc, viewport.height)
        const text=textFromContent(tc)
        const details={}
        for(let si=0;si<slots.length;si++){
          details[slots[si]]=articleDetails(tc,viewport.width,viewport.height,slots[si])
        }
        pagePlans.push({page:pageNo,slots,text,details})
        emit('pdf.page','Page analysée',{page:pageNo,slots,items:tc.items.length})
      } catch(e) {
        throw asError(e,`PDF / page ${pageNo}`)
      }
    }

    const magazine={title,issue,date,sha256,magazineKey,magazineId,pageCount:doc.numPages}
    emit('pdf.load','Analyse Famileo terminée',{
      magazineId,
      issue,
      date,
      articlePages:pagePlans.length,
    })
    return new FamileoPdf(bytes,doc,magazine,pagePlans)
  }

  async renderCover(scale=1.25) {
    const page = await this.doc.getPage(1)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await page.render({ canvas, viewport }).promise
    return canvas
  }

  articles() {
    const out=[]
    for(let i=0;i<this.pagePlans.length;i++){
      const plan=this.pagePlans[i]
      for(let j=0;j<plan.slots.length;j++){
        const slot=plan.slots[j]
        out.push({
          magazineId:this.magazine.magazineId,
          articleKey:articleKey(this.magazine.magazineId,plan.page,slot),
          page:plan.page,
          slot,
          pageText:plan.text,
          articleText:plan.details?.[slot]?.articleText || plan.text,
          authorName:plan.details?.[slot]?.authorName || '',
          articleDateLabel:plan.details?.[slot]?.articleDateLabel || '',
          bodyText:plan.details?.[slot]?.bodyText || plan.details?.[slot]?.articleText || plan.text,
          textBounds:plan.details?.[slot]?.textBounds || null,
          photoBounds:plan.details?.[slot]?.photoBounds || null,
          avatarBounds:plan.details?.[slot]?.avatarBounds || null,
        })
      }
    }
    return out
  }

  async renderArticlePhoto(article, scale=2.4) {
    const collages=Array.isArray(article?.collages)?article.collages.filter(c=>Array.isArray(c?.box_pt)&&c.box_pt.length===4):[]
    if(!collages.length) throw new Error('Zone photo indisponible pour cet article.')
    const page=await this.doc.getPage(article.page)
    const viewport=page.getViewport({scale})
    const canvas=document.createElement('canvas')
    canvas.width=Math.ceil(viewport.width)
    canvas.height=Math.ceil(viewport.height)
    await page.render({canvas,viewport}).promise

    const x0=Math.min(...collages.map(c=>c.box_pt[0]))
    const y0=Math.min(...collages.map(c=>c.box_pt[1]))
    const x1=Math.max(...collages.map(c=>c.box_pt[0]+c.box_pt[2]))
    const y1=Math.max(...collages.map(c=>c.box_pt[1]+c.box_pt[3]))
    const x=Math.max(0,Math.floor(x0*scale)),y=Math.max(0,Math.floor(y0*scale))
    const w=Math.max(1,Math.min(canvas.width-x,Math.ceil((x1-x0)*scale)))
    const h=Math.max(1,Math.min(canvas.height-y,Math.ceil((y1-y0)*scale)))
    const out=document.createElement('canvas')
    out.width=w;out.height=h
    out.getContext('2d').drawImage(canvas,x,y,w,h,0,0,w,h)
    try { canvas.width=1;canvas.height=1;page.cleanup?.() } catch {}
    return out
  }

  async renderArticle(article, scale=1.8) {
    const page=await this.doc.getPage(article.page)
    const viewport=page.getViewport({scale})
    const canvas=document.createElement('canvas')
    canvas.width=Math.ceil(viewport.width)
    canvas.height=Math.ceil(viewport.height)
    await page.render({canvas,viewport}).promise

    const W=canvas.width,H=canvas.height
    let x,w,y,h
    if(Array.isArray(article.boxPt)&&article.boxPt.length===4){
      const rb=article.renderBounds&&typeof article.renderBounds==='object'?article.renderBounds:null
      const bx=article.boxPt[0],by=article.boxPt[1],bw=article.boxPt[2],bh=article.boxPt[3]
      const rx=bx+bw*(rb?.x0??0),ry=by+bh*(rb?.y0??0),rw=bw*((rb?.x1??1)-(rb?.x0??0)),rh=bh*((rb?.y1??1)-(rb?.y0??0))
      x=Math.max(0,Math.floor(rx*scale));y=Math.max(0,Math.floor(ry*scale));w=Math.min(W-x,Math.ceil(rw*scale));h=Math.min(H-y,Math.ceil(rh*scale))
    } else {
      x=Math.floor(W*0.035);w=Math.floor(W*0.93)
      if(article.slot==='h'){y=Math.floor(H*0.015);h=Math.floor(H*0.475)}
      else if(article.slot==='b'){y=Math.floor(H*0.495);h=Math.floor(H*0.465)}
      else {y=Math.floor(H*0.015);h=Math.floor(H*0.945)}
    }

    const out=document.createElement('canvas')
    out.width=w
    out.height=h
    out.getContext('2d').drawImage(canvas,x,y,w,h,0,0,w,h)
    try { canvas.width=1; canvas.height=1; page.cleanup?.() } catch {}
    return out
  }
}
