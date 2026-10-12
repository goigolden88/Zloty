/**
 * Ядро «Злотых» — собранное по её конфигу (Р-03).
 *
 * Код приложения берёт `db`, `sync`, `layout` и `importing` отсюда; `sync`
 * в демо нет. К хранилищу обращаются только через этот `db`: напрямую в IndexedDB
 * не ходит никто, кроме `shared/core/db.ts`. Общий интерфейс ядра получает
 * те же объекты контекстом — `<CoreProvider>` в `app.tsx` (Я-03 «FamilyCore»).
 */

import { createDb } from '../shared/core/db.ts'
import { createImporting } from '../shared/core/importing.ts'
import { createLayout } from '../shared/core/layout.ts'
import { createSync } from '../shared/core/sync.ts'
import { config } from './config.ts'

export const db = createDb(config)
// В демо синхронизации нет (Я-44 «FamilyCore»): база выдуманная, и `createSync`
// на ней падает — чтобы ни одна запись демо не уехала в `ZlotyData`.
export const sync = db.demo ? undefined : createSync(config, db)
export const layout = createLayout(config)
export const importing = createImporting(config)
