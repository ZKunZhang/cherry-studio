import { describe, expect, it, vi } from 'vitest'

import { commandSuggestion } from '../command'

const createEditorMock = () => {
  const run = vi.fn()
  const insertContent = vi.fn(() => ({ run }))
  const focus = vi.fn(() => ({ insertContent }))
  const chain = vi.fn(() => ({ focus }))

  return {
    editor: {
      chain
    },
    spies: { chain, focus, insertContent, run }
  }
}

describe('commandSuggestion.onKeyDown', () => {
  it('inserts newline when Shift+Enter is pressed', () => {
    const { editor, spies } = createEditorMock()
    const preventDefault = vi.fn()

    const handled = commandSuggestion.onKeyDown?.({
      event: {
        key: 'Enter',
        shiftKey: true,
        preventDefault
      },
      editor
    } as any) ?? false

    expect(handled).toBe(true)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(spies.chain).toHaveBeenCalledTimes(1)
    expect(spies.focus).toHaveBeenCalledTimes(1)
    expect(spies.insertContent).toHaveBeenCalledWith('\n')
    expect(spies.run).toHaveBeenCalledTimes(1)
  })

  it('ignores other keys', () => {
    const { editor, spies } = createEditorMock()
    const preventDefault = vi.fn()

    const handled = commandSuggestion.onKeyDown?.({
      event: {
        key: 'Enter',
        shiftKey: false,
        preventDefault
      },
      editor
    } as any) ?? false

    expect(handled).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(spies.chain).not.toHaveBeenCalled()
  })
})
