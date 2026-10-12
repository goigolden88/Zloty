/**
 * Демо-данные «Злотых» (Я-44, Я-45 «FamilyCore»): выдуманные записи каждого
 * хранилища от дня входа в демо — настройки учёта с целью, рубль и доллар
 * с курсом, три счёта, категории, регулярная, операции за три прошлых
 * месяца и текущий по день входа, снимки счетов с заметкой к капиталу,
 * поездка особым периодом; в долгах — разовый долг с частичным возвратом
 * и комната с событием, тратами и переводом. Даты — от `day`, так демо
 * всегда живое.
 *
 * Ядро кладёт эти записи в свою базу `zloty-demo` при её создании;
 * синхронизации у неё нет. Репозиторий публичный — ничего настоящего.
 *
 * Правила модели держит и демо: сумма — целое в минимальных единицах
 * с кодом валюты (Р-04), долги — не расход и не доход (Р-05), настройки
 * учёта — одна запись, «я» — один человек. Итоги экранов не подгоняются:
 * их считают сами экраны.
 *
 * Живёт в `screens/`, а не в `app/`: знает и учёт, и капитал, и долги, как
 * срез итогов. Полноту проверяет `checkDemo` ядра — `demo.test.ts`: новое
 * хранилище без строки здесь — красный тест.
 */

import { addDays, addMonths, lastDayOf, monthOf, type DateStr } from '../shared/core/dates.ts'
import { ulid } from '../shared/core/id.ts'
import type {
  Account,
  Balance,
  Category,
  Currency,
  Entry,
  Loan,
  Note,
  Person,
  Profile,
  Rate,
  Recurring,
  Repayment,
  Room,
  RoomEvent,
  RoomSpend,
  RoomTransfer,
  SpecialPeriod,
  StoreRecord,
} from '../app/model.ts'

/** Записи демо по хранилищам — форма `AppConfig.demo`. */
export type DemoData = { [S in keyof StoreRecord]: StoreRecord[S][] }

/** Основная валюта демо и вторая — у брокерского счёта и в показе капитала. */
const BASE = 'RUB'
const SECOND = 'USD'

/** Сколько прошлых месяцев учёта в демо: хватает на обычный месяц и «Вышло за обычное». */
const PAST_MONTHS = 3

/** Рубли в копейки: в модели суммы — целые в минимальных единицах (Р-04). */
const kop = (rubles: number) => Math.round(rubles * 100)

/**
 * Месяц учёта: число месяца, категория, сумма в рублях, счёт. Регулярная
 * «Связь» и поездка — отдельно. Чтобы месяцы не были копией друг друга,
 * суммы трат умножаются на множитель месяца.
 */
type Line = { dom: number; category: string; rubles: number; account?: 'cash' }

const INCOME: readonly Line[] = [
  { dom: 1, category: 'Зарплата', rubles: 120000 },
  { dom: 16, category: 'Зарплата', rubles: 60000 },
]

const EXPENSES: readonly Line[] = [
  { dom: 2, category: 'Жильё', rubles: 35000 },
  { dom: 3, category: 'Продукты', rubles: 4200 },
  { dom: 5, category: 'Транспорт', rubles: 2500 },
  { dom: 7, category: 'Продукты', rubles: 1800, account: 'cash' },
  { dom: 8, category: 'Продукты', rubles: 5100 },
  { dom: 12, category: 'Кафе', rubles: 1800 },
  { dom: 13, category: 'Продукты', rubles: 3900 },
  { dom: 18, category: 'Продукты', rubles: 4600 },
  { dom: 20, category: 'Здоровье', rubles: 3000 },
  { dom: 23, category: 'Продукты', rubles: 5300 },
  { dom: 24, category: 'Кафе', rubles: 2400 },
  { dom: 27, category: 'Продукты', rubles: 3700 },
]

/** Множитель трат по месяцам, от давнего к текущему: жизнь, а не таблица. */
const SPREAD = [0.94, 1.08, 0.97, 1.03]

