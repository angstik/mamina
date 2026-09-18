import { loadEncryptedSecret, decryptCredentials } from './crypto.js'
import { TelegramGateway } from './telegram.js'
import { FamileoPdf } from './pdf.js'
import { parseMeta, stripMeta } from './protocol.js'
import {
  settings, putMagazine, getMagazine, getMagazineByTopic, listMagazines,
  putTopicState, getTopicState, replaceArticles, listArticles,
  putMessages, listMessagesByMagazine, deleteMessagesByMagazine,
  getReadState, putReadState, listReadStates,
  putAsset, getAsset, deleteAsset, pruneToMagazineIds,
} from './user-storage.js'
import { info, warn, error as logError } from './log.js'

function idOfPeer(peer) { return String(typeof peer?.id === 'bigint' ? peer.id : peer?.id?.value ?? peer?.id ?? '') }
function topicKey(peer, topicId) { return `${idOfPeer(peer)}:${Number(topicId)}` }
function isMagazineTopic(topic) { return /famileo/i.test(String(topic?.title || '')) }
function topicIdOf(topic) { return Number(topic?.id || topic?.topicId || 0) }
function rowMetaText(message) { return message?.text || message?.caption || '' }

function canvasBlob(canvas, type='image/jpeg', quality=.82) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Conversion image impossible.')), type, quality))
}

function resolveRowsToArticles(rows, articles) {
  const articleKeys = new Set(articles.map(a => a.articleKey))
  const roots = new Map()
  for (const row of rows) {
    if (row.meta?.kind === 'root' && row.meta.articleKey) {
      const list = roots.get(row.meta.articleKey) || []
      list.push(row)
      roots.set(row.meta.articleKey, list)
    }
  }
  for (const list of roots.values()) list.sort((a,b)=>a.id-b.id)
  const rootById = new Map()
  for (const [ak,list] of roots) for (const root of list) rootById.set(root.id,ak)
  const rowById = new Map(rows.map(r=>[r.id,r]))
  const byArticle = new Map(articles.map(a=>[a.articleKey,[]]))

  const resolveArticle = row => {
    if (row.meta?.articleKey && articleKeys.has(row.meta.articleKey)) return row.meta.articleKey
    let id=row.replyToId, guard=0
    while(id && guard++<50) {
      if(rootById.has(id)) return rootById.get(id)
      const p=rowById.get(id)
      id=p?.replyToId || null
    }
    return null
  }

  for (const row of rows) {
    if (row.meta?.kind === 'message' || (!row.meta && row.replyToId)) {
      const ak = resolveArticle(row)
      if (!ak || !byArticle.has(ak)) continue
      byArticle.get(ak).push({ ...row, articleKey:ak, displayText:stripMeta(row.text) })
    }
  }
  return { roots, byArticle }
}

export class UserMaminaService {
  constructor() {
    this.gateway=null
    this.dialog=null
    this.dialogModel=null
    this.current=null
    this.syncing=null
    this.updateUnsubscribe=null
    this.onChanged=null
    this.onConnectionState=null
  }

  async unlock(password) {
    const blob=await loadEncryptedSecret()
    const creds=await decryptCredentials(blob,password)
    this.gateway=new TelegramGateway(creds)
    this.gateway.onConnectionState(state=>this.onConnectionState?.(state))
  }

  async login() {
    if(!this.gateway) throw new Error('Secrets non déverrouillés.')
    const me=await this.gateway.login()
    this.installUpdates()
    return me
  }

  installUpdates() {
    if(this.updateUnsubscribe || !this.gateway) return
    let timer=null
    this.updateUnsubscribe=this.gateway.onNewMessage(()=>{
      clearTimeout(timer)
      timer=setTimeout(async()=>{
        try { await this.syncAll(); this.onChanged?.() } catch(e) { console.error('Mamina sync update',e) }
      },700)
    })
  }

  async listForumDialogs() {
    const rows=await this.gateway.dialogs()
    return rows.map(TelegramGateway.dialogModel).filter(x=>x.isForum)
  }

  async restoreOrSelectDialog(dialogModel=null) {
    const rows=await this.gateway.dialogs()
    const models=rows.map(TelegramGateway.dialogModel).filter(x=>x.isForum)
    const wanted=dialogModel ? idOfPeer((dialogModel.dialog||dialogModel).peer) : await settings.get('groupId','')
    const selected=models.find(m=>idOfPeer(m.dialog.peer)===String(wanted)) || (models.length===1?models[0]:null)
    if(selected) await this.selectDialog(selected)
    return {models,selected}
  }

