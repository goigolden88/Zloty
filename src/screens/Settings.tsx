import { useCallback, useEffect, useRef, useState } from 'react'
import { config } from '../app/config.ts'
import { db } from '../app/core.ts'
import { CHANGES } from '../changes.ts'
import { SCHEMA_VERSION, SYNCED_STORES } from '../app/model.ts'
import { today } from '../shared/core/dates.ts'
import { backupNote, backupSummary } from '../shared/ui/backup.ts'
import { Fold } from '../shared/ui/Fold.tsx'
import { InstallNote } from '../shared/ui/Install.tsx'
import { ReportBug } from '../shared/ui/Report.tsx'
import { SyncSettings } from '../shared/ui/SyncSettings.tsx'
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
 * В Этапе 0 разделов три: «Синхронизация», «Копия данных» и «О приложении».
 * «Напоминания» придут вместе с тем, о чём напоминать (Этап 1).
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
    </Fold>
  )
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
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
              {row.total > row.live && <span className="muted"> (и {row.total - row.live} удалённых)</span>}
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
