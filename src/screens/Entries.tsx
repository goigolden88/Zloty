import { useState } from 'react'
import { Link } from 'react-router-dom'
import { db } from '../app/core.ts'
import type { Category, Entry } from '../app/model.ts'
import { active, activeCategories } from '../modules/ledger/ledger.ts'
import { entriesOfMonth, makeEntry, type EntryData, type EntryDraft } from '../modules/ledger/entries.ts'
import { dueThisMonth, enterAll, enterRecurring, leftToPay, type Due } from '../modules/ledger/recurring.ts'
import { useEntries } from '../modules/ledger/useEntries.ts'
import { useLedger, type LedgerData } from '../modules/ledger/useLedger.ts'
import { findCurrency, formatMoney } from '../modules/money/money.ts'
import { addMonths, formatDate, formatMonth, monthOf, today } from '../shared/core/dates.ts'
import { Fold } from '../shared/ui/Fold.tsx'

/**
 * «Операции» — то, что внесено руками, и итоги периодов (Р-02).
 *
 * Руками вносится только то, чего не будет в выписке: наличные и итоги
 * прежней таблицы. Остальное приходит импортом — операция, внесённая
 * руками, ключа импорта не имеет и с той же операцией из выписки
 * не склеится (Р-12, «Цена», п. 2). Форма так и говорит.
 */
export function Entries() {
  const ledger = useLedger()
  const entries = useEntries()
  const [month, setMonth] = useState(() => monthOf(today()))
  const [adding, setAdding] = useState(false)

  const busy = ledger.status === 'loading' || entries.status === 'loading'
  const failed = ledger.status === 'failed' || entries.status === 'failed'
  const accounts = active(ledger.data.accounts)
  const shown = entriesOfMonth(entries.all, month)

  return (
    <>
      <header className="screen-head">
        <div className="screen-head__row">
          <h1>Операции</h1>
          <div className="screen-head__tools">
            <Link className="gear" to="/import" aria-label="Загрузить выписку">
              ↓
            </Link>
            <Link className="gear" to="/books" aria-label="Счета и категории">
              ₽
            </Link>
            <Link className="gear" to="/help" aria-label="Справка">
              ?
            </Link>
          </div>
        </div>
      </header>

      <div className="row month-row">
        <button type="button" onClick={() => setMonth(addMonths(month, -1))} aria-label="Прошлый месяц">
          ←
        </button>
        <b>{formatMonth(month)}</b>
        <button type="button" onClick={() => setMonth(addMonths(month, 1))} aria-label="Следующий месяц">
          →
        </button>
      </div>

      {busy && <p className="muted">Читаю…</p>}
      {failed && <p className="error">{ledger.error || entries.error}</p>}

      {!busy && !failed && accounts.length === 0 && (
        <p className="muted">
          Сначала заведите счёт — на <Link to="/books">«Счетах и категориях»</Link>. Без него операцию некуда
          записать.
        </p>
      )}

      {!busy && !failed && accounts.length > 0 && (
        <>
          {adding ? (
            <EntryForm
              ledger={ledger.data}
              entries={entries.all}
              month={month}
              onDone={() => setAdding(false)}
            />
          ) : (
            <div className="row">
              <button type="button" className="btn--primary" onClick={() => setAdding(true)}>
                Внести
              </button>
            </div>
          )}

          <RecurringBlock ledger={ledger.data} entries={entries.all} month={month} />

          <Periods list={shown.periods} ledger={ledger.data} />

          <h2>Операции месяца</h2>
          {shown.operations.length === 0 ? (
            <p className="muted">
              За этот месяц ничего не внесено. Выписку банка можно{' '}
              <Link to="/import">загрузить</Link>, а руками вносится то, чего в выписке не будет.
            </p>
          ) : (
            <ul className="plain">
              {shown.operations.map((entry) => (
                <EntryLine key={entry.id} entry={entry} ledger={ledger.data} />
              ))}
            </ul>
          )}
        </>
      )}
    </>
  )
}

// ─── Регулярные (Р-06) ─────────────────────────────────────────────────────

/**
 * Что ждёт этого месяца. Шаблон сам ничего не пишет: запись появляется
 * тапом «Внести» — или сама, когда платёж придёт выпиской.
 *
 * Внесённое из списка не исчезает: человеку нужно видеть, что платёж был,
 * а не только то, чего не хватает.
 */