  async selectDialog(model) {
    this.dialog=model.dialog||model
    this.dialogModel=model.dialog?model:TelegramGateway.dialogModel(model)
    await settings.set('groupId',idOfPeer(this.dialog.peer))
    this.current=null
  }

  async syncAll() {
    if(!this.dialog) throw new Error('Aucun groupe sélectionné.')
    info('sync','Synchronisation demandée',{group:this.dialogModel?.title||null})
    if(this.syncing) return this.syncing
    this.syncing=this._syncAll().then(result=>{info('sync','Synchronisation terminée',{magazines:result?.length||0});return result}).catch(e=>{logError('sync','Synchronisation échouée',e);throw e}).finally(()=>{this.syncing=null})
    return this.syncing
  }

  async _syncAll() {
    const peer=this.dialog.peer
    info('sync','Lecture des sujets Telegram')
    const allTopics=await this.gateway.topics(peer)
    info('sync','Sujets reçus',{count:allTopics.length})
    const topics=allTopics.filter(isMagazineTopic).sort((a,b)=>topicIdOf(b)-topicIdOf(a))
    info('sync','Sujets Famileo détectés',{count:topics.length,titles:topics.slice(0,10).map(t=>t.title)})
    const cached=await listMagazines()
    const cachedByTopic=new Map(cached.map(m=>[m.topicKey,m]))
    let found=[]

    // Scan a bounded set of recent Famileo topics; stop when ten magazines are known.
    for(const topic of topics.slice(0,30)) {
      const tid=topicIdOf(topic); if(!tid) continue
      const key=topicKey(peer,tid)
      let magazine=cachedByTopic.get(key)
      info('sync.topic','Traitement sujet',{title:topic.title||'',topicId:tid,cached:Boolean(magazine)})
      if(!magazine) magazine=await this.discoverTopic(topic)
      else magazine=await this.syncKnownTopic(magazine)
      if(magazine) found.push(magazine)
      if(found.length>=10) break
    }

    // Keep already cached magazines that may not have appeared in the first page of topics.
    for(const m of cached) if(!found.some(x=>x.magazineId===m.magazineId)) found.push(m)
    found.sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')) || b.topicId-a.topicId)
    found=found.slice(0,10)

    for(const m of found.slice(0,2)) await this.ensureFullCache(m)
    for(const m of found.slice(2)) await this.dropFullCache(m)

    const keepIds=found.map(m=>m.magazineId)
    const before=await listMagazines()
    for(const old of before) if(!keepIds.includes(old.magazineId)){ await deleteAsset(`cover:${old.magazineId}`); await deleteAsset(`pdf:${old.magazineId}`); await deleteAsset(`staging-pdf:${old.magazineId}`); await deleteMessagesByMagazine(old.magazineId); await replaceArticles(old.magazineId,[]) }
    await pruneToMagazineIds(keepIds)
    await settings.set('magazineOrder',found.map(m=>m.magazineId))
    return this.magazineSummaries()
  }

