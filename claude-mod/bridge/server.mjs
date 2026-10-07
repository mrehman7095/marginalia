// Local receiver for the Marginalia extension. Prints one JSON line per event on stdout.
// Usage: node server.mjs <port> <inboxDir>
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const [port, inbox] = [Number(process.argv[2]), process.argv[3]]
const MAX_BODY = 25 * 1024 * 1024
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n')
const slug = (s) => String(s || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

mkdirSync(inbox, { recursive: true })

// Status changes Claude made, for the extension to pull. `boot` tells it the sequence restarted.
const boot = randomUUID()
const updates = []

const server = createServer((req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'GET' && req.url === '/ping') return reply(200, { ok: true, app: 'marginalia-bridge' })
  const url = new URL(req.url, 'http://bridge')
  // Chrome sends no Origin on an extension's GET. A web page can request this too but cannot
  // read the reply, since no CORS header allows it.
  if (req.method === 'GET' && url.pathname === '/updates') {
    const since = url.searchParams.get('boot') === boot ? Number(url.searchParams.get('since') || 0) : 0
    return reply(200, { ok: true, boot, seq: updates.length, updates: updates.slice(since) })
  }
  // Web pages can POST to localhost too; only the extension's own origin may feed Claude.
  if (!String(req.headers.origin || '').startsWith('chrome-extension://')) return reply(403, { ok: false, error: 'extension only' })
  if (req.method === 'POST' && req.url === '/release') {
    reply(200, { ok: true })
    emit({ type: 'released' })
    return setTimeout(() => process.exit(0), 50)
  }
  if (req.method !== 'POST' || !['/note', '/resolve'].includes(url.pathname)) return reply(404, { ok: false })

  let size = 0
  const chunks = []
  req.on('data', (c) => {
    size += c.length
    if (size > MAX_BODY) req.destroy()
    else chunks.push(c)
  })
  req.on('end', () => {
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return reply(400, { ok: false, error: 'bad json' })
    }
    if (url.pathname === '/resolve') {
      if (!body.noteId) return reply(400, { ok: false, error: 'noteId is required' })
      updates.push({ noteId: body.noteId, status: 'resolved', comment: body.comment || '' })
      return reply(200, { ok: true })
    }
    const { session, note, md } = body
    if (!note?.id || typeof md !== 'string') return reply(400, { ok: false, error: 'note.id and md are required' })
    let image = null
    if (body.png) {
      // The id keeps a later session's note 1 from overwriting this one.
      const label = `${body.kind === 'drawing' ? 'drawing' : String(note.number).padStart(3, '0')}-${String(note.id).slice(0, 8)}`
      image = join(inbox, `${slug(session?.name)}-${label}.png`)
      writeFileSync(image, Buffer.from(body.png, 'base64'))
    }
    emit({ type: 'note', kind: body.kind === 'drawing' ? 'drawing' : 'note', id: note.id, number: note.number ?? 0, status: note.status, session: session?.name ?? '', md, image })
    reply(200, { ok: true })
  })
})

server.on('error', (e) => {
  emit({ type: e.code === 'EADDRINUSE' ? 'busy' : 'error', message: String(e.message) })
  process.exit(3)
})
server.listen(port, '127.0.0.1', () => emit({ type: 'listening', port }))
