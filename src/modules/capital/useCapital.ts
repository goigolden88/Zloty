/**
 * Снимки и заметки из базы — единственное место модуля, которое ходит в `db`
 * (02-Архитектура, «Структура кода»). Расчёт — чистыми функциями рядом.
 *
 * Читается всё, включая надгробия: строка снимка правит снимок той же даты
 * надгробием (`row.ts`), и ей нужно видеть, что уже записано. Снимков —
 * сотня в год, читать целиком дёшево. Образец — `useDebts`.
 */

import { useEffect, useState } from 'react'
import { db } from '../../app/core.ts'
import type { Balance, Note } from '../../app/model.ts'

const STORES = ['balances', 'notes'] as const

export type CapitalRecords = { balances: Balance[]; notes: Note[] }

export type CapitalState = {
  status: 'loading' | 'ready' | 'failed'
  error: string
  data: CapitalRecords
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'Неизвестная ошибка'
}

/** Перечитывается на любую запись в снимки и заметки — своей рукой или синхронизацией. */
export function useCapital(): CapitalState {
  const [state, setState] = useState<CapitalState>({ status: 'loading', error: '', data: { balances: [], notes: [] } })

  useEffect(() => {
    let alive = true

    async function load() {
      try {
        await db.ready()
        const [balances, notes] = await Promise.all([
          db.getAll('balances', { includeDeleted: true }),
          db.getAll('notes', { includeDeleted: true }),
        ])
        if (alive) setState({ status: 'ready', error: '', data: { balances, notes } })
      } catch (failure) {
        if (alive) setState((was) => ({ ...was, status: 'failed', error: describe(failure) }))
      }
    }

    void load()
    const off = db.onChange((event) => {
      if ((STORES as readonly string[]).includes(event.store)) void load()
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return state
}
