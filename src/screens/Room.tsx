import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { db } from '../app/core.ts'
import type { Currency, Person, RoomEvent, RoomSpend, RoomTransfer } from '../app/model.ts'
import { eventsOf, roomBalances, settle, spendsOf, spentTotal, totalsOf, transfersOf } from '../modules/debts/balance.ts'
import {
  createEvent,
  createSpend,
  createTransfer,
  eventProblem,
  nameOf,
  removed,
  updateEvent,
  updateSpend,
  type EventDraft,
  type SpendDraft,
} from '../modules/debts/records.ts'
import { sharesOf, spendProblem } from '../modules/debts/split.ts'
import { roomText } from '../modules/debts/text.ts'
import { useDebts } from '../modules/debts/useDebts.ts'
import { useLedger } from '../modules/ledger/useLedger.ts'
import { findCurrency, formatMoney, parseAmount } from '../modules/money/money.ts'
import { formatDate, plural, today } from '../shared/core/dates.ts'
import { Fold } from '../shared/ui/Fold.tsx'
import { roomById } from './Debts.tsx'

/**
 * Комната: события, траты внутри них, переводы и «кто кому должен» (Р-30).
 *
 * Всё, кроме фактов, считается заново (условие 4 Р-01): итог события, баланс
 * комнаты и минимизация переводов нигде не хранятся. Записью становится
 * только перевод, который отметили сделанным.
 */
export function Room() {
  const { roomId } = useParams()
  const debts = useDebts()
  const ledger = useLedger()
  const room = roomById(debts.data.rooms, roomId)

  if (debts.status === 'loading') return <p className="muted">Читаю…</p>
  if (debts.status === 'failed') return <p className="error">{debts.error}</p>
  if (!room) {
    return (
      <section className="screen">
        <p className="error">Такой комнаты нет — возможно, её удалили на другом устройстве.</p>
        <Link to="/debts">Ко всем долгам</Link>
      </section>
    )
  }

  const events = eventsOf(debts.data.roomEvents, room.id).sort((a, b) => b.date.localeCompare(a.date))
  const spends = events.flatMap((event) => spendsOf(debts.data.roomSpends, event.id))
  const transfers = transfersOf(debts.data.roomTransfers, room.id).sort((a, b) => b.date.localeCompare(a.date))
  const currency = findCurrency(ledger.data.currencies, room.currency)
  const balances = roomBalances(room.personIds, spends, transfers)
  const money = (amount: number) => formatMoney({ amount, currency: room.currency }, currency)

  return (
    <section className="screen">
      <header className="screen-head">
        <div className="screen-head__row">
          <h1>{room.name}</h1>
          <div className="screen-head__tools">
            <Link className="gear" to="/debts" aria-label="Ко всем долгам">
              ←
            </Link>
          </div>
        </div>
        <p className="muted">
          {room.personIds.length} {plural(room.personIds.length, ['участник', 'участника', 'участников'])} ·{' '}
          {events.length} {plural(events.length, ['событие', 'события', 'событий'])} · потрачено{' '}
          {money(spentTotal(spends))}
        </p>
      </header>

      <WhoOwes room={room} balances={balances} people={debts.data.people} money={money} />

      <Events room={room} events={events} data={debts.data} currency={currency} />

      <Transfers room={room} transfers={transfers} people={debts.data.people} money={money} currency={currency} />

      <ShareText
        text={() =>
          roomText({
            name: room.name,
            personIds: room.personIds,
            people: debts.data.people,
            events,
            spends,
            transfers,
            code: room.currency,
            currency,
          })
        }
      />
    </section>
  )
}

// ─── Кто кому должен ───────────────────────────────────────────────────────

