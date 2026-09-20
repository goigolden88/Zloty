/**
 * Реестр видов записей (02-Архитектура, «Структура кода»).
 *
 * Таблица, а не механизм: на каждый вид записи — подпись и разделы импорта.
 * Сами функции живут в модулях, здесь они только сведены. Одно из немногих
 * мест, которые знают все модули разом, — вместе с `app.tsx`, `notify.ts`
 * и `screens/`. Модули друг про друга не знают.
 *
 * Растёт по этапам: сейчас — подпись и импорт; лента и markdown придут
 * вместе со своим пунктом Этапа 1, долги и капитал — своими этапами.
 *
 * Образец — `registry.ts` «Трапезы» (её Р-53). Своё здесь — замена итога
 * периода операциями: единственное место, где импорт не только добавляет
 * (Р-02).
 */

import type { Snapshot } from './shared/core/db.ts'
import type { DateStr } from './shared/core/dates.ts'
import { mergeResults, type ImportContext, type ImportPlan, type ImportSpec } from './shared/core/importing.ts'
import { importing } from './app/core.ts'
import type { StoreRecord } from './app/model.ts'
import { lastDayOn } from './modules/ledger/entries.ts'
import {
  accountsImportSpec,
  categoriesImportSpec,
  currenciesImportSpec,
  entriesImportSpec,
  importAccounts,
  importCategories,
  importCurrencies,
  importEntries,
  importRates,
  ledgerSpecs,
  ratesImportSpec,
  replacedTotals,
  type LedgerImportData,
} from './modules/ledger/import.ts'

/** Все синхронизируемые хранилища вместе с надгробиями — слепок базы. */
export type Data = Snapshot<StoreRecord>['data']

type Plan = ImportPlan<StoreRecord>

type Section = { spec: ImportSpec; run: (raw: unknown, data: LedgerImportData, ctx: ImportContext) => Plan }

/**
 * Разделы учёта по порядку разбора: справочники раньше записей, которые на
 * них ссылаются. Порядок здесь, а не в файле импорта: файл пишет беседа,
 * и полагаться на порядок ключей в нём нельзя.
 */
const LEDGER: readonly Section[] = [
  { spec: currenciesImportSpec, run: importCurrencies },
  { spec: accountsImportSpec, run: importAccounts },
  { spec: categoriesImportSpec, run: importCategories },
  { spec: ratesImportSpec, run: importRates },
  { spec: entriesImportSpec, run: importEntries },
]

/** Что разделам учёта нужно из слепка базы. */
function ledgerData(data: Data): LedgerImportData {
  return {
    currencies: data.currencies,
    accounts: data.accounts,
    categories: data.categories,
    recurring: data.recurring,
    entries: data.entries,
    rates: data.rates,
  }
}

/**
 * База вместе с тем, что завёл предыдущий раздел: категория, заведённая
 * разделом `categories`, видна разделу `entries` в том же файле.
 */
function withWrites(data: Data, plan: Plan): Data {
  const next = { ...data } as Record<string, { id: string }[]>
  for (const [store, records] of Object.entries(plan.writes)) {
    if (!records || records.length === 0) continue
    const ids = new Set(records.map((record) => record.id))
    next[store] = [...(next[store] ?? []).filter((record) => !ids.has(record.id)), ...records]
  }
  return next as unknown as Data
}

/**
 * План импорта: что добавится, что уже есть, что не разобрано. В базу
 * не пишет — сначала сводка, запись по кнопке. Кидает, если файл не тот.
 */
export function planImport(text: string, data: Data, ctx: ImportContext): Plan {
  const sections = importing.readImportFile(text)
  const results: Plan[] = []

  let current = data
  for (const section of LEDGER) {
    if (!(section.spec.section in sections)) continue
    const result = section.run(sections[section.spec.section], ledgerData(current), ctx)
    results.push(result)
    current = withWrites(current, result)
  }

  // Разделы, которых нет: молчать о них нельзя — человек мог написать
  // «operations» вместо «entries» и не понять, почему ничего не загрузилось.
  const known = new Set(LEDGER.map((section) => section.spec.section))
  for (const section of Object.keys(sections)) {
    if (known.has(section)) continue
    results.push({
      writes: {},
      added: [],
      skipped: 0,
      issues: [{ section, title: `раздел «${section}»`, reason: 'такого раздела нет — пропущен целиком' }],
    })
  }

  const plan = mergeResults(results)
  return withReplacedTotals(plan, data, ctx.now)
}

/**
 * Итоги периодов, которые заменяют пришедшие операции (Р-02).
 *
 * Единственное место, где импорт не только добавляет: операции подробнее
 * итога, и держать оба — считать расход дважды. Итог уходит надгробием,
 * а разница называется в сводке, а не проглатывается.
 */
function withReplacedTotals(plan: Plan, data: Data, now: string): Plan {
  const incoming = plan.writes.entries ?? []
  if (incoming.length === 0) return plan

  const { tombstones, notes } = replacedTotals(ledgerData(data), incoming, now)
  if (tombstones.length === 0) return plan

  return {
    ...plan,
    writes: { ...plan.writes, entries: [...incoming, ...tombstones] },
    issues: [
      ...plan.issues,
      ...notes.map((reason) => ({ section: entriesImportSpec.section, title: 'итог периода', reason })),
    ],
  }
}

/**
 * Промпт для беседы. Разделы собираются со справочниками внутри: беседа
 * обязана знать мои счета, категории и то, по какой день уже загружено
 * (Р-12, пп. 5, 8).
 */
export function importPrompt(data: Data, day: DateStr): string {
  const ledger = ledgerData(data)
  const lastDays = new Map(data.accounts.map((account) => [account.id, lastDayOn(data.entries, account.id)]))
  return importing.buildPrompt(ledgerSpecs(ledger, lastDays), day)
}
