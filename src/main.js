import { TelegramClient } from '@mtcute/web'
import './style.css'

const $ = (id) => document.getElementById(id)

let tg = null
let currentApiId = null
let currentApiHash = null

function status(id, text, ok = null) {
  const el = $(id)
  el.textContent = text
  el.className = 'status' + (ok === true ? ' ok' : ok === false ? ' error' : '')
}

function debug(value) {
  const el = $('debug')
  const text = typeof value === 'string' ? value : JSON.stringify(value, replacer, 2)
  el.textContent = `${el.textContent}${el.textContent ? '\n' : ''}${text}`
}

function replacer(_k, v) {
  return typeof v === 'bigint' ? v.toString() : v
}

function createClient() {
  const apiId = Number.parseInt($('apiId').value, 10)
  const apiHash = $('apiHash').value.trim()

  if (!Number.isInteger(apiId) || !apiHash) {
    throw new Error('api_id / api_hash manquants.')
  }

  // IndexedDB natif via @mtcute/web.
  // Le nom est stable : la session survit aux rechargements de la PWA.
  if (!tg || apiId !== currentApiId || apiHash !== currentApiHash) {
    tg = new TelegramClient({
      apiId,
      apiHash,
      storage: 'mamina-telegram-user',
      logLevel: 3,
    })
    currentApiId = apiId
    currentApiHash = apiHash
  }

  return tg
}

async function ensureLogin() {
  const client = createClient()

  status('loginStatus', 'Connexion à Telegram…')

  const self = await client.start({
    phone: async () => {
      const v = prompt('Numéro Telegram au format international, ex. +336…')
      if (!v) throw new Error('Numéro annulé.')
      return v.trim()
    },
    code: async () => {
      const v = prompt('Code reçu dans Telegram')
      if (!v) throw new Error('Code annulé.')
      return v.trim()
    },
    password: async () => {
      const v = prompt('Mot de passe 2FA Telegram')
      if (v === null) throw new Error('Mot de passe annulé.')
      return v
    },
  })

  status(
    'loginStatus',
    `Connecté : ${self.displayName || ''}${self.username ? ` (@${self.username})` : ''}\nSession : IndexedDB locale`,
    true,
  )

  return client
}

$('connect').addEventListener('click', async () => {
  try {
    await ensureLogin()
  } catch (e) {
    console.error(e)
    debug(e?.stack || e?.message || String(e))
    status('loginStatus', `Erreur : ${e?.message || e}`, false)
  }
})

$('logout').addEventListener('click', async () => {
  try {
    if (!tg) tg = createClient()
    await tg.logOut()
    tg = null
    status('loginStatus', 'Session Telegram révoquée pour cette PWA.', true)
  } catch (e) {
    console.error(e)
    debug(e?.stack || e?.message || String(e))
    status('loginStatus', `Erreur logout : ${e?.message || e}`, false)
  }
})

function msgText(m) {
  return m?.text ?? m?.caption ?? m?.message ?? ''
}

function senderName(m) {
  const s = m?.sender
  return s?.displayName || s?.username || s?.firstName || ''
}

function topicOf(m) {
  // Propriétés haut niveau mtcute selon le type de message.
  return (
    m?.threadId ??
    m?.topicId ??
    m?.replyToMessage?.threadId ??
    null
  )
}

async function directParent(client, message) {
  // API haut niveau mtcute : fiable même si le parent n'est pas dans les 20 messages.
  try {
    const parent = await client.getReplyTo(message)
    return parent || null
  } catch (e) {
    debug(`getReplyTo(${message.id}) : ${e?.message || e}`)
    return null
  }
}

async function buildRows(client, messages) {
  const byId = new Map(messages.map((m) => [Number(m.id), m]))
  const parentCache = new Map()

  async function getParent(m) {
    const id = Number(m.id)
    if (parentCache.has(id)) return parentCache.get(id)

    const p = await directParent(client, m)
    parentCache.set(id, p)

    if (p && !byId.has(Number(p.id))) {
      byId.set(Number(p.id), p)
    }

    return p
  }

  async function rootOf(m) {
    let cur = m
    const seen = new Set()

    for (let depth = 0; depth < 32; depth++) {
      const id = Number(cur.id)

      if (seen.has(id)) {
        return { root: cur, cycle: true }
      }
      seen.add(id)

      const parent = await getParent(cur)
      if (!parent) return { root: cur, cycle: false }

      cur = parent
    }

    return { root: cur, cycle: true }
  }

  const rows = []

  // Séquentiel volontairement : petit lot de 20 et beaucoup plus lisible pour le diagnostic.
  for (const m of messages) {
    const parent = await getParent(m)
    const { root, cycle } = await rootOf(m)

    rows.push({
      message: m,
      id: Number(m.id),
      parentId: parent ? Number(parent.id) : null,
      rootId: Number(root.id),
      topicId: topicOf(m),
      cycle,
    })
  }

  return rows
}

function render(rows) {
  const container = $('threads')
  container.innerHTML = ''

  const groups = new Map()
  for (const row of rows) {
    if (!groups.has(row.rootId)) groups.set(row.rootId, [])
    groups.get(row.rootId).push(row)
  }

  const ordered = [...groups.entries()].sort((a, b) => a[0] - b[0])

  for (const [rootId, group] of ordered) {
    const block = document.createElement('article')
    block.className = 'thread'

    const heading = document.createElement('h3')
    heading.textContent = `File ${rootId} — ${group.length} message(s) dans la fenêtre`
    block.appendChild(heading)

    for (const row of group.sort((a, b) => a.id - b.id)) {
      const card = document.createElement('div')
      card.className = 'message' + (row.id === rootId ? ' root' : '')

      const badges = [
        `msg ${row.id}`,
        row.parentId ? `parent ${row.parentId}` : 'sans parent',
        `racine ${row.rootId}`,
        row.topicId ? `topic ${row.topicId}` : null,
      ].filter(Boolean)

      card.innerHTML = `
        <div class="badges">${badges.map((x) => `<span>${escapeHtml(x)}</span>`).join('')}</div>
        <div class="author">${escapeHtml(senderName(row.message))}</div>
        <div class="text">${escapeHtml(msgText(row.message) || '[média / service / texte vide]')}</div>
      `
      block.appendChild(card)
    }

    container.appendChild(block)
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

$('read').addEventListener('click', async () => {
  try {
    const client = await ensureLogin()
    const chatId = $('chatId').value.trim()
    if (!chatId) throw new Error('ID du groupe manquant.')

    status('readStatus', 'Lecture de l’historique…')

    // getHistory est l'API user prévue pour l'historique.
    const history = await client.getHistory(chatId, { limit: 20 })
    const messages = Array.from(history)

    status('readStatus', `${messages.length} message(s) lus. Reconstruction des parents…`)

    const rows = await buildRows(client, messages)

    render(rows)

    status(
      'readStatus',
      `${messages.length} message(s) lus et ${new Set(rows.map((r) => r.rootId)).size} file(s) reconstruite(s).`,
      true,
    )

    debug(
      rows.map((r) => ({
        id: r.id,
        parentId: r.parentId,
        rootId: r.rootId,
        topicId: r.topicId,
        text: msgText(r.message).slice(0, 80),
      })),
    )
  } catch (e) {
    console.error(e)
    debug(e?.stack || e?.message || String(e))
    status('readStatus', `Erreur : ${e?.message || e}`, false)
  }
})
