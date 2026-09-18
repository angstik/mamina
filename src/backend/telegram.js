import { TelegramClient, InputMedia } from '@mtcute/web'
import { withMeta, parseMeta, canonicalRoots } from './protocol.js'

export class TelegramGateway {
  constructor({ apiId, apiHash }) {
    this.tg = new TelegramClient({
      apiId,
      apiHash,
      storage: 'mamina-telegram-user',
      logLevel: 2,
    })
    this.self = null
  }

  async login() {
    this.self = await this.tg.start({
      phone: async () => prompt('Numéro Telegram (+33…)') || '',
      code: async () => prompt('Code Telegram') || '',
      password: async () => prompt('Mot de passe 2FA') || '',
    })
    return this.self
  }

  async logout() { await this.tg.logOut(); this.self = null }

  async dialogs(limit=200) {
    const out=[]
    for await (const d of this.tg.iterDialogs({ limit })) out.push(d)
    return out
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

  async postMagazinePdf(peer, topicId, file, meta, progressCallback) {
    const caption = withMeta(`📄 ${meta.title || file.name}`, {
      kind: 'pdf',
      magazineId: meta.magazineId,
      magazineKey: meta.magazineKey,
      issue: meta.issue ?? null,
      date: meta.date ?? null,
      sha256: meta.sha256,
    })
    return this.tg.sendMedia(peer, InputMedia.document(file, { fileName: file.name, fileMime: 'application/pdf', fileSize: file.size }), {
      threadId: topicId,
      caption,
      progressCallback,
    })
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

  async postTextComment(peer, topicId, rootId, articleKey, text) {
    return this.tg.sendText(peer, withMeta(text, { kind:'message', type:'text', articleKey }), {
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
      text: message.text || message.caption || '',
      meta,
      replyToId: Number(message.replyToMessage?.id || message.replyTo?.id || 0) || null,
      topicId: Number(message.replyToMessage?.threadId || message.replyTo?.threadId || message.topicId || 0) || null,
      hasMedia: Boolean(message.media),
      mediaType: message.media?.type || null,
    }
  }
}