function RecurringBlock({
  ledger,
  entries,
  month,
}: {
  ledger: LedgerData
  entries: readonly Entry[]
  month: string
}) {
  const [problems, setProblems] = useState<string[]>([])
  const data = {
    recurring: ledger.recurring,
    categories: ledger.categories,
    accounts: ledger.accounts,
    entries,
  }
  const due = dueThisMonth(data, month)
  if (due.length === 0) return null

  const left = due.filter((each) => each.entries.length === 0)

  async function enterOne(one: Due) {
    const made = enterRecurring(one.recurring, data, month, today())
    if ('problem' in made) return setProblems([made.problem])
    setProblems([])
    await db.put('entries', made.entry)
  }

  async function all() {
    const made = enterAll(data, month, today())
    setProblems(made.problems)
    if (made.entries.length > 0) await db.putMany('entries', made.entries)
  }

  return (
    <Fold
      id="entries:recurring"
      title="Регулярные"
      summary={
        <span className="muted">
          {left.length === 0 ? 'все внесены' : `не внесено ${left.length} из ${due.length}`}
        </span>
      }
    >
      <ul className="plain">
        {due.map((one) => (
          <li key={one.recurring.id} className="line">
            <div className="line__main">
              <b>{one.recurring.name}</b>{' '}
              <span className="muted">
                · ждём {formatMoney(one.recurring.expected, findCurrency(ledger.currencies, one.recurring.expected.currency))}
              </span>
              {one.entries.length > 0 && (
                <div className="basis">
                  внесено {formatMoney({ amount: one.paid, currency: one.recurring.expected.currency }, findCurrency(ledger.currencies, one.recurring.expected.currency))}
                  {leftToPay(one) !== 0 &&
                    ` — это ${leftToPay(one) > 0 ? 'меньше' : 'больше'} ожидаемого`}
                </div>
              )}
            </div>
            {one.entries.length === 0 && (
              <button type="button" onClick={() => void enterOne(one)}>
                Внести
              </button>
            )}
          </li>
        ))}
      </ul>

      {left.length > 1 && (
        <div className="row">
          <button type="button" className="btn--primary" onClick={() => void all()}>
            Внести все — {left.length}
          </button>
        </div>
      )}

      {problems.map((problem) => (
        <p key={problem} className="error">
          {problem}
        </p>
      ))}
    </Fold>
  )
}

// ─── Показ записи ──────────────────────────────────────────────────────────

function accountName(data: LedgerData, id: string | undefined): string {
  return data.accounts.find((each) => each.id === id)?.name ?? 'счёт не найден'
}

function categoryName(data: LedgerData, id: string | undefined): string | null {
  if (!id) return null
  return data.categories.find((each) => each.id === id)?.name ?? 'категория не найдена'
}

function money(data: LedgerData, entry: Entry): string {
  return formatMoney(entry.money, findCurrency(data.currencies, entry.money.currency))
}

/** Вид записи словом: знака у суммы нет, направление говорит подпись (Р-12). */
function kindWord(entry: Entry): string {
  if (entry.kind === 'transfer') return 'перевод'
  return entry.kind === 'income' ? 'доход' : 'расход'
}

function EntryLine({ entry, ledger }: { entry: Entry; ledger: LedgerData }) {
  const [asking, setAsking] = useState(false)
  const category = categoryName(ledger, entry.categoryId)

  return (
    <li className="line">
      <div className="line__main">
        <b>{money(ledger, entry)}</b> <span className="muted">· {kindWord(entry)}</span>
        {category && <span className="muted"> · {category}</span>}
        <div className="muted">
          {entry.date && formatDate(entry.date)}
          {entry.time && ` ${entry.time}`} · {accountName(ledger, entry.accountId)}
          {entry.toAccountId && ` → ${accountName(ledger, entry.toAccountId)}`}
          {entry.kind === 'transfer' && !entry.toAccountId && ' → второй счёт не указан'}
          {entry.special && ' · особая'}
          {entry.for && ` · за ${formatMonth(entry.for)}`}
        </div>
        {entry.note && <div className="muted">{entry.note}</div>}
      </div>

      {asking ? (
        <div className="row">
          <button type="button" className="btn--danger" onClick={() => void db.remove('entries', entry.id)}>
            Удалить насовсем
          </button>
          <button type="button" onClick={() => setAsking(false)}>
            Оставить
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setAsking(true)}>
          Удалить
        </button>
      )}
    </li>
  )
}

/**
 * Итоги периодов, которые задевают месяц. Числом месяц их не показывает:
 * по месяцам итог не дробится (Р-12, п. 6) — он называет период, за который
 * записан, а сопоставимость даст расход в день на экране «Месяц».
 */
function Periods({ list, ledger }: { list: Entry[]; ledger: LedgerData }) {
  if (list.length === 0) return null

  return (
    <Fold id="entries:periods" title="Этот месяц покрыт итогами периодов" summary={<span className="muted">{list.length}</span>}>
      <p className="muted">
        Итог периода по месяцам не дробится: он записан целиком за свой промежуток, а не за этот месяц.
        Сравнивать такие промежутки между собой будет экран «Месяц» — расходом в день.
      </p>
      <ul className="plain">
        {list.map((entry) => (
          <li key={entry.id} className="line">
            <div className="line__main">
              <b>{money(ledger, entry)}</b>{' '}
              <span className="muted">
                · за {formatDate(entry.period?.from ?? '')} — {formatDate(entry.period?.to ?? '')} ·{' '}
                {accountName(ledger, entry.accountId)}
              </span>
              {!entry.categoryId && <div className="muted">по категориям не разложено</div>}
            </div>
          </li>
        ))}
      </ul>
    </Fold>
  )
}

// ─── Форма ─────────────────────────────────────────────────────────────────

