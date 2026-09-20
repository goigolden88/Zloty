/**
 * Записи учёта из базы.
 *
 * Отдельно от `useLedger`: справочников десятки, а записей — около 250
 * в месяц (Р-12), и за год их тысячи. Экран, которому нужны только счета,
 * их читать не должен.
 *
 * Читается всё хранилище целиком и фильтруется в памяти: ядро заводит
 * индекс `entries.date`, но выборок по нему не даёт (Журнал 20.09.2026).
 * Для года истории это дёшево; когда станет дорого — это и будет поводом
 * к правке ядра, а не `as` здесь.
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
