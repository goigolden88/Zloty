import { useState } from 'react'
import { Link } from 'react-router-dom'
import { db } from '../app/core.ts'
import type { Account, Currency, Note } from '../app/model.ts'
import { capitalDates, staleOf, type Holding } from '../modules/capital/capital.ts'
import { createNote, noteProblem, notesOn, updateNote } from '../modules/capital/notes.ts'
import { draftRow, rowWrites, unchanged, withDeferred, type RowDraft } from '../modules/capital/row.ts'
import { useCapital } from '../modules/capital/useCapital.ts'
import { useDebts } from '../modules/debts/useDebts.ts'
import { baseCurrencyOf, readProfile } from '../modules/ledger/profile.ts'
import { useLedger } from '../modules/ledger/useLedger.ts'
import { useRates } from '../modules/ledger/useRates.ts'
import { findCurrency, formatMoney } from '../modules/money/money.ts'
import type { RateLeg } from '../modules/money/rates.ts'
import { formatDate, formatDateLoose, nowIso, plural, today } from '../shared/core/dates.ts'
import { ulid } from '../shared/core/id.ts'
import { BarChart, type BarItem } from '../shared/ui/BarChart.tsx'
import { Fold } from '../shared/ui/Fold.tsx'
import { capitalSeries, fullCapitalOn, type FullCapital, type FullData } from '../summary/capital.ts'

/**
 * «Капитал» — сколько у меня всего и как это растёт (Р-05, Р-35…Р-40).
 *
 * Сверху — итог на дату с основанием: по скольким счетам, какие снимки
 * устарели, что вне итога без курса. Ниже — из чего он сложился: сбережения
 * как лежат, вложения, отложенный платёж, долги. Всё посчитано из снимков,
 * курсов и долгов; хранятся только они (Р-05, правило 1).
 *
 * Снимок вносится строкой по всем счетам сразу, как строка прежней таблицы
 * (Р-39): форма заполнена прошлыми значениями.
 */
export function Capital() {
  const ledger = useLedger()
  const rates = useRates()
  const capital = useCapital()
  const debts = useDebts()
  const [chosen, setChosen] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const statuses = [ledger, rates, capital, debts]
  const failed = statuses.find((each) => each.status === 'failed')
  const loading = statuses.some((each) => each.status === 'loading')

  return (
    <section className="screen">
      <header className="screen-head">
        <div className="screen-head__row">
          <h1>Капитал</h1>
          <div className="screen-head__tools">
            <Link className="gear" to="/books" aria-label="Счета и категории">
              ≡
            </Link>
            <Link className="gear" to="/help" aria-label="Справка">
              ?
            </Link>
          </div>
        </div>
      </header>

      {failed && <p className="error">{failed.error}</p>}
      {loading && !failed && <p className="muted">Загрузка…</p>}

      {!loading && !failed && (
        <Body
          ledger={ledger.data}
          data={{
            accounts: ledger.data.accounts,
            balances: capital.data.balances,
            rates: rates.all,
            currencies: ledger.data.currencies,
            debts: debts.data,
          }}
          notes={capital.data.notes}
          chosen={chosen}
          onChoose={setChosen}
          adding={adding}
          onAdding={setAdding}
        />
      )}
    </section>
  )
}

type Raw = Omit<FullData, 'base' | 'show'>

