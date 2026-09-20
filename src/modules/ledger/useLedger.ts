/**
 * Справочники учёта из базы: валюты, счета, категории, настройки.
 *
 * Единственное место модуля, которое ходит в `db` (02-Архитектура,
 * «Структура кода»); расчёт — в `ledger.ts` и `profile.ts`, чистыми
 * функциями. Образец — `useFood` «Трапезы».
 *
 * **Операций здесь нет намеренно.** Справочников у человека десятки, а
 * операций — около 250 в месяц (Р-12), и за год это тысячи записей. Читать
 * их, чтобы нарисовать список счетов, незачем; месяц операций получит свой
 * хук, когда появится экран операций.
 *
 * Читается всё хранилище целиком, включая надгробия: ядро заводит индексы,
 * но выборок по ним не даёт (Журнал 20.09.2026, находка) — до правки ядра
 * это единственный способ, и для справочников он ничего не стоит.
 */

import { useEffect, useState } from 'react'
import { db } from '../../app/core.ts'
import type { Account, Category, Currency, Profile } from '../../app/model.ts'

const STORES = ['profile', 'currencies', 'accounts', 'categories'] as const

export type LedgerData = {
  profile: Profile[]
  currencies: Currency[]
  accounts: Account[]
  categories: Category[]
}

export type Ledger = {
  status: 'loading' | 'ready' | 'failed'
  error: string
  data: LedgerData
}

const EMPTY: LedgerData = { profile: [], currencies: [], accounts: [], categories: [] }

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'Неизвестная ошибка'
}

async function readAll(): Promise<LedgerData> {
  await db.ready()
  const [profile, currencies, accounts, categories] = await Promise.all([
    db.getAll('profile', { includeDeleted: true }),
    db.getAll('currencies', { includeDeleted: true }),
    db.getAll('accounts', { includeDeleted: true }),
    db.getAll('categories', { includeDeleted: true }),
  ])
  return { profile, currencies, accounts, categories }
}

/**
 * Справочники и настройки. Перечитываются на любую запись в них — своей
 * рукой, импортом, синхронизацией или восстановлением из копии.
 */
export function useLedger(): Ledger {
  const [state, setState] = useState<Ledger>({ status: 'loading', error: '', data: EMPTY })

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
