import { describe, expect, it } from 'vitest'
import type { Note } from '../../app/model.ts'
import { createNote, noteProblem, notesOn, updateNote } from './notes.ts'

/** Тексты выдуманы: код публичный (CLAUDE.md, «Личные данные»). */
const AT = '2026-09-20T10:00:00.000Z'
const note = (id: string, date: string, text: string, fields: Partial<Note> = {}): Note => ({
  id,
  updatedAt: AT,
  about: 'capital',
  date,
  text,
  ...fields,
})

describe('заметки к капиталу (Р-36)', () => {
  const list = [
    note('02', '2026-09-01', 'вторая'),
    note('01', '2026-09-01', 'первая'),
    note('03', '2026-08-01', 'чужая дата'),
    note('04', '2026-09-01', 'удалена', { deleted: true }),
  ]

  it('на дату — живые, в порядке заведения', () => {
    expect(notesOn(list, '2026-09-01').map((each) => each.text)).toEqual(['первая', 'вторая'])
  })

  it('пустая заметка и заметка без даты не пишутся', () => {
    expect(noteProblem('  ', '2026-09-01')).toBe('заметка пустая')
    expect(noteProblem('текст', '')).toBe('у заметки нет даты')
    expect(noteProblem('текст', '2026-09-01')).toBeNull()
  })

  it('заводится к капиталу, текст без лишних пробелов', () => {
    expect(createNote('2026-09-01', '  рынок просел ')).toMatchObject({ about: 'capital', date: '2026-09-01', text: 'рынок просел' })
  })

  it('правка меняет текст и время, но не id и дату', () => {
    const was = note('01', '2026-09-01', 'было')
    expect(updateNote(was, 'стало')).toMatchObject({ id: '01', date: '2026-09-01', text: 'стало' })
  })
})