function Body({
  ledger,
  data: raw,
  notes,
  chosen,
  onChoose,
  adding,
  onAdding,
}: {
  ledger: ReturnType<typeof useLedger>['data']
  data: Raw
  notes: readonly Note[]
  chosen: string | null
  onChoose: (date: string) => void
  adding: boolean
  onAdding: (on: boolean) => void
}) {
  const profile = readProfile(ledger.profile)
  const base = baseCurrencyOf(profile, ledger.currencies)

  if ('pick' in base) {
    return (
      <div className="note">
        <p>
          Валют несколько, а основная не выбрана — в какой считать капитал, решаете вы. Выберите её в{' '}
          <Link to="/books">«Счета и категории»</Link>, раздел «Настройки учёта»: там же — вторая валюта капитала.
        </p>
      </div>
    )
  }

  const data: FullData = { ...raw, base: base.code }
  if (profile?.showCurrency) data.show = profile.showCurrency
  const dates = capitalDates(data)
  const last = dates.at(-1) ?? null
  const date = chosen && dates.includes(chosen) ? chosen : last
  const show = (amount: number) => formatMoney({ amount, currency: data.base }, findCurrency(data.currencies, data.base))

  const form = adding && (
    <SnapshotForm
      accounts={raw.accounts}
      balances={raw.balances}
      currencies={raw.currencies}
      onDone={(saved) => {
        onAdding(false)
        if (saved) onChoose(saved)
      }}
    />
  )

  if (!date) {
    return (
      <>
        <div className="note">
          <p>
            Снимков ещё нет. Снимок — сколько лежит на каждом счёте на дату; капитал складывается из них,
            курсов и долгов. Из операций остаток не выводится (Р-05).
          </p>
        </div>
        {form || (
          <button type="button" className="btn--primary" onClick={() => onAdding(true)}>
            Новый снимок
          </button>
        )}
      </>
    )
  }

  const capital = fullCapitalOn(data, date)
  const series = capitalSeries(data)
  const index = series.findIndex((point) => point.date === date)
  const previous = index > 0 ? series[index - 1] : undefined

  return (
    <>
      {form || (
        <div className="row">
          <button type="button" className="btn--primary" onClick={() => onAdding(true)}>
            Новый снимок
          </button>
        </div>
      )}

      <Total capital={capital} previous={previous} show={show} data={data} />
      <Parts capital={capital} show={show} currencies={data.currencies} />
      <Notes date={date} notes={notes} />
      <Chart series={series} show={show} />
      <Points series={series} chosen={date} show={show} onChoose={onChoose} />
    </>
  )
}

// ─── Итог ──────────────────────────────────────────────────────────────────

const ACCOUNT_FORMS: [string, string, string] = ['счёту', 'счетам', 'счетам']
const POSITION_FORMS: [string, string, string] = ['позиция', 'позиции', 'позиций']

function percent(change: number): string {
  const value = (change * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1, signDisplay: 'exceptZero' })
  return `${value}%`
}

function Total({
  capital,
  previous,
  show,
  data,
}: {
  capital: FullCapital
  previous: { date: string; net: number } | undefined
  show: (amount: number) => string
  data: FullData
}) {
  const counted = capital.holdings.length
  const stale = staleOf(capital)
  const change = previous && previous.net > 0 ? (capital.net - previous.net) / previous.net : null

  return (
    <div className="block">
      <h2>Капитал на {formatDate(capital.date)}</h2>
      <p className="big">{show(capital.net)}</p>
      <SecondCurrency capital={capital} data={data} />

      <p className="basis">
        по {counted} {plural(counted, ACCOUNT_FORMS)}
        {(capital.owedToMe > 0 || capital.owedByMe > 0) && ' и долгам на эту дату'}
        {capital.deferred > 0 && ', за вычетом отложенного платежа'}
      </p>
      {change !== null && previous && (
        <p className="basis">
          {percent(change)} к {formatDate(previous.date)} — было {show(previous.net)}
        </p>
      )}
      {!previous && <p className="basis">первый снимок — сравнивать не с чем</p>}

      {stale.length > 0 && (
        <p className="basis">
          по старым снимкам: {stale.map((each) => `${each.account.name} — ${formatDate(each.date)}`).join(', ')}
        </p>
      )}
      {capital.without.length > 0 && (
        <p className="basis">без снимка, в итог не входят: {capital.without.map((each) => each.name).join(', ')}</p>
      )}
      {capital.missing.length > 0 && (
        <p className="error">
          Вне итога — нет курса на {formatDate(capital.date)}:{' '}
          {capital.missing
            .map((each) => `${each.currency}, ${each.count} ${plural(each.count, POSITION_FORMS)}`)
            .join('; ')}
          . Внесите курс — итог пересчитается.
        </p>
      )}
    </div>
  )
}

function SecondCurrency({ capital, data }: { capital: FullCapital; data: FullData }) {
  if (!data.show) {
    return (
      <p className="basis">
        вторая валюта капитала не выбрана — <Link to="/books">«Настройки учёта»</Link>
      </p>
    )
  }
  if (!capital.shown) return <p className="basis">в {data.show} — нет курса на {formatDate(capital.date)}</p>
  const money = formatMoney({ amount: capital.shown.amount, currency: data.show }, findCurrency(data.currencies, data.show))
  return (
    <p>
      {money} <span className="basis">{legsText(capital.shown.legs, data.currencies)}</span>
    </p>
  )
}

