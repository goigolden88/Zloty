import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CHANGES } from '../changes.ts'
import { SYNCED_STORES } from '../app/model.ts'
import { baseCurrencyOf, readProfile } from '../modules/ledger/profile.ts'
import { useLedger } from '../modules/ledger/useLedger.ts'
import { useEntries } from '../modules/ledger/useEntries.ts'
import { useRates } from '../modules/ledger/useRates.ts'
import {
  monthlyExpenses,
  monthReport,
  observations,
  overUsual,
  usualMonth,
  USUAL_MONTHS,
  type Missing,
  type MonthData,
  type Sum,
} from '../modules/ledger/month.ts'
import { findCurrency, formatMoney } from '../modules/money/money.ts'
import { addMonths, formatDate, formatMonth, MONTHS_SHORT, monthOf, plural, today } from '../shared/core/dates.ts'
import { BarChart, type BarItem } from '../shared/ui/BarChart.tsx'
import { WhatsNew } from '../shared/screens/WhatsNew.tsx'
import { useFirstRun } from '../shared/screens/useFirstRun.ts'
import { useWhatsNew } from '../shared/screens/useWhatsNew.ts'
import { Welcome } from './Welcome.tsx'

/** Сколько месяцев показывают столбики. */
const BARS = 12

/**
 * Главный экран — «Месяц»: сколько отложено и хватает ли дохода (Р-07).
 *
 * Каждое число идёт с основанием: по скольким записям оно посчитано и чего
 * в нём не хватает. Число без основания здесь хуже, чем его отсутствие:
 * ему верят, а проверить нечем.
 *
 * Расчёт — в `modules/ledger/month.ts`, чистыми функциями с тестами. Этот
 * файл только показывает.
 */
export function Month() {
  const base = useFirstRun(SYNCED_STORES)
  const whatsNew = useWhatsNew(base, CHANGES)
  const ledger = useLedger()
  const entries = useEntries()
  const rates = useRates()
  const [month, setMonth] = useState(() => monthOf(today()))

  if (whatsNew.show.length > 0) return <WhatsNew changes={whatsNew.show} onDone={whatsNew.dismiss} />

  const busy = ledger.status === 'loading' || entries.status === 'loading' || rates.status === 'loading'
  const profile = readProfile(ledger.data.profile)

  // Валюта итогов: из настроек, а если их нет — единственная заведённая.
  // Приложение доходит до записей и без настроек: валюта, счёт и операции
  // приезжают одним файлом импорта. Упереться после этого в пустой экран
  // значило бы довести человека до данных и не ответить на вопрос.
  const currency = baseCurrencyOf(profile, ledger.data.currencies)

  return (
    <>
      <header className="screen-head">
        <div className="screen-head__row">
          <h1>Месяц</h1>
          <div className="screen-head__tools">
            <Link className="gear" to="/books" aria-label="Счета и категории">
              ₽
            </Link>
            <Link className="gear" to="/help" aria-label="Справка">
              ?
            </Link>
            <Link className="gear" to="/settings" aria-label="Настройки">
              ⚙
            </Link>
          </div>
        </div>
      </header>

      {base.welcome && <Welcome onDone={base.dismissWelcome} empty={base.empty} />}

      {busy && <p className="muted">Считаю…</p>}

      {!busy && 'pick' in currency && (
        <p className="muted">
          {currency.pick.length === 0
            ? 'Считать пока нечего: ни одной валюты не заведено. Начните со '
            : 'Валют заведено несколько, и надо выбрать, в какой считать итоги. Это '}
          <Link to="/books">{currency.pick.length === 0 ? 'счетов и категорий' : 'настройки учёта'}</Link>
          {currency.pick.length === 0 ? ' — там же заводятся валюты.' : '.'}
        </p>
      )}

      {!busy && 'code' in currency && (
        <>
          {currency.from === 'only' && (
            <p className="basis">
              Итоги считаются в {currency.code} — это единственная заведённая валюта. Станет больше —
              основную выбирают в <Link to="/books">настройках учёта</Link>.
            </p>
          )}
          <Report
            month={month}
            onMonth={setMonth}
            data={{
              entries: entries.all,
              currencies: ledger.data.currencies,
              rates: rates.all,
              base: currency.code,
            }}
            goal={profile?.savingsGoal ?? null}
            names={new Map(ledger.data.categories.map((each) => [each.id, each.name]))}
          />
        </>
      )}
    </>
  )
}

