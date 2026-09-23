/**
 * Реестр видов записей (02-Архитектура, «Структура кода»).
 *
 * Таблица, а не механизм: на каждый вид записи — подпись и разделы импорта.
 * Сами функции живут в модулях, здесь они только сведены. Одно из немногих
 * мест, которые знают все модули разом, — вместе с `app.tsx`, `notify.ts`
 * и `screens/`. Модули друг про друга не знают.
 *
 * Растёт по этапам: подпись, импорт учёта и капитала, строки ленты и markdown.
 *
 * Отдельного экрана ленты у «Злотых» нет (Р-15): строками ищут внутри
 * «Операций». Строки всё равно собираются здесь — это договор семьи,
 * и когда появятся долги и снимки, они лягут в тот же список.
 *
 * Образец — `registry.ts` «Трапезы» (её Р-53). Своё здесь — два места, где
 * импорт не только добавляет: итог периода, заменённый операциями, уходит
 * надгробием (Р-02), а сошедшаяся сверка правит счёт отметкой `loadedThrough`
 * (Р-26). Оба названы в сводке своим словом — `removed` и `changed` (Я-07 ядра).
 */

import type { Snapshot } from './shared/core/db.ts'
import type { DateStr, Period } from './shared/core/dates.ts'
import type { FeedItem } from './shared/core/feed.ts'
import { mergeResults, type ImportContext, type ImportPlan, type ImportSpec } from './shared/core/importing.ts'
import { importing } from './app/core.ts'
import type { StoreRecord } from './app/model.ts'
import {
  balancesImportSpec,
  capitalSpecs,
  importBalances,
  importNotes,
  notesImportSpec,
  type CapitalImportData,
} from './modules/capital/import.ts'
import { lastDayOn } from './modules/ledger/entries.ts'
import { entryFeed, entryMarkdown, ENTRY_KIND, type FeedData } from './modules/ledger/feed.ts'
import {
  ACCOUNT_FORMS,
  accountsImportSpec,
  applyChecks,
  categoriesImportSpec,
  checksImportSpec,
  currenciesImportSpec,
  ENTRY_FORMS,
  entriesImportSpec,
  importAccounts,
  importChecks,
  importCategories,
  importCurrencies,
  importEntries,
  importRates,
  ledgerSpecs,
  loadedThroughUpdates,
  ratesImportSpec,
  replacedTotals,
  TOTAL_FORMS,
  type LedgerImportData,
} from './modules/ledger/import.ts'

/** Все синхронизируемые хранилища вместе с надгробиями — слепок базы. */
export type Data = Snapshot<StoreRecord>['data']

type Plan = ImportPlan<StoreRecord>

/** Раздел импорта: получает слепок базы и сам берёт из него то, что знает его модуль. */
type Section = { spec: ImportSpec; run: (raw: unknown, data: Data, ctx: ImportContext) => Plan }

/**
 * Разделы по порядку разбора: справочники раньше записей, которые на них
 * ссылаются; снимки — после счетов, которые может завести тот же файл.
 * Порядок здесь, а не в файле импорта: файл пишет беседа, и полагаться на
 * порядок ключей в нём нельзя.
 */