/** Остатки на конец прошлых месяцев и на день входа: рубли, рубли, доллары. */
const HELD = {
  bank: [210000, 236000, 262000, 281000],
  cash: [15000, 18000, 12000, 14000],
  broker: [4000, 4150, 4080, 4420],
}

/** Курс доллара на те же даты — выдуманный. */
const USD_RUB = [92.4, 90.8, 93.1, 91.6]

export function demo(day: DateStr): DemoData {
  const at = `${day}T08:00:00.000Z`
  const stamp = Date.parse(at)
  let n = 0
  /** `Base` записи: id по времени входа, по порядку. */
  const base = () => ({ id: ulid(stamp + n++), updatedAt: at })
  const rub = (rubles: number) => ({ amount: kop(rubles), currency: BASE })

  const profile: Profile[] = [{ ...base(), baseCurrency: BASE, showCurrency: SECOND, savingsGoal: 0.2 }]

  const currencies: Currency[] = [
    { ...base(), code: BASE, name: 'Рубль', decimals: 2, order: 0 },
    { ...base(), code: SECOND, name: 'Доллар', decimals: 2, order: 1 },
  ]

  const bank: Account = { ...base(), name: 'Синий банк', currency: BASE, kind: 'savings', order: 0 }
  const cash: Account = { ...base(), name: 'Наличные', currency: BASE, kind: 'savings', order: 1 }
  const broker: Account = { ...base(), name: 'Брокерский счёт', currency: SECOND, kind: 'investment', order: 2 }
  const accounts = [bank, cash, broker]

  const categories: Category[] = [
    ...['Жильё', 'Продукты', 'Транспорт', 'Связь', 'Кафе', 'Здоровье', 'Отдых'].map(
      (name, order): Category => ({ ...base(), name, side: 'expense', order }),
    ),
    ...['Зарплата', 'Подработка'].map((name, order): Category => ({ ...base(), name, side: 'income', order })),
  ]
  const categoryId = (name: string) => categories.find((each) => each.name === name)?.id ?? ''

  const now = monthOf(day)
  const first = addMonths(now, -PAST_MONTHS)
  const months = Array.from({ length: PAST_MONTHS + 1 }, (_, at) => addMonths(first, at))
  const dateIn = (month: string, dom: number) => `${month}-${String(dom).padStart(2, '0')}`

  const phone: Recurring = {
    ...base(),
    name: 'Связь',
    categoryId: categoryId('Связь'),
    accountId: bank.id,
    expected: rub(650),
    every: { months: 1 },
    from: first,
    order: 0,
  }

  const entries: Entry[] = []
  const put = (entry: Omit<Entry, 'id' | 'updatedAt'>) => {
    // Демо — по день входа: будущих операций не бывает.
    if (entry.date && entry.date <= day) entries.push({ ...base(), ...entry })
  }

  months.forEach((month, index) => {
    const spread = SPREAD[index] ?? 1
    for (const line of INCOME) {
      put({ kind: 'income', accountId: bank.id, money: rub(line.rubles), date: dateIn(month, line.dom), categoryId: categoryId(line.category) })
    }
    // Подработка — не каждый месяц: доход тоже бывает неровным.
    if (index % 2 === 1) {
      put({ kind: 'income', accountId: bank.id, money: rub(15000), date: dateIn(month, 22), categoryId: categoryId('Подработка') })
    }
    for (const line of EXPENSES) {
      put({
        kind: 'expense',
        accountId: line.account === 'cash' ? cash.id : bank.id,
        money: rub(Math.round(line.rubles * spread)),
        date: dateIn(month, line.dom),
        categoryId: categoryId(line.category),
      })
    }
    put({
      kind: 'expense',
      accountId: bank.id,
      money: phone.expected,
      date: dateIn(month, 10),
      categoryId: phone.categoryId,
      recurringId: phone.id,
      for: month,
    })
    // Перевод между своими счетами: не расход и не доход (Р-12).
    put({ kind: 'transfer', accountId: bank.id, toAccountId: cash.id, money: rub(5000), date: dateIn(month, 6) })
  })

  // Поездка позапрошлого месяца — особый период (Р-55): её траты особые
  // сами, без пометки, и в обычный месяц не идут.
  const tripMonth = addMonths(now, -2)
  const specials: SpecialPeriod[] = [
    { ...base(), from: dateIn(tripMonth, 9), to: dateIn(tripMonth, 11), title: 'Поездка к морю' },
  ]
  put({ kind: 'expense', accountId: bank.id, money: rub(18500), date: dateIn(tripMonth, 9), categoryId: categoryId('Отдых'), note: 'Гостиница' })
  put({ kind: 'expense', accountId: bank.id, money: rub(6200), date: dateIn(tripMonth, 10), categoryId: categoryId('Кафе') })

  // Снимки — на конец каждого прошлого месяца и на день входа; курс — на те
  // же даты, иначе брокерский счёт выпал бы из капитала без курса (Р-04).
  const snapshotDates = [...months.slice(0, -1).map(lastDayOf), day]
  const balances: Balance[] = []
  const rates: Rate[] = []
  snapshotDates.forEach((date, index) => {
    balances.push({ ...base(), accountId: bank.id, date, amount: kop(HELD.bank[index] ?? 0) })
    balances.push({ ...base(), accountId: cash.id, date, amount: kop(HELD.cash[index] ?? 0) })
    balances.push({ ...base(), accountId: broker.id, date, amount: kop(HELD.broker[index] ?? 0) })
    rates.push({ ...base(), date, from: SECOND, to: BASE, rate: USD_RUB[index] ?? 1, source: 'manual' })
  })

  const notes: Note[] = [
    {
      ...base(),
      about: 'capital',
      date: snapshotDates[1] ?? day,
      text: 'Брокерский немного просел вслед за рынком — не продаю',
    },
  ]

  // ─── Долги ───────────────────────────────────────────────────────────────

  const me: Person = { ...base(), name: 'Я', self: true }
  const anya: Person = { ...base(), name: 'Аня', starred: true }
  const borya: Person = { ...base(), name: 'Боря' }
  const vera: Person = { ...base(), name: 'Вера' }
  const people = [me, anya, borya, vera]

  const loan: Loan = {
    ...base(),
    personId: vera.id,
    direction: 'lent',
    money: rub(10000),
    date: addDays(day, -40),
    note: 'до зарплаты',
  }
  const repayments: Repayment[] = [{ ...base(), loanId: loan.id, money: rub(4000), date: addDays(day, -12) }]

  const room: Room = { ...base(), name: 'Дача', currency: BASE, personIds: [me.id, anya.id, borya.id] }
  const event: RoomEvent = {
    ...base(),
    roomId: room.id,
    name: 'Шашлыки',
    date: addDays(day, -20),
    personIds: [me.id, anya.id, borya.id],
  }
  const everyone = event.personIds.map((personId) => ({ personId }))
  const roomSpends: RoomSpend[] = [
    { ...base(), eventId: event.id, date: event.date, title: 'Мясо и овощи', payerId: me.id, amount: kop(6000), split: everyone },
    { ...base(), eventId: event.id, date: event.date, title: 'Аренда беседки', payerId: anya.id, amount: kop(3000), split: everyone },
  ]
  const roomTransfers: RoomTransfer[] = [
    { ...base(), roomId: room.id, date: addDays(day, -15), fromId: borya.id, toId: me.id, amount: kop(2000), note: 'на Синий банк' },
  ]

  return {
    profile,
    currencies,
    accounts,
    categories,
    recurring: [phone],
    rates,
    entries,
    balances,
    people,
    rooms: [room],
    roomEvents: [event],
    roomSpends,
    roomTransfers,
    loans: [loan],
    repayments,
    notes,
    specials,
  }
}
