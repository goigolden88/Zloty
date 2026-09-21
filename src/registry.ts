/**
 * Реестр видов записей (02-Архитектура, «Структура кода»).
 *
 * Таблица, а не механизм: на каждый вид записи — подпись и разделы импорта.
 * Сами функции живут в модулях, здесь они только сведены. Одно из немногих
 * мест, которые знают все модули разом, — вместе с `app.tsx`, `notify.ts`
 * и `screens/`. Модули друг про друга не знают.
 *
 * Растёт по этапам: сейчас — подпись, импорт, строки ленты и markdown;
 * долги и капитал придут своими этапами.
 *
 * Отдельного экрана ленты у «Злотых» нет (Р-15): строками ищут внутри
 * «Операций». Строки всё равно собираются здесь — это договор семьи,
 * и когда появятся долги и снимки, они лягут в тот же список.
 *
 * Образец — `registry.ts` «Трапезы» (её Р-53). Своё здесь — замена итога
 * периода операциями: единственное место, где импорт не только добавляет
 * (Р-02).
 */

import type { Snapshot } from './shared/core/db.ts'
import type { DateStr, Period } from './shared/core/dates.ts'
import type { FeedItem } from './shared/core/feed.ts'
import { mergeResults, type ImportContext, type ImportPlan, type ImportSpec } from './shared/core/importing.ts'
import { importing } from './app/core.ts'
import type { StoreRecord } from './app/model.ts'
import { lastDayOn } from './modules/ledger/entries.ts'
import { entryFeed, entryMarkdown, ENTRY_KIND, type FeedData } from './modules/ledger/feed.ts'
import {
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
  for (const section of LEDGER) {
    if (!(section.spec.section in sections)) continue
    const result = section.run(sections[section.spec.section], ledgerData(current), ctx)
    results.push(result)
    current = withWrites(current, result)
  }

  // Разделы, которых нет: молчать о них нельзя — человек мог написать
  // «operations» вместо «entries» и не понять, почему ничего не загрузилось.
  // Сверка разбирается не здесь, а после записей: ей нужно то, что они дали.
  const known = new Set([...LEDGER.map((section) => section.spec.section), checksImportSpec.section])
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
  const { kept, issues: refused } = applyChecks(checks, incoming, ledger)

  return {
    ...plan,
    writes: { ...plan.writes, entries: kept },
    added: plan.added.map((each) =>
      each.forms === ENTRY_FORMS ? { ...each, count: each.count - (incoming.length - kept.length) } : each,
    ).filter((each) => each.count > 0),
    issues: [...plan.issues, ...issues, ...refused],
  }
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
