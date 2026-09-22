import { useState } from 'react'
import { Link } from 'react-router-dom'
import { db } from '../app/core.ts'
import type { Currency, Loan, Money, Person, Room } from '../app/model.ts'
import { loanState, signedLeft } from '../modules/debts/loans.ts'
import {
  createLoan,
  createPerson,
  createRepayment,
  createRoom,
  nameOf,
  personProblem,
  removed,
  roomProblem,
  setClosed,
  sortedPeople,
  updatePerson,
  type LoanDraft,
  type PersonDraft,
  type RoomDraft,
} from '../modules/debts/records.ts'
import { debtTotals, debtsByPerson, selfOf, type DebtsData, type PersonDebt } from '../modules/debts/summary.ts'
import { useDebts } from '../modules/debts/useDebts.ts'
import { baseCurrencyOf, readProfile } from '../modules/ledger/profile.ts'
import { useLedger, type LedgerData } from '../modules/ledger/useLedger.ts'
import { findCurrency, formatMoney, parseAmount } from '../modules/money/money.ts'
import { today } from '../shared/core/dates.ts'
import { Fold } from '../shared/ui/Fold.tsx'

/**
 * «Долги» — кто мне должен, кому я, и что лежит в комнатах (Р-01, Р-30).
 *
 * Главное здесь — люди с итогом: человек начинает с того, что нужно ему
 * одному, а комнаты и события лежат внутрь, на свой экран. Всё, что видно
 * на этом экране, посчитано (условие 4 Р-01): хранятся только траты,
 * переводы и долги.
 *
 * Расход месяца этот экран не трогает: связь с учётом идёт со стороны
 * операции, полем `refs` (Р-31), и живёт на «Операциях».
 */
export function Debts() {
  const debts = useDebts()
  const ledger = useLedger()
  const me = selfOf(debts.data.people)

  return (
    <section className="screen">
      <header className="screen-head">
        <div className="screen-head__row">
          <h1>Долги</h1>
          <div className="screen-head__tools">
            <Link className="gear" to="/help" aria-label="Справка">
              ?
            </Link>
          </div>
        </div>
      </header>

      {debts.status === 'loading' && <p className="muted">Читаю…</p>}
      {debts.status === 'failed' && <p className="error">{debts.error}</p>}

      {debts.status === 'ready' && (
        <>
          {!me && <SelfNote people={debts.data.people} />}
          {me && <Summary data={debts.data} ledger={ledger.data} />}

          <Loans data={debts.data} ledger={ledger.data} />
          <Rooms data={debts.data} ledger={ledger.data} />
          <People data={debts.data} />
        </>
      )}
    </section>
  )
}

// ─── Итог ──────────────────────────────────────────────────────────────────

/** Без пометки «я» считать нечего — и приложение говорит это прямо. */
function SelfNote({ people }: { people: readonly Person[] }) {
  const has = people.filter((each) => !each.deleted).length > 0
  return (
    <div className="note">
      <p>
        Отметьте себя среди людей — галочкой «это я». Без неё приложение не знает, чьи долги считать: в комнате
        вы такой же участник, как остальные, и узнаётся только по этой пометке.
      </p>
      {!has && <p className="muted">Людей пока нет вовсе — заведите себя первым, в разделе «Люди» ниже.</p>}
    </div>
  )
}

function moneyList(list: readonly Money[], currencies: readonly Currency[]): string {
  if (list.length === 0) return 'ничего'
  return list.map((money) => formatMoney(money, findCurrency(currencies, money.currency))).join(' и ')
}

