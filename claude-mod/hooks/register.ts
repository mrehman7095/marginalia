import type { EngineInterface, Register } from 'claude-code'

// The extension posts here; only the session that ran /marginalia holds the port.
const PORT = 47321
const INBOX = 'mcp__marginalia__inbox'
const RESOLVE = 'mcp__marginalia__resolve'

export type InboxNote = {
  kind?: 'note' | 'drawing'
  id: string
  number: number
  status?: string
  session: string
  md: string
  image: string | null
}

export function contextBlock(notes: InboxNote[]): string {
  const body = notes
    .sort((a, b) => a.number - b.number)
    .map((n) =>
      [
        n.md.trim(),
        n.kind === 'drawing' ? null : `- note id: ${n.id}`,
        n.image ? `- annotated screenshot: ${n.image} (Read it to see the page)` : '- no screenshot',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n')
  return [
    '<marginalia-notes>',
    `The user annotated ${notes.length} UI issue(s) in the browser with the Marginalia extension since their last prompt.`,
    'Numbers in the screenshots match the note numbers. Boxes are viewport CSS pixels.',
    'When you have fixed a note, call the marginalia resolve tool with its note id so its pin turns resolved in the browser.',
    '',
    body,
    '</marginalia-notes>',
  ].join('\n')
}

// Follows the workspace rule for bug reports: diagnose and propose, edit only on a go-ahead.
export function autoPrompt(notes: InboxNote[]): string {
  return [
    contextBlock(notes),
    '',
    'For each note: Read its screenshot, find the code that renders it, and give the cause and a proposed fix.',
    'Do not edit files yet; wait for the user to approve. Skip drawings unless they explain a note.',
  ].join('\n')
}

export function statusText(listening: boolean, auto: boolean, pending: number): string | undefined {
  if (!listening) return undefined
  if (pending) return `marginalia: ${pending} new note${pending === 1 ? '' : 's'}${auto ? ', starting Claude' : ''}`
  return auto ? 'marginalia: listening (auto)' : 'marginalia: listening (quiet)'
}

// Notes saved within this window of each other go to Claude as one turn.
const BATCH_MS = 8_000

let listening = false
let auto = true
let ownRelease = false
let batchTimer: { cancel: () => void } | undefined
const pending = new Map<string, InboxNote>()

async function refresh($: EngineInterface) {
  await $.ui.status(statusText(listening, auto, pending.size))
}

async function submitPending($: EngineInterface) {
  batchTimer = undefined
  if (!auto || !pending.size) return
  const notes = [...pending.values()]
  pending.clear()
  await refresh($)
  await $.prompt.submit({ text: autoPrompt(notes) })
}

async function postBridge($: EngineInterface, path: string, body?: unknown) {
  const argv = ['curl', '-s', '-m', '3', '-X', 'POST', '-H', 'Origin: chrome-extension://claude-code']
  if (body !== undefined) argv.push('-H', 'content-type: application/json', '--data-binary', JSON.stringify(body))
  return $.process.run([...argv, `http://127.0.0.1:${PORT}${path}`], { timeoutMs: 5_000 })
}

async function release($: EngineInterface) {
  await postBridge($, '/release')
}

// Resolves with the bridge's first event ('listening' or why not); the loop then runs for the session's life.
function startBridge($: EngineInterface, inbox: string): Promise<string> {
  return new Promise(resolve => {
    void (async () => {
      let buffer = ''
      let first = true
      try {
        const child = $.process.spawn({ argv: ['node', `${$.plugin.root}/bridge/server.mjs`, String(PORT), inbox] })
        for await (const chunk of child) {
          if (chunk.stream !== 'stdout') continue
          buffer += chunk.text
          let nl: number
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl)
            buffer = buffer.slice(nl + 1)
            let ev: any
            try {
              ev = JSON.parse(line)
            } catch {
              continue
            }
            if (first) {
              first = false
              resolve(ev.type)
            }
            if (ev.type === 'listening') listening = true
            else if (ev.type === 'note') {
              pending.set(ev.id, ev)
              await $.ui.toast(ev.kind === 'drawing' ? 'Marginalia drawing received' : `Marginalia note ${ev.number} received`)
              if (auto) {
                batchTimer?.cancel()
                batchTimer = await $.clock.after(BATCH_MS, () => submitPending($))
              }
            } else if (ev.type === 'released') {
              listening = false
              if (!ownRelease) await $.ui.toast('Marginalia moved to another Claude session')
              ownRelease = false
            }
            await refresh($)
          }
        }
      } catch (err) {
        if (first) resolve(`error: ${String(err)}`)
      }
      if (first) resolve('exited')
      listening = false
      await refresh($)
    })()
  })
}