  async discoverTopic(topic) {
    const peer=this.dialog.peer, tid=topicIdOf(topic), key=topicKey(peer,tid)
    info('sync.discover','Découverte du sujet',{title:topic.title||'',topicId:tid})
    const raw=await this.gateway.topicMessages(peer,tid,{limit:Infinity})
    const rows=raw.map(TelegramGateway.messageModel)
    const pdfIndex=rows.findIndex(r=>r.meta?.kind==='pdf')
    if(pdfIndex<0){info('sync.discover','Pas de marqueur PDF Mamina',{topicId:tid});return null}
    const pdfRow=rows[pdfIndex]
    const rawPdf=raw[pdfIndex]
    if(!rawPdf?.media) return null

    info('sync.discover','Téléchargement PDF',{topicId:tid,messageId:pdfRow.id})
    const bytes=await this.gateway.downloadMessageMedia(rawPdf)
    info('sync.discover','Analyse PDF',{bytes:bytes?.byteLength||bytes?.length||0})
    const pdf=await FamileoPdf.load(bytes,{trace:(scope,message,detail)=>info(scope,message,detail)})
    info('sync.discover','PDF analysé',{
      magazineId:pdf.magazine?.magazineId||null,
      issue:pdf.magazine?.issue??null,
      date:pdf.magazine?.date||null,
      pages:pdf.magazine?.pageCount??null,
    })

    if(pdfRow.meta?.sha256 && pdf.magazine.sha256!==pdfRow.meta.sha256) {
      throw new Error(`Hash PDF incohérent pour ${topic.title||tid}.`)
    }

    const articles=pdf.articles()
    info('sync.discover','Articles détectés',{
      topicId:tid,
      count:articles.length,
      slots:articles.reduce((acc,a)=>{acc[a.slot]=(acc[a.slot]||0)+1;return acc},{}),
    })

    const resolved=resolveRowsToArticles(rows,articles)

    info('sync.discover','Rendu couverture',{topicId:tid})
    const coverCanvas=await pdf.renderCover()
    info('sync.discover','Conversion couverture en image',{
      width:coverCanvas.width,
      height:coverCanvas.height,
    })
    const cover=await canvasBlob(coverCanvas)
    info('sync.discover','Stockage couverture',{
      magazineId:pdf.magazine.magazineId,
      bytes:cover.size||0,
    })
    await putAsset(`cover:${pdf.magazine.magazineId}`,cover)
    info('sync.discover','Couverture stockée',{
      magazineId:pdf.magazine.magazineId,
      storage:'Uint8Array+MIME',
    })

    const read=await this.readMap()
    const comments=[...resolved.byArticle.values()].flat()
    const unread=comments.filter(c=>!c.isOutgoing && c.id>(read.get(c.articleKey)||0)).length
    const record={
      ...pdf.magazine,
      topicId:tid, topicKey:key, topicTitle:topic.title||'', pdfMessageId:pdfRow.id,
      reactionCount:comments.length, unreadCount:unread, fullyCached:false,
      lastMessageId:rows.reduce((m,r)=>Math.max(m,r.id),0), updatedAt:new Date().toISOString(),
    }
    await putMagazine(record)
    await putTopicState({topicKey:key,topicId:tid,cursor:record.lastMessageId,updatedAt:record.updatedAt})
    // Temporarily retain bytes so promotion to top-2 needs no second download.
    await putAsset(`staging-pdf:${record.magazineId}`,bytes)
    info('sync.discover','Revue découverte',{magazineId:record.magazineId,articles:articles.length,reactions:comments.length})
    return record
  }

  async syncKnownTopic(magazine) {
    const peer=this.dialog.peer, state=await getTopicState(magazine.topicKey)
    info('sync.known','Synchronisation revue connue',{magazineId:magazine.magazineId,topicId:magazine.topicId})
    const cursor=Number(state?.cursor||magazine.lastMessageId||0)
    const raw=await this.gateway.topicMessages(peer,magazine.topicId,{minId:cursor,limit:Infinity})
    if(!raw.length){info('sync.known','Aucun nouveau message',{magazineId:magazine.magazineId,cursor});return magazine}
    const rows=raw.map(TelegramGateway.messageModel).filter(r=>r.id>cursor)
    const messages=rows.filter(r=>r.meta?.kind==='message')
    let unreadAdd=0
    for(const m of messages) {
      if(m.isOutgoing) continue
      const rs=await getReadState(m.meta?.articleKey||'')
      if(m.id>Number(rs?.lastReadMessageId||0)) unreadAdd++
    }
    const next={...magazine,reactionCount:Number(magazine.reactionCount||0)+messages.length,unreadCount:Number(magazine.unreadCount||0)+unreadAdd,lastMessageId:Math.max(cursor,...rows.map(r=>r.id)),updatedAt:new Date().toISOString()}
    await putMagazine(next)
    await putTopicState({topicKey:magazine.topicKey,topicId:magazine.topicId,cursor:next.lastMessageId,updatedAt:next.updatedAt})

    if(magazine.fullyCached && rows.length) await this.mergeFullRows(next,rows)
    return next
  }

