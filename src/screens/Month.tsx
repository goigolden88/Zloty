import { Link } from 'react-router-dom'
import { config } from '../app/config.ts'
import { CHANGES } from '../changes.ts'
import { SYNCED_STORES } from '../app/model.ts'
import { WhatsNew } from '../shared/screens/WhatsNew.tsx'
import { useFirstRun } from '../shared/screens/useFirstRun.ts'
import { useWhatsNew } from '../shared/screens/useWhatsNew.ts'
import { Welcome } from './Welcome.tsx'

/**
 * Главный экран — «Месяц»: сколько отложено и хватает ли дохода (Р-07).
 *
 * В Этапе 0 он пустой намеренно: экраны ввода, импорт и расчёты приходят
 * в Этапе 1. Пустой экран говорит, чего ещё нет, а не показывает нули —
 * ноль здесь означал бы «вы ничего не потратили», и это была бы неправда.
 */
export function Month() {
  const base = useFirstRun(SYNCED_STORES)
  const whatsNew = useWhatsNew(base, CHANGES)

  if (whatsNew.show.length > 0) return <WhatsNew changes={whatsNew.show} onDone={whatsNew.dismiss} />

  return (
    <>
      <header className="screen-head">
        <div className="screen-head__row">
          <h1>Месяц</h1>
          <div className="screen-head__tools">
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

      <p className="muted">
        Учёта здесь пока нет: {config.name} установлены и работают без сети, а счета, операции и ответ «сколько
        я отложил» появятся на следующем шаге.
      </p>

      <p className="muted">
        Пока можно настроить синхронизацию и файл-копию в «Настройках» — данные, которые появятся, сразу будут
        уезжать на второе устройство.
      </p>
    </>
  )
}
