import { loadEncryptedSecret, decryptCredentials } from './crypto.js'
import { TelegramGateway } from './telegram.js'
import { FamileoPdf } from './pdf.js'
import { FamileoGeometryParser } from './famileo-parser.js'
import { EmojiResolver } from './emoji-catalog.js'
import { parseMeta, stripMeta } from './protocol.js'
import {
  settings, putMagazine, getMagazine, getMagazineByTopic, listMagazines,
  putTopicState, getTopicState, replaceArticles, listArticles,
  putMessages, listMessagesByMagazine, deleteMessagesByMagazine, deleteMessageByKey,
  getReadState, putReadState, listReadStates,
  putAsset, getAsset, deleteAsset, deleteAssetsByPrefix, pruneToMagazineIds,
  putOutbox, getOutbox, listOutbox, deleteOutbox, countOutbox, estimateLocalStorage, clearPublicationCache,
} from './user-storage.js'
import { info, warn, error as logError } from './log.js'

function idOfPeer(peer) { return String(typeof peer?.id === 'bigint' ? peer.id : peer?.id?.value ?? peer?.id ?? '') }
function topicKey(peer, topicId) { return `${idOfPeer(peer)}:${Number(topicId)}` }
function isMagazineTopic(topic) { return /famileo/i.test(String(topic?.title || '')) }
function topicIdOf(topic) { return Number(topic?.id || topic?.topicId || 0) }
function rowMetaText(message) { return message?.text || message?.caption || '' }
const PARAMS_TOPIC='params', CATALOG_TOPIC='catalog'
function exactTopic(topic,name){return String(topic?.title||'').trim().toLowerCase()===name}
function slotCode(slot){return slot==='top'?'h':slot==='bottom'?'b':'p'}
function clamp01(n){return Math.max(0,Math.min(1,Number(n)||0))}
function cleanBounds(b){
  if(!b)return null
  const x0=clamp01(b.x0),y0=clamp01(b.y0),x1=clamp01(b.x1),y1=clamp01(b.y1)
  return x1>x0&&y1>y0?{x0,y0,x1,y1}:null
}
function unionBounds(list=[]){
  const rows=list.filter(Boolean)
  if(!rows.length)return null
  return cleanBounds({x0:Math.min(...rows.map(b=>b.x0)),y0:Math.min(...rows.map(b=>b.y0)),x1:Math.max(...rows.map(b=>b.x1)),y1:Math.max(...rows.map(b=>b.y1))})
}
function expandBounds(b,padX=.006,padY=.008){return cleanBounds(b?{x0:b.x0-padX,y0:b.y0-padY,x1:b.x1+padX,y1:b.y1+padY}:null)}
function renormBounds(b,outer){
  if(!b||!outer)return b||null
  const w=Math.max(.0001,outer.x1-outer.x0),h=Math.max(.0001,outer.y1-outer.y0)
  return cleanBounds({x0:(b.x0-outer.x0)/w,y0:(b.y0-outer.y0)/h,x1:(b.x1-outer.x0)/w,y1:(b.y1-outer.y0)/h})
}
function postArticle(magazineId,post,sidecar={}){
  const slot=slotCode(post.slot),box=post.box_pt||[0,0,1,1],collages=post.collages||[],g=sidecar[`${post.page}:${post.slot}`]||{}
  const union=collages.length?{
    x0:Math.min(...collages.map(x=>x.box_pt[0])),y0:Math.min(...collages.map(x=>x.box_pt[1])),
    x1:Math.max(...collages.map(x=>x.box_pt[0]+x.box_pt[2])),y1:Math.max(...collages.map(x=>x.box_pt[1]+x.box_pt[3])),
  }:null
  const norm=b=>cleanBounds(b?{x0:(b[0]-box[0])/box[2],y0:(b[1]-box[1])/box[3],x1:(b[0]+b[2]-box[0])/box[2],y1:(b[1]+b[3]-box[1])/box[3]}:null)
  const rawPhotoBounds=union?cleanBounds({x0:(union.x0-box[0])/box[2],y0:(union.y0-box[1])/box[3],x1:(union.x1-box[0])/box[2],y1:(union.y1-box[1])/box[3]}):null
  let rawTextBounds=norm(g.body_box_pt)
  if(!rawTextBounds&&rawPhotoBounds) rawTextBounds=post.layout==='text_right'?{x0:Math.max(0,rawPhotoBounds.x1),y0:0,x1:1,y1:1}:{x0:0,y0:Math.max(0,rawPhotoBounds.y1),x1:1,y1:1}
  // avatar_box_pt comes directly from the placed 170×170 XObject: it is the
  // authoritative square. Do not apply layout-dependent offsets.
  const rawAvatarBounds=norm(g.avatar_box_pt)
  // Article view contains only useful content, not the decorative box margins.
  const renderBounds=expandBounds(unionBounds([rawPhotoBounds,rawTextBounds,rawAvatarBounds]))||{x0:0,y0:0,x1:1,y1:1}
  return {magazineId,articleKey:`${magazineId}:p${String(post.page).padStart(2,'0')}:${slot}`,page:post.page,slot,pageText:post.text,articleText:post.text,authorName:post.author,articleDateLabel:post.date_label,bodyText:post.text,lines:post.lines||[],dateIso:post.date_iso||null,layout:post.layout,boxPt:post.box_pt,renderBounds,collages:post.collages||[],textBounds:renormBounds(rawTextBounds,renderBounds),photoBounds:renormBounds(rawPhotoBounds,renderBounds),avatarBounds:renormBounds(rawAvatarBounds,renderBounds)}
}
function parseEnvelopeArticles(magazineId,envelope){const gazette=envelope?.gazette||envelope;return (gazette?.posts||[]).map(p=>postArticle(magazineId,p,envelope?.geometry||{}))}

function canvasBlob(canvas, type='image/jpeg', quality=.82) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    try { canvas.width=1; canvas.height=1 } catch {}
    blob ? resolve(blob) : reject(new Error('Conversion image impossible.'))
  }, type, quality))
}

