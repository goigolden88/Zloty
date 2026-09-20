/**
 * Напоминания.
 *
 * Механика — окно со звуком, тихое вне окна, не чаще раза в день, журнал
 * пробуждений, разрешение — ядра (`shared/notify.ts`). Своё здесь — о чём
 * напоминать: правила в `modules/ledger/remind.ts` и тексты.
 *
 * Тем две, и они про разное: месяц, который не внесён, и регулярные,
 * которых ещё нет. Ядро показывает их по очереди, и громкое одной темы
 * не глушит другую.
 *
 * Живёт на уровне приложения, рядом с `app.tsx`, а не в модуле: оно знает
 * и записи, и регулярные. Тот же объект зовут работник (`remind`)
 * и «Настройки».
 */

import { DAY_KEYS, createReminders } from './shared/notify.ts'
import { db } from './app/core.ts'
import { monthNotice, recurringNotice } from './modules/ledger/remind.ts'

export const reminders = createReminders(db.settings, {
  async topics(day) {
    const [entries, recurring, categories, accounts] = await Promise.all([
      db.getAll('entries'),
      db.getAll('recurring'),
      db.getAll('categories'),
      db.getAll('accounts'),
    ])

    return [
      {
        notice: monthNotice(entries, day),
        tag: 'month',
        target: '/import',
        loudKey: DAY_KEYS.loud,
        quietKey: DAY_KEYS.quiet,
      },
      {
        notice: recurringNotice({ recurring, categories, accounts, entries }, day),
        tag: 'recurring',
        // Блок «Регулярные» живёт на «Операциях»: тап по уведомлению ведёт
        // туда, где это можно закрыть, а не на главный экран.
        target: '/entries',
        loudKey: DAY_KEYS.loud,
        quietKey: DAY_KEYS.quiet,
      },
    ]
  },
  idle: {
    title: 'Напоминать не о чем',
    body: 'Месяц внесён и регулярные записаны. Уведомление пришло, чтобы было видно: они доходят.',
    tag: 'month',
    target: '/',
  },
})
