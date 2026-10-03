/**
 * Особые периоды трат из базы (Р-55).
 *
 * Отдельным хуком, как курсы: периоды нужны там, где расход делится
 * на обычный и особый, и в подписи операции — экрану счетов они ни к чему.
 * Надгробия не читаются: удалённый период трату особой не делает.
 */

import { useEffect, useState } from 'react'
import { db } from '../../app/core.ts'
import type { SpecialPeriod } from '../../app/model.ts'

export type Specials = {
  status: 'loading' | 'ready' | 'failed'
  error: string
  all: SpecialPeriod[]
}

export function useSpecials(): Specials {
  const [state, setState] = useState<Specials>({ status: 'loading', error: '', all: [] })

  useEffect(() => {
    let alive = true

    async function load() {
      try {
        await db.ready()
        const all = await db.getAll('specials')
        if (alive) setState({ status: 'ready', error: '', all })
      } catch (failure) {
        if (alive) {
          setState((was) => ({
            ...was,
            status: 'failed',
            error: failure instanceof Error ? failure.message : 'Неизвестная ошибка',
          }))
        }
      }
    }

    void load()
    const off = db.onChange((event) => {
      if (event.store === 'specials') void load()
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return state
}
