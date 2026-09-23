import { useCallback, useEffect, useRef, useState } from 'react'
import { config } from '../app/config.ts'
import { db } from '../app/core.ts'
import { CHANGES } from '../changes.ts'
import { SCHEMA_VERSION, SYNCED_STORES } from '../app/model.ts'
import { monthPeriod, monthOf, formatMonth, today } from '../shared/core/dates.ts'
import { markdownExport } from '../registry.ts'
import { backupNote, backupSummary } from '../shared/ui/backup.ts'
import { Fold } from '../shared/ui/Fold.tsx'
import { InstallNote } from '../shared/ui/Install.tsx'
import { ReportBug } from '../shared/ui/Report.tsx'
import { SyncSettings } from '../shared/ui/SyncSettings.tsx'
import { reminders } from '../notify.ts'
import { REMIND_FROM_DAY, RECURRING_FROM_DAY } from '../modules/ledger/remind.ts'
import type { RemindResult, ReminderStatus, ReminderWindow, Wake } from '../shared/notify.ts'
import { useSyncStatus } from '../shared/ui/useSync.ts'
import { ChangeList } from '../shared/screens/WhatsNew.tsx'

/** Когда с этого устройства в последний раз забирали копию. Настройка устройства, не данных. */
const LAST_EXPORT = 'lastExport'

const LABELS: Record<(typeof SYNCED_STORES)[number], string> = {
  profile: 'Настройки учёта',
  currencies: 'Валюты',
  accounts: 'Счета',
  categories: 'Категории',
  recurring: 'Регулярные',
  rates: 'Курсы',
  entries: 'Операции и итоги',
  balances: 'Снимки остатков',
  people: 'Люди',
  rooms: 'Комнаты',
  roomEvents: 'События комнат',
  roomSpends: 'Траты событий',
  roomTransfers: 'Переводы в комнатах',
  loans: 'Разовые долги',
  repayments: 'Возвраты долгов',
  notes: 'Заметки к капиталу',
}

type Row = { store: (typeof SYNCED_STORES)[number]; live: number; total: number }

type State = { status: 'loading' } | { status: 'ready'; rows: Row[] } | { status: 'failed'; message: string }

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'Неизвестная ошибка'
}

/**
 * Настройки разделами, свёрнутыми: в них заходят за чем-то одним, и экран
 * читается как оглавление. Устройство — «Трапезы» и «Дневников».
 *
 * Разделов четыре: «Синхронизация», «Копия данных», «Напоминания»
 * и «О приложении». Напоминания появились вместе с тем, о чём напоминать
 * (Этап 1, п. 9): месяц, который не внесён, и регулярные, которых ещё нет.
 */
export function Settings() {
  const [state, setState] = useState<State>({ status: 'loading' })

  const load = useCallback(async () => {
    try {
      await db.ready()
      const rows: Row[] = []
      for (const store of SYNCED_STORES) {
        rows.push({ store, live: await db.count(store), total: await db.count(store, { includeDeleted: true }) })
      }
      setState({ status: 'ready', rows })
    } catch (error) {
      setState({ status: 'failed', message: describe(error) })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <>
      <header className="screen-head">
        <h1>Настройки</h1>
      </header>

      <SyncSettings onChanged={load} />

      <Backup onChanged={load} />

      <Reminders />

      <About state={state} />
    </>
  )
}

/**
 * Копия данных файлом — механика ядра: `exportAll` и `importAll`. Она нужна
 * до синхронизации и после неё: синхронизация переносит данные между своими
 * устройствами, копия — спасает от потери.
 */
function Backup({ onChanged }: { onChanged: () => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null)
  const sync = useSyncStatus()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [lastSaved, setLastSaved] = useState<string | null | undefined>(undefined)

  // Дата последней выгрузки лежит в настройках устройства: они не
  // синхронизируются, и это правильно — «когда я забирал копию» у каждого
  // устройства своё.
  useEffect(() => {
    void db.settings.get<string>(LAST_EXPORT).then((value) => setLastSaved(value ?? null))
  }, [])

  async function save() {
    setBusy(true)
    setNote('')
    setError('')
    try {
      const snapshot = await db.exportAll()
      download(`${config.dbName}-${today()}.json`, JSON.stringify(snapshot, null, 2))
      // Браузер не сообщает, дошёл ли файл до диска: диалог мог быть отменён.
      // Отметка означает «выгрузку запускали», а не «копия точно есть».
      const at = new Date().toISOString()
      await db.settings.set(LAST_EXPORT, at)
      setLastSaved(at)
      setNote('Файл сохранён')
    } catch (failure) {
      setError(describe(failure))
    } finally {
      setBusy(false)
    }
  }

  /** Выгрузка в markdown: месяц или всё время. */
  async function asText(month: string | null) {
    setBusy(true)
    setNote('')
    setError('')
    try {
      const data = (await db.exportAll()).data
      const span = month ? { period: monthPeriod(month), label: formatMonth(month) } : null
      const text = markdownExport(data, today(), span)
      download(`${config.dbName}-${month ?? 'всё'}.md`, text, 'text/markdown')
      setNote('Файл сохранён')
    } catch (failure) {
      setError(describe(failure))
    } finally {
      setBusy(false)
    }
  }

  async function open(file: File) {
    setBusy(true)
    setNote('')
    setError('')
    try {
      const applied = await db.importAll(db.parseSnapshot(await file.text()))
      await onChanged()
      setNote(applied === 0 ? 'Ничего не изменилось: в файле нет записей новее здешних' : `Загружено записей: ${applied}`)
    } catch (failure) {
      setError(describe(failure))
    } finally {
      setBusy(false)
      // Одинаковый файл должен открываться повторно — без сброса второй
      // выбор того же файла не даёт события.
      if (input.current) input.current.value = ''
    }
  }

  // Тон говорит, тревожить ли: копии нет — красным, копия в репозитории —
  // приглушённо. Правило одно и живёт в ядре.
  const summary = lastSaved === undefined ? undefined : backupSummary(lastSaved, sync, today())
  const state = backupNote(lastSaved ?? null, sync, today())

  return (
    <Fold
      id="settings:backup"
      title="Копия данных"
      summary={summary && <span className={summary.tone === 'error' ? 'error' : 'muted'}>{summary.text}</span>}
      folded
    >
      <p className={state.tone === 'error' ? 'error' : 'muted'}>{state.text}</p>

      <div className="row">
        <button type="button" onClick={() => void save()} disabled={busy}>
          Сохранить копию
        </button>
        <button type="button" onClick={() => input.current?.click()} disabled={busy}>
          Восстановить из копии
        </button>
      </div>

      <input
        ref={input}
        type="file"
        accept="application/json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void open(file)
        }}
      />

      {note && <p className="note">{note}</p>}
      {error && <p className="error">{error}</p>}

      <h3>Выгрузка для чтения</h3>
      <p className="muted">
        Текстом, а не для переноса: обратно такой файл не загружается. Пригодится, чтобы разобрать
        месяц в беседе с ИИ.
      </p>
      <div className="row row--wrap">
        <button type="button" disabled={busy} onClick={() => void asText(null)}>
          Весь учёт
        </button>
        <button type="button" disabled={busy} onClick={() => void asText(monthOf(today()))}>
          Этот месяц
        </button>
      </div>
    </Fold>
  )
}

