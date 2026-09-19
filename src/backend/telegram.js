import { TelegramClient, InputMedia } from '@mtcute/web'
import { withMeta, parseMeta, canonicalRoots } from './protocol.js'
import { info, warn, error as logError } from './log.js'

export class TelegramGateway {
  constructor({ apiId, apiHash }) {
    this.tg = new TelegramClient({
      apiId,
      apiHash,
      storage: 'mamina-telegram-user',
      logLevel: Number(localStorage.getItem('MTCUTE_LOG_LEVEL') || 2),
      updates: { catchUp: true, messageGroupingInterval: 250 },
    })
    this.self = null
    this.connectionState = 'offline'
    this.connectionListeners = new Set()
    this.tg.onConnectionState.add((state) => {
      this.connectionState = state
      info('telegram.connection', `État: ${state}`)
      for (const fn of this.connectionListeners) { try { fn(state) } catch {} }
    })
    this.tg.onError.add((err) => logError('telegram', err?.message || 'Erreur mtcute', err))
  }

  async login() {
    info('telegram.login','Démarrage / reprise de session')
    this.self = await this.tg.start({
      phone: async () => prompt('Numéro Telegram (+33…)') || '',
      code: async () => prompt('Code Telegram') || '',
      password: async () => prompt('Mot de passe 2FA') || '',
    })
    info('telegram.login','Session prête',{user:this.self?.displayName||this.self?.username||null})
    return this.self
  }

  async logout() { await this.tg.logOut(); this.self = null }

  onConnectionState(handler) {
    this.connectionListeners.add(handler)
    try { handler(this.connectionState) } catch {}
    return () => this.connectionListeners.delete(handler)
  }

  isConnected() { return Boolean(this.tg?.isConnected) }