  async ensureFullCache(magazine) {
    const fresh=await getMagazine(magazine.magazineId) || magazine
    let pdfBytes=await getAsset(`pdf:${fresh.magazineId}`)
    if(!pdfBytes) pdfBytes=await getAsset(`staging-pdf:${fresh.magazineId}`)

    let raw=null, rows=null
    if(!pdfBytes || !fresh.fullyCached) {
      raw=await this.gateway.topicMessages(this.dialog.peer,fresh.topicId,{limit:Infinity})
      rows=raw.map(TelegramGateway.messageModel)
      const pdfIdx=rows.findIndex(r=>r.meta?.kind==='pdf')
      if(pdfIdx<0) throw new Error(`PDF Mamina introuvable dans ${fresh.topicTitle}.`)
      if(!pdfBytes) pdfBytes=await this.gateway.downloadMessageMedia(raw[pdfIdx])
    }

    const pdf=await FamileoPdf.load(pdfBytes)
    const articles=pdf.articles()
    await putAsset(`pdf:${fresh.magazineId}`,pdfBytes)
    await deleteAsset(`staging-pdf:${fresh.magazineId}`)
    await replaceArticles(fresh.magazineId,articles.map(a=>({...a,magazineId:fresh.magazineId})))

    if(!rows) {
      raw=await this.gateway.topicMessages(this.dialog.peer,fresh.topicId,{limit:Infinity})
      rows=raw.map(TelegramGateway.messageModel)
    }
    await deleteMessagesByMagazine(fresh.magazineId)
    await this.persistResolvedMessages(fresh,articles,rows)
    const resolved=resolveRowsToArticles(rows,articles)
    const comments=[...resolved.byArticle.values()].flat()
    const unread=await this.countUnread(comments)
    const next={...fresh,reactionCount:comments.length,unreadCount:unread,fullyCached:true,lastMessageId:rows.reduce((m,r)=>Math.max(m,r.id),0),updatedAt:new Date().toISOString()}
    await putMagazine(next)
    await putTopicState({topicKey:next.topicKey,topicId:next.topicId,cursor:next.lastMessageId,updatedAt:next.updatedAt})
    return next
  }

  async dropFullCache(magazine) {
    const fresh=await getMagazine(magazine.magazineId) || magazine
    if(fresh.fullyCached) {
      const oldArticles=await listArticles(fresh.magazineId)
      await deleteMessagesByMagazine(fresh.magazineId)
      for(const a of oldArticles) await deleteAsset(`article:${a.articleKey}`)
      await replaceArticles(fresh.magazineId,[])
      await deleteAsset(`pdf:${fresh.magazineId}`)
      await putMagazine({...fresh,fullyCached:false})
    }
    await deleteAsset(`staging-pdf:${fresh.magazineId}`)
  }

  async mergeFullRows(magazine, rows) {
    const articles=await listArticles(magazine.magazineId)
    if(!articles.length) return
    await this.persistResolvedMessages(magazine,articles,rows)
  }

  async persistResolvedMessages(magazine,articles,rows) {
    const existing=await listMessagesByMagazine(magazine.magazineId)
    const all=[...existing.map(x=>({...x})),...rows]
    const resolved=resolveRowsToArticles(all,articles)
    const comments=[...resolved.byArticle.values()].flat()
    const payload=comments.map(c=>({
      ...c,
      key:`${magazine.magazineId}:${c.id}`,
      magazineId:magazine.magazineId,
      topicKey:magazine.topicKey,
      articleKey:c.articleKey,
    }))
    await putMessages(payload)
  }

  async readMap() {
    const states=await listReadStates()
    return new Map(states.map(s=>[s.articleKey,Number(s.lastReadMessageId||0)]))
  }

  async countUnread(comments) {
    const map=await this.readMap()
    return comments.filter(c=>!c.isOutgoing && c.id>(map.get(c.articleKey)||0)).length
  }

  async magazineSummaries(rows=null) {
    const magazines=(rows||await listMagazines()).slice(0,10)
    return Promise.all(magazines.map(async m=>({...m,cover:await getAsset(`cover:${m.magazineId}`)})))
  }