function Summary({ data, ledger }: { data: DebtsData; ledger: LedgerData }) {
  const { owedToMe, owedByMe } = debtTotals(data)
  const people = debtsByPerson(data)

  if (people.length === 0) {
    return (
      <div className="note">
        <p>Долгов нет: ни вам, ни вы. Заведите разовый долг или комнату — ниже.</p>
      </div>
    )
  }

  return (
    <div className="unit">
      <h2 className="unit__name">Кто кому должен</h2>
      <p>
        Вам должны <strong>{moneyList(owedToMe, ledger.currencies)}</strong>, вы должны{' '}
        <strong>{moneyList(owedByMe, ledger.currencies)}</strong>.
      </p>
      <p className="muted">
        Встречные долги не складываются в одно число: это разные люди и разные сроки.
      </p>

      <ul className="plain">
        {people.map((debt) => (
          <PersonLine key={debt.personId} debt={debt} data={data} ledger={ledger} />
        ))}
      </ul>
    </div>
  )
}

function PersonLine({ debt, data, ledger }: { debt: PersonDebt; data: DebtsData; ledger: LedgerData }) {
  const rooms = debt.sources.filter((each) => each.kind === 'room').length
  const loans = debt.sources.filter((each) => each.kind === 'loan').length
  const basis = [
    rooms > 0 ? `по комнатам: ${rooms}` : '',
    loans > 0 ? `разовых долгов: ${loans}` : '',
  ].filter(Boolean)

  return (
    <li className="line">
      <div className="line__main">
        {nameOf(data.people, debt.personId)}
        <span className="muted"> · {basis.join(', ')}</span>
      </div>
      <div className="row row--wrap">
        {debt.amounts.map((money) => (
          <span key={money.currency} className={money.amount > 0 ? 'good' : 'error'}>
            {money.amount > 0 ? 'должен вам ' : 'вы должны '}
            {formatMoney(
              { amount: Math.abs(money.amount), currency: money.currency },
              findCurrency(ledger.currencies, money.currency),
            )}
          </span>
        ))}
      </div>
    </li>
  )
}

// ─── Разовые долги ─────────────────────────────────────────────────────────

