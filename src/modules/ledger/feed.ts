/**
 * Записи учёта строками ленты и markdown (План, Этап 1, п. 7).
 *
 * Лента — договор семьи: `FeedItem` приходит из ядра, а переводят свои
 * записи в строки сами модули (`shared/core/feed.ts`). Сводит их
 * `registry.ts`.
 *
 * **Отдельной вкладки «Лента» у «Злотых» нет** (Р-15): поиск живёт внутри
 * «Операций». Строки ленты от этого не лишние — ими же ищется по всей
 * истории, механикой ядра: слова запроса по отдельности, дата цифрами
 * и словами.
 *
 * В `extra` уходит то, чего на экране не видно, но по чему ищут: исходная
 * строка выписки и заметка. Найти списание по обрывку банковского описания —
 * ровно то, ради чего `bankText` и хранится (Р-12, п. 8).
 */

import { escapeMarkdown, type FeedItem } from '../../shared/core/feed.ts'
import { formatDate, formatMonth, type Period } from '../../shared/core/dates.ts'
import type { Account, Category, Currency, Entry } from '../../app/model.ts'
import { findCurrency, formatMoney } from '../money/money.ts'

/** Вид записи «Злотых» в ленте. Он один: долги и снимки придут своими этапами. */
export const ENTRY_KIND = 'entry'

export type FeedData = {
  entries: readonly Entry[]
  accounts: readonly Account[]
  categories: readonly Category[]
  currencies: readonly Currency[]
}

function accountName(data: FeedData, id: string | undefined): string {
  return data.accounts.find((each) => each.id === id)?.name ?? 'счёт удалён'
}

function categoryName(data: FeedData, id: string | undefined): string | null {
  if (!id) return null
  return data.categories.find((each) => each.id === id)?.name ?? 'категория удалена'
}

/** Направление словом: знака у суммы нет (Р-12, п. 7). */
function kindWord(entry: Entry): string {
  if (entry.kind === 'transfer') return 'перевод'
  return entry.kind === 'income' ? 'доход' : 'расход'
}

/** Что за запись — строкой под суммой: вид, счёт, категория и оговорки. */
function detailOf(entry: Entry, data: FeedData): string {
  const parts = [kindWord(entry), accountName(data, entry.accountId)]

  const category = categoryName(data, entry.categoryId)
  if (category) parts.push(category)
  else if (entry.period) parts.push('по категориям не разложено')

  if (entry.toAccountId) parts.push(`→ ${accountName(data, entry.toAccountId)}`)
  else if (entry.kind === 'transfer') parts.push('второй счёт не указан')

  if (entry.special) parts.push('особая')
  if (entry.for) parts.push(`за ${formatMonth(entry.for)}`)
  if (entry.period) parts.push(`итог за ${formatDate(entry.period.from)} — ${formatDate(entry.period.to)}`)

  return parts.join(' · ')
}

/**
 * Строки ленты. Дата итога периода — конец периода: по нему он и лежит
 * в раскладке (Р-12). Числом месяца он от этого не становится — этим
 * занимается «Месяц».
 */
export function entryFeed(data: FeedData): FeedItem[] {
  return data.entries
    .filter((each) => !each.deleted)
    .map((entry) => {
      const item: FeedItem = {
        kind: ENTRY_KIND,
        id: entry.id,
        date: entry.date ?? entry.period?.to ?? '',
        title: formatMoney(entry.money, findCurrency(data.currencies, entry.money.currency)),
        detail: detailOf(entry, data),
      }
      // По этому ищут, но на экране оно не стоит: банковское описание длинное,
      // а заметка — своя.
      const extra = [entry.bankText, entry.note].filter(Boolean).join(' ')
      if (extra) item.extra = extra
      return item
    })
}

// ─── Markdown ──────────────────────────────────────────────────────────────

/**
 * Выгрузка записей текстом — читать глазами, а не переносить: обратно файл
 * не загружается, для переноса есть копия в JSON.
 *
 * Период — на выбор; `null` — за всё время. Записи без разбираемой даты
 * попадают только в выгрузку за всё время: иначе они тихо пропадали бы
 * из любого периода.
 */
export function entryMarkdown(data: FeedData, period: Period | null): string {
  const inside = data.entries
    .filter((each) => !each.deleted)
    .filter((entry) => {
      if (!period) return true
      const day = entry.date ?? entry.period?.to ?? null
      return day !== null && day >= period.from && day <= period.to
    })

  if (inside.length === 0) return '_Записей нет._'

  const rows = [...inside].sort((a, b) => {
    const dateA = a.date ?? a.period?.to ?? ''
    const dateB = b.date ?? b.period?.to ?? ''
    return dateB.localeCompare(dateA) || b.id.localeCompare(a.id)
  })

  return rows
    .map((entry) => {
      const day = entry.date ?? entry.period?.to ?? ''
      const money = formatMoney(entry.money, findCurrency(data.currencies, entry.money.currency))
      return `- ${day ? formatDate(day) : 'без даты'} — **${money}** · ${escapeMarkdown(detailOf(entry, data))}`
    })
    .join('\n')
}