function Report({
  month,
  onMonth,
  data,
  goal,
  names,
}: {
  month: string
  onMonth: (month: string) => void
  data: MonthData
  goal: number | null
  names: Map<string, string>
}) {
  const report = monthReport(data, month)
  const seen = observations(data, month)
  const usual = usualMonth(seen.list, seen.missing)
  const over = overUsual(data, month)
  const bars = monthlyExpenses(data, month, BARS)

  const show = (amount: number) =>
    formatMoney({ amount, currency: data.base }, findCurrency(data.currencies, data.base))

  return (
    <>
      <div className="row month-row">
        <button type="button" onClick={() => onMonth(addMonths(month, -1))} aria-label="Прошлый месяц">
          ←
        </button>
        <b>{formatMonth(month)}</b>
        <button type="button" onClick={() => onMonth(addMonths(month, 1))} aria-label="Следующий месяц">
          →
        </button>
      </div>

      {/* Главный ответ — первым. Всё остальное объясняет его. */}
      <div className="block">
        <h2>Отложено</h2>
        {report.saved === null ? (
          <p className="error">
            Доход за этот месяц не внесён — считать не из чего. Это не ноль: ноль значил бы, что вы ничего
            не заработали.
          </p>
        ) : (
          <>
            <p className="big">{show(report.saved)}</p>
            <p className="basis">
              {report.savingsRate === null
                ? 'доход нулевой, доля не считается'
                : `${percent(report.savingsRate)} дохода — ${basis(report.income, 'доход')}, ${basis(report.expense, 'расход')}`}
            </p>
            {goal !== null && report.savingsRate !== null && (
              <p className="basis">
                {report.savingsRate >= goal
                  ? `цель — ${percent(goal)}, и в этом месяце она взята`
                  : `цель — ${percent(goal)}: до неё не хватает ${show(Math.round(report.income.amount * goal) - report.saved)}`}
              </p>
            )}
          </>
        )}
      </div>

      <div className="block">
        <h2>Из чего это вышло</h2>
        <ul className="plain">
          <li className="line">
            <div className="line__main">Доход</div>
            <div>
              {report.income.entries === 0 ? <span className="muted">не внесён</span> : show(report.income.amount)}
            </div>
          </li>
          <li className="line">
            <div className="line__main">
              Расход обычный
              <div className="basis">без особых трат</div>
            </div>
            <div>{show(report.usualExpense.amount)}</div>
          </li>
          <li className="line">
            <div className="line__main">
              Расход особый
              <div className="basis">в обычный месяц не идёт</div>
            </div>
            <div>{show(report.specialExpense.amount)}</div>
          </li>
        </ul>
        <p className="basis">
          {basis(report.expense, 'расход')}
          {report.transfers > 0 &&
            `; переводов между своими счетами — ${report.transfers}, они не расход и не доход`}
        </p>
        <MissingNote list={[...report.income.missing, ...report.expense.missing]} />
        <PeriodsNote report={report} show={show} />
      </div>

      <div className="block">
        <h2>Обычный месяц</h2>
        {usual === null ? (
          <p className="muted">
            Считать не по чему: за прошлые {plural(USUAL_MONTHS, ['месяц', 'месяца', 'месяцев'])} записей нет.
            Обычный месяц появится, когда наберётся хотя бы один прошлый месяц с записями.
          </p>
        ) : (
          <>
            <p className="big">{show(usual.monthly)}</p>
            <p className="basis">{usualBasis(usual.months, usual.periods)}</p>
            <MissingNote list={usual.missing} />
            {report.usualExpense.entries > 0 && (
              <p className="basis">
                этот месяц — {show(report.usualExpense.amount)}, то есть{' '}
                {report.usualExpense.amount > usual.monthly ? 'больше' : 'меньше'} обычного на{' '}
                {show(Math.abs(report.usualExpense.amount - usual.monthly))}
              </p>
            )}
          </>
        )}
      </div>

      {over.length > 0 && (
        <div className="block">
          <h2>Вышло за обычное</h2>
          <ul className="plain">
            {over.map((row) => (
              <li key={row.categoryId ?? 'нет'} className="line">
                <div className="line__main">
                  {row.categoryId === null ? 'Без категории' : (names.get(row.categoryId) ?? 'категория удалена')}
                  <div className="basis">
                    обычно {show(row.usual)} — по {row.months} {plural(row.months, ['месяцу', 'месяцам', 'месяцам'])}
                  </div>
                </div>
                <div className={row.delta > 0 ? 'error' : 'muted'}>
                  {row.delta > 0 ? '+' : '−'}
                  {show(Math.abs(row.delta))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="block">
        <h2>Расход по месяцам</h2>
        <BarChart
          items={bars.map((bar): BarItem => ({
            value: bar.amount > 0 ? bar.amount : null,
            label: MONTHS_SHORT[Number(bar.month.slice(5, 7)) - 1] ?? bar.month,
            title: `${formatMonth(bar.month)}: ${bar.amount > 0 ? show(bar.amount) : 'записей нет'}`,
            muted: bar.amount === 0,
          }))}
          label="Расход по месяцам"
          tickText={show}
          peakText={show}
        />
        <p className="basis">
          итоги периодов в столбики не входят: по месяцам они не дробятся
        </p>
      </div>
    </>
  )
}

// ─── Основания ─────────────────────────────────────────────────────────────

/** «по 142 операциям» — число вместе с тем, по чему оно посчитано (Р-07). */
function basis(sum: Sum, what: string): string {
  return `${what} — по ${sum.entries} ${plural(sum.entries, ['операции', 'операциям', 'операциям'])}`
}

function usualBasis(months: number, periods: number): string {
  const parts: string[] = []
  if (months > 0) parts.push(`${months} ${plural(months, ['месяцу', 'месяцам', 'месяцам'])}`)
  if (periods > 0) parts.push(`${periods} ${plural(periods, ['периоду', 'периодам', 'периодам'])} прежней таблицы`)
  return `по ${parts.join(' и ')}, без особых трат`
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`
}

/** Чего не хватило, чтобы сумма вошла в итог. Молчать об этом нельзя (Р-04). */
function MissingNote({ list }: { list: readonly Missing[] }) {
  if (list.length === 0) return null
  const lines = list.map((each) => `${each.currency} на ${formatDate(each.date)}${each.count > 1 ? ` (${each.count})` : ''}`)
  return <p className="error">В итог не вошло: нет курса {lines.join(', ')}.</p>
}

/** Месяц, покрытый чужим периодом, называет период, а не показывает число (Р-12, п. 6). */
function PeriodsNote({ report, show }: { report: ReturnType<typeof monthReport>; show: (amount: number) => string }) {
  if (report.periodTotals.length === 0) return null

  return (
    <div className="panel">
      <p>Этот месяц частью покрыт итогами за период — их числа в месяц не входят:</p>
      <ul className="plain">
        {report.periodTotals.map((total) => (
          <li key={total.id} className="muted">
            {show(total.money.amount)} за {formatDate(total.period?.from ?? '')} —{' '}
            {formatDate(total.period?.to ?? '')}
          </li>
        ))}
      </ul>
      <p className="basis">
        Сравнивать такие промежутки с месяцами можно расходом в день — так считается обычный месяц.
      </p>
    </div>
  )
}
