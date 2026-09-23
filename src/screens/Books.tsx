import { useState } from 'react'
import { Link } from 'react-router-dom'
import { db } from '../app/core.ts'
import type { Account, Category, Currency, Recurring } from '../app/model.ts'
import {
  accountProblem,
  active,
  activeCategories,
  archived,
  categoryProblem,
  createAccount,
  createCategory,
  createCurrency,
  currencyDraftProblem,
  perMajorOf,
  unitFromPerMajor,
  updateCurrency,
  moved,
  setArchived,
  sortedCurrencies,
  updateAccount,
  updateCategory,
  type AccountDraft,
  type CategoryDraft,
  type CurrencyDraft,
} from '../modules/ledger/ledger.ts'
import {
  DEFAULT_PERIOD_START_DAY,
  profileWrites,
  MAX_PERIOD_START_DAY,
  profileProblem,
  readProfile,
  type ProfileDraft,
} from '../modules/ledger/profile.ts'
import {
  createRecurring,
  recurringProblem,
  updateRecurring,
  type RecurringDraft,
} from '../modules/ledger/recurring.ts'
import { useLedger, type LedgerData } from '../modules/ledger/useLedger.ts'
import { findCurrency, formatMoney, parseAmount, suggestDecimals } from '../modules/money/money.ts'
import { monthOf, plural, today } from '../shared/core/dates.ts'
import { Fold } from '../shared/ui/Fold.tsx'

/**
 * «Счета и категории» — справочники учёта: где лежат деньги, на что они
 * идут, в каких валютах и как считать итоги.
 *
 * Экран не ежедневный: заводят один раз и правят редко, — поэтому он живёт
 * ссылкой из шапки «Месяца», а не вкладкой внизу. Так же устроены
 * «Настройки»: вкладки — для того, что открывают каждый день.
 *
 * Стартовых счетов и категорий в коде нет (02-Архитектура): у каждого они
 * свои, и подсунутые чужие пришлось бы удалять. Пустой раздел говорит, чего
 * не хватает и почему это нужно.
 */
export function Books() {
  const ledger = useLedger()

  return (
    <>
      <header className="screen-head">
        <div className="screen-head__row">
          <h1>Счета и категории</h1>
          <div className="screen-head__tools">
            <Link className="gear" to="/help" aria-label="Справка">
              ?
            </Link>
          </div>
        </div>
      </header>

      {ledger.status === 'loading' && <p className="muted">Читаю…</p>}
      {ledger.status === 'failed' && <p className="error">{ledger.error}</p>}

      {ledger.status === 'ready' && (
        <>
          <Accounts data={ledger.data} />
          <Categories data={ledger.data} />
          <Recurrings data={ledger.data} />
          <Currencies data={ledger.data} />
          <LedgerSettings data={ledger.data} />
        </>
      )}
    </>
  )
}

/** Что показать под заголовком блока — оно же видно, когда блок свёрнут. */
function count(n: number, forms: [string, string, string]): string {
  return `${n} ${plural(n, forms)}`
}

// ─── Счета ─────────────────────────────────────────────────────────────────