function download(name: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

// ─── Напоминания ───────────────────────────────────────────────────────────

/**
 * Что происходит сейчас — по состоянию, которое отдаёт ядро. Текст свой:
 * он про деньги, а не про еду или задачи.
 */
const REMINDER_TEXT: Record<ReminderStatus, string> = {
  unsupported:
    'Этот браузер не умеет напоминать, когда приложение закрыто. Напоминания работают ' +
    'в Chrome на Android у установленного приложения.',
  denied: 'Уведомления для этого сайта запрещены в настройках браузера. Разрешить их можно только там.',
  off: 'Приложение напомнит, когда прошлый месяц не внесён или когда этого месяца ждут регулярные. Даже закрытое.',
  'not-installed':
    'Уведомления разрешены, но фоновую проверку браузер не дал. Так бывает, когда приложение ' +
    'открыто во вкладке, а не установлено иконкой.',
  on: 'Включено. Браузер проверяет примерно раз в сутки, точное время выбирает сам.',
}

const REMINDER_SUMMARY: Record<ReminderStatus, string> = {
  unsupported: 'браузер не умеет',
  denied: 'запрещены',
  off: 'выключены',
  'not-installed': 'выключены',
  on: 'включены',
}

const CHECK_TEXT: Record<RemindResult | 'denied' | 'unsupported', string> = {
  shown: 'Уведомление показано.',
  quiet: 'Уведомление показано без звука.',
  nothing:
    'Напоминать не о чем — месяц внесён и регулярные записаны. Пришло пустое уведомление, ' +
    'чтобы было видно, что они доходят.',
  already: 'Сегодня уже напоминало.',
  failed: 'Показать уведомление не вышло.',
  denied: 'Уведомления запрещены — показать нечего.',
  unsupported: REMINDER_TEXT.unsupported,
}

const WAKE_TEXT: Record<RemindResult, string> = {
  shown: 'показано со звуком',
  quiet: 'показано без звука — вне окна',
  nothing: 'напоминать было не о чем',
  already: 'сегодня уже напоминало',
  failed: 'показать не вышло',
}

/**
 * Напоминания включаются кнопкой, а не сами: разрешение на уведомления
 * браузер спрашивает только по действию человека. «Проверить сейчас» —
 * чтобы не ждать сутки, прежде чем узнать, работает ли.
 */
function Reminders() {
  const [status, setStatus] = useState<ReminderStatus | null>(null)
  const [hours, setHours] = useState<ReminderWindow | null>(null)
  const [wakes, setWakes] = useState<Wake[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => {
    void reminders
      .reminderStatus()
      .then(setStatus)
      .catch(() => setStatus('unsupported'))
    void reminders.readWindow().then(setHours)
    void reminders
      .readWakes()
      .then(setWakes)
      .catch(() => setWakes([]))
  }, [])

  async function pickHours(next: ReminderWindow) {
    setHours(next)
    await reminders.saveWindow(next)
  }

  async function act(action: () => Promise<void>) {
    setBusy(true)
    setNote('')
    try {
      await action()
    } catch (failure) {
      setNote(describe(failure))
    } finally {
      setBusy(false)
    }
  }

  const summary =
    status === null
      ? undefined
      : status === 'on' && hours
        ? `включены, ${hours.from}–${hours.to}`
        : REMINDER_SUMMARY[status]
  const usable = status !== null && status !== 'unsupported' && status !== 'denied'

  return (
    <Fold id="settings:reminders" title="Напоминания" summary={summary} folded>
      {status !== null && (
        <>
          <p className="muted">{REMINDER_TEXT[status]}</p>

          <ul>
            <li>
              <b>Месяц не внесён</b> — если за прошлый месяц нет ни одной записи. С{' '}
              {REMIND_FROM_DAY}-го числа, не раньше: выписка формируется не мгновенно.
            </li>
            <li>
              <b>Регулярные</b> — если этого месяца ждут платежи, которых ещё нет. С{' '}
              {RECURRING_FROM_DAY}-го числа.
            </li>
          </ul>

          <div className="row row--wrap">
            {(status === 'off' || status === 'not-installed') && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(async () => setStatus(await reminders.enableReminders()))}
              >
                Включить напоминания
              </button>
            )}
            {status === 'on' && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await reminders.disableReminders()
                    setStatus('off')
                  })
                }
              >
                Выключить
              </button>
            )}
            {usable && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(async () => setNote(CHECK_TEXT[await reminders.checkReminder()]))}
              >
                Проверить сейчас
              </button>
            )}
          </div>

          {note && <p className="muted">{note}</p>}

          {usable && hours && (
            <>
              <div className="row row--wrap">
                <HourField label="Со звуком с" value={hours.from} onPick={(from) => void pickHours({ ...hours, from })} />
                <HourField label="до" value={hours.to} onPick={(to) => void pickHours({ ...hours, to })} />
              </div>
              <p className="muted">
                Вне этих часов уведомление приходит без звука и ждёт в шторке. Часы — по времени этого
                устройства.
              </p>
            </>
          )}

          {usable && <WakeLog wakes={wakes} />}
        </>
      )}
    </Fold>
  )
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour)