  async openMagazine(magazineId) {
    const magazine=await getMagazine(magazineId)
    if(!magazine) throw new Error('Revue inconnue.')
    let bytes=await getAsset(`pdf:${magazineId}`)
    let rows
    if(magazine.fullyCached && bytes) {
      rows=await listMessagesByMagazine(magazineId)
      const pdf=await FamileoPdf.load(bytes,{trace:(scope,message,detail)=>info(scope,message,detail)})
      this.current={magazine,pdf,articles:pdf.articles(),rows}
    } else {
      const raw=await this.gateway.topicMessages(this.dialog.peer,magazine.topicId,{limit:Infinity})
      const models=raw.map(TelegramGateway.messageModel)
      const pdfIdx=models.findIndex(r=>r.meta?.kind==='pdf')
      if(pdfIdx<0) throw new Error('PDF introuvable dans le sujet.')
      bytes=await this.gateway.downloadMessageMedia(raw[pdfIdx])
      const pdf=await FamileoPdf.load(bytes,{trace:(scope,message,detail)=>info(scope,message,detail)})
      const articles=pdf.articles()
      const resolved=resolveRowsToArticles(models,articles)
      rows=[...resolved.byArticle.values()].flat()
      this.current={magazine,pdf,articles,rows}
    }
    return this.currentView()
  }

  async currentView() {
    if(!this.current) return null
    const {magazine,pdf,articles,rows}=this.current
    const read=await this.readMap()
    const commentsBy=new Map(articles.map(a=>[a.articleKey,[]]))
    for(const row of rows) if(row.articleKey && commentsBy.has(row.articleKey)) commentsBy.get(row.articleKey).push(row)
    const withState=articles.map(a=>{
      const comments=(commentsBy.get(a.articleKey)||[]).sort((x,y)=>x.id-y.id)
      const lastRead=read.get(a.articleKey)||0
      return {...a,comments,lastReadMessageId:lastRead,unreadCount:comments.filter(c=>!c.isOutgoing&&c.id>lastRead).length}
    })
    return {magazine,articles:withState,pdf}
  }

  async markArticleRead(articleKey) {
    if(!this.current) return
    const rows=this.current.rows.filter(r=>r.articleKey===articleKey && !r.isOutgoing)
    if(!rows.length) return
    const max=Math.max(...rows.map(r=>r.id))
    await putReadState(articleKey,max)
    const magazine=await getMagazine(this.current.magazine.magazineId)
    if(magazine) {
      const all=this.current.rows
      const unread=await this.countUnread(all)
      await putMagazine({...magazine,unreadCount:unread})
      this.current.magazine={...magazine,unreadCount:unread}
    }
  }

  async postText(articleKey,text) {
    if(!this.current) throw new Error('Aucune revue ouverte.')
    const article=this.current.articles.find(a=>a.articleKey===articleKey)
    if(!article) throw new Error('Article inconnu.')
    if(!String(text).trim()) throw new Error('Message vide.')
    const topicId=this.current.magazine.topicId
    const full=await this.gateway.topicMessages(this.dialog.peer,topicId,{limit:Infinity})
    const {rootId}=await this.gateway.ensureRoot(this.dialog.peer,topicId,this.current.pdf.magazine,article,full)
    await this.gateway.postTextComment(this.dialog.peer,topicId,rootId,articleKey,text,'mamina-markdown-v1')
    const magazine=await getMagazine(this.current.magazine.magazineId)
    if(magazine) await this.syncKnownTopic(magazine)
    return this.openMagazine(this.current.magazine.magazineId)
  }

  async getArticleImage(articleKey) {
    if(!this.current) throw new Error('Aucune revue ouverte.')
    const assetKey=`article:${articleKey}`
    const cached=await getAsset(assetKey)
    if(cached) return cached
    const article=this.current.articles.find(a=>a.articleKey===articleKey)
    if(!article) throw new Error('Article inconnu.')
    const blob=await canvasBlob(await this.current.pdf.renderArticle(article), 'image/jpeg', .86)
    if(this.current.magazine.fullyCached) await putAsset(assetKey,blob)
    return blob
  }

  async ensureConnected(reason='app-resume') {
    if(!this.gateway) throw new Error('Telegram non initialisé.')
    return this.gateway.ensureConnected(reason)
  }

  connectionState() { return this.gateway?.connectionState || 'offline' }

  async getSettings() { return {reactionOrder:await settings.get('reactionOrder','asc'),recentColors:await settings.get('recentColors',[])} }
  async setReactionOrder(order) { if(!['asc','desc'].includes(order))throw new Error('Ordre invalide.');await settings.set('reactionOrder',order) }
  async rememberColor(color) {
    const normalized=String(color||'').toUpperCase()
    if(!/^#[0-9A-F]{6}$/.test(normalized)) return
    const old=await settings.get('recentColors',[])
    await settings.set('recentColors',[normalized,...old.filter(x=>x!==normalized)].slice(0,3))
  }
}
