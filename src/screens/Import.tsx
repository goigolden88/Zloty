import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { db } from '../app/core.ts'
import { lastDayOn } from '../modules/ledger/entries.ts'
import { active } from '../modules/ledger/ledger.ts'
import { importPrompt, planImport, type Data } from '../registry.ts'
import { formatDate, type DateStr } from '../shared/core/dates.ts'
import { ImportRecords } from '../shared/screens/ImportRecords.tsx'

/**
 * Импорт выписок и учёта — единственная дверь в данные извне (Р-09).
 *
 * Экран ядра с разбором и промптом этого модуля (Р-03). Своё здесь — слова
 * над полем и то, чего ядро знать не может: по какому день уже загружено
 * на каждом счёте. Это же уходит в промпт (Р-12, п. 5), но человеку нужно
 * видеть это глазами до того, как он пойдёт просить выписку.
 */
export function Import() {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      await db.ready()
      setData((await db.exportAll()).data)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Неизвестная ошибка')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Читаю…</p>

  return (
    <>
      <header className="screen-head">
        <div className="screen-head__row">
          <h1>Загрузить выписку</h1>
          <div className="screen-head__tools">
            <Link className="gear" to="/help" aria-label="Справка">
              ?
            </Link>
          </div>
        </div>
      </header>

      <ImportRecords
        planImport={planImport}
        importPrompt={(day: DateStr) => importPrompt(data, day)}
        intro={<Intro data={data} />}
        onChanged={load}
      />
    </>
  )
}

/**
 * Что загружают и с какого дня. Дата последней операции — не украшение:
 * выписка берётся с этого дня включительно, иначе потеряются операции,
 * случившиеся после того, как прошлая выписка была сформирована (Р-12, п. 5).
 */
function Intro({ data }: { data: Data }) {
  const accounts = active(data.accounts).filter((account) => !account.ledgerOnly)

  return (
    <>
      <p>
        Сюда загружаются выписки банков и записи учёта — разобранные в беседе с ИИ по промпту внизу
        экрана. Руками вносится только то, чего в выписке не будет.
      </p>

      {accounts.length === 0 ? (
        <p className="muted">
          Счетов пока нет — заведите их на <Link to="/books">«Счетах и категориях»</Link>, иначе операции
          будет некуда положить.
        </p>
      ) : (
        <>
          <h3>С какого дня брать выписку</h3>
          <ul className="plain">
            {accounts.map((account) => {
              const last = lastDayOn(data.entries, account.id)
              return (
                <li key={account.id} className="line">
                  <div className="line__main">
                    <b>{account.name}</b>{' '}
                    <span className="muted">
                      {last
                        ? `· загружено по ${formatDate(last)} — берите выписку с этого дня, его тоже`
                        : '· операций ещё нет — берите выписку с любого дня'}
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
          <p className="muted">
            День повторяется намеренно: операции этого дня могли появиться уже после того, как прошлая
            выписка была сформирована. Повторы приложение отсечёт само.
          </p>
        </>
      )}
    </>
  )
}