function HourField({ label, value, onPick }: { label: string; value: number; onPick: (hour: number) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onPick(Number(event.target.value))}>
        {HOURS.map((hour) => (
          <option key={hour} value={hour}>{`${hour}:00`}</option>
        ))}
      </select>
    </label>
  )
}

function wakeTime(at: string): string {
  return new Date(at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/**
 * Журнал фоновых проверок: будит ли их браузер вообще и чем они кончаются.
 * Без него «ни разу не пришло само» — три неразличимых случая: не будил;
 * будил, но напоминать было не о чем; будил, но сегодня уже было.
 */
function WakeLog({ wakes }: { wakes: Wake[] | null }) {
  if (wakes === null) return null

  const last = wakes[0]
  if (!last) return <p className="muted">Фоновая проверка на этом устройстве ещё ни разу не просыпалась.</p>

  return (
    <>
      <p className="muted">
        Фоновая проверка последний раз: {wakeTime(last.at)} — {WAKE_TEXT[last.result]}.
      </p>
      {wakes.length > 1 && (
        <Fold id="settings:reminders:wakes" title="Все пробуждения" summary={wakes.length} sub folded>
          <ul className="plain">
            {wakes.map((wake) => (
              <li key={wake.at} className="muted">
                {wakeTime(wake.at)} — {WAKE_TEXT[wake.result]}
              </li>
            ))}
          </ul>
        </Fold>
      )}
    </>
  )
}

function About({ state }: { state: State }) {
  return (
    <Fold id="settings:about" title="О приложении" folded>
      <p className="muted">
        {config.name}: {config.about.data}. Всё хранится на этом устройстве и работает без сети.
      </p>

      <h3 className="unit__name">Что где лежит</h3>
      {state.status === 'loading' && <p className="muted">Считаю…</p>}
      {state.status === 'failed' && <p className="error">{state.message}</p>}
      {state.status === 'ready' && (
        <ul>
          {state.rows.map((row) => (
            <li key={row.store}>
              {LABELS[row.store]}: {row.live}
              {row.total > row.live && <span className="muted"> (и ещё удалённых: {row.total - row.live})</span>}
            </li>
          ))}
        </ul>
      )}

      <p className="muted">
        Версия схемы данных: {SCHEMA_VERSION}. Сборка: {__BUILD_TIME__}.
      </p>

      <h3 className="unit__name">Установка</h3>
      <InstallNote empty={false} />

      <h3 className="unit__name">Что нового</h3>
      <ChangeList changes={CHANGES} />

      <ReportBug />
    </Fold>
  )
}