/** Что вносят руками. Итог периода — отдельный вид: у него период вместо даты. */
type FormKind = 'expense' | 'income' | 'transfer' | 'period'

function EntryForm({
  ledger,
  entries,
  month,
  onDone,
}: {
  ledger: LedgerData
  entries: readonly Entry[]
  month: string
  onDone: () => void
}) {
  const accounts = active(ledger.accounts)
  const [kind, setKind] = useState<FormKind>('expense')
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [toAccountId, setToAccountId] = useState('')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(() => (monthOf(today()) === month ? today() : `${month}-01`))
  const [from, setFrom] = useState(`${month}-01`)
  const [to, setTo] = useState(`${month}-28`)
  const [categoryId, setCategoryId] = useState('')
  const [special, setSpecial] = useState(false)
  const [forMonth, setForMonth] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  const side: Category['side'] = kind === 'income' ? 'income' : 'expense'
  const categories = kind === 'transfer' ? [] : activeCategories(ledger.categories, side)

  const data: EntryData = {
    accounts: ledger.accounts,
    currencies: ledger.currencies,
    categories: ledger.categories,
    entries,
  }

  async function save() {
    const draft: EntryDraft = {
      kind: kind === 'period' ? 'expense' : kind,
      accountId,
      amount,
    }
    if (kind === 'period') draft.period = { from, to }
    else draft.date = date
    if (categoryId && kind !== 'transfer') draft.categoryId = categoryId
    if (toAccountId && kind === 'transfer') draft.toAccountId = toAccountId
    if (special && (kind === 'expense' || kind === 'period')) draft.special = true
    if (forMonth) draft.for = forMonth
    if (note.trim()) draft.note = note

    const result = makeEntry(draft, data)
    if ('problem' in result) return setError(result.problem)

    setError('')
    await db.put('entries', result.entry)
    onDone()
  }

  return (
    <div className="form">
      <label className="field">
        Что вносим
        <select
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as FormKind)
            setCategoryId('')
          }}
        >
          <option value="expense">Расход</option>
          <option value="income">Доход</option>
          <option value="transfer">Перевод между своими счетами</option>
          <option value="period">Итог за период — там, где операций нет</option>
        </select>
      </label>

      <label className="field">
        {kind === 'transfer' ? 'Откуда' : 'Счёт'}
        <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
          {accounts.map((each) => (
            <option key={each.id} value={each.id}>
              {each.name} · {each.currency}
            </option>
          ))}
        </select>
      </label>

      {kind === 'transfer' && (
        <label className="field">
          Куда — если известно
          <select value={toAccountId} onChange={(event) => setToAccountId(event.target.value)}>
            <option value="">— второй счёт не указан —</option>
            {accounts
              .filter((each) => each.id !== accountId)
              .map((each) => (
                <option key={each.id} value={each.id}>
                  {each.name}
                </option>
              ))}
          </select>
        </label>
      )}

      <label className="field">
        Сумма в валюте счёта
        <input
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="1234,56"
          inputMode="decimal"
          autoFocus
        />
      </label>

      {kind === 'period' ? (
        <div className="row row--wrap">
          <label className="field">
            Период с
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="field">
            по
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
        </div>
      ) : (
        <label className="field">
          Дата
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
      )}

      {kind !== 'transfer' && (
        <label className="field">
          Категория{kind === 'period' && ' — если она известна'}
          <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
            <option value="">{kind === 'period' ? '— по категориям не разложено —' : '— не выбрана —'}</option>
            {categories.map((each) => (
              <option key={each.id} value={each.id}>
                {each.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {(kind === 'expense' || kind === 'period') && (
        <>
          <label className="check">
            <input type="checkbox" checked={special} onChange={(event) => setSpecial(event.target.checked)} />
            {kind === 'period' ? 'Итог особых трат за период' : 'Особая трата: в обычный месяц не идёт'}
          </label>
          {kind === 'period' && (
            <p className="muted">
              Лист прежней таблицы делит период на обычные и особые траты. Внесите их двумя итогами:
              обычный — без пометки, особый — с ней. Иначе «обычный месяц» на истории окажется завышен
              на все особые траты.
            </p>
          )}
        </>
      )}

      {kind !== 'period' && (
        <label className="field">
          За какой месяц — если платёж не за этот
          <input
            value={forMonth}
            onChange={(event) => setForMonth(event.target.value)}
            placeholder="2026-08"
          />
        </label>
      )}

      <label className="field">
        Заметка
        <input value={note} onChange={(event) => setNote(event.target.value)} />
      </label>

      <p className="muted">
        Руками вносите только то, чего не будет в выписке: наличные и итоги прежней таблицы. Внесённая
        руками операция и она же из выписки не склеятся — выйдет двойная запись.
      </p>

      {error && <p className="error">{error}</p>}

      <div className="form__actions">
        <button type="button" onClick={onDone}>
          Отмена
        </button>
        <button type="button" className="btn--primary" onClick={() => void save()}>
          Записать
        </button>
      </div>
    </div>
  )
}
