import { describe, expect, test } from 'claude-code/testing'
import { autoPrompt, contextBlock, statusText } from './register'

describe('contextBlock', () => {
  test('orders notes by number and points at each screenshot', () => {
    const text = contextBlock([
      { id: 'b', number: 4, session: 'QA', md: '### 4. [ux] [open]\n\n> Spacing', image: null },
      { id: 'a', number: 2, session: 'QA', md: '### 2. [bug] [open]\n\n> Overlap', image: '/inbox/qa-002.png' },
    ])
    expect(text.indexOf('### 2.')).toBeLessThan(text.indexOf('### 4.'))
    expect(text).toContain('annotated screenshot: /inbox/qa-002.png')
    expect(text).toContain('- no screenshot')
    expect(text).toContain('2 UI issue(s)')
  })
})

describe('statusText', () => {
  test('is empty while not listening', () => {
    expect(statusText(false, true, 3)).toBe(undefined)
  })
  test('counts pending notes', () => {
    expect(statusText(true, false, 0)).toBe('marginalia: listening (quiet)')
    expect(statusText(true, false, 1)).toBe('marginalia: 1 new note')
    expect(statusText(true, true, 3)).toBe('marginalia: 3 new notes, starting Claude')
  })
})

describe('contextBlock ids', () => {
  test('gives notes an id to resolve and leaves drawings without one', () => {
    const text = contextBlock([
      { kind: 'note', id: 'n-1', number: 1, session: 'QA', md: '### 1. [bug] [open]', image: null },
      { kind: 'drawing', id: 'd-1', number: 0, session: 'QA', md: '### Drawing on Visitors', image: '/inbox/d.png' },
    ])
    expect(text).toContain('- note id: n-1')
    expect(text).not.toContain('note id: d-1')
  })
})

describe('autoPrompt', () => {
  test('carries the notes and asks for a diagnosis before any edit', () => {
    const text = autoPrompt([{ kind: 'note', id: 'n-1', number: 1, session: 'QA', md: '### 1. [bug] [open]', image: null }])
    expect(text).toContain('- note id: n-1')
    expect(text).toContain('Do not edit files yet')
  })
})