const SECTIONS: readonly Section[] = [
  { spec: currenciesImportSpec, run: (raw, data, ctx) => importCurrencies(raw, ledgerData(data), ctx) },
  { spec: accountsImportSpec, run: (raw, data, ctx) => importAccounts(raw, ledgerData(data), ctx) },
  { spec: categoriesImportSpec, run: (raw, data, ctx) => importCategories(raw, ledgerData(data), ctx) },
  { spec: ratesImportSpec, run: (raw, data, ctx) => importRates(raw, ledgerData(data), ctx) },
  { spec: entriesImportSpec, run: (raw, data, ctx) => importEntries(raw, ledgerData(data), ctx) },
  { spec: balancesImportSpec, run: (raw, data, ctx) => importBalances(raw, capitalData(data), ctx) },
  { spec: notesImportSpec, run: (raw, data, ctx) => importNotes(raw, capitalData(data), ctx) },
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

/** Что разделам капитала нужно из слепка базы. */
function capitalData(data: Data): CapitalImportData {
  return {
    currencies: data.currencies,
    accounts: data.accounts,
    balances: data.balances,
    notes: data.notes,
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

/** Что нужно строкам ленты из слепка базы. */
function feedData(data: Data): FeedData {
  return {
    entries: data.entries,
    accounts: data.accounts,
    categories: data.categories,
    currencies: data.currencies,
  }
}

/** Подпись вида записи. Незнакомый вид подписывается как есть. */
export function kindLabel(kind: string): string {
  return kind === ENTRY_KIND ? 'Учёт' : kind
}

/**
 * Все строки ленты, без порядка: порядок — дело `shared/core/feed.ts`.
 *
 * Вид пока один. Долги и снимки капитала добавят сюда свои строки,
 * и поиск станет общим, не меняя ни одного экрана.
 */
export function feedItems(data: Data): FeedItem[] {
  return entryFeed(feedData(data))
}

/**
 * Выгрузка в markdown — читать глазами, а не переносить: обратно файл
 * не загружается, для переноса есть копия в JSON.
 */
export function markdownExport(data: Data, day: DateStr, span: { period: Period; label: string } | null): string {
  const head = [
    '# Злотые',
    '',
    `Выгрузка от ${day}. Для чтения: обратно в приложение этот файл не загружается,`,
    'для переноса данных есть копия в JSON — «Настройки» → «Копия данных».',
  ]
  if (span) head.push('', `Период: ${span.label}.`)

  return `${head.join('\n')}\n\n## Учёт\n\n${entryMarkdown(feedData(data), span?.period ?? null)}\n`
}

/**
 * План импорта: что добавится, что уже есть, что не разобрано. В базу
 * не пишет — сначала сводка, запись по кнопке. Кидает, если файл не тот.
 */
export function planImport(text: string, data: Data, ctx: ImportContext): Plan {
  const sections = importing.readImportFile(text)
  const results: Plan[] = []

  let current = data
  for (const section of SECTIONS) {
    if (!(section.spec.section in sections)) continue
    const result = section.run(sections[section.spec.section], current, ctx)
    results.push(result)
    current = withWrites(current, result)
  }

  // Разделы, которых нет: молчать о них нельзя — человек мог написать
  // «operations» вместо «entries» и не понять, почему ничего не загрузилось.
  // Сверка разбирается не здесь, а после записей: ей нужно то, что они дали.
  const known = new Set([...SECTIONS.map((section) => section.spec.section), checksImportSpec.section])
  for (const section of Object.keys(sections)) {
    if (known.has(section)) continue
    results.push({
      writes: {},
      added: [],
      skipped: 0,
      issues: [{ section, title: `раздел «${section}»`, reason: 'такого раздела нет — пропущен целиком' }],
    })
  }

  // Справочники — те, что вышли из разбора: счёт мог завестись этим же
  // файлом, и сверка обязана знать его название, а не показывать id.
  // Записи — те, что были до разбора: новые придут отдельно, в `incoming`,
  // и взятые отсюда же посчитались бы дважды.
  const forChecks = { ...ledgerData(current), entries: ledgerData(data).entries }
  const plan = withChecks(mergeResults(results), sections[checksImportSpec.section], forChecks)
  return withReplacedTotals(plan, data, ctx.now)
}

/**
 * Сверка выписки (Р-16): счёт, чьи числа не сошлись с тем, что говорит о себе
 * сама выписка, записей не получает. Идёт до замены итогов периодов — иначе
 * итог заменили бы операции, которые в базу не попадут.
 */
function withChecks(plan: Plan, raw: unknown, ledger: LedgerImportData): Plan {
  const incoming = plan.writes.entries ?? []
  if (incoming.length === 0) return plan

  const { checks, issues } = importChecks(raw ?? [], ledger)
  const { kept, issues: refused, loaded } = applyChecks(checks, incoming, ledger)

  // Сошедшаяся сверка — единственное место, где известно, по какое число
  // доведена выписка счёта (Р-26). Отметка ложится на счёт, в том числе
  // на заведённый этим же файлом.
  const pending = plan.writes.accounts ?? []
  const marked = loadedThroughUpdates(loaded, ledger, pending)
  const accounts = [
    ...pending.filter((each) => !marked.some((mark) => mark.id === each.id)),
    ...marked,
  ]
  // Правка — только у счёта, который уже лежит в базе. Заведённый этим же
  // файлом — новый, и сводка уже назвала его в «Добавится».
  const edited = marked.filter((each) => !pending.some((fresh) => fresh.id === each.id)).length

  return {
    ...plan,
    writes: { ...plan.writes, entries: kept, ...(accounts.length > 0 ? { accounts } : {}) },
    added: plan.added.map((each) =>
      each.forms === ENTRY_FORMS ? { ...each, count: each.count - (incoming.length - kept.length) } : each,
    ).filter((each) => each.count > 0),
    issues: [...plan.issues, ...issues, ...refused],
    changed: [...(plan.changed ?? []), { count: edited, forms: ACCOUNT_FORMS }].filter((each) => each.count > 0),
  }
}

/**
 * Итоги периодов, которые заменяют пришедшие операции (Р-02).
 *
 * Операции подробнее итога, и держать оба — считать расход дважды. Итог
 * уходит надгробием и считается в «Удалится», а разница называется
 * заметкой: запись загрузится, отказа здесь нет (Я-07 ядра).
 */
function withReplacedTotals(plan: Plan, data: Data, now: string): Plan {
  const incoming = plan.writes.entries ?? []
  if (incoming.length === 0) return plan

  const { tombstones, notes } = replacedTotals(ledgerData(data), incoming, now)
  if (tombstones.length === 0) return plan

  return {
    ...plan,
    writes: { ...plan.writes, entries: [...incoming, ...tombstones] },
    removed: [...(plan.removed ?? []), { count: tombstones.length, forms: TOTAL_FORMS }],
    notes: [
      ...(plan.notes ?? []),
      ...notes.map((text) => ({ section: entriesImportSpec.section, title: 'итог периода', text })),
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
  return importing.buildPrompt([...ledgerSpecs(ledger, lastDays), ...capitalSpecs(data)], day)
}