function resolveRowsToArticles(rows, articles) {
  const articleKeys = new Set(articles.map(a => a.articleKey))
  // Deletion markers are tombstones. Missing targets are intentionally ignored:
  // a newcomer may only receive the tombstone because Telegram already deleted
  // the original message.
  const deletedIds = new Set(rows.filter(r=>r.meta?.kind==='delete').map(r=>Number(r.meta?.targetMessageId||0)).filter(x=>x>0))
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
  const motionsBy = new Map(articles.map(a=>[a.articleKey,[]]))
  const soundsBy = new Map(articles.map(a=>[a.articleKey,null]))

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
    if(row.meta?.kind==='delete' || deletedIds.has(Number(row.id)))continue
    const ak=resolveArticle(row)
    if(!ak)continue
    if (row.meta?.kind === 'motion' && row.meta?.type === 'emoji' && motionsBy.has(ak)) {
      motionsBy.get(ak).push({ ...row, articleKey:ak, motion:row.meta.motion||null })
      continue
    }
    if (row.meta?.kind === 'sound' && row.meta?.type === 'article' && soundsBy.has(ak)) {
      const previous=soundsBy.get(ak)
      if(!previous || Number(row.id)>Number(previous.id))soundsBy.set(ak,{...row,articleKey:ak,sound:row.meta.sound||null})
      continue
    }
    if (row.meta?.kind === 'message' || (!row.meta && row.replyToId)) {
      if (!byArticle.has(ak)) continue
      byArticle.get(ak).push({ ...row, articleKey:ak, displayText:stripMeta(row.text) })
    }
  }
  return { roots, byArticle, motionsBy, soundsBy }
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
    this.authProvider=null
    this.onActivity=null
    this.pdfLoadPromise=null
    this.renderChain=Promise.resolve()
  }

  setAuthProvider(provider) { this.authProvider=provider || null }
  setActivityListener(fn) { this.onActivity=typeof fn==='function'?fn:null }
  activity(text, detail=null) { try { this.onActivity?.({text,detail,at:new Date().toISOString()}) } catch {} }

  async _listPendingMotions() {
    const rows=await settings.get('pendingEmojiMotions',[])
    if(!Array.isArray(rows))return[]
    return rows.filter(Boolean).map(item=>({...item,motion:{...(item.motion||{}),clientId:String(item.motion?.clientId||item.id||'')}}))
  }

  async _savePendingMotions(rows=[]) {
    await settings.set('pendingEmojiMotions',Array.isArray(rows)?rows.filter(Boolean):[])
  }

  async _listPendingTopicOps() {
    const rows=await settings.get('pendingTopicOps',[])
    return Array.isArray(rows)?rows.filter(Boolean):[]
  }

  async _savePendingTopicOps(rows=[]) {
    await settings.set('pendingTopicOps',Array.isArray(rows)?rows.filter(Boolean):[])
  }

  async _queueTopicOp(op) {
    const rows=await this._listPendingTopicOps()
    rows.push({id:`op:${Date.now()}:${Math.random().toString(36).slice(2,8)}`,createdAt:new Date().toISOString(),...op})
    await this._savePendingTopicOps(rows)
  }

  _pendingMotionRow(item,ordinal=0) {
    return {
      id:Number.MAX_SAFE_INTEGER-1000+ordinal,
      articleKey:item.articleKey,
      author:'Moi',
      senderId:null,
      isOutgoing:true,
      pending:true,
      pendingId:item.id,
      date:item.createdAt,
      text:'',
      meta:{kind:'motion',type:'emoji'},
      motion:item.motion,
      topicId:Number(item.topicId||0)||null,
      pendingId:item.id,
    }
  }

  async _queueEmojiMotion(articleKey,motion) {
    if(!this.current) throw new Error('Aucune revue ouverte.')
    const rows=await this._listPendingMotions()
    const id=`motion:${Date.now()}:${Math.random().toString(36).slice(2,8)}`
    const normalizedMotion={...motion,clientId:String(motion?.clientId||id)}
    rows.push({
      id,
      createdAt:new Date().toISOString(),
      articleKey,
      magazineId:this.current.magazine.magazineId,
      topicId:this.current.magazine.topicId,
      motion:normalizedMotion,
    })
    await this._savePendingMotions(rows)
    info('motion.outbox','Animation mise en attente',{articleKey,clientId:normalizedMotion.clientId})
  }

  async _sendMotionNow(item) {
    if(!this.gateway || !this.dialog) throw new Error('Telegram non initialisé.')
    const magazine=await getMagazine(item.magazineId)
    if(!magazine) throw new Error('Revue de l’animation en attente introuvable.')

    let bytes=await getAsset(`pdf:${magazine.magazineId}`)
    if(!bytes) bytes=await getAsset(`staging-pdf:${magazine.magazineId}`)
    if(!bytes) throw new Error('PDF local requis pour résoudre l’animation en attente.')

    const pdf=await FamileoPdf.load(bytes)
    try {
      const article=pdf.articles().find(a=>a.articleKey===item.articleKey)
      if(!article) throw new Error('Article de l’animation en attente introuvable.')
      const full=await this.gateway.topicMessages(this.dialog.peer,Number(item.topicId),{limit:Infinity})
      const {rootId}=await this.gateway.ensureRoot(this.dialog.peer,Number(item.topicId),pdf.magazine,article,full)
      const sentMessage=await this.gateway.postEmojiMotion(this.dialog.peer,Number(item.topicId),rootId,item.articleKey,item.motion)
      return {sentMessage,magazine,article}
    } finally {
      try { await pdf.doc?.cleanup?.(); await pdf.doc?.destroy?.() } catch {}
    }
  }

  async _persistSentMotionResult(item,result) {
    const message=result?.sentMessage
    const magazine=result?.magazine
    if(!message || !magazine) return

    const row=TelegramGateway.messageModel(message)
    await this.cacheMotionAvatars([message],[row])
    const payload={...row,articleKey:item.articleKey,motion:item.motion,key:`${magazine.magazineId}:${row.id}`,magazineId:magazine.magazineId,topicKey:magazine.topicKey}
    await putMessages([payload])

    if(this.current?.magazine?.magazineId===magazine.magazineId){
      const withoutSame=this.current.rows.filter(r=>r.id!==payload.id)
      this.current.rows=[...withoutSame,payload].sort((a,b)=>a.id-b.id)
    }

    const stored=await getMagazine(magazine.magazineId)
    if(stored){
      const next={...stored,motionCount:Number(stored.motionCount||0)+1}
      await putMagazine(next)
      if(this.current?.magazine?.magazineId===magazine.magazineId)this.current.magazine=next
    }
  }


  _profileCacheKey() { return `familyProfiles:${idOfPeer(this.dialog?.peer)}` }

  async familyProfileAssignments({refresh=true}={}) {
    const key=this._profileCacheKey()
    let cached=await settings.get(key,{})
    if(!cached||typeof cached!=='object'||Array.isArray(cached))cached={}
    if(!refresh||!this.gateway||!this.dialog||!(this.gateway.connectionState==='connected'||this.gateway.connectionState==='updating'||this.gateway.isConnected()))return cached
    try {
      let topicId=Number(await settings.get('paramsTopicId',0)||0)
      if(!topicId){const topic=(await this.gateway.topics(this.dialog.peer)).find(t=>exactTopic(t,PARAMS_TOPIC));topicId=topic?topicIdOf(topic):0;if(topicId)await settings.set('paramsTopicId',topicId)}
      if(!topicId)return cached
      const raw=await this.gateway.topicMessages(this.dialog.peer,topicId,{limit:300})
      const rows=raw.map(TelegramGateway.messageModel).filter(r=>r.meta?.kind==='mamina-profile'&&r.senderId&&String(r.meta?.famileoName||'').trim()).sort((a,b)=>a.id-b.id)
      const map={}
      for(const row of rows)map[String(row.senderId)]={telegramUserId:Number(row.senderId),famileoName:String(row.meta.famileoName).trim(),messageId:row.id,author:row.author||''}
      await settings.set(key,map)
      return map
    } catch(e) { warn('profile','Profils famille indisponibles',{message:e?.message||String(e)});return cached }
  }

  async avatarAssociationState() {
    const userId=Number(await settings.get('userId',0)||0)||null
    const profiles=await this.familyProfileAssignments({refresh:true})
    const own=userId?profiles[String(userId)]||null:null
    return {userId,own,assignedNames:[...new Set(Object.values(profiles).map(x=>String(x?.famileoName||'').trim()).filter(Boolean))],profiles}
  }

  async motionAuthorFamileoName(senderId,{isOutgoing=false}={}) {
    const userId=Number(await settings.get('userId',0)||0)||null
    const target=Number(senderId||0)||(isOutgoing?userId:null)
    if(!target)return''
    const profiles=await this.familyProfileAssignments({refresh:false})
    return String(profiles?.[String(target)]?.famileoName||'')
  }

  async adminAvatarAssignments() {
    if(!this.dialog)throw new Error('Aucun groupe sélectionné.')
    const userId=Number(await settings.get('userId',0)||0)||null
    const profiles=await this.familyProfileAssignments({refresh:true})
    const canDeleteOthers=Boolean(this.gateway?.canDeleteOthers?.(this.dialog.peer))
    return {userId,canDeleteOthers,profiles:Object.values(profiles).sort((a,b)=>String(a.famileoName||'').localeCompare(String(b.famileoName||''),'fr'))}
  }

  async adminRemoveAvatarAssociation(telegramUserId) {
    if(!this.gateway||!this.dialog)throw new Error('Telegram non initialisé.')
    const state=await this.adminAvatarAssignments(),target=Number(telegramUserId||0),profile=state.profiles.find(x=>Number(x.telegramUserId)===target)
    if(!profile)throw new Error('Association introuvable.')
    if(target!==Number(state.userId)&&!state.canDeleteOthers)throw new Error('Le droit Telegram « supprimer les messages » est requis pour retirer l’association d’un autre utilisateur.')
    let topicId=Number(await settings.get('paramsTopicId',0)||0)
    if(!topicId){const topic=(await this.gateway.topics(this.dialog.peer)).find(t=>exactTopic(t,PARAMS_TOPIC));topicId=topic?topicIdOf(topic):0}
    if(!topicId)throw new Error('Sujet params introuvable.')
    await this.gateway.deleteMessagesById(this.dialog.peer,[profile.messageId])
    await this.familyProfileAssignments({refresh:true})
    return this.adminAvatarAssignments()
  }

  async assignFamileoAvatar(famileoName) {
    if(!this.gateway||!this.dialog||!(this.gateway.connectionState==='connected'||this.gateway.connectionState==='updating'||this.gateway.isConnected()))throw new Error('Connexion Telegram requise pour associer un avatar.')
    const name=String(famileoName||'').trim();if(!name)throw new Error('Avatar invalide.')
    const state=await this.avatarAssociationState(),needle=name.toLocaleLowerCase('fr')
    const taken=Object.values(state.profiles||{}).find(x=>Number(x?.telegramUserId)!==Number(state.userId)&&String(x?.famileoName||'').trim().toLocaleLowerCase('fr')===needle)
    if(taken)throw new Error('Cet avatar vient d’être attribué à un autre utilisateur.')
    let topicId=Number(await settings.get('paramsTopicId',0)||0)
    if(!topicId){const topic=(await this.gateway.topics(this.dialog.peer)).find(t=>exactTopic(t,PARAMS_TOPIC));topicId=topic?topicIdOf(topic):0}
    if(!topicId)throw new Error('Sujet params introuvable.')
    await this.gateway.postFamilyProfile(this.dialog.peer,topicId,name)
    await settings.set('paramsTopicId',topicId)
    await this.familyProfileAssignments({refresh:true})
    return this.avatarAssociationState()
  }

  async cacheMotionAvatars(rawMessages=[],models=null) {
    const rows=models||rawMessages.map(TelegramGateway.messageModel)
    const seen=new Set()
    for(let i=0;i<rows.length;i++){
      const row=rows[i]
      if(row?.meta?.kind!=='motion'||row.meta?.type!=='emoji'||!row.senderId||seen.has(row.senderId))continue
      seen.add(row.senderId)
      const key=`sender-avatar:${row.senderId}`
      if(await getAsset(key))continue
      const bytes=await this.gateway?.senderAvatar(rawMessages[i]).catch(()=>null)
      if(bytes?.byteLength)await putAsset(key,new Uint8Array(bytes))
    }
  }

  async motionAuthorAvatar(senderId,{isOutgoing=false}={}) {
    if(isOutgoing){
      const own=await getAsset('user-avatar')
      if(own)return own
    }
    if(!senderId)return null
    const bytes=await getAsset(`sender-avatar:${Number(senderId)}`)
    return bytes ? new Blob([bytes],{type:'image/jpeg'}) : null
  }

  async ensureMotionCount(magazine) {
    if(Number.isFinite(Number(magazine?.motionCount)))return magazine
    if(!this.gateway||!this.dialog||!magazine?.topicId)return {...magazine,motionCount:0}
    try{
      const raw=await this.gateway.topicMessages(this.dialog.peer,magazine.topicId,{limit:Infinity})
      const rows=raw.map(TelegramGateway.messageModel)
      await this.cacheMotionAvatars(raw,rows)
      const motionCount=rows.filter(r=>r.meta?.kind==='motion'&&r.meta?.type==='emoji').length
      const next={...magazine,motionCount}
      await putMagazine(next)
      return next
    }catch(e){warn('motion.count','Comptage animations indisponible',{magazineId:magazine?.magazineId,message:e?.message||String(e)});return {...magazine,motionCount:0}}
  }

  async unlock(password) {
    const blob=await loadEncryptedSecret()
    const creds=await decryptCredentials(blob,password)
    this.gateway=new TelegramGateway(creds,{authProvider:this.authProvider})
    this.gateway.onConnectionState(state=>this.onConnectionState?.(state))
  }

  async login() {
    if(!this.gateway) throw new Error('Secrets non déverrouillés.')
    this.activity('Connexion à Telegram…')
    const me=await this.gateway.login()
    this.activity('Profil Telegram…')
    try {
      const profile=await this.gateway.selfProfile()
      if(profile.id) await settings.set('userId',Number(profile.id))
      if(profile.name) await settings.set('userName',profile.name)
      if(profile.username) await settings.set('userUsername',profile.username)
      if(profile.avatar) await putAsset('user-avatar',new Uint8Array(profile.avatar))
    } catch(e) {
      warn('telegram.profile','Profil local non mis à jour',{message:e?.message||String(e)})
    }
    this.installUpdates()
    try { await this.flushOutbox(true) } catch(e) { warn('outbox','Envoi différé après login incomplet',{message:e?.message||String(e)}) }
    this.activity('Telegram prêt')
    return me
  }

  async localUserProfile() {
    const id=Number(await settings.get('userId',0)||0)||null
    const name=await settings.get('userName','')
    const username=await settings.get('userUsername','')
    const bytes=await getAsset('user-avatar')
    const avatar=bytes ? new Blob([bytes],{type:'image/jpeg'}) : null
    return {id,name,username,avatar}
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
    const next=model.dialog||model,nextId=idOfPeer(next.peer),prev=await settings.get('groupId','')
    const changed=Boolean(prev)&&String(prev)!==String(nextId)

    if(changed){
      this.activity('Nouveau groupe · purge du cache local…')
      await clearPublicationCache()
      info('storage','Cache magazines purgé après changement de groupe',{previousGroupId:String(prev),nextGroupId:String(nextId)})
    }

    this.dialog=next
    this.dialogModel=model.dialog?model:TelegramGateway.dialogModel(model)
    await settings.set('groupId',nextId)

    if(String(prev)!==String(nextId)){
      await settings.set('paramsMessageId',0)
      await settings.set('paramsTopicId',0)
      await settings.set('remoteParams',null)
    }
    this.current=null
  }

  async syncAll() {
    if(!this.dialog) throw new Error('Aucun groupe sélectionné.')
    if(this.gateway?.connectionState==='connected') {
      try { await this.flushOutbox() } catch(e) { warn('outbox','Flush avant synchro incomplet',{message:e?.message||String(e)}) }
    }
    this.activity('Synchronisation Telegram…')
    info('sync','Synchronisation demandée',{group:this.dialogModel?.title||null})
    if(this.syncing) return this.syncing
    this.syncing=this._syncAll().then(result=>{info('sync','Synchronisation terminée',{magazines:result?.length||0});return result}).catch(e=>{logError('sync','Synchronisation échouée',e);throw e}).finally(()=>{this.syncing=null})
    return this.syncing
  }

  async _syncAll() {
    const peer=this.dialog.peer
    this.activity('Telegram · lecture des sujets')
    info('sync','Lecture des sujets Telegram')
    const allTopics=await this.gateway.topics(peer)
    try { await this.loadRemoteParams(allTopics) } catch(e) { warn('params','Paramètres distants indisponibles',{message:e?.message||String(e)}) }
    info('sync','Sujets reçus',{count:allTopics.length})
    const topics=allTopics.filter(isMagazineTopic).sort((a,b)=>topicIdOf(b)-topicIdOf(a))
    info('sync','Sujets Famileo détectés',{count:topics.length,titles:topics.slice(0,10).map(t=>t.title)})
    const cached=await listMagazines()
    const cachedByTopic=new Map(cached.map(m=>[m.topicKey,m]))
    let found=[]

    // Scan a bounded set of recent Famileo topics; stop when ten magazines are known.
    const scanTopics=topics.slice(0,30)
    for(let topicIndex=0;topicIndex<scanTopics.length;topicIndex++) {
      const topic=scanTopics[topicIndex]
      this.activity(`Messages · revue ${Math.min(topicIndex+1,10)}/${Math.min(scanTopics.length,10)}`)
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
    for(let i=0;i<found.length;i++)if(!Number.isFinite(Number(found[i]?.motionCount)))found[i]=await this.ensureMotionCount(found[i])
    if(found.length) await settings.set('appTitle',String(found[0].appTitle||'MamiNa'))

    for(const m of found.slice(0,2)) await this.ensureFullCache(m)
    for(const m of found.slice(2)) await this.dropFullCache(m)

    const keepIds=found.map(m=>m.magazineId)
    const before=await listMagazines()
    for(const old of before) if(!keepIds.includes(old.magazineId)){ await deleteAsset(`cover:${old.magazineId}`); await deleteAsset(`pdf:${old.magazineId}`); await deleteAsset(`staging-pdf:${old.magazineId}`); await deleteMessagesByMagazine(old.magazineId); await replaceArticles(old.magazineId,[]) }
    await pruneToMagazineIds(keepIds)
    await settings.set('magazineOrder',found.map(m=>m.magazineId))
    try { await this.migrateDerivedArticleGeometry() } catch(e) { warn('cache.migration','Migration différée',{message:e?.message||String(e)}) }
    return this.magazineSummaries()
  }

  async discoverTopic(topic) {
    const peer=this.dialog.peer, tid=topicIdOf(topic), key=topicKey(peer,tid)
    info('sync.discover','Découverte du sujet',{title:topic.title||'',topicId:tid})
    this.activity(`Telegram · messages du sujet ${tid}`)
    const raw=await this.gateway.topicMessages(peer,tid,{limit:Infinity})
    this.activity(`Telegram · ${raw.length} message${raw.length>1?'s':''} reçu${raw.length>1?'s':''}`)
    const rows=raw.map(TelegramGateway.messageModel)
    const pdfIndex=rows.findIndex(r=>r.meta?.kind==='pdf')
    if(pdfIndex<0){info('sync.discover','Pas de marqueur PDF Mamina',{topicId:tid});return null}
    const pdfRow=rows[pdfIndex]
    const rawPdf=raw[pdfIndex]
    if(!rawPdf?.media) return null

    info('sync.discover','Téléchargement PDF',{topicId:tid,messageId:pdfRow.id})
    const bytes=await this.gateway.downloadMessageMedia(rawPdf)
    let envelope=null
    const parseIndex=rows.findIndex(r=>r.meta?.kind==='parse')
    if(parseIndex>=0&&raw[parseIndex]?.media){
      try { envelope=JSON.parse(new TextDecoder().decode(await this.gateway.downloadMessageMedia(raw[parseIndex]))) }
      catch(e){ warn('sync.discover','JSON parsé invalide, fallback local',{message:e?.message||String(e)}) }
    }
    let pdf=null, magazine, articles
    if(envelope?.gazette){
      const g=envelope.gazette,sha=pdfRow.meta?.sha256||envelope.sha256||null
      const magazineKey=`famileo:${String(g.source?.title||'gazette').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')}:n${g.cover.issue_number||0}:${g.cover.date_iso||'date-unknown'}`
      magazine={title:g.source?.title||'Gazette Famileo',issue:g.cover.issue_number,date:g.cover.date_iso,sha256:sha,magazineKey,magazineId:pdfRow.meta?.magazineId||`${magazineKey}:sha256-${String(sha||'').slice(0,12)}`,pageCount:g.source?.pages||0,parsedSchema:envelope.schema||'mamina-gazette-v1'}
      articles=parseEnvelopeArticles(magazine.magazineId,envelope)
      this.activity('JSON Famileo · lecture directe')
    } else {
      this.activity('PDF · analyse locale (compatibilité)')
      pdf=await FamileoPdf.load(bytes,{trace:(scope,message,detail)=>info(scope,message,detail)})
      magazine=pdf.magazine;articles=pdf.articles()
    }
    if(pdfRow.meta?.sha256 && magazine.sha256 && magazine.sha256!==pdfRow.meta.sha256) throw new Error(`Hash PDF incohérent pour ${topic.title||tid}.`)
    info('sync.discover','Articles détectés',{
      topicId:tid,
      count:articles.length,
      slots:articles.reduce((acc,a)=>{acc[a.slot]=(acc[a.slot]||0)+1;return acc},{}),
    })

    const resolved=resolveRowsToArticles(rows,articles)
    await this.cacheMotionAvatars(raw,rows)

    info('sync.discover','Rendu couverture',{topicId:tid})
    if(!pdf) pdf=await FamileoPdf.load(bytes)
    const coverCanvas=await pdf.renderCover()
    info('sync.discover','Conversion couverture en image',{
      width:coverCanvas.width,
      height:coverCanvas.height,
    })
    const cover=await canvasBlob(coverCanvas)
    info('sync.discover','Stockage couverture',{
      magazineId:magazine.magazineId,
      bytes:cover.size||0,
    })
    this.activity('Base locale · couverture')
    await putAsset(`cover:${magazine.magazineId}`,cover)
    info('sync.discover','Couverture stockée',{
      magazineId:magazine.magazineId,
      storage:'Uint8Array+MIME',
    })

    const read=await this.readMap()
    const comments=[...resolved.byArticle.values()].flat()
    const motions=[...resolved.motionsBy.values()].flat()
    const unread=comments.filter(c=>!c.isOutgoing && c.id>(read.get(c.articleKey)||0)).length
    const record={
      ...magazine,
      appTitle:String(pdfRow.meta?.appTitle||'MamiNa'),
      topicId:tid, topicKey:key, topicTitle:topic.title||'', pdfMessageId:pdfRow.id,
      reactionCount:comments.length, motionCount:motions.length, unreadCount:unread, fullyCached:false,
      lastMessageId:rows.reduce((m,r)=>Math.max(m,r.id),0), updatedAt:new Date().toISOString(),
    }
    this.activity('Base locale · index revue')
    await putMagazine(record)
    if(envelope?.gazette) await putAsset(`parse:${record.magazineId}`,new TextEncoder().encode(JSON.stringify(envelope)))
    await replaceArticles(record.magazineId,articles.map(a=>({...a,magazineId:record.magazineId})))
    await putTopicState({topicKey:key,topicId:tid,cursor:record.lastMessageId,updatedAt:record.updatedAt})
    // Temporarily retain bytes so promotion to top-2 needs no second download.
    await putAsset(`staging-pdf:${record.magazineId}`,bytes)
    try { await pdf?.doc?.cleanup?.(); await pdf?.doc?.destroy?.() } catch {}
    info('sync.discover','Revue découverte',{magazineId:record.magazineId,articles:articles.length,reactions:comments.length})
    return record
  }

  async syncKnownTopic(magazine) {
    const peer=this.dialog.peer, state=await getTopicState(magazine.topicKey)
    info('sync.known','Synchronisation revue connue',{magazineId:magazine.magazineId,topicId:magazine.topicId})
    const cursor=Number(state?.cursor||magazine.lastMessageId||0)
    this.activity(`Telegram · messages N°${magazine.issue||''}`)
    const raw=await this.gateway.topicMessages(peer,magazine.topicId,{minId:cursor,limit:Infinity})
    this.activity(raw.length?`Telegram · ${raw.length} nouveau${raw.length>1?'x':''} message${raw.length>1?'s':''}`:'Telegram · aucun nouveau message')
    if(!raw.length){info('sync.known','Aucun nouveau message',{magazineId:magazine.magazineId,cursor});return magazine}
    const models=raw.map(TelegramGateway.messageModel)
    await this.cacheMotionAvatars(raw,models)
    const rows=models.filter(r=>r.id>cursor)
    const messages=rows.filter(r=>r.meta?.kind==='message')
    const motionAdd=rows.filter(r=>r.meta?.kind==='motion'&&r.meta?.type==='emoji').length
    const messageDelete=rows.filter(r=>r.meta?.kind==='delete'&&r.meta?.targetKind==='message').length
    const motionDelete=rows.filter(r=>r.meta?.kind==='delete'&&r.meta?.targetKind==='motion').length
    let unreadAdd=0
    for(const m of messages) {
      if(m.isOutgoing) continue
      const rs=await getReadState(m.meta?.articleKey||'')
      if(m.id>Number(rs?.lastReadMessageId||0)) unreadAdd++
    }
    const next={...magazine,reactionCount:Math.max(0,Number(magazine.reactionCount||0)+messages.length-messageDelete),motionCount:Math.max(0,Number(magazine.motionCount||0)+motionAdd-motionDelete),unreadCount:Number(magazine.unreadCount||0)+unreadAdd,lastMessageId:Math.max(cursor,...rows.map(r=>r.id)),updatedAt:new Date().toISOString()}
    this.activity('Base locale · mise à jour des messages')
    await putMagazine(next)
    await putTopicState({topicKey:magazine.topicKey,topicId:magazine.topicId,cursor:next.lastMessageId,updatedAt:next.updatedAt})

    if(magazine.fullyCached && rows.length) await this.mergeFullRows(next,rows)
    return next
  }

  async ensureFullCache(magazine) {
    this.activity(`Cache local · ${magazine.issue?`N°${magazine.issue}`:'revue'}`)
    const fresh=await getMagazine(magazine.magazineId) || magazine
    let pdfBytes=await getAsset(`pdf:${fresh.magazineId}`)
    if(!pdfBytes) pdfBytes=await getAsset(`staging-pdf:${fresh.magazineId}`)

    // Critical fast path: a fully cached magazine must not be reparsed every
    // 30-second synchronization cycle.
    if(fresh.fullyCached && pdfBytes) return fresh

    let raw=null, rows=null
    if(!pdfBytes || !fresh.fullyCached) {
      raw=await this.gateway.topicMessages(this.dialog.peer,fresh.topicId,{limit:Infinity})
      rows=raw.map(TelegramGateway.messageModel)
      await this.cacheMotionAvatars(raw,rows)
      const pdfIdx=rows.findIndex(r=>r.meta?.kind==='pdf')
      if(pdfIdx<0) throw new Error(`PDF Mamina introuvable dans ${fresh.topicTitle}.`)
      if(!pdfBytes) pdfBytes=await this.gateway.downloadMessageMedia(raw[pdfIdx])
    }

    let articles=await listArticles(fresh.magazineId)
    if(!articles.length) {
      const parsedBytes=await getAsset(`parse:${fresh.magazineId}`)
      if(parsedBytes){
        try{articles=parseEnvelopeArticles(fresh.magazineId,JSON.parse(new TextDecoder().decode(parsedBytes)))}catch{}
      }
      if(!articles.length){
        const pdf=await FamileoPdf.load(pdfBytes)
        articles=pdf.articles().map(a=>({...a,magazineId:fresh.magazineId}))
        try { await pdf.doc?.cleanup?.(); await pdf.doc?.destroy?.() } catch {}
      }
      await replaceArticles(fresh.magazineId,articles)
    }
    await putAsset(`pdf:${fresh.magazineId}`,pdfBytes)
    await deleteAsset(`staging-pdf:${fresh.magazineId}`)

    if(!rows) {
      raw=await this.gateway.topicMessages(this.dialog.peer,fresh.topicId,{limit:Infinity})
      rows=raw.map(TelegramGateway.messageModel)
    }
    await deleteMessagesByMagazine(fresh.magazineId)
    await this.persistResolvedMessages(fresh,articles,rows)
    const resolved=resolveRowsToArticles(rows,articles)
    const comments=[...resolved.byArticle.values()].flat()
    const motions=[...resolved.motionsBy.values()].flat()
    const unread=await this.countUnread(comments)
    const next={...fresh,reactionCount:comments.length,motionCount:motions.length,unreadCount:unread,fullyCached:true,lastMessageId:rows.reduce((m,r)=>Math.max(m,r.id),0),updatedAt:new Date().toISOString()}
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
    const motions=[...resolved.motionsBy.values()].flat()
    const sounds=[...resolved.soundsBy.values()].filter(Boolean)
    const tombstones=all.filter(r=>r.meta?.kind==='delete'&&Number(r.meta?.targetMessageId||0)>0).map(r=>({
      ...r,
      articleKey:r.meta?.articleKey||r.articleKey||null,
      key:`${magazine.magazineId}:${r.id}`,
      magazineId:magazine.magazineId,
      topicKey:magazine.topicKey,
    }))
    const payload=[...comments,...motions,...sounds,...tombstones].map(c=>({
      ...c,
      key:c.key||`${magazine.magazineId}:${c.id}`,
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
    return Promise.all(magazines.map(async m=>{
      let motionCount=Number.isFinite(Number(m.motionCount))?Number(m.motionCount):null
      if(motionCount==null){
        const local=await listMessagesByMagazine(m.magazineId)
        motionCount=local.filter(r=>r.meta?.kind==='motion'&&r.meta?.type==='emoji').length
      }
      return {...m,motionCount,cover:await getAsset(`cover:${m.magazineId}`)}
    }))
  }

  async openMagazineLocalFirst(magazineId) {
    const magazine=await getMagazine(magazineId)
    if(!magazine) throw new Error('Revue inconnue.')

    const bytes=await getAsset(`pdf:${magazineId}`)
    const storedArticles=await listArticles(magazineId)
    const rows=await listMessagesByMagazine(magazineId)

    // Fast path: no PDF.js parse on every opening. Articles and messages are
    // already indexed in IndexedDB. PDF.js is loaded lazily only if an image
    // is not in the local asset cache.
    if(magazine.fullyCached && bytes && storedArticles.length) {
      const same=this.current?.magazine?.magazineId===magazineId
      this.current={
        magazine,
        pdf:same ? this.current.pdf : null,
        pdfBytes:bytes,
        articles:storedArticles,
        rows,
      }
      return this.currentView()
    }

    if(!this.gateway || !this.dialog) {
      throw new Error('Cette revue n’est pas entièrement disponible hors ligne. Connecte Telegram pour la charger.')
    }
    return this.openMagazine(magazineId)
  }

  async openMagazine(magazineId) {
    const magazine=await getMagazine(magazineId)
    if(!magazine) throw new Error('Revue inconnue.')
    let bytes=await getAsset(`pdf:${magazineId}`)
    let rows
    if(magazine.fullyCached && bytes) {
      rows=await listMessagesByMagazine(magazineId)
      let articles=await listArticles(magazineId)
      if(!articles.length){
        const parsedBytes=await getAsset(`parse:${magazineId}`)
        if(parsedBytes){try{articles=parseEnvelopeArticles(magazineId,JSON.parse(new TextDecoder().decode(parsedBytes)))}catch{}}
      }
      const pdf=await FamileoPdf.load(bytes,{trace:(scope,message,detail)=>info(scope,message,detail)})
      if(!articles.length)articles=pdf.articles()
      this.current={magazine,pdf,articles,rows}
    } else {
      const raw=await this.gateway.topicMessages(this.dialog.peer,magazine.topicId,{limit:Infinity})
      const models=raw.map(TelegramGateway.messageModel)
      const pdfIdx=models.findIndex(r=>r.meta?.kind==='pdf')
      if(pdfIdx<0) throw new Error('PDF introuvable dans le sujet.')
      bytes=await this.gateway.downloadMessageMedia(raw[pdfIdx])
      let articles=[]
      const parsedBytes=await getAsset(`parse:${magazineId}`)
      if(parsedBytes){try{articles=parseEnvelopeArticles(magazineId,JSON.parse(new TextDecoder().decode(parsedBytes)))}catch{}}
      if(!articles.length){
        const parseIdx=models.findIndex(r=>r.meta?.kind==='parse')
        if(parseIdx>=0&&raw[parseIdx]?.media){try{const env=JSON.parse(new TextDecoder().decode(await this.gateway.downloadMessageMedia(raw[parseIdx])));articles=parseEnvelopeArticles(magazineId,env);await putAsset(`parse:${magazineId}`,new TextEncoder().encode(JSON.stringify(env)))}catch{}}
      }
      const pdf=await FamileoPdf.load(bytes,{trace:(scope,message,detail)=>info(scope,message,detail)})
      if(!articles.length)articles=pdf.articles()
      const resolved=resolveRowsToArticles(models,articles)
      rows=[...resolved.byArticle.values(),...resolved.motionsBy.values(),...[...resolved.soundsBy.values()].filter(Boolean)].flat()
      this.current={magazine,pdf,articles,rows}
    }
    return this.currentView()
  }

  async currentView() {
    if(!this.current) return null
    const {magazine,pdf,articles,rows}=this.current
    const read=await this.readMap()
    const pendingTopicOps=await this._listPendingTopicOps()
    const pendingDeletedIds=new Set(pendingTopicOps.filter(x=>x.type==='delete-contribution'&&x.magazineId===magazine.magazineId).map(x=>Number(x.targetMessageId||0)).filter(x=>x>0))
    // Always resolve through the tombstone-aware path. Cached rows may still
    // contain the original contribution after Telegram deleted it, while a
    // later silent deletion marker tells every client to hide it. Pending
    // local deletions are treated as tombstones too, so sync cannot resurrect
    // them before the queued operation is sent.
    const resolved=resolveRowsToArticles(rows.filter(r=>!pendingDeletedIds.has(Number(r.id))),articles)
    const commentsBy=resolved.byArticle
    const motionsBy=resolved.motionsBy
    const soundsBy=resolved.soundsBy
    const pendingSoundBy=new Map()
    for(const op of pendingTopicOps){
      if(op.type==='set-sound'&&op.magazineId===magazine.magazineId)pendingSoundBy.set(op.articleKey,op)
    }
    const outbox=await listOutbox()
    const pendingBy=new Map(outbox.map(x=>[x.articleKey,x]))
    const pendingMotionRows=await this._listPendingMotions()
    const pendingMotionBy=new Map(articles.map(a=>[a.articleKey,[]]))
    const remoteClientIds=new Set([...motionsBy.values()].flat().map(r=>String(r.motion?.clientId||r.meta?.motion?.clientId||'')).filter(Boolean))
    for(const item of pendingMotionRows){
      if(remoteClientIds.has(String(item.motion?.clientId||'')))continue
      if(pendingMotionBy.has(item.articleKey))pendingMotionBy.get(item.articleKey).push(this._pendingMotionRow(item,pendingMotionBy.get(item.articleKey).length))
    }
    const withState=articles.map(a=>{
      const comments=(commentsBy.get(a.articleKey)||[]).sort((x,y)=>x.id-y.id)
      const pending=pendingBy.get(a.articleKey)
      if(pending) comments.push({
        id:Number.MAX_SAFE_INTEGER,
        articleKey:a.articleKey,
        author:'Moi',
        isOutgoing:true,
        pending:true,
        date:pending.createdAt,
        displayText:pending.text,
        text:pending.text,
      })
      const motions=[...(motionsBy.get(a.articleKey)||[]).sort((x,y)=>x.id-y.id),...(pendingMotionBy.get(a.articleKey)||[])]
      const remoteSoundRow=soundsBy.get(a.articleKey)||null
      const pendingSoundOp=pendingSoundBy.get(a.articleKey)||null
      const hasPendingSound=pendingSoundBy.has(a.articleKey)
      const sound=hasPendingSound?(pendingSoundOp?.sound?{...pendingSoundOp.sound,pending:true}:null):(remoteSoundRow?.sound||null)
      const soundContribution=hasPendingSound
        ? (pendingSoundOp?.sound?{id:Number.MAX_SAFE_INTEGER-500,articleKey:a.articleKey,author:'Moi',isOutgoing:true,pending:true,pendingId:pendingSoundOp.id,date:pendingSoundOp.createdAt,sound:pendingSoundOp.sound}:null)
        : (remoteSoundRow?.sound?{...remoteSoundRow,sound:remoteSoundRow.sound}:null)
      const lastRead=read.get(a.articleKey)||0
      return {...a,comments,motions,sound,soundContribution,lastReadMessageId:lastRead,unreadCount:comments.filter(c=>!c.isOutgoing&&c.id>lastRead).length}
    })
    return {magazine,articles:withState,pdf}
  }

  async markArticleRead(articleKey) {
    if(!this.current) return
    const rows=this.current.rows.filter(r=>r.articleKey===articleKey && r.meta?.kind!=='motion' && !r.isOutgoing)
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

  async postEmojiMotion(articleKey,motion) {
    if(!this.current) throw new Error('Aucune revue ouverte.')
    const article=this.current.articles.find(a=>a.articleKey===articleKey)
    if(!article) throw new Error('Article inconnu.')
    const emoji=Array.isArray(motion?.emoji)?motion.emoji.slice(0,3):[]
    if(emoji.length<1) throw new Error('Choisis au moins un emoji.')
    const points=['p0','p1','p2','p3'].map(k=>motion?.curve?.[k])
    if(points.some(p=>!Array.isArray(p)||p.length!==2||p.some(n=>!Number.isFinite(Number(n))))) throw new Error('Trajectoire invalide.')
    const normalized={
      version:1,
      emoji,
      curve:Object.fromEntries(['p0','p1','p2','p3'].map((k,i)=>[k,points[i].map(n=>Math.max(0,Math.min(1,Number(n))))])),
      size:Math.max(.035,Math.min(.16,Number(motion.size)||.075)),
      scale:['stable','grow','shrink','pulse','inverse-pulse','explosion','rain','cloud','random'].includes(motion.scale)?motion.scale:'stable',
      duration:Math.max(1200,Math.min(4500,Math.round(Number(motion.duration)||2200))),
      clientId:String(motion?.clientId||`motion:${Date.now()}:${Math.random().toString(36).slice(2,8)}`),
    }

    const online = typeof navigator==='undefined' || navigator.onLine!==false
    if(!this.gateway || !this.dialog || !online || this.gateway.connectionState!=='connected') {
      await this._queueEmojiMotion(articleKey,normalized)
      return this.currentView()
    }

    try {
      const full=await this.gateway.topicMessages(this.dialog.peer,Number(this.current.magazine.topicId),{limit:Infinity})
      const {rootId}=await this.gateway.ensureRoot(this.dialog.peer,Number(this.current.magazine.topicId),this.current.magazine,article,full)
      const sent=await this.gateway.postEmojiMotion(this.dialog.peer,Number(this.current.magazine.topicId),rootId,articleKey,normalized)
      await this._persistSentMotionResult({articleKey,magazineId:this.current.magazine.magazineId,motion:normalized}, {sentMessage:sent,magazine:this.current.magazine,article})
      return this.currentView()
    } catch(e) {
      warn('motion.outbox','Envoi direct impossible, animation conservée localement',{articleKey,message:e?.message||String(e)})
      await this._queueEmojiMotion(articleKey,normalized)
      return this.currentView()
    }
  }


  async _queueArticleSound(op) {
    const rows=(await this._listPendingTopicOps()).filter(x=>!(x.type==='set-sound'&&x.magazineId===op.magazineId&&x.articleKey===op.articleKey))
    rows.push({id:`op:${Date.now()}:${Math.random().toString(36).slice(2,8)}`,createdAt:new Date().toISOString(),...op})
    await this._savePendingTopicOps(rows)
  }

  async _executeSetSoundTopicOp(op) {
    if(!this.gateway||!this.dialog)throw new Error('Telegram non initialisé.')
    const magazine=await getMagazine(op.magazineId);if(!magazine)throw new Error('Revue introuvable pour le son.')
    const articles=await listArticles(op.magazineId),article=articles.find(a=>a.articleKey===op.articleKey)||this.current?.articles?.find(a=>a.articleKey===op.articleKey)
    if(!article)throw new Error('Article introuvable pour le son.')
    const full=await this.gateway.topicMessages(this.dialog.peer,Number(op.topicId),{limit:Infinity})
    const {rootId}=await this.gateway.ensureRoot(this.dialog.peer,Number(op.topicId),magazine,article,full)
    const sent=await this.gateway.postArticleSound(this.dialog.peer,Number(op.topicId),rootId,op.articleKey,op.sound)
    const row=TelegramGateway.messageModel(sent)
    const payload={...row,articleKey:op.articleKey,key:`${magazine.magazineId}:${row.id}`,magazineId:magazine.magazineId,topicKey:magazine.topicKey}
    await putMessages([payload])
    if(this.current?.magazine?.magazineId===magazine.magazineId){
      this.current.rows=[...this.current.rows.filter(r=>Number(r.id)!==Number(row.id)),payload].sort((a,b)=>a.id-b.id)
    }
    return row
  }

  async postArticleSound(articleKey,sound) {
    if(!this.current)throw new Error('Aucune revue ouverte.')
    const article=this.current.articles.find(a=>a.articleKey===articleKey);if(!article)throw new Error('Article inconnu.')
    const soundId=String(sound?.soundId||'').trim();if(!soundId)throw new Error('Son invalide.')
    const duration=['source','5','15','continuous'].includes(String(sound?.duration))?String(sound.duration):'source'
    const normalized={version:1,soundId,duration,clientId:String(sound?.clientId||`sound:${Date.now()}:${Math.random().toString(36).slice(2,8)}`)}
    const op={type:'set-sound',magazineId:this.current.magazine.magazineId,topicId:this.current.magazine.topicId,articleKey,sound:normalized}
    const online=typeof navigator==='undefined'||navigator.onLine!==false
    if(!this.gateway||!this.dialog||!online||this.gateway.connectionState!=='connected'){
      await this._queueArticleSound(op)
      return this.currentView()
    }
    try{await this._executeSetSoundTopicOp(op)}
    catch(e){warn('sound.outbox','Envoi direct impossible, son conservé localement',{articleKey,message:e?.message||String(e)});await this._queueArticleSound(op)}
    return this.currentView()
  }

  async _applyLocalDeleteOp(op,{markerRow=null}={}) {
    const id=Number(op.targetMessageId||0),magazineId=op.magazineId,ak=op.articleKey
    if(id>0){try{await deleteMessageByKey(`${magazineId}:${id}`)}catch(e){warn('delete','Suppression cache local impossible',{messageId:id,message:e?.message||String(e)})}}
    if(this.current?.magazine?.magazineId===magazineId){
      this.current.rows=this.current.rows.filter(r=>Number(r.id)!==id)
      if(markerRow){const payload={...markerRow,articleKey:ak,key:`${magazineId}:${markerRow.id}`,magazineId,topicKey:this.current.magazine.topicKey};this.current.rows.push(payload);await putMessages([payload])}
      this.current.rows.sort((a,b)=>a.id-b.id)
    }
  }

  async _executeDeleteTopicOp(op) {
    if(!this.gateway||!this.dialog)throw new Error('Telegram non initialisé.')
    const magazine=await getMagazine(op.magazineId);if(!magazine)throw new Error('Revue introuvable pour la suppression.')
    const articles=await listArticles(op.magazineId),article=articles.find(a=>a.articleKey===op.articleKey)||this.current?.articles?.find(a=>a.articleKey===op.articleKey)
    if(!article)throw new Error('Article introuvable pour la suppression.')
    const full=await this.gateway.topicMessages(this.dialog.peer,Number(op.topicId),{limit:Infinity})
    const {rootId}=await this.gateway.ensureRoot(this.dialog.peer,Number(op.topicId),magazine,article,full)
    const marker=await this.gateway.postDeletionMarker(this.dialog.peer,Number(op.topicId),rootId,op.articleKey,Number(op.targetMessageId),op.targetKind)
    // Once the tombstone exists, direct Telegram deletion is best-effort only.
    try{await this.gateway.deleteMessagesById(this.dialog.peer,[Number(op.targetMessageId)])}catch(e){warn('delete','Suppression Telegram directe impossible, tombstone publié',{messageId:op.targetMessageId,message:e?.message||String(e)})}
    const markerRow=TelegramGateway.messageModel(marker)
    await this._applyLocalDeleteOp(op,{markerRow})
    return markerRow
  }

  async deleteOwnContribution({articleKey,kind,messageId=null,pendingId=null}={}) {
    if(!this.current)throw new Error('Aucune revue ouverte.')
    const ak=String(articleKey||'');if(!ak)throw new Error('Article inconnu.')
    if(kind==='motion'&&pendingId){
      const before=await this._listPendingMotions(),after=before.filter(x=>x.id!==pendingId)
      if(after.length===before.length)throw new Error('Animation en attente introuvable.')
      await this._savePendingMotions(after)
      return this.currentView()
    }
    if(kind==='sound'&&pendingId){
      const before=await this._listPendingTopicOps(),after=before.filter(x=>!(x.id===pendingId&&x.type==='set-sound'&&x.articleKey===ak))
      if(after.length===before.length)throw new Error('Son en attente introuvable.')
      await this._savePendingTopicOps(after)
      return this.currentView()
    }
    if(kind==='message'&&!messageId){await deleteOutbox(ak);return this.currentView()}
    const id=Number(messageId||0),row=this.current.rows.find(r=>Number(r.id)===id&&r.articleKey===ak)
    if(!row||!row.isOutgoing)throw new Error('Seules tes contributions peuvent être supprimées.')
    if(kind==='sound'){
      const op={id:`op:${Date.now()}:${Math.random().toString(36).slice(2,8)}`,createdAt:new Date().toISOString(),type:'set-sound',magazineId:this.current.magazine.magazineId,topicId:this.current.magazine.topicId,articleKey:ak,sound:null}
      await this._queueArticleSound(op)
      const online=typeof navigator==='undefined'||navigator.onLine!==false
      if(!this.gateway||!this.dialog||!online||this.gateway.connectionState!=='connected')return this.currentView()
      try{
        await this._executeSetSoundTopicOp(op)
        await this._savePendingTopicOps((await this._listPendingTopicOps()).filter(x=>x.id!==op.id))
      }catch(e){warn('sound.outbox','Suppression du son différée après échec réseau',{messageId:id,message:e?.message||String(e)})}
      return this.currentView()
    }
    const op={type:'delete-contribution',magazineId:this.current.magazine.magazineId,topicId:this.current.magazine.topicId,articleKey:ak,targetMessageId:id,targetKind:kind}
    // Hide immediately on this device. The pending op acts as a local tombstone
    // and prevents a sync from resurrecting the row while offline.
    await this._applyLocalDeleteOp(op)
    const online=typeof navigator==='undefined'||navigator.onLine!==false
    if(!this.gateway||!this.dialog||!online||this.gateway.connectionState!=='connected'){
      await this._queueTopicOp(op);info('delete.outbox','Suppression mise en attente',{articleKey:ak,messageId:id});return this.currentView()
    }
    try{await this._executeDeleteTopicOp(op)}catch(e){warn('delete.outbox','Suppression différée après échec réseau',{messageId:id,message:e?.message||String(e)});await this._queueTopicOp(op)}
    return this.currentView()
  }

  async queueText(articleKey,text) {
    if(!this.current) throw new Error('Aucune revue ouverte.')
    const article=this.current.articles.find(a=>a.articleKey===articleKey)
    if(!article) throw new Error('Article inconnu.')
    const clean=String(text||'').trim()
    if(!clean) throw new Error('Message vide.')

    // Keyed by articleKey: at most one pending message per discussion.
    await putOutbox({
      articleKey,
      magazineId:this.current.magazine.magazineId,
      topicId:this.current.magazine.topicId,
      text:clean,
      format:'mamina-markdown-v1',
    })
    info('outbox','Message mis en attente',{articleKey})
    return this.currentView()
  }

  async postText(articleKey,text) {
    if(!this.current) throw new Error('Aucune revue ouverte.')
    const clean=String(text||'').trim()
    if(!clean) throw new Error('Message vide.')

    const online = typeof navigator==='undefined' || navigator.onLine!==false
    if(!this.gateway || !this.dialog || !online || this.gateway.connectionState!=='connected') {
      return this.queueText(articleKey,clean)
    }

    try {
      const item={
        articleKey,
        magazineId:this.current.magazine.magazineId,
        topicId:this.current.magazine.topicId,
        text:clean,
        format:'mamina-markdown-v1',
      }
      const result=await this._sendTextNow(item)
      await this._persistSentResult(item,result)
      const magazine=await getMagazine(this.current.magazine.magazineId)
      if(magazine) await this.syncKnownTopic(magazine)
      return this.openMagazineLocalFirst(this.current.magazine.magazineId)
    } catch(e) {
      // Network/connection loss during send: preserve the user's text locally.
      warn('outbox','Envoi direct impossible, message conservé localement',{
        articleKey,message:e?.message||String(e),
      })
      return this.queueText(articleKey,clean)
    }
  }

  async _sendTextNow(item) {
    if(!this.gateway || !this.dialog) throw new Error('Telegram non initialisé.')
    const magazine=await getMagazine(item.magazineId)
    if(!magazine) throw new Error('Revue de la file d’attente introuvable.')

    let bytes=await getAsset(`pdf:${magazine.magazineId}`)
    if(!bytes) bytes=await getAsset(`staging-pdf:${magazine.magazineId}`)
    if(!bytes) throw new Error('PDF local requis pour résoudre l’article en attente.')

    const pdf=await FamileoPdf.load(bytes)
    try {
      const article=pdf.articles().find(a=>a.articleKey===item.articleKey)
      if(!article) throw new Error('Article de la file d’attente introuvable.')
      const full=await this.gateway.topicMessages(this.dialog.peer,Number(item.topicId),{limit:Infinity})
      const {rootId}=await this.gateway.ensureRoot(
        this.dialog.peer,Number(item.topicId),pdf.magazine,article,full
      )
      const sentMessage=await this.gateway.postTextComment(
        this.dialog.peer,Number(item.topicId),rootId,item.articleKey,item.text,item.format||'mamina-markdown-v1'
      )
      return {sentMessage,magazine,article}
    } finally {
      try { await pdf.doc?.cleanup?.(); await pdf.doc?.destroy?.() } catch {}
    }
  }

  async _persistSentResult(item,result) {
    const message=result?.sentMessage
    const magazine=result?.magazine
    if(!message || !magazine?.fullyCached) return

    const row=TelegramGateway.messageModel(message)
    const payload={
      ...row,
      articleKey:item.articleKey,
      displayText:stripMeta(row.text),
      key:`${magazine.magazineId}:${row.id}`,
      magazineId:magazine.magazineId,
      topicKey:magazine.topicKey,
    }
    await putMessages([payload])

    if(this.current?.magazine?.magazineId===magazine.magazineId){
      const withoutSame=this.current.rows.filter(r=>r.id!==payload.id)
      this.current.rows=[...withoutSame,payload].sort((a,b)=>a.id-b.id)
    }
  }

  async flushOutbox(force=false) {
    if(!this.gateway || !this.dialog) return 0
    const connected=this.gateway.connectionState==='connected' || this.gateway.connectionState==='updating' || this.gateway.isConnected()
    if(!connected && !force) return 0
    const rows=await listOutbox()
    const motions=await this._listPendingMotions()
    const topicOps=await this._listPendingTopicOps()
    const total=rows.length+motions.length+topicOps.length
    if(total) this.activity(`Envoi différé · ${total} élément${total>1?'s':''}`)
    let sent=0
    for(const item of rows) {
      try {
        const result=await this._sendTextNow(item)
        await deleteOutbox(item.articleKey)
        await this._persistSentResult(item,result)
        sent++
        info('outbox','Message différé envoyé et normalisé localement',{articleKey:item.articleKey,messageId:Number(result?.sentMessage?.id||0)||null})
      } catch(e) {
        warn('outbox','Message différé toujours en attente',{articleKey:item.articleKey,message:e?.message||String(e)})
        if(this.gateway.connectionState!=='connected') break
      }
    }
    let pendingMotions=await this._listPendingMotions()
    for(const item of pendingMotions) {
      try {
        const result=await this._sendMotionNow(item)
        await this._savePendingMotions((await this._listPendingMotions()).filter(x=>x.id!==item.id))
        await this._persistSentMotionResult(item,result)
        sent++
        info('motion.outbox','Animation différée envoyée et normalisée localement',{articleKey:item.articleKey,messageId:Number(result?.sentMessage?.id||0)||null})
      } catch(e) {
        warn('motion.outbox','Animation différée toujours en attente',{articleKey:item.articleKey,message:e?.message||String(e)})
        if(this.gateway.connectionState!=='connected') break
      }
    }
    const pendingOps=await this._listPendingTopicOps()
    for(const item of pendingOps){
      try{
        if(item.type==='delete-contribution')await this._executeDeleteTopicOp(item)
        else if(item.type==='set-sound')await this._executeSetSoundTopicOp(item)
        else throw new Error(`Opération différée inconnue: ${item.type}`)
        await this._savePendingTopicOps((await this._listPendingTopicOps()).filter(x=>x.id!==item.id))
        sent++
        info('topic.outbox','Opération différée envoyée',{type:item.type,articleKey:item.articleKey||null})
      }catch(e){
        warn('topic.outbox','Opération différée toujours en attente',{type:item.type,message:e?.message||String(e)})
        if(this.gateway.connectionState!=='connected')break
      }
    }
    return sent
  }

  async reconnectAndFlush(reason='manual') {
    if(!this.gateway) throw new Error('Telegram non initialisé.')
    this.activity('Reconnexion à Telegram…')
    await this.gateway.ensureConnected(reason)
    if(!this.dialog) {
      const restored=await this.restoreOrSelectDialog()
      if(!restored.selected) throw new Error('Groupe Telegram non sélectionné.')
    }
    const sent=await this.flushOutbox(true)
    this.activity(sent?`Messages différés envoyés · ${sent}`:'Telegram connecté')
    return sent
  }

  async migrateDerivedArticleGeometry(force=false) {
    const target='article-geometry-v3'
    if(!force && await settings.get('derivedArticleGeometryVersion','')===target)return {updated:0,cleared:0}
    let updated=0,missing=0
    for(const magazine of await listMagazines()){
      const bytes=await getAsset(`parse:${magazine.magazineId}`)
      if(!bytes){missing++;continue}
      try{
        const envelope=JSON.parse(new TextDecoder().decode(bytes))
        const articles=parseEnvelopeArticles(magazine.magazineId,envelope)
        if(articles.length){await replaceArticles(magazine.magazineId,articles);updated++}
      }catch(e){warn('cache.migration','Géométrie article non reconstruite',{magazineId:magazine.magazineId,message:e?.message||String(e)})}
    }
    const cleared=(await deleteAssetsByPrefix('article:'))+(await deleteAssetsByPrefix('photo:'))
    // If some old magazines have no parse sidecar, run again after a future sync.
    if(!missing)await settings.set('derivedArticleGeometryVersion',target)
    info('cache.migration','Géométries article actualisées',{updated,missing,cleared})
    return {updated,missing,cleared}
  }

  async pendingCount() { return (await countOutbox()) + (await this._listPendingMotions()).length + (await this._listPendingTopicOps()).length }
  async storageStats() { return estimateLocalStorage() }
  async pendingForArticle(articleKey) { return {text:await getOutbox(articleKey),motions:(await this._listPendingMotions()).filter(x=>x.articleKey===articleKey)} }

  async ensureCurrentPdf() {
    if(!this.current) throw new Error('Aucune revue ouverte.')
    if(this.current.pdf) return this.current.pdf
    if(this.pdfLoadPromise) return this.pdfLoadPromise

    const currentRef=this.current
    this.pdfLoadPromise=(async()=>{
      const bytes=currentRef.pdfBytes || await getAsset(`pdf:${currentRef.magazine.magazineId}`)
      if(!bytes) throw new Error('PDF local indisponible.')
      const pdf=await FamileoPdf.load(bytes)
      currentRef.pdf=pdf
      currentRef.pdfBytes=bytes
      // Parsed v1 articles already contain authoritative geometry/text from
      // the master JSON. Never replace them with the legacy PDF heuristic.
      if(!currentRef.articles?.length){
        const parsed=pdf.articles()
        if(parsed.length){currentRef.articles=parsed;try{await replaceArticles(currentRef.magazine.magazineId,parsed)}catch{}}
      }
      return pdf
    })()
    try { return await this.pdfLoadPromise }
    finally { this.pdfLoadPromise=null }
  }

  async getArticleImageInfo(articleKey) {
    if(!this.current) throw new Error('Aucune revue ouverte.')
    const assetKey=`article:${articleKey}`
    const cached=await getAsset(assetKey)
    if(cached) return {blob:cached,source:'local'}

    const task=async()=>{
      const secondCheck=await getAsset(assetKey)
      if(secondCheck) return {blob:secondCheck,source:'local'}
      let article=this.current?.articles.find(a=>a.articleKey===articleKey)
      if(!article) throw new Error('Article inconnu.')
      this.activity('Préparation de l’article…')
      const pdf=await this.ensureCurrentPdf()
      article=this.current?.articles.find(a=>a.articleKey===articleKey) || article
      const canvas=await pdf.renderArticle(article)
      const blob=await canvasBlob(canvas,'image/jpeg',.84)
      if(this.current?.magazine?.fullyCached) await putAsset(assetKey,blob)
      return {blob,source:'PDF'}
    }
    const result=this.renderChain.then(task,task)
    this.renderChain=result.then(()=>undefined,()=>undefined)
    return result
  }

  async getArticleImage(articleKey) {
    return (await this.getArticleImageInfo(articleKey)).blob
  }

  async getArticlePhotoInfo(articleKey) {
    if(!this.current) throw new Error('Aucune revue ouverte.')
    const assetKey=`photo:${articleKey}`
    const cached=await getAsset(assetKey)
    if(cached) return {blob:cached,source:'local-photo'}

    const task=async()=>{
      const secondCheck=await getAsset(assetKey)
      if(secondCheck) return {blob:secondCheck,source:'local-photo'}
      const article=this.current?.articles.find(a=>a.articleKey===articleKey)
      if(!article) throw new Error('Article inconnu.')
      if(!article.collages?.length) throw new Error('Zone photo indisponible.')
      this.activity('Préparation de la photo…')
      const pdf=await this.ensureCurrentPdf()
      const canvas=await pdf.renderArticlePhoto(article)
      const blob=await canvasBlob(canvas,'image/jpeg',.92)
      if(this.current?.magazine?.fullyCached) await putAsset(assetKey,blob)
      return {blob,source:'PDF-photo'}
    }
    const result=this.renderChain.then(task,task)
    this.renderChain=result.then(()=>undefined,()=>undefined)
    return result
  }

  async warmArticleImages(articleKeys=[]) {
    if(!this.current?.magazine?.fullyCached) return
    for(const key of articleKeys){
      try {
        const cached=await getAsset(`article:${key}`)
        if(!cached) await this.getArticleImageInfo(key)
      } catch(e) {
        warn('cache','Préchargement article impossible',{articleKey:key,message:e?.message||String(e)})
      }
      await new Promise(resolve=>{
        if('requestIdleCallback' in globalThis) requestIdleCallback(()=>resolve(),{timeout:350})
        else setTimeout(resolve,40)
      })
    }
  }

  async closeMagazine() {
    const current=this.current
    try { await this.renderChain } catch {}
    this.current=null
    this.pdfLoadPromise=null
    try { await current?.pdf?.doc?.cleanup?.() } catch {}
    try { await current?.pdf?.doc?.destroy?.() } catch {}
  }

  async ensureConnected(reason='app-resume') {
    if(!this.gateway) throw new Error('Telegram non initialisé.')
    return this.gateway.ensureConnected(reason)
  }

  connectionState() { return this.gateway?.connectionState || 'offline' }
  hasGateway() { return Boolean(this.gateway) }
  hasDialog() { return Boolean(this.dialog) }

  async loadRemoteParams(topics=null) {
    if(!this.dialog) return null
    const peer=this.dialog.peer
    let messageId=Number(await settings.get('paramsMessageId',0)||0),msg=null
    if(messageId) msg=await this.gateway.messageById(peer,messageId).catch(()=>null)
    if(!msg){const list=topics||await this.gateway.topics(peer),topic=list.find(t=>exactTopic(t,PARAMS_TOPIC));if(!topic)return null;const rows=await this.gateway.topicMessages(peer,topicIdOf(topic),{limit:50});const models=rows.map(TelegramGateway.messageModel);let i=-1;for(let x=models.length-1;x>=0;x--)if(models[x].meta?.kind==='mamina-params'){i=x;break}if(i<0)return null;msg=rows[i];messageId=Number(msg.id);await settings.set('paramsMessageId',messageId);await settings.set('paramsTopicId',topicIdOf(topic))}
    const meta=TelegramGateway.messageModel(msg).meta;if(meta?.kind!=='mamina-params')return null;await settings.set('remoteParams',meta);return meta
  }

  async loadEmojiResolver() {
    const params=await this.loadRemoteParams();if(!params?.catalog?.manifestMessageId)throw new Error('CATALOG_PARAMS_MISSING')
    const peer=this.dialog.peer,manifestMsg=await this.gateway.messageById(peer,params.catalog.manifestMessageId);const manifest=TelegramGateway.messageModel(manifestMsg).meta
    if(manifest?.kind!=='mamina-catalog-manifest')throw new Error('CATALOG_MANIFEST_INVALID')
    const load=async(role)=>{const id=manifest.files?.[role];if(!id)throw new Error(`CATALOG_FILE_MISSING:${role}`);const key=`catalog:${id}`;let bytes=await getAsset(key);if(!bytes){const m=await this.gateway.messageById(peer,id);bytes=await this.gateway.downloadMessageMedia(m);await putAsset(key,bytes)}return bytes}
    const [shaB,jsonB,binB]=await Promise.all([load('sha256'),load('json'),load('bin')]);return new EmojiResolver({shaJson:JSON.parse(new TextDecoder().decode(shaB)),catalogJson:JSON.parse(new TextDecoder().decode(jsonB)),catalogBin:binB,set:params.parser?.emojiSet||'apple',threshold:Number(params.parser?.emojiThreshold||.999)})
  }

  async adminSaveParams({storagePassword=true,sounds=null}={}) {
    if(!this.dialog)throw new Error('Aucun groupe sélectionné.')
    const peer=this.dialog.peer
    let topics=await this.gateway.topics(peer)
    let topic=topics.find(x=>exactTopic(x,PARAMS_TOPIC))
    let paramsTopicId
    if(topic)paramsTopicId=topicIdOf(topic)
    else {
      const created=await this.gateway.createTopic(peer,PARAMS_TOPIC)
      paramsTopicId=created.topicId
      topics=await this.gateway.topics(peer)
    }
    const rows=await this.gateway.topicMessages(peer,paramsTopicId,{limit:50})
    const existing=[...rows].reverse().find(m=>TelegramGateway.messageModel(m).meta?.kind==='mamina-params')||null
    const previous=existing?TelegramGateway.messageModel(existing).meta:(await settings.get('remoteParams',null)||{})
    const enabled=Boolean(storagePassword)
    const normalizedSounds=(Array.isArray(sounds)?sounds:(Array.isArray(previous?.sounds)?previous.sounds:[])).map((x,i)=>({
      id:String(x?.id||`sound-${i+1}`).trim().slice(0,80),
      emoji:String(x?.emoji||'🎶').trim().slice(0,16)||'🎶',
      label:String(x?.label||'Son').trim().slice(0,120)||'Son',
      url:String(x?.url||'').trim().slice(0,2048),
      provider:String(x?.provider||'').trim().slice(0,40),
      providerId:String(x?.providerId||'').trim().slice(0,80),
      license:String(x?.license||'').trim().slice(0,80),
      keywords:String(x?.keywords||'').trim().slice(0,240),
    })).filter(x=>/^https?:\/\//i.test(x.url))
    const paramsMeta={...previous,kind:'mamina-params',version:Number(previous?.version||1),storagePassword:enabled,auth:{...(previous?.auth||{}),storePassword:enabled},sounds:normalizedSounds}
    delete paramsMeta.freesoundApiKey
    const paramsMsg=existing
      ? await this.gateway.editSystemText(peer,existing.id,'Paramètres MamiNa',paramsMeta)
      : await this.gateway.postSystemText(peer,paramsTopicId,'Paramètres MamiNa',paramsMeta)
    await settings.set('paramsTopicId',paramsTopicId)
    await settings.set('paramsMessageId',Number(paramsMsg.id))
    await settings.set('remoteParams',paramsMeta)
    return {paramsTopicId,paramsMessageId:Number(paramsMsg.id),params:paramsMeta}
  }

  async adminInitializeSystem({shaFile,catalogJsonFile,catalogBinFile}={}) {
    if(!this.dialog)throw new Error('Aucun groupe sélectionné.')
    if(!shaFile||!catalogJsonFile||!catalogBinFile)throw new Error('Sélectionne les 3 fichiers catalogue.')
    const peer=this.dialog.peer;let topics=await this.gateway.topics(peer)
    const ensure=async name=>{let t=topics.find(x=>exactTopic(x,name));if(t)return topicIdOf(t);const c=await this.gateway.createTopic(peer,name);topics=await this.gateway.topics(peer);return c.topicId}
    const paramsTopicId=await ensure(PARAMS_TOPIC),catalogTopicId=await ensure(CATALOG_TOPIC)
    const post=async(file,role)=>this.gateway.postDocument(peer,catalogTopicId,file,{kind:'catalog-file',role,name:file.name})
    const [shaMsg,jsonMsg,binMsg]=await Promise.all([post(shaFile,'sha256'),post(catalogJsonFile,'json'),post(catalogBinFile,'bin')])
    const manifest=await this.gateway.postSystemText(peer,catalogTopicId,'Catalogue MamiNa',{kind:'mamina-catalog-manifest',version:1,files:{sha256:Number(shaMsg.id),json:Number(jsonMsg.id),bin:Number(binMsg.id)}})
    const paramsMeta={kind:'mamina-params',version:1,parser:{spec:'SPEC_v1_CG',emojiSet:'apple',emojiThreshold:.999},catalog:{topicId:catalogTopicId,manifestMessageId:Number(manifest.id)},storagePassword:true,auth:{storePassword:true},sounds:[]}
    const oldParams=await this.gateway.topicMessages(peer,paramsTopicId,{limit:50})
    const existing=[...oldParams].reverse().find(m=>TelegramGateway.messageModel(m).meta?.kind==='mamina-params')
    const paramsMsg=existing?await this.gateway.editSystemText(peer,existing.id,'Paramètres MamiNa',paramsMeta):await this.gateway.postSystemText(peer,paramsTopicId,'Paramètres MamiNa',paramsMeta)
    await settings.set('paramsTopicId',paramsTopicId);await settings.set('paramsMessageId',Number(paramsMsg.id));await settings.set('remoteParams',paramsMeta)
    return {paramsTopicId,catalogTopicId,paramsMessageId:Number(paramsMsg.id),catalogManifestMessageId:Number(manifest.id)}
  }

  async adminListForumDialogs() {
    return this.listForumDialogs()
  }

  async adminListTopics() {
    if(!this.dialog) throw new Error('Aucun groupe sélectionné.')
    return this.gateway.topics(this.dialog.peer)
  }

  async adminCreateMagazine(file,{onStep,progressCallback}={}) {
    if(!this.dialog) throw new Error('Aucun groupe sélectionné.')
    if(!file) throw new Error('PDF manquant.')
    const step=(name,detail={})=>onStep?.({name,detail,at:new Date().toISOString()})
    try {
      step('magazine.pdf.read.start',{name:file.name,size:file.size,type:file.type})
      const resolver=await this.loadEmojiResolver()
      const parsed=await FamileoGeometryParser.parse(file,{emojiResolver:resolver,onProgress:text=>this.activity(text)})
      if(parsed.warnings?.length){
        step('magazine.pdf.read.warnings',{count:parsed.warnings.length,warnings:parsed.warnings})
        warn('pdf.parse','Parsing Famileo tolérant',{warnings:parsed.warnings})
      }
      const g=parsed.gazette,appTitle=await settings.get('appTitle','MamiNa'),sha256=parsed.sha256
      const slug=String(g.source?.title||'gazette').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'gazette'
      const magazineKey=`famileo:${slug}:n${g.cover.issue_number||0}:${g.cover.date_iso||'date-unknown'}`
      const magazine={title:g.source?.title||'Gazette Famileo',issue:g.cover.issue_number,date:g.cover.date_iso,sha256,magazineKey,magazineId:`${magazineKey}:sha256-${sha256.slice(0,12)}`,pageCount:g.source.pages,appTitle}
      const envelope={schema:'mamina-gazette-v1',spec:'SPEC_v1_CG',sha256,gazette:g,geometry:parsed.geometry}
      const articles=parseEnvelopeArticles(magazine.magazineId,envelope)
      try { await parsed.doc?.cleanup?.(); await parsed.doc?.destroy?.() } catch {}
      step('magazine.pdf.read.done',{
        magazineId:magazine.magazineId,issue:magazine.issue,date:magazine.date,articles:articles.length
      })
      const title=`${magazine.date?magazine.date.slice(0,7):'Revue'} — Famileo${magazine.issue?` N°${magazine.issue}`:''}`
      step('magazine.topic.create.start',{title})
      const {topicId}=await this.gateway.createTopic(this.dialog.peer,title)
      step('magazine.topic.create.done',{topicId})
      await this.gateway.postMagazinePdf(this.dialog.peer,topicId,file,magazine,{progressCallback,onStep})
      const parseFile=new File([JSON.stringify(envelope)],`gazette-${magazine.issue||'parse'}.json`,{type:'application/json'})
      await this.gateway.postDocument(this.dialog.peer,topicId,parseFile,{kind:'parse',schema:'mamina-gazette-v1',spec:'SPEC_v1_CG',magazineId:magazine.magazineId,sha256})
      step('magazine.done',{topicId})
      await this.syncAll()
      return {topicId,magazine,articles}
    } catch(error) {
      onStep?.({
        name:'magazine.error',
        detail:{message:error?.message||String(error),stack:error?.stack||null},
        at:new Date().toISOString(),
      })
      throw error
    }
  }

  async setAppTitle(value) {
    const title=String(value||'').trim()||'MamiNa'
    await settings.set('appTitle',title)
    return title
  }

  async maminaPasswordStorageEnabled() {
    const remote=await settings.get('remoteParams',null)
    if(typeof remote?.storagePassword==='boolean')return remote.storagePassword
    if(typeof remote?.auth?.storePassword==='boolean')return remote.auth.storePassword
    return true
  }

  async getSettings() {
    const storagePassword=await this.maminaPasswordStorageEnabled()
    const remote=await settings.get('remoteParams',null)
    return {
      reactionOrder:await settings.get('reactionOrder','asc'),
      articleOrderMode:await settings.get('articleOrderMode','magazine'),
      recentColors:await settings.get('recentColors',[]),
      appTitle:await settings.get('appTitle','MamiNa'),
      theme:await settings.get('theme','system'),
      storagePassword,
      groupId:String(await settings.get('groupId','')||''),
      sounds:Array.isArray(remote?.sounds)?remote.sounds:[],
      freesoundApiKey:String(remote?.freesoundApiKey||''), // legacy migration only
    }
  }
  async setReactionOrder(order) {
    if(!['asc','desc'].includes(order))throw new Error('Ordre invalide.')
    await settings.set('reactionOrder',order)
  }
  async setTheme(theme) {
    if(!['system','light','dark'].includes(theme)) throw new Error('Thème invalide.')
    await settings.set('theme',theme)
  }
  async setArticleOrderMode(mode) {
    if(!['magazine','activity'].includes(mode))throw new Error('Ordre d’articles invalide.')
    await settings.set('articleOrderMode',mode)
  }
  async rememberColor(color) {
    const normalized=String(color||'').toUpperCase()
    if(!/^#[0-9A-F]{6}$/.test(normalized)) return
    const old=await settings.get('recentColors',[])
    await settings.set('recentColors',[normalized,...old.filter(x=>x!==normalized)].slice(0,3))
  }
}
