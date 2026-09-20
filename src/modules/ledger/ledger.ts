/**
 * Справочники учёта: валюты, счета, категории — заведение, правка, архив.
 *
 * Чистые функции, без React и без базы (02-Архитектура, «Структура кода»).
 * Запись в базу — `useLedger.ts`, экран — `screens/Books.tsx`.
 *
 * Чем это отличается от справочника «Трапезы», откуда взят каркас:
 *
 * — **id — ULID, а не название** (Р-12, п. 11). У «Трапезы» id блюда
 *   собирается из названия, чтобы одно и то же блюдо, заведённое на двух
 *   устройствах, не раздвоилось. Здесь так нельзя: договор семьи требует
 *   ULID у всего, а счетов и категорий у человека десятки, а не сотни —
 *   раздвоение видно глазом и чинится переименованием.
 * — **Сопоставление по названию — `sameText` ядра** (02-Архитектура,
 *   «Модель данных»): то же правило и при импорте, и при проверке «такое
 *   название уже есть». Своего правила не заводим: разойдясь, они дали бы
 *   импорту заводить двойников там, где экран их не пускает.
 *
 * Архива хватает вместо удаления: категория, которой больше не пользуются,
 * остаётся нужна истории. Удаление — мягкое и через `db`, здесь его нет.
 */

import { nowIso } from '../../shared/core/dates.ts'
import { ulid } from '../../shared/core/id.ts'
import { sameText } from '../../shared/core/importing.ts'
import type { Account, Category, Currency, CurrencyCode } from '../../app/model.ts'
import { currencyProblem, MAX_DECIMALS } from '../money/money.ts'

/** Что есть у всякой записи справочника: по этому она ищется, сортируется и прячется. */
export type Named = { id: string; name: string; order: number; deleted?: boolean; archived?: boolean }

// ─── Названия ──────────────────────────────────────────────────────────────

/** Название на экран и в базу: без пробелов по краям и без двойных внутри. */
export function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, ' ')
}

/** Живая запись с таким названием — архивная тоже. */
export function findByName<T extends Named>(list: readonly T[], name: string): T | undefined {
  return list.find((each) => !each.deleted && sameText(each.name, name))
}

/** Почему название не годится. `archived` — двойник лежит в архиве: его возвращают, а не заводят второй. */
export type NameProblem = 'empty' | 'duplicate' | 'archived'

export function nameProblem(list: readonly Named[], name: string, selfId?: string): NameProblem | null {
  if (!cleanName(name)) return 'empty'
  const twin = list.find((each) => !each.deleted && each.id !== selfId && sameText(each.name, name))
  if (!twin) return null
  return twin.archived === true ? 'archived' : 'duplicate'
}

// ─── Порядок и архив ───────────────────────────────────────────────────────

/** Живые записи по порядку; одинаковый порядок разводится названием. */
export function sorted<T extends Named>(list: readonly T[]): T[] {
  return list
    .filter((each) => !each.deleted)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ru'))
}

/** Те, которыми пользуются сейчас. */
export function active<T extends Named>(list: readonly T[]): T[] {
  return sorted(list).filter((each) => !each.archived)
}

/** Те, что убраны в архив: история к ним привязана, из выбора они ушли. */
export function archived<T extends Named>(list: readonly T[]): T[] {
  return sorted(list).filter((each) => each.archived === true)
}

/** Номер следующей записи: она встаёт в конец, а не в середину чужого порядка. */
export function nextOrder(list: readonly Named[]): number {
  const live = list.filter((each) => !each.deleted)
  return live.length === 0 ? 0 : Math.max(...live.map((each) => each.order)) + 1
}

/** Убрать в архив или вернуть из него. */
export function setArchived<T extends Named>(record: T, value: boolean): T {
  const next = { ...record, updatedAt: nowIso() }
  if (value) next.archived = true
  else delete next.archived
  return next
}

/**
 * Поменять местами с соседом по порядку. Возвращает две записи к записи,
 * а не перенумерованный список: правок ровно столько, сколько изменилось,
 * и синхронизация увезёт две записи вместо всего справочника.
 *
 * Соседа нет — двигать некуда, и писать нечего: пустой список.
 */
export function moved<T extends Named>(list: readonly T[], id: string, delta: -1 | 1): T[] {
  const line = sorted(list)
  const at = line.findIndex((each) => each.id === id)
  const to = at + delta
  const one = line[at]
  const other = line[to]
  if (!one || !other) return []
  const at2 = nowIso()
  return [
    { ...one, order: other.order, updatedAt: at2 },
    { ...other, order: one.order, updatedAt: at2 },
  ]
}

// ─── Валюты ────────────────────────────────────────────────────────────────

/** Заготовка валюты: то, что вводит человек. */
export type CurrencyDraft = {
  code: string
  name: string
  decimals: number
  unit?: { name: string; factor: number }
}

/**
 * Почему валюта не годится. Форму записи проверяет `money.ts` — здесь
 * только то, чего одна запись о себе не знает: занят ли код.
 */
export function currencyDraftProblem(
  list: readonly Currency[],
  draft: CurrencyDraft,
  selfId?: string,
): string | null {
  const code = draft.code.trim().toUpperCase()
  if (!code) return 'у валюты нет кода'
  if (!cleanName(draft.name)) return 'у валюты нет названия'
  if (list.some((each) => !each.deleted && each.id !== selfId && each.code === code)) {
    return `валюта ${code} уже заведена`
  }
  if (!Number.isInteger(draft.decimals) || draft.decimals < 0 || draft.decimals > MAX_DECIMALS) {
    return `знаков после запятой бывает от 0 до ${MAX_DECIMALS}`
  }
  return currencyProblem(asCurrency(draft, { id: 'проверка', updatedAt: '', order: 0 }))
}

