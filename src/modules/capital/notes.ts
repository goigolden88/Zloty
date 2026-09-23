/**
 * Заметки к капиталу на дату (Р-36).
 *
 * «Понятные только мне» — обычный текст: приложение его не читает и ничего
 * по нему не считает. Заметок на одну дату может быть несколько — перенос
 * листов кладёт по одной на лист.
 */

import type { Note } from '../../app/model.ts'
import { nowIso } from '../../shared/core/dates.ts'
import { ulid } from '../../shared/core/id.ts'

/** Живые заметки к капиталу на дату, в порядке заведения. */
export function notesOn(notes: readonly Note[], date: string): Note[] {
  return notes
    .filter((each) => !each.deleted && each.about === 'capital' && each.date === date)
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** Почему заметку нельзя записать; `null` — можно. */
export function noteProblem(text: string, date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'у заметки нет даты'
  if (!text.trim()) return 'заметка пустая'
  return null
}

export function createNote(date: string, text: string): Note {
  return { id: ulid(), updatedAt: nowIso(), about: 'capital', date, text: text.trim() }
}

export function updateNote(note: Note, text: string): Note {
  return { ...note, updatedAt: nowIso(), text: text.trim() }
}