/** Основание пересчёта: «по 86 ₽ за USD на 01.09.2026». Через промежуточную валюту — оба курса (Р-37). */
function legsText(legs: readonly RateLeg[], currencies: readonly Currency[]): string {
  if (legs.length === 0) return ''
  const parts = legs.map((leg) => {
    const rate = leg.rate.toLocaleString('ru-RU', { maximumFractionDigits: leg.rate < 1 ? 6 : 2 })
    const to = findCurrency(currencies, leg.to)
    return `${rate} ${to?.code ?? leg.to} за ${leg.from}`
  })
  const dates = [...new Set(legs.map((leg) => leg.date))].map((each) => formatDate(each))
  return `по ${parts.join(' и ')} на ${dates.join(' и ')}`
}

// ─── Из чего сложился ──────────────────────────────────────────────────────

function Parts({
  capital,
  show,
  currencies,
}: {
  capital: FullCapital
  show: (amount: number) => string
  currencies: readonly Currency[]
}) {
  const savings = capital.holdings.filter((each) => each.account.kind !== 'investment')
  const investments = capital.holdings.filter((each) => each.account.kind === 'investment')
  const deferred = capital.holdings.filter((each) => each.deferred > 0)

  return (
    <div className="block">
      <h2>Из чего сложился</h2>
      <ul className="plain">
        <Group title="Сбережения" note="деньги как лежат" amount={show(capital.savings)} list={savings} show={show} currencies={currencies} />
        <Group title="Вложения" amount={show(capital.investments)} list={investments} show={show} currencies={currencies} />
        {capital.deferred > 0 && (
          <li className="line">
            <div className="line__main">
              Отложенный платёж
              <div className="basis">
                {deferred
                  .map((each) => `${each.account.name}: ${deferredParts(each)} — ${money(each.deferred, each.account, currencies)}`)
                  .join('; ')}
                . Деньги лежат в сбережениях, но их надо вернуть
              </div>
            </div>
            <div>−{show(capital.deferred)}</div>
          </li>
        )}
        {capital.owedToMe > 0 && (
          <li className="line">
            <div className="line__main">
              Мне должны
              <div className="basis">по долгам на эту дату — подробно в «Долгах»</div>
            </div>
            <div>+{show(capital.owedToMe)}</div>
          </li>
        )}
        {capital.owedByMe > 0 && (
          <li className="line">
            <div className="line__main">
              Я должен
              <div className="basis">по долгам на эту дату — подробно в «Долгах»</div>
            </div>
            <div>−{show(capital.owedByMe)}</div>
          </li>
        )}
        {capital.owedToMe === 0 && capital.owedByMe === 0 && (
          <li className="line">
            <div className="line__main muted">Долгов на эту дату нет — ни вам, ни вы</div>
          </li>
        )}
      </ul>
    </div>
  )
}

function money(amount: number, account: Account, currencies: readonly Currency[]): string {
  return formatMoney({ amount, currency: account.currency }, findCurrency(currencies, account.currency))
}

function deferredParts(holding: Holding): string {
  return holding.parts.filter((each) => each.amount < 0).map((each) => each.part ?? 'весь счёт').join(', ')
}