  async ensureConnected(reason='manual') {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      warn('telegram.connection',`Réseau hors ligne (${reason})`)
      throw new Error('Pas de connexion réseau.')
    }
    info('telegram.connection',`Contrôle connexion (${reason})`,{connected:Boolean(this.tg?.isConnected)})
    try {
      await this.tg.connect()
      await this.tg.call({ _: 'help.getConfig' })
      info('telegram.connection',`Connexion Telegram opérationnelle (${reason})`,{connected:Boolean(this.tg?.isConnected)})
      return true
    } catch (e) {
      logError('telegram.connection',`Échec reconnexion (${reason})`,e)
      throw e
    }
  }


  onNewMessage(handler) {
    const wrapped = (message) => {
      try { handler(message) } catch (error) { console.error('Mamina update handler', error) }
    }
    this.tg.onNewMessage.add(wrapped)
    return () => this.tg.onNewMessage.remove?.(wrapped)
  }

  async dialogs(limit=200) {
    const out=[]
    for await (const d of this.tg.iterDialogs({ limit })) out.push(d)
    return out
  }

  static dialogModel(dialog) {
    const peer = dialog.peer
    return {
      dialog,
      title: peer?.displayName || peer?.title || peer?.username || String(peer?.id ?? ''),
      isForum: Boolean(peer?.isForum),
      isGroup: Boolean(peer?.isGroup),
      peerType: peer?.type || null,
    }
  }

  async topics(peer) {
    const out=[]
    for await (const t of this.tg.iterForumTopics(peer, { limit: Infinity })) out.push(t)
    return out
  }

  async createTopic(peer, title) {
    const service = await this.tg.createForumTopic({ chatId: peer, title })
    const topicId = Number(service?.replyToMessage?.threadId || service?.threadId || service?.id)
    if (!topicId) throw new Error('Sujet créé mais topicId introuvable.')
    return { topicId, service }
  }

  async topicMessages(peer, topicId, { minId=0, limit=Infinity }={}) {
    const out=[]
    for await (const m of this.tg.iterSearchMessages({
      chatId: peer,
      threadId: topicId,
      minId,
      limit,
      query: '',
    })) out.push(m)
    out.sort((a,b)=>Number(a.id)-Number(b.id))
    return out
  }

  async postMagazinePdf(peer, topicId, file, meta, { progressCallback, onStep }={}) {
    const step = (name, detail={}) => onStep?.({ name, detail, at: new Date().toISOString() })

    step('telegram.pdf.caption')
    const caption = withMeta(`📄 ${meta.title || file.name || 'Gazette Famileo'}`, {
      kind: 'pdf',
      magazineId: meta.magazineId,
      magazineKey: meta.magazineKey,
      issue: meta.issue ?? null,
      date: meta.date ?? null,
      sha256: meta.sha256,
      appTitle: meta.appTitle || 'MamiNa',
    })

    // @mtcute/web 0.32.1 explicitly supports the browser File API as InputFileLike.
    // Keep the native File object here instead of converting it ourselves.
    step('telegram.pdf.prepareMedia', {
      name: file?.name || null,
      type: file?.type || null,
      size: file?.size ?? null,
      isFile: typeof File !== 'undefined' && file instanceof File,
    })
    const media = InputMedia.document(file, {
      fileName: file?.name || 'gazette.pdf',
      fileMime: file?.type || 'application/pdf',
      fileSize: file?.size,
    })

    // Separate upload from sending on purpose. This gives us an exact failure
    // boundary and avoids hiding an upload exception inside sendMedia().
    step('telegram.pdf.upload.start', { topicId })
    const uploaded = await this.tg.uploadMedia(media, {
      peer,
      progressCallback: (uploadedBytes, totalBytes) => {
        progressCallback?.(uploadedBytes, totalBytes)
        onStep?.({
          name: 'telegram.pdf.upload.progress',
          detail: { uploadedBytes, totalBytes },
          at: new Date().toISOString(),
        })
      },
    })
    step('telegram.pdf.upload.done', {
      mediaType: uploaded?.type || null,
      fileName: uploaded?.fileName || null,
      fileSize: uploaded?.fileSize ?? null,
      hasInputMedia: Boolean(uploaded?.inputMedia),
      hasFileId: Boolean(uploaded?.fileId),
    })

    if (!uploaded?.inputMedia) {
      throw new Error('Upload Telegram terminé mais inputMedia est absent.')
    }

    step('telegram.pdf.send.start', { topicId })
    const sent = await this.tg.sendMedia(peer, uploaded.inputMedia, {
      threadId: topicId,
      caption,
    })
    step('telegram.pdf.send.done', { messageId: Number(sent?.id || 0) || null })
    return sent
  }

  async downloadMessageMedia(message, progressCallback) {
    if (!message?.media) throw new Error('Ce message ne contient pas de média.')
    return this.tg.downloadAsBuffer(message.media, { progressCallback })
  }

  async ensureRoot(peer, topicId, magazine, article, currentMessages=null) {
    let messages = currentMessages || await this.topicMessages(peer, topicId)
    let roots = canonicalRoots(messages)
    let found = roots.get(article.articleKey)
    if (!found) {
      const human = `🧵 Article p${String(article.page).padStart(2,'0')}-${article.slot}`
      await this.tg.sendText(peer, withMeta(human, {
        kind:'root',
        magazineId: magazine.magazineId,
        articleKey: article.articleKey,
        page: article.page,
        slot: article.slot,
      }), { threadId: topicId, silent: true })
      messages = await this.topicMessages(peer, topicId)
      roots = canonicalRoots(messages)
      found = roots.get(article.articleKey)
    }
    if (!found) throw new Error('Impossible de résoudre la racine de l’article.')
    return { rootId:Number(found.canonical.message.id), duplicates:found.duplicates.map(x=>Number(x.message.id)), messages }
  }

  async postTextComment(peer, topicId, rootId, articleKey, text, format='mamina-markdown-v1') {
    return this.tg.sendText(peer, withMeta(text, { kind:'message', type:'text', format, articleKey }), {
      threadId: topicId,
      replyTo: rootId,
    })
  }

  async postImageComment(peer, topicId, rootId, articleKey, file, text='', progressCallback) {
    return this.tg.sendMedia(peer, InputMedia.photo(file), {
      threadId: topicId,
      replyTo: rootId,
      caption: withMeta(text, { kind:'message', type:'img', articleKey }),
      progressCallback,
    })
  }

  static messageModel(message) {
    const meta = parseMeta(message.text || message.caption || '')
    return {
      id: Number(message.id),
      date: message.date ? new Date(message.date).toISOString() : null,
      author: message.sender?.displayName || message.sender?.username || message.sender?.firstName || '—',
      senderId: Number(message.sender?.id || 0) || null,
      isOutgoing: Boolean(message.isOutgoing),
      text: message.text || message.caption || '',
      meta,
      replyToId: Number(message.replyToMessage?.id || message.replyTo?.id || 0) || null,
      topicId: Number(message.replyToMessage?.threadId || message.replyTo?.threadId || message.topicId || 0) || null,
      hasMedia: Boolean(message.media),
      mediaType: message.media?.type || null,
    }
  }
}
