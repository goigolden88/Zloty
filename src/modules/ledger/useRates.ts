/**
 * Курсы валют из базы.
 *
 * Отдельным хуком, а не внутри `useLedger`: курсы нужны только там, где
 * считаются итоги в базовой валюте, — экрану со списком счетов они ни к чему.
 * Записей у курса немного: одна на дату и пару валют.
 */

import { useEffect, useState } from 'react'
import { db } from '../../app/core.ts'
import type { Rate } from '../../app/model.ts'

export type Rates = {
  status: 'loading' | 'ready' | 'failed'
  error: string
  all: Rate[]
}

export function useRates(): Rates {
  const [state, setState] = useState<Rates>({ status: 'loading', error: '', all: [] })

  useEffect(() => {
    let alive = true

    async function load() {
      try {
        await db.ready()
        const all = await db.getAll('rates')
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
      if (event.store === 'rates') void load()
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return state
}
