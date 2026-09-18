import { loadEncryptedSecret, decryptCredentials } from './crypto.js'
import { TelegramGateway } from './telegram.js'
import { FamileoPdf } from './pdf.js'
import { parseMeta, stripMeta } from './protocol.js'
import { kv, cacheMessages, getCachedMessages, putFile, getFile } from './storage.js'

function idOfPeer(peer){return String(typeof peer?.id==='bigint'?peer.id:peer?.id?.value??peer?.id??'')}
function topicKey(peer, topicId){return `${idOfPeer(peer)}:${topicId}`}

export class MaminaService {
  constructor(){this.gateway=null;this.dialog=null;this.topic=null;this.pdf=null}

  async unlock(password){
    const blob=await loadEncryptedSecret()
    const creds=await decryptCredentials(blob,password)
    this.gateway=new TelegramGateway(creds)
    return true
  }

  async login(){if(!this.gateway)throw new Error('Secrets non déverrouillés.');return this.gateway.login()}
  async logout(){if(this.gateway)await this.gateway.logout()}
  async listDialogs(){return this.gateway.dialogs()}
  async selectDialog(dialog){this.dialog=dialog;this.topic=null;this.pdf=null;await kv.set('lastDialogId',idOfPeer(dialog.peer))}
  async listTopics(){if(!this.dialog)throw new Error('Aucun groupe sélectionné.');return this.gateway.topics(this.dialog.peer)}
  async selectTopic(topic){this.topic=topic;this.pdf=null;await kv.set(`lastTopic:${idOfPeer(this.dialog.peer)}`,Number(topic.id))}

  async createMagazineTopic(file){
    if(!this.dialog)throw new Error('Aucun groupe sélectionné.')
    const pdf=await FamileoPdf.load(file)
    const m=pdf.magazine
    const title=`${m.date?m.date.slice(0,7):'Revue'} — Famileo${m.issue?` N°${m.issue}`:''}`
    const {topicId}=await this.gateway.createTopic(this.dialog.peer,title)
    await this.gateway.postMagazinePdf(this.dialog.peer,topicId,file,m)
    const topics=await this.listTopics()
    this.topic=topics.find(t=>Number(t.id)===Number(topicId)) || {id:topicId,title}
    this.pdf=pdf
    await putFile(`pdf:${m.sha256}`,new Uint8Array(await file.arrayBuffer()))
    return {topic:this.topic,magazine:m,articles:pdf.articles()}
  }

  async syncTopic({full=false}={}){
    if(!this.dialog||!this.topic)throw new Error('Groupe et sujet requis.')
    const key=topicKey(this.dialog.peer,this.topic.id)
    const cursor=full?0:Number(await kv.get(`cursor:${key}`)||0)
    const raw=await this.gateway.topicMessages(this.dialog.peer,Number(this.topic.id),{minId:cursor,limit:Infinity})
    const rows=raw.map(TelegramGateway.messageModel)
    if(rows.length){await cacheMessages(key,rows);await kv.set(`cursor:${key}`,Math.max(cursor,...rows.map(r=>r.id)))}
    return {raw,rows,cached:await getCachedMessages(key)}
  }

  async loadMagazine(){
    if(!this.dialog||!this.topic)throw new Error('Groupe et sujet requis.')
    const synced=await this.syncTopic({full:false})
    let cached=synced.cached
    let pdfRow=cached.find(r=>r.meta?.kind==='pdf')
    let rawPdf=synced.raw.find(m=>parseMeta(m.text||m.caption||'')?.kind==='pdf')
    if(!pdfRow){
      const full=await this.syncTopic({full:true});cached=full.cached;pdfRow=cached.find(r=>r.meta?.kind==='pdf');rawPdf=full.raw.find(m=>parseMeta(m.text||m.caption||'')?.kind==='pdf')
    }
    if(!pdfRow)throw new Error('Aucun PDF Mamina trouvé dans ce sujet.')
    const sha=pdfRow.meta.sha256
    let bytes=await getFile(`pdf:${sha}`)
    if(!bytes){
      if(!rawPdf){
        const fullRaw=await this.gateway.topicMessages(this.dialog.peer,Number(this.topic.id),{limit:Infinity})
        rawPdf=fullRaw.find(m=>parseMeta(m.text||m.caption||'')?.kind==='pdf')
      }
      if(!rawPdf)throw new Error('Message PDF introuvable.')
      bytes=await this.gateway.downloadMessageMedia(rawPdf)
      await putFile(`pdf:${sha}`,bytes)
    }
    this.pdf=await FamileoPdf.load(bytes)
    if(this.pdf.magazine.sha256!==sha)throw new Error('Le PDF téléchargé ne correspond pas au hash annoncé.')
    return this.viewModel(cached)
  }

  async refresh(){
    const sync=await this.syncTopic({full:false})
    if(!this.pdf) return this.loadMagazine()
    return this.viewModel(sync.cached)
  }

  viewModel(cached){
    const articles=this.pdf.articles()
    const roots=new Map()
    for(const row of cached){if(row.meta?.kind==='root'&&row.meta.articleKey){const a=roots.get(row.meta.articleKey)||[];a.push(row);roots.set(row.meta.articleKey,a)}}
    for(const a of roots.values())a.sort((x,y)=>x.id-y.id)
    const rootById=new Map();for(const [ak,a] of roots)for(const r of a)rootById.set(r.id,ak)
    const byArticle=new Map(articles.map(a=>[a.articleKey,[]]))
    const rowById=new Map(cached.map(r=>[r.id,r]))
    const resolveArticle=(row)=>{
      if(row.meta?.articleKey)return row.meta.articleKey
      let p=row.replyToId,guard=0
      while(p&&guard++<50){if(rootById.has(p))return rootById.get(p);const parent=rowById.get(p);p=parent?.replyToId||null}
      return null
    }
    for(const row of cached){if(row.meta?.kind==='message'||(!row.meta&&row.replyToId)){const ak=resolveArticle(row);if(ak&&byArticle.has(ak))byArticle.get(ak).push({...row,displayText:stripMeta(row.text)})}}
    return {magazine:this.pdf.magazine,articles:articles.map(a=>({...a,comments:byArticle.get(a.articleKey)||[],rootId:roots.get(a.articleKey)?.[0]?.id||null,duplicateRootIds:(roots.get(a.articleKey)||[]).slice(1).map(x=>x.id)}))}
  }

  async postComment(article,{text='',imageFile=null}={}){
    if(!text.trim()&&!imageFile)throw new Error('Commentaire vide.')
    const full=await this.gateway.topicMessages(this.dialog.peer,Number(this.topic.id),{limit:Infinity})
    const {rootId}=await this.gateway.ensureRoot(this.dialog.peer,Number(this.topic.id),this.pdf.magazine,article,full)
    if(imageFile)await this.gateway.postImageComment(this.dialog.peer,Number(this.topic.id),rootId,article.articleKey,imageFile,text)
    else await this.gateway.postTextComment(this.dialog.peer,Number(this.topic.id),rootId,article.articleKey,text)
    return this.refresh()
  }
}
