/**
 * Записи учёта из базы.
 *
 * Отдельно от `useLedger`: справочников десятки, а записей — около 250
 * в месяц (Р-12), и за год их тысячи. Экран, которому нужны только счета,
 * их читать не должен.
 *
 * Читается всё хранилище целиком, хотя ядро даёт выборку по индексу
 * `entries.date` (Я-08 ядра): всем читателям нужна вся история — поиску
 * «Операций», окну обычного месяца, долгам капитала на любую дату (Р-43).
 * И ловушка: итог периода хранит `period`, а не `date`, — в индекс даты
 * он не попадает, и выборка «месяц по индексу» молча потеряла бы историю
 * таблицы. Экран, которому нужна часть истории, — повод читать по индексу.
 */

import { useEffect, useState } from 'react'
import { db } from '../../app/core.ts'
import type { Entry } from '../../app/model.ts'

export type Entries = {
  status: 'loading' | 'ready' | 'failed'
  error: string
  /** С надгробиями: по ним видно, что удалено, и они же нужны слиянию. */
  all: Entry[]
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'Неизвестная ошибка'
}

export function useEntries(): Entries {
  const [state, setState] = useState<Entries>({ status: 'loading', error: '', all: [] })

  useEffect(() => {
    let alive = true

    async function load() {
      try {
        await db.ready()
        const all = await db.getAll('entries', { includeDeleted: true })
        if (alive) setState({ status: 'ready', error: '', all })
      } catch (failure) {
        if (alive) setState((was) => ({ ...was, status: 'failed', error: describe(failure) }))
      }
    }

    void load()
    const off = db.onChange((event) => {
      if (event.store === 'entries') void load()
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return state
}
