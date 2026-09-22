/**
 * Конфиг «Злотых» для ядра `FamilyCore` (Р-03, Р-47 «Трапезы»).
 *
 * Всё, чем «Злотые» отличаются для ядра, — одним объектом. Значения —
 * из `docs/02-Архитектура.md`: имя базы, состав `v1Stores`, индексы
 * и раскладка лягут на устройства и в `ZlotyData` с первым релизом
 * и после этого не меняются. Сторож — `config.test.ts`.
 */

import type { AppConfig } from '../shared/core/model.ts'
import { entryDate, MIGRATIONS, SCHEMA_VERSION, SYNCED_STORES, V1_STORES, type StoreRecord } from './model.ts'

export const config: AppConfig<StoreRecord> = {
  name: 'Злотые',

  // Имя обязано отличаться от `dnevniki`, `deluvremya` и `trapeza`: все
  // приложения семьи живут на одном origin, а IndexedDB различается только
  // именем. Не меняется никогда (Р-10).
  dbName: 'zloty',

  schemaVersion: SCHEMA_VERSION,
  migrations: MIGRATIONS,
  stores: SYNCED_STORES,

  // Восемь хранилищ учёта и снимков (Р-11, Р-12) — раскладка версии 1,
  // замороженная с первым релизом. Семь хранилищ долгов завела миграция
  // на версию 2 (Р-30); сюда они не дописываются никогда.
  v1Stores: V1_STORES,

  // Сверх `updatedAt`. Месяц читается по дате, повтор импорта ловится по
  // `ext`, история счёта — по `accountId` (02-Архитектура, «Хранение»).
  // Хранилищам долгов своих индексов не заводим: читать по ним ядро всё равно
  // не умеет, а записей там сотни за год.
  indexes: {
    profile: [],
    currencies: [],
    accounts: [],
    categories: [],
    recurring: [],
    rates: ['date'],
    entries: ['date', 'ext', 'accountId'],
    balances: ['date', 'accountId'],
    people: [],
    rooms: [],
    roomEvents: [],
    roomSpends: [],
    roomTransfers: [],
    loans: [],
    repayments: [],
  },

  // 02-Архитектура, «Раскладка данных в репозитории». Правило одно на всё:
  // справочники — одним файлом, датированное — по месяцам.
  places: {
    profile: { split: 'none', path: 'profile.json' },
    currencies: { split: 'none', path: 'currencies.json' },
    accounts: { split: 'none', path: 'accounts.json' },
    categories: { split: 'none', path: 'categories.json' },
    recurring: { split: 'none', path: 'recurring.json' },
    rates: { split: 'month', dir: 'rates', dateOf: (rate) => rate.date },
    // Операция — по своей дате, итог периода — по концу периода (Р-12).
    // Ни того ни другого не оказалось — запись уходит в undated.json,
    // а не теряется.
    entries: { split: 'month', dir: 'entries', dateOf: entryDate },
    balances: { split: 'month', dir: 'balances', dateOf: (balance) => balance.date },
    // Долги (Р-30). Люди и комнаты — справочники; событие, трата, перевод,
    // долг и возврат несут свою дату и ложатся по ней.
    people: { split: 'none', path: 'people.json' },
    rooms: { split: 'none', path: 'rooms.json' },
    roomEvents: { split: 'month', dir: 'events', dateOf: (event) => event.date },
    roomSpends: { split: 'month', dir: 'spends', dateOf: (spend) => spend.date },
    roomTransfers: { split: 'month', dir: 'transfers', dateOf: (transfer) => transfer.date },
    loans: { split: 'month', dir: 'loans', dateOf: (loan) => loan.date },
    repayments: { split: 'month', dir: 'repayments', dateOf: (repayment) => repayment.date },
  },

  storeNotes: {
    profile: 'настройки учёта: валюты, отчётный период, цель',
    currencies: 'валюты: знаки после запятой и единица показа',
    accounts: 'счета — где лежат деньги',
    categories: 'категории расходов и доходов',
    recurring: 'шаблоны регулярных расходов',
    rates: 'курсы валют — по дате курса',
    entries: 'операции и итоги периодов — по месяцу, к которому относятся',
    balances: 'снимки остатков — по дате снимка',
    people: 'люди: на комнаты и разовые долги; «я» — с пометкой',
    rooms: 'комнаты — компании, на которые ведётся общий счёт',
    roomEvents: 'события комнат — поводы, на которые скидывались',
    roomSpends: 'траты событий: кто заплатил и на кого делится',
    roomTransfers: 'переводы внутри комнаты — кто кому вернул',
    loans: 'разовые долги: дал или взял',
    repayments: 'возвраты разовых долгов, в том числе частями',
  },

  importFormat: 'zloty-import',

  // Свои правила промпта — первыми, общие ядро допишет следом. Правила про
  // поля живут в описаниях разделов `modules/<модуль>/import.ts`, а не здесь.
  promptRules: [
    'Записей не выдумывай: чего нет в моих данных — не пиши. Необязательное поле, которого нет ' +
      'в данных, опусти. Запись без обязательного поля не пиши вовсе, а назови в списке после JSON.',
    'Даты — ГГГГ-ММ-ДД, время — ЧЧ:ММ. Любой вид (24.01.26, 20-02-2026, «3 марта») приводи к нему. ' +
      'Дата обработки банком — не дата операции: бери дату, когда операция совершена.',
    'Суммы — в обычных единицах, как в выписке: 1234.56, а не в копейках. Знак не ставь: ' +
      'направление задаёт вид записи. Валюту указывай кодом — RUB, USD.',
    'Итоги, проценты и суммы за месяц не переноси: приложение посчитает их само.',
  ],

  about: {
    data: 'учёт денег: операции и итоги периодов, счета, курсы и снимки остатков',
    privacy: 'внутри то, сколько вы получаете и на что тратите, и остатки на счетах',
    sources: 'выписки банков, скриншоты операций и таблицы учёта',
  },
}