function Accounts({ data }: { data: LedgerData }) {
  const [editing, setEditing] = useState<Account | null>(null)
  const [adding, setAdding] = useState(false)
  const live = active(data.accounts)
  const gone = archived(data.accounts)
  const currencies = sortedCurrencies(data.currencies)

  async function save(draft: AccountDraft) {
    const record = editing ? updateAccount(editing, draft) : createAccount(data.accounts, draft)
    await db.put('accounts', record)
    setEditing(null)
    setAdding(false)
  }

  return (
    <Fold id="books:accounts" title="Счета" summary={<span className="muted">{count(live.length, ['счёт', 'счёта', 'счетов'])}</span>}>
      <p className="muted">
        Счёт — банк целиком, а не отдельная карта или вклад: выписка банка ложится на один счёт, а
        перекидывания между своими картами внутри банка в учёт не попадают. Отдельно заводятся наличные и
        счета в других валютах.
      </p>

      {currencies.length === 0 && <p className="error">Сначала заведите валюту — в разделе «Валюты» ниже.</p>}

      {live.length === 0 && currencies.length > 0 && (
        <p className="muted">Счетов пока нет. Заведите тот банк, выписку которого будете загружать первой.</p>
      )}

      <ul className="plain">
        {live.map((account, at) => (
          <li key={account.id} className="line">
            <div className="line__main">
              <b>{account.name}</b>
              <span className="muted">
                {' '}
                · {account.currency} · {account.kind === 'investment' ? 'вложения' : 'сбережения'}
                {account.ledgerOnly && ' · счёт истории'}
              </span>
            </div>
            <div className="row row--wrap">
              <button type="button" onClick={() => void moveAccount(data.accounts, account.id, -1)} disabled={at === 0} aria-label="Выше">
                ↑
              </button>
              <button
                type="button"
                onClick={() => void moveAccount(data.accounts, account.id, 1)}
                disabled={at === live.length - 1}
                aria-label="Ниже"
              >
                ↓
              </button>
              <button type="button" onClick={() => setEditing(account)}>
                Изменить
              </button>
              <button type="button" onClick={() => void db.put('accounts', setArchived(account, true))}>
                В архив
              </button>
            </div>
          </li>
        ))}
      </ul>

      {(adding || editing) && (
        <AccountForm
          // Форма помнит своё состояние: без ключа «Изменить» на другом
          // счёте открыло бы её с прежними значениями.
          key={editing?.id ?? 'new'}
          data={data}
          record={editing}
          onSave={save}
          onCancel={() => {
            setEditing(null)
            setAdding(false)
          }}
        />
      )}

      {!adding && !editing && currencies.length > 0 && (
        <div className="row">
          <button type="button" className="btn--primary" onClick={() => setAdding(true)}>
            Завести счёт
          </button>
        </div>
      )}

      {gone.length > 0 && (
        <Fold id="books:accounts:archive" title="Архив" sub summary={<span className="muted">{gone.length}</span>} folded>
          <p className="muted">Из выбора они ушли, а история к ним осталась привязанной.</p>
          <ul className="plain">
            {gone.map((account) => (
              <li key={account.id} className="line">
                <div className="line__main">
                  {account.name} <span className="muted">· {account.currency}</span>
                </div>
                <button type="button" onClick={() => void db.put('accounts', setArchived(account, false))}>
                  Вернуть
                </button>
              </li>
            ))}
          </ul>
        </Fold>
      )}
    </Fold>
  )
}

/** Перестановка — две записи, а не перенумерованный список (`ledger.moved`). */
async function moveAccount(list: readonly Account[], id: string, delta: -1 | 1): Promise<void> {
  const two = moved(list, id, delta)
  if (two.length > 0) await db.putMany('accounts', two)
}

async function moveCategory(list: readonly Category[], id: string, delta: -1 | 1): Promise<void> {
  const two = moved(list, id, delta)
  if (two.length > 0) await db.putMany('categories', two)
}