function asCurrency(draft: CurrencyDraft, base: { id: string; updatedAt: string; order: number }): Currency {
  const currency: Currency = {
    ...base,
    code: draft.code.trim().toUpperCase(),
    name: cleanName(draft.name),
    decimals: draft.decimals,
  }
  if (draft.unit) currency.unit = { name: cleanName(draft.unit.name), factor: draft.unit.factor }
  return currency
}

export function createCurrency(list: readonly Currency[], draft: CurrencyDraft): Currency {
  return asCurrency(draft, { id: ulid(), updatedAt: nowIso(), order: nextOrder(asNamed(list)) })
}

export function updateCurrency(record: Currency, draft: CurrencyDraft): Currency {
  return asCurrency(draft, { id: record.id, updatedAt: nowIso(), order: record.order })
}

/** Валюты сортируются по порядку, а ищутся по коду: `Named` из кода не выводится. */
function asNamed(list: readonly Currency[]): Named[] {
  return list.map((each) => ({ id: each.id, name: each.code, order: each.order, deleted: each.deleted }))
}

/** Живые валюты по порядку. Архива у валюты нет: она либо есть, либо нет. */
export function sortedCurrencies(list: readonly Currency[]): Currency[] {
  return list
    .filter((each) => !each.deleted)
    .sort((a, b) => a.order - b.order || a.code.localeCompare(b.code, 'ru'))
}

// ─── Счета ─────────────────────────────────────────────────────────────────

/**
 * Заготовка счёта. Счёт — банк целиком, а не карта и не вклад (Р-12, п. 1):
 * форма так и говорит, потому что это не очевидно.
 */
export type AccountDraft = {
  name: string
  currency: CurrencyCode
  kind: Account['kind']
  ledgerOnly?: boolean
}

export function accountProblem(
  data: { accounts: readonly Account[]; currencies: readonly Currency[] },
  draft: AccountDraft,
  selfId?: string,
): string | null {
  const problem = nameProblem(data.accounts, draft.name, selfId)
  if (problem === 'empty') return 'у счёта нет названия'
  if (problem === 'duplicate') return `счёт «${cleanName(draft.name)}» уже есть`
  if (problem === 'archived') return `счёт «${cleanName(draft.name)}» лежит в архиве — верните его, а не заводите второй`
  if (!data.currencies.some((each) => !each.deleted && each.code === draft.currency)) {
    return `валюты ${draft.currency || '—'} нет в справочнике`
  }
  return null
}

export function createAccount(list: readonly Account[], draft: AccountDraft): Account {
  return fillAccount(draft, { id: ulid(), updatedAt: nowIso(), order: nextOrder(list) })
}

export function updateAccount(record: Account, draft: AccountDraft): Account {
  const next = fillAccount(draft, { id: record.id, updatedAt: nowIso(), order: record.order })
  if (record.archived) next.archived = true
  return next
}

function fillAccount(draft: AccountDraft, base: { id: string; updatedAt: string; order: number }): Account {
  const account: Account = {
    ...base,
    name: cleanName(draft.name),
    currency: draft.currency,
    kind: draft.kind,
  }
  if (draft.ledgerOnly) account.ledgerOnly = true
  return account
}

/**
 * Счета, на которые можно загружать операции: без архивных и без счетов
 * истории (Р-12, п. 6). Счёт истории держит итоги таблицы, и выписка на него
 * не ложится никогда — иначе итог периода и операции столкнутся на одном
 * счёте в одном месяце, чего Р-02 не разрешает.
 */
export function importableAccounts(list: readonly Account[]): Account[] {
  return active(list).filter((account) => !account.ledgerOnly)
}

// ─── Категории ─────────────────────────────────────────────────────────────

export type CategoryDraft = { name: string; side: Category['side'] }

export function categoryProblem(
  list: readonly Category[],
  draft: CategoryDraft,
  selfId?: string,
): string | null {
  // Расходная и доходная категории — разные (Р-05), и одноимённые среди них
  // законны: «Подарки» бывают и тем и другим. Двойник ищется в своей стороне.
  const side = list.filter((each) => each.side === draft.side)
  const problem = nameProblem(side, draft.name, selfId)
  if (problem === 'empty') return 'у категории нет названия'
  const what = draft.side === 'income' ? 'доходная категория' : 'категория'
  if (problem === 'duplicate') return `${what} «${cleanName(draft.name)}» уже есть`
  if (problem === 'archived') {
    return `${what} «${cleanName(draft.name)}» лежит в архиве — верните её, а не заводите вторую`
  }
  return null
}

export function createCategory(list: readonly Category[], draft: CategoryDraft): Category {
  return {
    id: ulid(),
    updatedAt: nowIso(),
    name: cleanName(draft.name),
    side: draft.side,
    order: nextOrder(list.filter((each) => each.side === draft.side)),
  }
}

export function updateCategory(record: Category, draft: CategoryDraft): Category {
  const next: Category = {
    ...record,
    updatedAt: nowIso(),
    name: cleanName(draft.name),
    side: draft.side,
  }
  return next
}

/** Категории одной стороны, которыми пользуются сейчас. */
export function activeCategories(list: readonly Category[], side: Category['side']): Category[] {
  return active(list.filter((each) => each.side === side))
}
