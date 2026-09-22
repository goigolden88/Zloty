/**
 * Заведение и правка записей долгов (Р-01, Р-30).
 *
 * Экран собирает черновик, здесь он превращается в запись, а `db.put` пишет.
 * Проверки — рядом с заведением: экран не должен знать, почему имя не годится.
 *
 * Модуль живёт сам по себе (условие 5 Р-01): ни одной строки про операции,
 * счета и категории учёта здесь нет и быть не может — это сторожит
 * `conditions.test.ts`.
 */

import { nowIso } from '../../shared/core/dates.ts'
import { ulid } from '../../shared/core/id.ts'
import type {
  CurrencyCode,
  Loan,
  Money,
  Person,
  Repayment,
  Room,
  RoomEvent,
  RoomSpend,
  RoomTransfer,
} from '../../app/model.ts'

/** Лишние пробелы — не часть имени. */
function clean(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

const same = (a: string, b: string) => clean(a).toLocaleLowerCase('ru') === clean(b).toLocaleLowerCase('ru')

const live = <T extends { deleted?: boolean }>(list: readonly T[]): T[] => list.filter((each) => !each.deleted)

// ─── Люди ──────────────────────────────────────────────────────────────────

export type PersonDraft = { name: string; self: boolean }

/**
 * Пометка «я» одна на справочник (условие 2 Р-01): по ней идут все выборки
 * «мои долги», и вторая сделала бы ответ неопределённым.
 */
export function personProblem(
  list: readonly Person[],
  draft: PersonDraft,
  id?: string,
): string | null {
  if (clean(draft.name).length === 0) return 'Без имени человека не завести'

  const others = live(list).filter((each) => each.id !== id)
  if (others.some((each) => same(each.name, draft.name))) return 'Такой человек уже есть'
  if (draft.self && others.some((each) => each.self)) {
    const marked = others.find((each) => each.self)
    return `Пометка «это я» уже стоит на «${marked?.name}»`
  }
  return null
}

export function createPerson(draft: PersonDraft): Person {
  return fillPerson(draft, { id: ulid(), updatedAt: nowIso() })
}

export function updatePerson(record: Person, draft: PersonDraft): Person {
  const next = fillPerson(draft, { id: record.id, updatedAt: nowIso() })
  if (record.archived) next.archived = true
  return next
}

function fillPerson(draft: PersonDraft, base: { id: string; updatedAt: string }): Person {
  const person: Person = { ...base, name: clean(draft.name) }
  if (draft.self) person.self = true
  return person
}

/** Люди по алфавиту; «я» — первым: с него начинается любой ответ про долги. */
export function sortedPeople(list: readonly Person[]): Person[] {
  return live(list)
    .filter((each) => !each.archived)
    .sort((a, b) => Number(Boolean(b.self)) - Number(Boolean(a.self)) || a.name.localeCompare(b.name, 'ru'))
}

/** Имя человека по id; нет такого — так и сказано, а не пустая строка. */
export function nameOf(list: readonly Person[], id: string): string {
  return list.find((each) => each.id === id)?.name ?? 'кто-то удалённый'
}

// ─── Комнаты ───────────────────────────────────────────────────────────────

export type RoomDraft = { name: string; currency: CurrencyCode; personIds: string[] }

export function roomProblem(list: readonly Room[], draft: RoomDraft, id?: string): string | null {
  if (clean(draft.name).length === 0) return 'Без названия комнату не завести'
  if (!draft.currency) return 'Не выбрана валюта комнаты'
  if (draft.personIds.length < 2) return 'В комнате должно быть хотя бы двое'

  const others = live(list).filter((each) => each.id !== id)
  if (others.some((each) => same(each.name, draft.name))) return 'Комната с таким названием уже есть'
  return null
}

export function createRoom(draft: RoomDraft): Room {
  return { id: ulid(), updatedAt: nowIso(), name: clean(draft.name), currency: draft.currency, personIds: [...draft.personIds] }
}

export function updateRoom(record: Room, draft: RoomDraft): Room {
  const next: Room = {
    id: record.id,
    updatedAt: nowIso(),
    name: clean(draft.name),
    currency: record.currency, // валюта комнаты не меняется: суммы уже записаны в ней
    personIds: [...draft.personIds],
  }
  if (record.closed) next.closed = true
  return next
}

/** Закрыть или открыть комнату заново. */
export function setClosed<T extends { closed?: boolean }>(record: T, value: boolean): T {
  const next = { ...record, updatedAt: nowIso() }
  if (value) next.closed = true
  else delete next.closed
  return next
}

// ─── События ───────────────────────────────────────────────────────────────

export type EventDraft = { name: string; date: string; personIds: string[] }

export function eventProblem(draft: EventDraft): string | null {
  if (clean(draft.name).length === 0) return 'Без названия событие не завести'
  if (!draft.date) return 'Не указана дата события'
  if (draft.personIds.length === 0) return 'В событии нет ни одного участника'
  return null
}

export function createEvent(roomId: string, draft: EventDraft): RoomEvent {
  return {
    id: ulid(),
    updatedAt: nowIso(),
    roomId,
    name: clean(draft.name),
    date: draft.date,
    personIds: [...draft.personIds],
  }
}

export function updateEvent(record: RoomEvent, draft: EventDraft): RoomEvent {
  const next: RoomEvent = {
    id: record.id,
    updatedAt: nowIso(),
    roomId: record.roomId,
    name: clean(draft.name),
    date: draft.date,
    personIds: [...draft.personIds],
  }
  if (record.closed) next.closed = true
  return next
}

// ─── Траты ─────────────────────────────────────────────────────────────────

export type SpendDraft = {
  title: string
  date: string
  payerId: string
  amount: number
  split: { personId: string; share?: number }[]
}

export function createSpend(eventId: string, draft: SpendDraft): RoomSpend {
  return {
    id: ulid(),
    updatedAt: nowIso(),
    eventId,
    date: draft.date,
    title: clean(draft.title),
    payerId: draft.payerId,
    amount: draft.amount,
    split: draft.split.map((part) => ({ ...part })),
  }
}

export function updateSpend(record: RoomSpend, draft: SpendDraft): RoomSpend {
  return {
    id: record.id,
    updatedAt: nowIso(),
    eventId: record.eventId,
    date: draft.date,
    title: clean(draft.title),
    payerId: draft.payerId,
    amount: draft.amount,
    split: draft.split.map((part) => ({ ...part })),
  }
}

// ─── Переводы ──────────────────────────────────────────────────────────────

export type TransferDraft = { fromId: string; toId: string; amount: number; date: string; note?: string }

export function transferProblem(draft: TransferDraft): string | null {
  if (!Number.isInteger(draft.amount) || draft.amount <= 0) return 'Сумма перевода должна быть больше нуля'
  if (!draft.fromId || !draft.toId) return 'Не сказано, кто кому перевёл'
  if (draft.fromId === draft.toId) return 'Перевод самому себе ничего не меняет'
  if (!draft.date) return 'Не указана дата перевода'
  return null
}

export function createTransfer(roomId: string, draft: TransferDraft): RoomTransfer {
  const transfer: RoomTransfer = {
    id: ulid(),
    updatedAt: nowIso(),
    roomId,
    date: draft.date,
    fromId: draft.fromId,
    toId: draft.toId,
    amount: draft.amount,
  }
  if (draft.note && clean(draft.note).length > 0) transfer.note = clean(draft.note)
  return transfer
}

// ─── Разовые долги ─────────────────────────────────────────────────────────

export type LoanDraft = {
  personId: string
  direction: Loan['direction']
  money: Money
  date: string
  note?: string
}

export function createLoan(draft: LoanDraft): Loan {
  const loan: Loan = {
    id: ulid(),
    updatedAt: nowIso(),
    personId: draft.personId,
    direction: draft.direction,
    money: { ...draft.money },
    date: draft.date,
  }
  if (draft.note && clean(draft.note).length > 0) loan.note = clean(draft.note)
  return loan
}

export function updateLoan(record: Loan, draft: LoanDraft): Loan {
  const next = createLoan(draft)
  return { ...next, id: record.id }
}

export function createRepayment(loanId: string, money: Money, date: string): Repayment {
  return { id: ulid(), updatedAt: nowIso(), loanId, money: { ...money }, date }
}

/** Мягкое удаление: запись остаётся надгробием, иначе её воскресит синхронизация. */
export function removed<T extends { deleted?: boolean }>(record: T): T {
  return { ...record, updatedAt: nowIso(), deleted: true }
}