function WhoOwes({
  room,
  balances,
  people,
  money,
}: {
  room: { id: string; personIds: string[] }
  balances: Map<string, number>
  people: readonly Person[]
  money: (amount: number) => string
}) {
  const lines = settle(balances)

  async function mark(fromId: string, toId: string, amount: number) {
    await db.put('roomTransfers', createTransfer(room.id, { fromId, toId, amount, date: today() }))
  }

  return (
    <div className="unit">
      <h2 className="unit__name">Кто кому должен</h2>
      <p className="muted">
        Это подсказка, а не запись: переводы считаются каждый раз заново. Записью становится тот, который
        вы отметите сделанным.
      </p>

      {lines.length === 0 && <p className="muted">Все в расчёте — переводить нечего.</p>}

      <ul className="plain">
        {lines.map((line) => (
          <li key={`${line.fromId}-${line.toId}`} className="line">
            <div className="line__main">
              {nameOf(people, line.fromId)} → {nameOf(people, line.toId)}
            </div>
            <div className="row row--wrap">
              <strong>{money(line.amount)}</strong>
              <button type="button" onClick={() => void mark(line.fromId, line.toId, line.amount)}>
                Перевели
              </button>
            </div>
          </li>
        ))}
      </ul>

      <Fold id="room:balances" title="Итог по участникам" sub folded>
        <ul className="plain">
          {[...balances].map(([personId, amount]) => (
            <li key={personId} className="line">
              <div className="line__main">{nameOf(people, personId)}</div>
              <div className="row row--wrap">
                <span className={amount === 0 ? 'muted' : amount > 0 ? 'good' : 'error'}>
                  {amount === 0 ? 'в расчёте' : amount > 0 ? `получит ${money(amount)}` : `должен ${money(-amount)}`}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </Fold>
    </div>
  )
}

// ─── События и траты ───────────────────────────────────────────────────────

function Events({
  room,
  events,
  data,
  currency,
}: {
  room: { id: string; personIds: string[] }
  events: readonly RoomEvent[]
  data: { people: readonly Person[]; roomSpends: readonly RoomSpend[] }
  currency: Currency | null
}) {
  const [adding, setAdding] = useState(false)

  async function save(draft: EventDraft) {
    await db.put('roomEvents', createEvent(room.id, draft))
    setAdding(false)
  }

  return (
    <div className="unit">
      <h2 className="unit__name">События и траты</h2>
      <p className="muted">
        Событие — повод, на который скидывались. Траты живут внутри него, и участники берутся из состава
        события, а не всей комнаты.
      </p>

      {events.length === 0 && !adding && <p className="muted">Событий пока нет.</p>}

      {events.map((event, index) => (
        <EventCard
          key={event.id}
          event={event}
          room={room}
          data={data}
          currency={currency}
          folded={index > 0}
        />
      ))}

      {adding ? (
        <EventForm
          room={room}
          people={data.people}
          record={null}
          onSave={save}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <div className="row">
          <button type="button" className="btn--primary" onClick={() => setAdding(true)}>
            Новое событие
          </button>
        </div>
      )}
    </div>
  )
}

function EventCard({
  event,
  room,
  data,
  currency,
  folded,
}: {
  event: RoomEvent
  room: { personIds: string[] }
  data: { people: readonly Person[]; roomSpends: readonly RoomSpend[] }
  currency: Currency | null
  folded: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<RoomSpend | null>(null)
  const [renaming, setRenaming] = useState(false)
  const spends = spendsOf(data.roomSpends, event.id)
  const code = currency?.code ?? ''
  const money = (amount: number) => formatMoney({ amount, currency: code }, currency)

  async function saveSpend(draft: SpendDraft) {
    const record = editing ? updateSpend(editing, draft) : createSpend(event.id, draft)
    await db.put('roomSpends', record)
    setEditing(null)
    setAdding(false)
  }

  return (
    <Fold
      id={`room:event:${event.id}`}
      title={event.name}
      sub
      folded={folded}
      summary={
        <span className="muted">
          {formatDate(event.date)} · {spends.length} {plural(spends.length, ['трата', 'траты', 'трат'])} ·{' '}
          {event.personIds.length} {plural(event.personIds.length, ['человек', 'человека', 'человек'])}
        </span>
      }
    >
      {renaming ? (
        <EventForm
          room={room}
          people={data.people}
          record={event}
          onSave={async (draft) => {
            await db.put('roomEvents', updateEvent(event, draft))
            setRenaming(false)
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : (
        <div className="row row--wrap">
          <button type="button" onClick={() => setRenaming(true)}>
            Изменить событие
          </button>
          <button type="button" onClick={() => void db.put('roomEvents', removed(event))}>
            Удалить
          </button>
        </div>
      )}

      <ul className="plain">
        {spends.map((spend) => (
          <SpendLine key={spend.id} spend={spend} event={event} people={data.people} money={money} onEdit={setEditing} />
        ))}
      </ul>

      {spends.length > 0 && (
        <>
          <h3 className="unit__name">Итог события</h3>
          <p className="muted">Потрачено всего {money(spentTotal(spends))}</p>
          <ul className="plain">
            {totalsOf(spends).map((total) => (
              <li key={total.personId} className="line">
                <div className="line__main">
                  {nameOf(data.people, total.personId)}
                  <span className="muted">
                    {' · '}личные расходы {money(total.personal)} · оплачено {money(total.paid)}
                  </span>
                </div>
                <div className="row row--wrap">
                  <span className={total.net === 0 ? 'muted' : total.net > 0 ? 'good' : 'error'}>
                    {total.net === 0 ? 'в расчёте' : total.net > 0 ? `получит ${money(total.net)}` : `к оплате ${money(-total.net)}`}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {adding || editing ? (
        <SpendForm
          event={event}
          people={data.people}
          currency={currency}
          record={editing}
          onSave={saveSpend}
          onCancel={() => {
            setEditing(null)
            setAdding(false)
          }}
        />
      ) : (
        <div className="row">
          <button type="button" className="btn--primary" onClick={() => setAdding(true)}>
            Добавить трату
          </button>
        </div>
      )}
    </Fold>
  )
}

function SpendLine({
  spend,
  event,
  people,
  money,
  onEdit,
}: {
  spend: RoomSpend
  event: RoomEvent
  people: readonly Person[]
  money: (amount: number) => string
  onEdit: (spend: RoomSpend) => void
}) {
  const shares = sharesOf(spend)
  const even = spend.split.every((part) => part.share === undefined)
  const missing = event.personIds.length - spend.split.length

  return (
    <li className="line">
      <div className="line__main">
        {spend.title}
        <span className="muted">
          {' · '}заплатил {nameOf(people, spend.payerId)} ·{' '}
          {even ? 'поровну' : 'суммами'} · {spend.split.length}{' '}
          {plural(spend.split.length, ['человек', 'человека', 'человек'])}
        </span>
        {missing > 0 && (
          <div className="muted">
            в событии {event.personIds.length}{' '}
            {plural(event.personIds.length, ['участник', 'участника', 'участников'])}, в этой трате{' '}
            {spend.split.length}
          </div>
        )}
        <div className="muted">
          {[...shares].map(([personId, share]) => `${nameOf(people, personId)} ${money(share)}`).join(' · ')}
        </div>
      </div>
      <div className="row row--wrap">
        <strong>{money(spend.amount)}</strong>
        <button type="button" onClick={() => onEdit(spend)}>
          Изменить
        </button>
        <button type="button" onClick={() => void db.put('roomSpends', removed(spend))}>
          Удалить
        </button>
      </div>
    </li>
  )
}

function EventForm({
  room,
  people,
  record,
  onSave,
  onCancel,
}: {
  room: { personIds: string[] }
  people: readonly Person[]
  record: RoomEvent | null
  onSave: (draft: EventDraft) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState(record?.name ?? '')
  const [date, setDate] = useState(record?.date ?? today())
  const [chosen, setChosen] = useState<string[]>(record ? [...record.personIds] : [...room.personIds])
  const [error, setError] = useState('')

  function toggle(id: string) {
    setChosen((was) => (was.includes(id) ? was.filter((each) => each !== id) : [...was, id]))
  }

  function submit() {
    const draft: EventDraft = { name, date, personIds: chosen }
    const problem = eventProblem(draft)
    if (problem) return setError(problem)
    setError('')
    void onSave(draft)
  }

  return (
    <div className="form">
      <label className="field">
        Название
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Повод" autoFocus />
      </label>

      <label className="field">
        Когда
        <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
      </label>

      <fieldset className="field">
        <legend>Кто участвовал</legend>
        {room.personIds.map((id) => (
          <label key={id} className="check">
            <input type="checkbox" checked={chosen.includes(id)} onChange={() => toggle(id)} />
            {nameOf(people, id)}
          </label>
        ))}
      </fieldset>
      <p className="muted">
        Состав подставится в новую трату. Уже записанные траты он не меняет: доли в них записаны поимённо.
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

function SpendForm({
  event,
  people,
  currency,
  record,
  onSave,
  onCancel,
}: {
  event: RoomEvent
  people: readonly Person[]
  currency: Currency | null
  record: RoomSpend | null
  onSave: (draft: SpendDraft) => Promise<void>
  onCancel: () => void
}) {
  const [title, setTitle] = useState(record?.title ?? '')
  const [date, setDate] = useState(record?.date ?? event.date)
  const [payerId, setPayerId] = useState(record?.payerId ?? event.personIds[0] ?? '')
  const [amount, setAmount] = useState('')
  const [chosen, setChosen] = useState<string[]>(
    record ? record.split.map((part) => part.personId) : [...event.personIds],
  )
  const [exact, setExact] = useState<Record<string, string>>({})
  const [error, setError] = useState('')

  function toggle(id: string) {
    setChosen((was) => (was.includes(id) ? was.filter((each) => each !== id) : [...was, id]))
  }

  function submit() {
    if (!currency) return setError('у комнаты валюта, которой нет в справочнике')
    const parsed = parseAmount(amount, currency.decimals)
    if (!parsed) return setError('сумма — положительное число')
    if (chosen.length === 0) return setError('не выбрано, на кого делится')

    const split: SpendDraft['split'] = []
    for (const personId of chosen) {
      const typed = exact[personId]
      if (typed === undefined || typed.trim() === '') {
        split.push({ personId })
        continue
      }
      const share = parseAmount(typed, currency.decimals)
      if (!share) return setError(`доля «${nameOf(people, personId)}» — число или пусто`)
      split.push({ personId, share: share.amount })
    }

    const draft: SpendDraft = { title, date, payerId, amount: parsed.amount, split }
    const problem = spendProblem({
      id: record?.id ?? 'draft',
      updatedAt: '',
      eventId: event.id,
      ...draft,
    })
    if (problem) return setError(problem)

    setError('')
    void onSave(draft)
  }

  return (
    <div className="form">
      <label className="field">
        Что
        <input value={title} onChange={(input) => setTitle(input.target.value)} placeholder="За что платили" autoFocus />
      </label>

      <label className="field">
        Сколько, {currency?.code ?? ''}
        <input value={amount} onChange={(input) => setAmount(input.target.value)} inputMode="decimal" />
      </label>

      <label className="field">
        Кто заплатил
        <select value={payerId} onChange={(input) => setPayerId(input.target.value)}>
          {event.personIds.map((id) => (
            <option key={id} value={id}>
              {nameOf(people, id)}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        Когда
        <input type="date" value={date} onChange={(input) => setDate(input.target.value)} />
      </label>

      <fieldset className="field">
        <legend>На кого делится</legend>
        {event.personIds.map((id) => (
          <div key={id} className="row row--wrap">
            <label className="check">
              <input type="checkbox" checked={chosen.includes(id)} onChange={() => toggle(id)} />
              {nameOf(people, id)}
            </label>
            {chosen.includes(id) && (
              <input
                value={exact[id] ?? ''}
                onChange={(input) => setExact((was) => ({ ...was, [id]: input.target.value }))}
                placeholder="поровну"
                inputMode="decimal"
              />
            )}
          </div>
        ))}
      </fieldset>
      <p className="muted">
        Пустое поле — поровну с остальными пустыми. Вписанная сумма — его личный расход: «взял на эту сумму».
        Остаток от деления достаётся тому, кто платил.
      </p>

      {error && <p className="error">{error}</p>}

      <div className="form__actions">
        <button type="button" onClick={onCancel}>
          Отмена
        </button>
        <button type="button" className="btn--primary" onClick={submit}>
          {record ? 'Сохранить' : 'Добавить'}
        </button>
      </div>
    </div>
  )
}

// ─── Переводы ──────────────────────────────────────────────────────────────

function Transfers({
  room,
  transfers,
  people,
  money,
  currency,
}: {
  room: { id: string; personIds: string[] }
  transfers: readonly RoomTransfer[]
  people: readonly Person[]
  money: (amount: number) => string
  currency: Currency | null
}) {
  const [adding, setAdding] = useState(false)
  const [fromId, setFromId] = useState(room.personIds[0] ?? '')
  const [toId, setToId] = useState(room.personIds[1] ?? '')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  async function submit() {
    if (!currency) return setError('у комнаты валюта, которой нет в справочнике')
    const parsed = parseAmount(amount, currency.decimals)
    if (!parsed) return setError('сумма — положительное число')
    if (fromId === toId) return setError('перевод самому себе ничего не меняет')

    setError('')
    await db.put('roomTransfers', createTransfer(room.id, { fromId, toId, amount: parsed.amount, date: today(), note }))
    setAmount('')
    setNote('')
    setAdding(false)
  }

  return (
    <Fold id="room:transfers" title="Переводы" summary={<span className="muted">{transfers.length}</span>} folded>
      <p className="muted">
        Кто кому уже вернул. Банк — по желанию: справочника банков нет, там банки друзей, а не ваши счета.
      </p>

      {transfers.length === 0 && <p className="muted">Переводов пока не было.</p>}

      <ul className="plain">
        {transfers.map((transfer) => (
          <li key={transfer.id} className="line">
            <div className="line__main">
              {nameOf(people, transfer.fromId)} → {nameOf(people, transfer.toId)}
              <span className="muted">
                {' · '}
                {formatDate(transfer.date)}
                {transfer.note ? ` · ${transfer.note}` : ''}
              </span>
            </div>
            <div className="row row--wrap">
              <strong>{money(transfer.amount)}</strong>
              <button
                type="button"
                onClick={() => void db.put('roomTransfers', removed(transfer))}
              >
                Удалить
              </button>
            </div>
          </li>
        ))}
      </ul>

      {adding ? (
        <div className="form">
          <label className="field">
            Кто перевёл
            <select value={fromId} onChange={(input) => setFromId(input.target.value)}>
              {room.personIds.map((id) => (
                <option key={id} value={id}>
                  {nameOf(people, id)}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            Кому
            <select value={toId} onChange={(input) => setToId(input.target.value)}>
              {room.personIds.map((id) => (
                <option key={id} value={id}>
                  {nameOf(people, id)}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            Сколько, {currency?.code ?? ''}
            <input value={amount} onChange={(input) => setAmount(input.target.value)} inputMode="decimal" />
          </label>

          <label className="field">
            Куда
            <input value={note} onChange={(input) => setNote(input.target.value)} placeholder="на Сбер, если нужно" />
          </label>

          {error && <p className="error">{error}</p>}

          <div className="form__actions">
            <button type="button" onClick={() => setAdding(false)}>
              Отмена
            </button>
            <button type="button" className="btn--primary" onClick={() => void submit()}>
              Записать
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button type="button" onClick={() => setAdding(true)}>
            Записать перевод
          </button>
        </div>
      )}
    </Fold>
  )
}

// ─── Итог друзьям ──────────────────────────────────────────────────────────

function ShareText({ text }: { text: () => string }) {
  const [note, setNote] = useState('')

  async function copy() {
    try {
      await navigator.clipboard.writeText(text())
      setNote('Итог скопирован — отправьте его друзьям')
    } catch {
      setNote('Скопировать не вышло: браузер не дал доступ к буферу обмена')
    }
  }

  return (
    <div className="unit">
      <h2 className="unit__name">Итог друзьям</h2>
      <p className="muted">
        Друзья получают снимок текстом, а не живую комнату: вести её может только один человек. В тексте —
        и суммы, и основания.
      </p>
      <div className="row">
        <button type="button" onClick={() => void copy()}>
          Скопировать итог
        </button>
      </div>
      {note && <p className="muted">{note}</p>}
    </div>
  )
}
