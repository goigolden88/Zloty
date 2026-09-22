/**
 * Записи долгов из базы — единственное место модуля, которое ходит в `db`
 * (02-Архитектура, «Структура кода»). Расчёт — чистыми функциями рядом.
 *
 * Читается всё, включая надгробия: ядро заводит индексы, но выборок по ним
 * не даёт, а записей у долгов сотни за год — не тысячи, как у операций.
 * Образец — `useLedger` учёта.
 */

import { useEffect, useState } from 'react'
import { db } from '../../app/core.ts'
import type { DebtsData } from './summary.ts'

const STORES = ['people', 'rooms', 'roomEvents', 'roomSpends', 'roomTransfers', 'loans', 'repayments'] as const

export type Debts = {
  status: 'loading' | 'ready' | 'failed'
  error: string
  data: DebtsData
}

const EMPTY: DebtsData = {
  people: [],
  rooms: [],
  roomEvents: [],
  roomSpends: [],
  roomTransfers: [],
  loans: [],
  repayments: [],
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'Неизвестная ошибка'
}

async function readAll(): Promise<DebtsData> {
  await db.ready()
  const [people, rooms, roomEvents, roomSpends, roomTransfers, loans, repayments] = await Promise.all([
    db.getAll('people', { includeDeleted: true }),
    db.getAll('rooms', { includeDeleted: true }),
    db.getAll('roomEvents', { includeDeleted: true }),
    db.getAll('roomSpends', { includeDeleted: true }),
    db.getAll('roomTransfers', { includeDeleted: true }),
    db.getAll('loans', { includeDeleted: true }),
    db.getAll('repayments', { includeDeleted: true }),
  ])
  return { people, rooms, roomEvents, roomSpends, roomTransfers, loans, repayments }
}

/** Перечитывается на любую запись в долги — своей рукой или синхронизацией. */
export function useDebts(): Debts {
  const [state, setState] = useState<Debts>({ status: 'loading', error: '', data: EMPTY })

  useEffect(() => {
    let alive = true

    async function load() {
      try {
        const data = await readAll()
        if (alive) setState({ status: 'ready', error: '', data })
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