async function listen($: EngineInterface): Promise<string> {
  // Restart even when already listening, so an edited receiver script takes effect.
  if (listening) {
    ownRelease = true
    await release($)
    await $.clock.sleep(300)
  }
  const inbox = `${await $.env.get('HOME')}/.claude/marginalia-inbox`
  let result = await startBridge($, inbox)
  if (result === 'busy') {
    await release($)
    await $.clock.sleep(300)
    result = await startBridge($, inbox)
  }
  if (result !== 'listening') return `Could not start the Marginalia receiver: ${result}.`
  const how = auto
    ? `Claude starts on its own ${BATCH_MS / 1000} s after your last note (/marginalia quiet to wait for your prompt instead).`
    : 'Notes wait and go along with your next prompt (/marginalia auto to start Claude on its own).'
  return `This session receives Marginalia notes on 127.0.0.1:${PORT}; other Claude sessions get nothing. ${how}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'marginalia',
      description: 'Receive Marginalia browser notes in this session; auto starts Claude, quiet waits for your prompt',
      argumentHint: '[auto|quiet|stop]',
    })
    await $.tool.register({
      name: 'inbox',
      description:
        'Returns Marginalia browser notes the user annotated that have not reached you yet (text, element selector, annotated screenshot path), then clears them. Use when the user says to check their notes. Notes also arrive automatically with each user prompt.',
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'resolve',
      description:
        "Marks a Marginalia note resolved in the user's browser once you have fixed the issue it describes; its pin turns resolved within about 30 seconds. Use the note id from the notes block.",
      inputSchema: {
        type: 'object',
        properties: {
          noteId: { type: 'string', description: 'The note id from the Marginalia notes block.' },
          comment: { type: 'string', description: 'One line on what you changed; shown on the pin.' },
        },
        required: ['noteId'],
      },
    })
    return started
  })

  on('command.run', { command: 'marginalia' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'stop') {
      if (!listening) return { text: 'Marginalia is not listening in this session.' }
      batchTimer?.cancel()
      ownRelease = true
      await release($)
      return { text: 'Stopped receiving Marginalia notes.' }
    }
    if (arg === 'quiet' || arg === 'auto') {
      auto = arg === 'auto'
      if (!auto) batchTimer?.cancel()
      if (listening) {
        await refresh($)
        return { text: auto ? 'Claude now starts on its own when notes arrive.' : 'Notes now wait for your next prompt.' }
      }
    }
    return { text: await listen($) }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!pending.size) return next(e)
    const notes = [...pending.values()]
    pending.clear()
    await refresh($)
    await $.ui.toast(`Attached ${notes.length} Marginalia note${notes.length === 1 ? '' : 's'} to this prompt`)
    return next({ ...e, context: [...(e.context ?? []), contextBlock(notes)] })
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: RESOLVE }, async ($, e) => {
    if (!listening) return { result: 'Marginalia is not listening in this session, so the browser cannot be told. The user must run /marginalia first.' }
    const { noteId, comment } = e as unknown as { noteId: string; comment?: string }
    const r = await postBridge($, '/resolve', { noteId, comment: comment ?? '' })
    return { result: r.exitCode === 0 ? `Note ${noteId} marked resolved; the browser picks it up within about 30 seconds.` : `Could not reach the receiver: ${r.stderr.trim()}` }
  })

  on('tool.call', { tool: INBOX }, async $ => {
    if (!pending.size) {
      return { result: listening ? 'No new Marginalia notes.' : 'Marginalia is not listening in this session. The user must run /marginalia first.' }
    }
    const notes = [...pending.values()]
    pending.clear()
    await refresh($)
    return { result: contextBlock(notes) }
  })
}