function AccountForm({
  data,
  record,
  onSave,
  onCancel,
}: {
  data: LedgerData
  record: Account | null
  onSave: (draft: AccountDraft) => Promise<void>
  onCancel: () => void
}) {
  const currencies = sortedCurrencies(data.currencies)
  const [name, setName] = useState(record?.name ?? '')
  const [currency, setCurrency] = useState(record?.currency ?? currencies[0]?.code ?? '')
  const [kind, setKind] = useState<Account['kind']>(record?.kind ?? 'savings')
  const [ledgerOnly, setLedgerOnly] = useState(record?.ledgerOnly === true)
  const [error, setError] = useState('')

  const draft: AccountDraft = { name, currency, kind, ledgerOnly }

  function submit() {
    const problem = accountProblem(data, draft, record?.id)
    if (problem) return setError(problem)
    setError('')
    void onSave(draft)
  }

  return (
    <div className="form">
      <label className="field">
        Название
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Банк или «Наличные»" autoFocus />
      </label>

      <label className="field">
        Валюта
        <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
          {currencies.map((each) => (
            <option key={each.id} value={each.code}>
              {each.code} — {each.name}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        Что это
        <select value={kind} onChange={(event) => setKind(event.target.value as Account['kind'])}>
          <option value="savings">Сбережения — деньги, которыми пользуются</option>
          <option value="investment">Вложения — то, что вложено</option>
        </select>
      </label>

      <label className="check">
        <input type="checkbox" checked={ledgerOnly} onChange={(event) => setLedgerOnly(event.target.checked)} />
        Счёт истории: операции на него не загружаются
      </label>
      <p className="muted">
        Пометка нужна одному счёту — тому, на который переносятся итоги прежней таблицы. Иначе они столкнутся
        с выписками тех же месяцев.
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

// ─── Категории ─────────────────────────────────────────────────────────────

function Categories({ data }: { data: LedgerData }) {
  const live = data.categories.filter((each) => !each.deleted && !each.archived)
  const gone = archived(data.categories)

  return (
    <Fold
      id="books:categories"
      title="Категории"
      summary={<span className="muted">{count(live.length, ['категория', 'категории', 'категорий'])}</span>}
    >
      <p className="muted">
        Расходные и доходные категории — разные списки: «Подарки» бывают и тем и другим. Кэшбэк и возврат
        покупки — доход: расход месяца они не уменьшают.
      </p>

      <CategorySide data={data} side="expense" title="Расходы" />
      <CategorySide data={data} side="income" title="Доходы" />

      {gone.length > 0 && (
        <Fold id="books:categories:archive" title="Архив" sub summary={<span className="muted">{gone.length}</span>} folded>
          <ul className="plain">
            {gone.map((each) => (
              <li key={each.id} className="line">
                <div className="line__main">
                  {each.name} <span className="muted">· {each.side === 'income' ? 'доход' : 'расход'}</span>
                </div>
                <button type="button" onClick={() => void db.put('categories', setArchived(each, false))}>
                  Вернуть
                </button>
              </li>
            ))}
          </ul>
        </Fold>
      )}
    </Fold>
  )
}

function CategorySide({ data, side, title }: { data: LedgerData; side: Category['side']; title: string }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Category | null>(null)
  const live = activeCategories(data.categories, side)

  async function add() {
    const draft: CategoryDraft = { name, side }
    const problem = categoryProblem(data.categories, draft)
    if (problem) return setError(problem)
    setError('')
    setName('')
    await db.put('categories', createCategory(data.categories, draft))
  }

  /**
   * Переименование. Нужно чаще, чем кажется: недостающие категории заводит
   * импорт, называя их так, как разобрала беседа. Id при этом не меняется —
   * история остаётся привязанной к той же записи (02-Архитектура).
   */
  async function rename(record: Category, next: string) {
    const draft: CategoryDraft = { name: next, side: record.side }
    const problem = categoryProblem(data.categories, draft, record.id)
    if (problem) return setError(problem)
    setError('')
    setEditing(null)
    await db.put('categories', updateCategory(record, draft))
  }

  return (
    <Fold id={`books:categories:${side}`} title={title} sub summary={<span className="muted">{live.length}</span>}>
      {live.length === 0 && <p className="muted">Пусто. Категории можно не заводить заранее — импорт заведёт недостающие сам.</p>}

      <ul className="plain">
        {live.map((each, at) => (
          <li key={each.id} className="line">
            {editing?.id === each.id ? (
              <RenameField
                value={each.name}
                onSave={(next) => void rename(each, next)}
                onCancel={() => {
                  setEditing(null)
                  setError('')
                }}
              />
            ) : (
              <div className="line__main">{each.name}</div>
            )}
            <div className="row row--wrap">
              <button type="button" onClick={() => setEditing(editing?.id === each.id ? null : each)}>
                {editing?.id === each.id ? 'Не менять' : 'Переименовать'}
              </button>
              <button type="button" onClick={() => void moveCategory(data.categories, each.id, -1)} disabled={at === 0} aria-label="Выше">
                ↑
              </button>
              <button
                type="button"
                onClick={() => void moveCategory(data.categories, each.id, 1)}
                disabled={at === live.length - 1}
                aria-label="Ниже"
              >
                ↓
              </button>
              <button type="button" onClick={() => void db.put('categories', setArchived(each, true))}>
                В архив
              </button>
            </div>
          </li>
        ))}
      </ul>

      <div className="row">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={side === 'income' ? 'Зарплата, кэшбэк' : 'Еда, транспорт'}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void add()
          }}
        />
        <button type="button" onClick={() => void add()}>
          Добавить
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </Fold>
  )
}

/** Поле переименования: сохраняется по Enter, закрывается по Esc. */
function RenameField({
  value,
  onSave,
  onCancel,
}: {
  value: string
  onSave: (next: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(value)
  return (
    <input
      className="line__main"
      value={text}
      autoFocus
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onSave(text)
        if (event.key === 'Escape') onCancel()
      }}
      onBlur={() => onSave(text)}
    />
  )
}

// ─── Регулярные (Р-06) ─────────────────────────────────────────

/**
 * Шаблоны того, что повторяется: связь, интернет, страховка, стипендия.
 * Сами они ничего не пишут — запись появляется тапом на «Операциях»
 * или приходит выпиской. Месяц целиком не копируется, и в этом весь смысл.
 */
function Recurrings({ data }: { data: LedgerData }) {
  const [editing, setEditing] = useState<Recurring | null>(null)
  const [adding, setAdding] = useState(false)
  const live = data.recurring.filter((each) => !each.deleted).sort((a, b) => a.order - b.order)

  async function save(draft: RecurringDraft) {
    const record = editing ? updateRecurring(editing, draft) : createRecurring(data.recurring, draft)
    await db.put('recurring', record)
    setEditing(null)
    setAdding(false)
  }

  return (
    <Fold
      id="books:recurring"
      title="Регулярные"
      summary={<span className="muted">{count(live.length, ['шаблон', 'шаблона', 'шаблонов'])}</span>}
      folded
    >
      <p className="muted">
        Шаблон помнит, чего ждать каждый месяц, но сам ничего не записывает: на «Операциях» появится
        блок «Регулярные» с кнопкой «Внести». Месяц целиком не копируется — вместе с суммами переезжали
        бы и прошлые ошибки.
      </p>

      <ul className="plain">
        {live.map((each) => (
          <li key={each.id} className="line">
            <div className="line__main">
              <b>{each.name}</b>{' '}
              <span className="muted">
                · {formatMoney(each.expected, findCurrency(data.currencies, each.expected.currency))} ·{' '}
                {each.every.months === 1
                  ? 'каждый месяц'
                  : `раз в ${each.every.months} ${plural(each.every.months, ['месяц', 'месяца', 'месяцев'])}`}
              </span>
              <div className="basis">
                {data.categories.find((one) => one.id === each.categoryId)?.name ?? 'категория удалена'} · с{' '}
                {each.from}
                {each.to && ` по ${each.to}`}
              </div>
            </div>
            <div className="row row--wrap">
              <button type="button" onClick={() => setEditing(each)}>
                Изменить
              </button>
              <button type="button" onClick={() => void db.remove('recurring', each.id)}>
                Убрать
              </button>
            </div>
          </li>
        ))}
      </ul>

      {(adding || editing) && (
        <RecurringForm
          key={editing?.id ?? 'new'}
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
          <button type="button" onClick={() => setAdding(true)}>
            Завести регулярную
          </button>
        </div>
      )}
    </Fold>
  )
}

function RecurringForm({
  data,
  record,
  onSave,
  onCancel,
}: {
  data: LedgerData
  record: Recurring | null
  onSave: (draft: RecurringDraft) => Promise<void>
  onCancel: () => void
}) {
  const accounts = active(data.accounts)
  const categories = active(data.categories)
  const [name, setName] = useState(record?.name ?? '')
  const [categoryId, setCategoryId] = useState(record?.categoryId ?? categories[0]?.id ?? '')
  const [accountId, setAccountId] = useState(record?.accountId ?? accounts[0]?.id ?? '')
  const [amount, setAmount] = useState(() => {
    if (!record) return ''
    const currency = findCurrency(data.currencies, record.expected.currency)
    return currency ? String(record.expected.amount / 10 ** currency.decimals) : ''
  })
  const [everyMonths, setEveryMonths] = useState(record?.every.months ?? 1)
  const [from, setFrom] = useState(record?.from ?? monthOf(today()))
  const [to, setTo] = useState(record?.to ?? '')
  const [error, setError] = useState('')

  function submit() {
    const account = accounts.find((each) => each.id === accountId)
    if (!account) return setError('не выбран счёт')
    const currency = findCurrency(data.currencies, account.currency)
    if (!currency) return setError(`валюты ${account.currency} нет в справочнике`)

    const parsed = parseAmount(amount, currency.decimals)
    if (!parsed) return setError('ожидаемая сумма — положительное число')

    const draft: RecurringDraft = {
      name,
      categoryId,
      accountId,
      expected: { amount: parsed.amount, currency: account.currency },
      everyMonths,
      from,
    }
    if (to) draft.to = to

    const problem = recurringProblem(
      { recurring: data.recurring, categories: data.categories, accounts: data.accounts, entries: [] },
      draft,
      record?.id,
    )
    if (problem) return setError(problem)

    setError('')
    void onSave(draft)
  }

  return (
    <div className="form">
      <label className="field">
        Название
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Связь" autoFocus />
      </label>

      <label className="field">
        Категория — она же говорит, расход это или доход
        <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
          {categories.map((each) => (
            <option key={each.id} value={each.id}>
              {each.name} · {each.side === 'income' ? 'доход' : 'расход'}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        Счёт
        <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
          {accounts.map((each) => (
            <option key={each.id} value={each.id}>
              {each.name} · {each.currency}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        Сколько ждём
        <input
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="1234,56"
          inputMode="decimal"
        />
      </label>

      <div className="row row--wrap">
        <label className="field">
          Раз в сколько месяцев
          <input
            type="number"
            value={everyMonths}
            onChange={(event) => setEveryMonths(Number(event.target.value))}
            min={1}
          />
        </label>
        <label className="field">
          С какого месяца
          <input value={from} onChange={(event) => setFrom(event.target.value)} placeholder="2026-09" />
        </label>
        <label className="field">
          По какой — если кончается
          <input value={to} onChange={(event) => setTo(event.target.value)} placeholder="2027-06" />
        </label>
      </div>

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

// ─── Валюты ────────────────────────────────────────────────────────────────

function Currencies({ data }: { data: LedgerData }) {
  const list = sortedCurrencies(data.currencies)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [decimals, setDecimals] = useState<number | null>(null)
  const [unitName, setUnitName] = useState('')
  const [perMajor, setPerMajor] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState('')

  // Свёрнут ли блок, решается один раз при открытии экрана, а не считается
  // из данных на каждой перерисовке: иначе первая заведённая валюта
  // схлопывает блок под руками, и второй валюты уже не добавить.
  const [foldedAtStart] = useState(list.length > 0)

  // Сколько знаков у валюты, пока человек не сказал иначе: `Intl` знает про
  // фиат и не знает про крипту (Р-12, п. 10) — это подсказка, а не правило.
  const shownDecimals = decimals ?? suggestDecimals(code.trim().toUpperCase())

  async function add() {
    const unit = unitFromPerMajor(shownDecimals, unitName, Number(perMajor.replace(',', '.')))
    if ('problem' in unit) return setError(unit.problem)
    const draft: CurrencyDraft = unit.unit ? { code, name, decimals: shownDecimals, unit: unit.unit } : { code, name, decimals: shownDecimals }
    const problem = currencyDraftProblem(data.currencies, draft)
    if (problem) return setError(problem)
    setError('')
    setCode('')
    setName('')
    setDecimals(null)
    setUnitName('')
    setPerMajor('')
    await db.put('currencies', createCurrency(data.currencies, draft))
  }

  return (
    <Fold
      id="books:currencies"
      title="Валюты"
      summary={<span className="muted">{list.map((each) => each.code).join(', ') || 'пусто'}</span>}
      folded={foldedAtStart}
    >
      <p className="muted">
        Валюта — запись, а не строка в коде: новая заводится здесь, без обновления приложения. Число знаков
        после запятой менять после первых операций нельзя — суммы уже записаны в этих единицах.
      </p>

      <ul className="plain">
        {list.map((each) =>
          editing === each.id ? (
            <li key={each.id}>
              <CurrencyEdit record={each} list={data.currencies} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li key={each.id} className="line">
              <div className="line__main">
                <b>{each.code}</b> <span className="muted">— {each.name}, знаков: {each.decimals}</span>
                {each.unit && (
                  <span className="muted">
                    {' '}
                    · показывается в {each.unit.name}: в одном {each.code} — {perMajorOf(each)}
                  </span>
                )}
              </div>
              <button type="button" onClick={() => setEditing(each.id)}>
                Изменить
              </button>
            </li>
          ),
        )}
      </ul>

      <div className="form">
        <div className="row row--wrap">
          <label className="field">
            Код
            <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="RUB" size={6} />
          </label>
          <label className="field">
            Название
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Рубль" />
          </label>
          <label className="field">
            Знаков
            <input
              type="number"
              value={shownDecimals}
              onChange={(event) => setDecimals(Number(event.target.value))}
              min={0}
              max={8}
              size={3}
            />
          </label>
        </div>
        <UnitFields code={code.trim().toUpperCase()} name={unitName} perMajor={perMajor} onName={setUnitName} onPerMajor={setPerMajor} />

        {error && <p className="error">{error}</p>}

        <div className="form__actions">
          <button type="button" onClick={() => void add()}>
            Добавить валюту
          </button>
        </div>
      </div>
    </Fold>
  )
}

/**
 * Единица показа словами человека: «в одном BTC — 1000 mBTC» (Р-04, п. 2).
 * Про минимальные единицы и множитель не спрашиваем: их считает `unitFromPerMajor`.
 */
function UnitFields({
  code,
  name,
  perMajor,
  onName,
  onPerMajor,
}: {
  code: string
  name: string
  perMajor: string
  onName: (value: string) => void
  onPerMajor: (value: string) => void
}) {
  return (
    <div className="row row--wrap">
      <label className="field">
        Показывать в единице, если нужно
        <input value={name} onChange={(event) => onName(event.target.value)} placeholder="mBTC" size={8} />
      </label>
      {name.trim() && (
        <label className="field">
          Сколько её в одном {code || 'единице валюты'}
          <input value={perMajor} onChange={(event) => onPerMajor(event.target.value)} placeholder="1000" inputMode="numeric" size={8} />
        </label>
      )}
    </div>
  )
}

/**
 * Правка валюты: название и единица показа. Код и число знаков не меняются —
 * на код ссылаются счета, а в числе знаков уже записаны суммы.
 */
function CurrencyEdit({ record, list, onDone }: { record: Currency; list: readonly Currency[]; onDone: () => void }) {
  const [name, setName] = useState(record.name)
  const [unitName, setUnitName] = useState(record.unit?.name ?? '')
  const [perMajor, setPerMajor] = useState(String(perMajorOf(record) ?? ''))
  const [error, setError] = useState('')

  async function save() {
    const unit = unitFromPerMajor(record.decimals, unitName, Number(perMajor.replace(',', '.')))
    if ('problem' in unit) return setError(unit.problem)
    const draft: CurrencyDraft = unit.unit
      ? { code: record.code, name, decimals: record.decimals, unit: unit.unit }
      : { code: record.code, name, decimals: record.decimals }
    const problem = currencyDraftProblem(list, draft, record.id)
    if (problem) return setError(problem)
    await db.put('currencies', updateCurrency(record, draft))
    onDone()
  }

  return (
    <div className="form">
      <p>
        <b>{record.code}</b> <span className="muted">— код и знаков после запятой ({record.decimals}) не меняются</span>
      </p>
      <label className="field">
        Название
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <UnitFields code={record.code} name={unitName} perMajor={perMajor} onName={setUnitName} onPerMajor={setPerMajor} />
      {error && <p className="error">{error}</p>}
      <div className="form__actions">
        <button type="button" onClick={onDone}>
          Отмена
        </button>
        <button type="button" className="btn--primary" onClick={() => void save()}>
          Сохранить
        </button>
      </div>
    </div>
  )
}

// ─── Настройки учёта ───────────────────────────────────────────────────────

function LedgerSettings({ data }: { data: LedgerData }) {
  const current = readProfile(data.profile)
  const currencies = sortedCurrencies(data.currencies)
  const [base, setBase] = useState(current?.baseCurrency ?? '')
  const [show, setShow] = useState(current?.showCurrency ?? '')
  const [day, setDay] = useState(current?.periodStartDay ?? DEFAULT_PERIOD_START_DAY)
  const [goal, setGoal] = useState(current?.savingsGoal === undefined ? '' : String(current.savingsGoal * 100))
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  // То же, что у валют: сохранение не должно закрывать блок на глазах.
  const [foldedAtStart] = useState(current !== null)

  async function save() {
    const percent = goal.trim() ? Number(goal.replace(',', '.')) : null
    if (percent !== null && !Number.isFinite(percent)) return setError('цель — число процентов: 20')

    const draft: ProfileDraft = { baseCurrency: base }
    if (show) draft.showCurrency = show
    if (day !== DEFAULT_PERIOD_START_DAY) draft.periodStartDay = day
    if (percent !== null) draft.savingsGoal = percent / 100

    const problem = profileProblem(draft, data.currencies)
    if (problem) return setError(problem)

    setError('')

    // Настройки — одна запись (Р-12, п. 9), и лишние уходят надгробиями:
    // правило и его довод — в `profileWrites`.
    const { records } = profileWrites(data.profile, current, draft)
    await db.putMany('profile', records)

    const extra = records.length - 1
    setNote(extra === 0 ? 'Сохранено' : `Сохранено. Лишних записей настроек убрано: ${extra}`)
  }

  return (
    <Fold
      id="books:profile"
      title="Настройки учёта"
      summary={<span className="muted">{current ? `итоги в ${current.baseCurrency}` : 'не заданы'}</span>}
      folded={foldedAtStart}
    >
      <p className="muted">
        Это настройки данных, а не устройства: они уезжают на второй телефон вместе с записями. Токен и
        синхронизация — в <Link to="/settings">«Настройках»</Link>.
      </p>

      {currencies.length === 0 && <p className="error">Сначала заведите валюту.</p>}

      <div className="form">
        <label className="field">
          В какой валюте считать итоги
          <select value={base} onChange={(event) => setBase(event.target.value)}>
            <option value="">— не выбрана —</option>
            {currencies.map((each) => (
              <option key={each.id} value={each.code}>
                {each.code} — {each.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          Вторая валюта капитала, если нужна
          <select value={show} onChange={(event) => setShow(event.target.value)}>
            <option value="">— нет —</option>
            {currencies.map((each) => (
              <option key={each.id} value={each.code}>
                {each.code}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          С какого числа считается месяц
          <input
            type="number"
            value={day}
            onChange={(event) => setDay(Number(event.target.value))}
            min={1}
            max={MAX_PERIOD_START_DAY}
          />
        </label>

        <label className="field">
          Сколько хочу откладывать, % дохода
          <input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="20" inputMode="decimal" />
        </label>

        {error && <p className="error">{error}</p>}
        {note && <p className="note">{note}</p>}

        <div className="form__actions">
          <button type="button" className="btn--primary" onClick={() => void save()}>
            Сохранить
          </button>
        </div>
      </div>
    </Fold>
  )
}