function Loans({ data, ledger }: { data: DebtsData; ledger: LedgerData }) {
  const [adding, setAdding] = useState(false)
  const live = data.loans.filter((each) => !each.deleted)
  const open = live.filter((loan) => !loanState(loan, data.repayments).closed)
  const closed = live.filter((loan) => loanState(loan, data.repayments).closed)

  async function save(draft: LoanDraft) {
    await db.put('loans', createLoan(draft))
    setAdding(false)
  }

  return (
    <Fold
      id="debts:loans"
      title="Разовые долги"
      summary={<span className="muted">{open.length}</span>}
    >
      <p className="muted">
        «Дал Боре», «взял у Веры» — без комнаты и компании. Возврат частями законен: остаток считается
        по возвратам, а не хранится числом.
      </p>

      {open.length === 0 && !adding && <p className="muted">Открытых долгов нет.</p>}

      <ul className="plain">
        {open.map((loan) => (
          <LoanLine key={loan.id} loan={loan} data={data} ledger={ledger} />
        ))}
      </ul>

      {adding ? (
        <LoanForm data={data} ledger={ledger} onSave={save} onCancel={() => setAdding(false)} />
      ) : (
        <div className="row">
          <button type="button" className="btn--primary" onClick={() => setAdding(true)}>
            Записать долг
          </button>
        </div>
      )}

      {closed.length > 0 && (
        <Fold id="debts:loans:closed" title="Закрытые" sub summary={<span className="muted">{closed.length}</span>} folded>
          <ul className="plain">
            {closed.map((loan) => (
              <li key={loan.id} className="line">
                <div className="line__main">
                  {nameOf(data.people, loan.personId)}
                  <span className="muted"> · {loan.direction === 'lent' ? 'давали' : 'брали'} · рассчитались</span>
                </div>
                <div className="row row--wrap">
                  <span className="muted">
                    {formatMoney(loan.money, findCurrency(ledger.currencies, loan.money.currency))}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Fold>
      )}
    </Fold>
  )
}

function LoanLine({ loan, data, ledger }: { loan: Loan; data: DebtsData; ledger: LedgerData }) {
  const [paying, setPaying] = useState(false)
  const [amount, setAmount] = useState('')
  const [error, setError] = useState('')
  const state = loanState(loan, data.repayments)
  const currency = findCurrency(ledger.currencies, loan.money.currency)
  const mine = signedLeft(loan, data.repayments).amount > 0

  async function repay() {
    if (!currency) return setError(`валюты ${loan.money.currency} нет в справочнике`)
    const parsed = parseAmount(amount, currency.decimals)
    if (!parsed) return setError('сумма возврата — положительное число')
    if (parsed.amount > state.left) return setError(`осталось меньше: ${formatMoney({ amount: state.left, currency: loan.money.currency }, currency)}`)

    setError('')
    await db.put('repayments', createRepayment(loan.id, { amount: parsed.amount, currency: loan.money.currency }, today()))
    setAmount('')
    setPaying(false)
  }

  return (
    <li className="line">
      <div className="line__main">
        {nameOf(data.people, loan.personId)}
        <span className="muted">
          {' · '}
          {mine ? 'должен вам' : 'вы должны'} · от {loan.date}
          {loan.note ? ` · ${loan.note}` : ''}
        </span>
        {state.repaid > 0 && (
          <div className="muted">
            вернули {formatMoney({ amount: state.repaid, currency: loan.money.currency }, currency)} из{' '}
            {formatMoney(loan.money, currency)}
          </div>
        )}
      </div>

      <div className="row row--wrap">
        <strong>{formatMoney({ amount: state.left, currency: loan.money.currency }, currency)}</strong>
        {paying ? (
          <>
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="сколько вернули"
              inputMode="decimal"
              autoFocus
            />
            <button type="button" className="btn--primary" onClick={() => void repay()}>
              Записать возврат
            </button>
            <button type="button" onClick={() => { setPaying(false); setError('') }}>
              Отмена
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => setPaying(true)}>
              Вернули
            </button>
            <button type="button" onClick={() => void db.put('loans', removed(loan))}>
              Удалить
            </button>
          </>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </li>
  )
}

function LoanForm({
  data,
  ledger,
  onSave,
  onCancel,
}: {
  data: DebtsData
  ledger: LedgerData
  onSave: (draft: LoanDraft) => Promise<void>
  onCancel: () => void
}) {
  const people = sortedPeople(data.people).filter((each) => !each.self)
  const base = baseCurrencyOf(readProfile(ledger.profile), ledger.currencies)
  const [personId, setPersonId] = useState(people[0]?.id ?? '')
  const [direction, setDirection] = useState<Loan['direction']>('lent')
  const [amount, setAmount] = useState('')
  const [code, setCode] = useState('code' in base ? base.code : (ledger.currencies[0]?.code ?? ''))
  const [date, setDate] = useState(today())
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  function submit() {
    if (!personId) return setError('не выбран человек')
    const currency = findCurrency(ledger.currencies, code)
    if (!currency) return setError(`валюты ${code} нет в справочнике`)
    const parsed = parseAmount(amount, currency.decimals)
    if (!parsed) return setError('сумма — положительное число')

    setError('')
    void onSave({ personId, direction, money: { amount: parsed.amount, currency: code }, date, note })
  }

  if (people.length === 0) {
    return <p className="error">Сначала заведите человека — в разделе «Люди» ниже.</p>
  }

  return (
    <div className="form">
      <label className="field">
        Кто
        <select value={personId} onChange={(event) => setPersonId(event.target.value)}>
          {people.map((each) => (
            <option key={each.id} value={each.id}>
              {each.name}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        Что было
        <select value={direction} onChange={(event) => setDirection(event.target.value as Loan['direction'])}>
          <option value="lent">Дал в долг — должны мне</option>
          <option value="borrowed">Взял в долг — должен я</option>
        </select>
      </label>

      <label className="field">
        Сколько
        <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" autoFocus />
      </label>

      {ledger.currencies.length > 1 && (
        <label className="field">
          Валюта
          <select value={code} onChange={(event) => setCode(event.target.value)}>
            {ledger.currencies.map((each) => (
              <option key={each.id} value={each.code}>
                {each.code}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="field">
        Когда
        <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
      </label>

      <label className="field">
        Заметка
        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="за что, если нужно" />
      </label>

      {error && <p className="error">{error}</p>}

      <div className="form__actions">
        <button type="button" onClick={onCancel}>
          Отмена
        </button>
        <button type="button" className="btn--primary" onClick={submit}>
          Записать
        </button>
      </div>
    </div>
  )
}

// ─── Комнаты ───────────────────────────────────────────────────────────────

function Rooms({ data, ledger }: { data: DebtsData; ledger: LedgerData }) {
  const [adding, setAdding] = useState(false)
  const live = data.rooms.filter((each) => !each.deleted)
  const open = live.filter((room) => !room.closed)
  const done = live.filter((room) => room.closed)

  async function save(draft: RoomDraft) {
    await db.put('rooms', createRoom(draft))
    setAdding(false)
  }

  return (
    <Fold id="debts:rooms" title="Комнаты" summary={<span className="muted">{open.length}</span>}>
      <p className="muted">
        Комната — компания, на которую ведётся общий счёт: внутри неё события, а в событиях траты. Вести её —
        вам одному: друзья получают итог текстом.
      </p>

      {open.length === 0 && !adding && <p className="muted">Комнат пока нет.</p>}

      <ul className="plain">
        {open.map((room) => (
          <li key={room.id} className="line">
            <div className="line__main">
              <Link to={`/debts/${room.id}`}>{room.name}</Link>
              <span className="muted">
                {' · '}
                {room.personIds.length} участников · {room.currency}
              </span>
            </div>
            <div className="row row--wrap">
              <button type="button" onClick={() => void db.put('rooms', setClosed(room, true))}>
                Закрыть
              </button>
            </div>
          </li>
        ))}
      </ul>

      {adding ? (
        <RoomForm data={data} ledger={ledger} onSave={save} onCancel={() => setAdding(false)} />
      ) : (
        <div className="row">
          <button type="button" className="btn--primary" onClick={() => setAdding(true)}>
            Завести комнату
          </button>
        </div>
      )}

      {done.length > 0 && (
        <Fold id="debts:rooms:closed" title="Закрытые" sub summary={<span className="muted">{done.length}</span>} folded>
          <ul className="plain">
            {done.map((room) => (
              <li key={room.id} className="line">
                <div className="line__main">
                  <Link to={`/debts/${room.id}`}>{room.name}</Link>
                </div>
                <div className="row row--wrap">
                  <button type="button" onClick={() => void db.put('rooms', setClosed(room, false))}>
                    Открыть
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Fold>
      )}
    </Fold>
  )
}

function RoomForm({
  data,
  ledger,
  onSave,
  onCancel,
}: {
  data: DebtsData
  ledger: LedgerData
  onSave: (draft: RoomDraft) => Promise<void>
  onCancel: () => void
}) {
  const people = sortedPeople(data.people)
  const me = selfOf(data.people)
  const base = baseCurrencyOf(readProfile(ledger.profile), ledger.currencies)
  const [name, setName] = useState('')
  const [code, setCode] = useState('code' in base ? base.code : (ledger.currencies[0]?.code ?? ''))
  const [chosen, setChosen] = useState<string[]>(me ? [me.id] : [])
  const [error, setError] = useState('')

  function toggle(id: string) {
    setChosen((was) => (was.includes(id) ? was.filter((each) => each !== id) : [...was, id]))
  }

  function submit() {
    const draft: RoomDraft = { name, currency: code, personIds: chosen }
    const problem = roomProblem(data.rooms, draft)
    if (problem) return setError(problem)
    setError('')
    void onSave(draft)
  }

  return (
    <div className="form">
      <label className="field">
        Название
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Компания или повод" autoFocus />
      </label>

      <label className="field">
        Валюта комнаты
        <select value={code} onChange={(event) => setCode(event.target.value)}>
          {ledger.currencies.map((each) => (
            <option key={each.id} value={each.code}>
              {each.code} — {each.name}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">Потом она не меняется: суммы трат записываются целыми именно в ней.</p>

      <fieldset className="field">
        <legend>Кто в комнате</legend>
        {people.map((each) => (
          <label key={each.id} className="check">
            <input type="checkbox" checked={chosen.includes(each.id)} onChange={() => toggle(each.id)} />
            {each.name}
            {each.self && <span className="muted"> · это вы</span>}
          </label>
        ))}
      </fieldset>

      {error && <p className="error">{error}</p>}

      <div className="form__actions">
        <button type="button" onClick={onCancel}>
          Отмена
        </button>
        <button type="button" className="btn--primary" onClick={submit}>
          Завести
        </button>
      </div>
    </div>
  )
}

// ─── Люди ──────────────────────────────────────────────────────────────────

function People({ data }: { data: DebtsData }) {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Person | null>(null)
  const live = sortedPeople(data.people)

  async function save(draft: PersonDraft) {
    const record = editing ? updatePerson(editing, draft) : createPerson(draft)
    await db.put('people', record)
    setEditing(null)
    setAdding(false)
  }

  // Умолчание не зависит от числа людей: иначе блок сворачивался бы сам
  // в тот момент, когда появляется первый человек, — вместе с кнопкой
  // «Завести». Что свёрнуто, помнит устройство.
  return (
    <Fold id="debts:people" title="Люди" summary={<span className="muted">{live.length}</span>}>
      <p className="muted">
        Один справочник на комнаты и разовые долги: «сколько мне должен Боря» считается по всему сразу. Себя
        заведите тоже — с пометкой «это я».
      </p>

      <ul className="plain">
        {live.map((person) => (
          <li key={person.id} className="line">
            <div className="line__main">
              {person.name}
              {person.self && <span className="muted"> · это вы</span>}
            </div>
            <div className="row row--wrap">
              <button type="button" onClick={() => setEditing(person)}>
                Изменить
              </button>
            </div>
          </li>
        ))}
      </ul>

      {(adding || editing) && (
        <PersonForm
          data={data}
          record={editing}
          onSave={save}
          onCancel={() => {
            setEditing(null)
            setAdding(false)
          }}
        />
      )}

      {!adding && !editing && (
        <div className="row">
          <button type="button" className="btn--primary" onClick={() => setAdding(true)}>
            Завести человека
          </button>
        </div>
      )}
    </Fold>
  )
}

function PersonForm({
  data,
  record,
  onSave,
  onCancel,
}: {
  data: DebtsData
  record: Person | null
  onSave: (draft: PersonDraft) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState(record?.name ?? '')
  const [self, setSelf] = useState(record?.self === true)
  const [error, setError] = useState('')

  function submit() {
    const draft: PersonDraft = { name, self }
    const problem = personProblem(data.people, draft, record?.id)
    if (problem) return setError(problem)
    setError('')
    void onSave(draft)
  }

  return (
    <div className="form">
      <label className="field">
        Имя
        <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
      </label>

      <label className="check">
        <input type="checkbox" checked={self} onChange={(event) => setSelf(event.target.checked)} />
        Это я
      </label>
      <p className="muted">
        Пометка нужна одному человеку. По ней приложение отличает ваши долги от чужих: в комнате вы такой же
        участник, как остальные.
      </p>

      {error && <p className="error">{error}</p>}

      <div className="form__actions">
        <button type="button" onClick={onCancel}>
          Отмена
        </button>
        <button type="button" className="btn--primary" onClick={submit}>
          {record ? 'Сохранить' : 'Завести'}
        </button>
      </div>
    </div>
  )
}

/** Комната по адресу; нет такой — `null`, и экран комнаты скажет об этом. */
export function roomById(rooms: readonly Room[], id: string | undefined): Room | null {
  if (!id) return null
  return rooms.find((each) => each.id === id && !each.deleted) ?? null
}