function Group({
  title,
  note,
  amount,
  list,
  show,
  currencies,
}: {
  title: string
  note?: string
  amount: string
  list: readonly Holding[]
  show: (amount: number) => string
  currencies: readonly Currency[]
}) {
  return (
    <li>
      <div className="line">
        <div className="line__main">
          <b>{title}</b>
          {note && <div className="basis">{note}</div>}
        </div>
        <div>
          <b>{amount}</b>
        </div>
      </div>
      {list.length === 0 ? (
        <p className="muted">счетов со снимками нет</p>
      ) : (
        <ul className="plain sub">
          {list.map((each) => (
            <li key={each.account.id} className="line">
              <div className="line__main">
                {each.account.name}
                <div className="basis">{holdingBasis(each, currencies)}</div>
              </div>
              <div>{each.heldBase === null ? <span className="muted">нет курса</span> : show(each.heldBase)}</div>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/** Основание строки счёта: сколько в своей валюте, по какому курсу, с какой даты снимок. */
function holdingBasis(holding: Holding, currencies: readonly Currency[]): string {
  const parts: string[] = []
  const foreign = holding.legs.length > 0
  const named = holding.parts.filter((each) => each.part !== undefined && each.amount >= 0)
  if (named.length > 1) {
    parts.push(named.map((each) => `${each.part} ${money(each.amount, holding.account, currencies)}`).join(', '))
  } else if (foreign) {
    parts.push(money(holding.held, holding.account, currencies))
  }
  if (foreign) parts.push(legsText(holding.legs, currencies))
  if (holding.mixed) parts.push('на эту дату есть и снимок целиком, и части — взяты части')
  parts.push(`снимок ${formatDate(holding.date)}`)
  return parts.join(' · ')
}

// ─── Заметки к дате ────────────────────────────────────────────────────────

function Notes({ date, notes }: { date: string; notes: readonly Note[] }) {
  const list = notesOn(notes, date)
  const [text, setText] = useState('')
  const [error, setError] = useState('')

  async function add() {
    const problem = noteProblem(text, date)
    if (problem) return setError(problem)
    setError('')
    setText('')
    await db.put('notes', createNote(date, text))
  }

  return (
    <div className="block">
      <h2>Заметки к {formatDate(date)}</h2>
      {list.length === 0 && <p className="muted">Заметок к этой дате нет.</p>}
      <ul className="plain">
        {list.map((each) => (
          <NoteLine key={each.id} note={each} />
        ))}
      </ul>
      <div className="form">
        <label className="field">
          Новая заметка — про капитал целиком, для себя
          <textarea rows={2} value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="form__actions">
          <button type="button" onClick={() => void add()}>
            Добавить заметку
          </button>
        </div>
      </div>
    </div>
  )
}

function NoteLine({ note }: { note: Note }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(note.text)
  const [sure, setSure] = useState(false)

  if (editing) {
    return (
      <li className="form">
        <textarea rows={2} value={text} onChange={(event) => setText(event.target.value)} />
        <div className="form__actions">
          <button type="button" onClick={() => setEditing(false)}>
            Отмена
          </button>
          <button
            type="button"
            className="btn--primary"
            disabled={!text.trim()}
            onClick={() => {
              setEditing(false)
              void db.put('notes', updateNote(note, text))
            }}
          >
            Сохранить
          </button>
        </div>
      </li>
    )
  }

  return (
    <li className="line">
      <div className="line__main">{note.text}</div>
      <div className="row">
        <button type="button" onClick={() => setEditing(true)}>
          Изменить
        </button>
        {sure ? (
          <button type="button" className="btn--danger" onClick={() => void db.remove('notes', note.id)}>
            Точно удалить
          </button>
        ) : (
          <button type="button" onClick={() => setSure(true)}>
            Удалить
          </button>
        )}
      </div>
    </li>
  )
}

// ─── Динамика ──────────────────────────────────────────────────────────────

function Chart({ series, show }: { series: ReturnType<typeof capitalSeries>; show: (amount: number) => string }) {
  if (series.length < 2) return null
  return (
    <div className="block">
      <h2>Капитал по снимкам</h2>
      <BarChart
        items={series.map(
          (point): BarItem => ({
            value: point.net > 0 ? point.net : null,
            label: point.date.slice(8, 10) + '.' + point.date.slice(5, 7),
            title: `${formatDate(point.date)}: ${show(point.net)}${point.missing > 0 ? ' — без части позиций: нет курса' : ''}`,
          }),
        )}
        label="Капитал по снимкам"
        tickText={show}
        peakText={show}
      />
      <p className="basis">столбик — капитал на дату снимка, с долгами и за вычетом отложенного платежа</p>
    </div>
  )
}

function Points({
  series,
  chosen,
  show,
  onChoose,
}: {
  series: ReturnType<typeof capitalSeries>
  chosen: string
  show: (amount: number) => string
  onChoose: (date: string) => void
}) {
  return (
    <Fold id="capital:points" title="Все снимки" summary={<span className="muted">{series.length}</span>} folded>
      <ul className="plain">
        {[...series].reverse().map((point) => (
          <li key={point.date} className="line">
            <div className="line__main">
              {point.date === chosen ? <b>{formatDateLoose(point.date)}</b> : formatDateLoose(point.date)}
              {point.change !== null && <div className="basis">{percent(point.change)} к прошлому</div>}
            </div>
            <div className="row">
              {show(point.net)}
              {point.date !== chosen && (
                <button type="button" onClick={() => onChoose(point.date)}>
                  Открыть
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Fold>
  )
}

// ─── Новый снимок ──────────────────────────────────────────────────────────

function SnapshotForm({
  accounts,
  balances,
  currencies,
  onDone,
}: {
  accounts: readonly Account[]
  balances: FullData['balances']
  currencies: readonly Currency[]
  onDone: (saved: string | null) => void
}) {
  const [date, setDate] = useState(today())
  const [rows, setRows] = useState<RowDraft[]>(() => draftRow(accounts, balances, currencies, today()))
  const [problems, setProblems] = useState<{ accountId: string; reason: string }[]>([])
  const [busy, setBusy] = useState(false)

  const change = (accountId: string, next: RowDraft) =>
    setRows((was) => was.map((row) => (row.accountId === accountId ? next : row)))

  async function save() {
    const result = rowWrites(rows, { accounts, balances, currencies }, date, { newId: ulid, now: nowIso() })
    if (result.problems.length > 0) return setProblems(result.problems)
    if (result.put.length === 0) return setProblems([{ accountId: '', reason: 'все поля пусты — записывать нечего' }])
    setBusy(true)
    await db.putMany('balances', [...result.removed, ...result.put])
    setBusy(false)
    onDone(date)
  }

  const nameOf = (id: string) => accounts.find((each) => each.id === id)?.name ?? ''

  return (
    <div className="block form">
      <h2>Новый снимок</h2>
      <p className="muted">
        Сколько лежит на каждом счёте на дату. Поля заполнены прошлыми значениями — поменяйте то, что изменилось.
        Пустое поле — снимка нет, а не ноль. Снимок на дату, где он уже есть, заменит прежний.
      </p>
      <label className="field">
        Дата
        <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
      </label>

      {rows.length === 0 && (
        <p className="error">
          Счетов для снимка нет — заведите их в <Link to="/books">«Счета и категории»</Link>.
        </p>
      )}

      {rows.map((row) => {
        const account = accounts.find((each) => each.id === row.accountId)
        const currency = account ? findCurrency(currencies, account.currency) : null
        const unit = currency?.unit?.name ?? account?.currency ?? ''
        const same = unchanged(row)
        return (
          <div key={row.accountId} className="snapshot-row">
            <div className="line">
              <div className="line__main">
                <b>{account?.name}</b>{' '}
                <span className="muted">
                  · {account?.kind === 'investment' ? 'вложения' : 'сбережения'}
                  {same && ' · как в прошлый раз'}
                </span>
              </div>
            </div>
            {row.parts.map((part, index) => (
              <div key={index} className="row row--wrap">
                {(row.parts.length > 1 || part.deferred) && (
                  <label className="field">
                    {part.deferred ? 'Отложенный платёж' : 'Часть'}
                    <input
                      value={part.part}
                      size={12}
                      onChange={(event) =>
                        change(row.accountId, {
                          ...row,
                          parts: row.parts.map((each, at) => (at === index ? { ...each, part: event.target.value } : each)),
                        })
                      }
                    />
                  </label>
                )}
                <label className="field">
                  {part.deferred ? `К возврату, ${unit}` : unit}
                  <input
                    inputMode="decimal"
                    value={part.value}
                    placeholder="нет снимка"
                    onChange={(event) =>
                      change(row.accountId, {
                        ...row,
                        parts: row.parts.map((each, at) => (at === index ? { ...each, value: event.target.value } : each)),
                      })
                    }
                  />
                </label>
              </div>
            ))}
            {!row.parts.some((each) => each.deferred) && (
              <button type="button" onClick={() => change(row.accountId, withDeferred(row))}>
                + отложенный платёж (кредитка)
              </button>
            )}
          </div>
        )
      })}

      {problems.map((each, index) => (
        <p key={index} className="error">
          {each.accountId ? `${nameOf(each.accountId)}: ` : ''}
          {each.reason}
        </p>
      ))}

      <div className="form__actions">
        <button type="button" onClick={() => onDone(null)}>
          Отмена
        </button>
        <button type="button" className="btn--primary" disabled={busy} onClick={() => void save()}>
          Записать снимок
        </button>
      </div>
    </div>
  )
}
