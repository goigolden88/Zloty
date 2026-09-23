/**
 * Настройки учёта — одна запись `profile` (Р-12, п. 9): базовая валюта,
 * вторая валюта показа, начало отчётного периода, цель нормы сбережений.
 *
 * Почему не настройки устройства ядра: те не синхронизируются — в них лежит
 * токен. Базовая валюта — свойство данных, а не телефона: на втором
 * устройстве итоги обязаны считаться в той же валюте.
 *
 * **Единственность записи держат код и тест, а не тип.** Хранилище — обычное,
 * и слияние по `updatedAt` умеет разрешить правку одной записи на двух
 * устройствах, но не умеет выбрать между двумя разными записями. Поэтому:
 * читаем — берём одну по правилу ниже, пишем — правим ту же, а не заводим
 * вторую. Две записи всё же появились (две первые настройки до первой
 * синхронизации) — побеждает поздняя, а остальные уходят надгробиями.
 */

import { nowIso } from '../../shared/core/dates.ts'
import { ulid } from '../../shared/core/id.ts'
import type { Currency, CurrencyCode, Profile } from '../../app/model.ts'
import { sortedCurrencies } from './ledger.ts'

/** Календарный месяц: отчётный период начинается первым числом. */
export const DEFAULT_PERIOD_START_DAY = 1

/** Дальше 28-го начало периода не ставится: в феврале такого числа может не быть. */
export const MAX_PERIOD_START_DAY = 28

/**
 * Настройки учёта из хранилища.
 *
 * Записей больше одной — берётся правленная позже: это то же правило, по
 * которому сливает синхронизация, и оно даёт один ответ на всех устройствах.
 */
export function readProfile(list: readonly Profile[]): Profile | null {
  const live = list.filter((each) => !each.deleted)
  if (live.length === 0) return null
  return live.reduce((best, each) => (each.updatedAt > best.updatedAt ? each : best))
}

/** Лишние записи настроек — их пора убрать надгробиями. Обычно пусто. */
export function extraProfiles(list: readonly Profile[]): Profile[] {
  const kept = readProfile(list)
  if (!kept) return []
  return list.filter((each) => !each.deleted && each.id !== kept.id)
}

/**
 * В какой валюте считать итоги — и на каком основании.
 *
 * Настройки задают её прямо. Но приложение доходит до записей и без них:
 * валюта, счёт и операции приезжают одним файлом импорта, а `profile`
 * в формате нет. Упереться после этого в пустой «Месяц» — значит довести
 * человека до данных и не ответить на вопрос, ради которого всё затевалось.
 *
 * **Единственная заведённая валюта — не догадка:** выбирать не из чего,
 * и итог в ней единственно возможный. Экран всё равно называет основание
 * (Р-07): человек должен видеть, откуда взялась валюта, а не считать,
 * что её кто-то выбрал за него.
 *
 * Валют несколько, а настроек нет — итоги в **первой заведённой** (Р-41):
 * та, с которой человек начал учёт, почти всегда та, в которой он живёт.
 * Останавливать «Месяц» и «Капитал» до похода в настройки — неудобно, а
 * зашить рубль в код нельзя: у друга своя валюта (Р-04, п. 4). Экран
 * называет основание и то, где это меняется.
 */
export type BaseCurrency =
  /** Выбрана в настройках учёта. */
  | { code: CurrencyCode; from: 'profile' }
  /** Настроек нет, но валюта в справочнике одна. */
  | { code: CurrencyCode; from: 'only' }
  /** Настроек нет, валют несколько — первая заведённая (Р-41). */
  | { code: CurrencyCode; from: 'first' }
  /** Считать не в чем: валют нет вовсе. */
  | { pick: CurrencyCode[] }

export function baseCurrencyOf(
  profile: Profile | null,
  currencies: readonly Currency[],
): BaseCurrency {
  const live = currencies.filter((each) => !each.deleted)

  // Валюта настроек пропала из справочника — считать по ней нельзя:
  // ни знаков после запятой, ни знака валюты у неё больше нет.
  const chosen = profile ? live.find((each) => each.code === profile.baseCurrency) : undefined
  if (chosen) return { code: chosen.code, from: 'profile' }

  const only = live.length === 1 ? live[0] : undefined
  if (only) return { code: only.code, from: 'only' }

  const first = sortedCurrencies(live)[0]
  if (first) return { code: first.code, from: 'first' }

  return { pick: [] }
}

/** Что вводит человек. Валюта обязательна, остальное — по желанию. */
export type ProfileDraft = {
  baseCurrency: CurrencyCode
  showCurrency?: CurrencyCode
  periodStartDay?: number
  savingsGoal?: number
}

export function profileProblem(
  draft: ProfileDraft,
  currencies: readonly { code: CurrencyCode; deleted?: boolean }[],
): string | null {
  const known = (code: CurrencyCode) => currencies.some((each) => !each.deleted && each.code === code)

  if (!draft.baseCurrency) return 'не выбрана валюта, в которой считать итоги'
  if (!known(draft.baseCurrency)) return `валюты ${draft.baseCurrency} нет в справочнике`
  if (draft.showCurrency && !known(draft.showCurrency)) return `валюты ${draft.showCurrency} нет в справочнике`
  if (draft.showCurrency && draft.showCurrency === draft.baseCurrency) {
    return 'вторая валюта совпадает с основной — тогда её просто нет'
  }

  const day = draft.periodStartDay
  if (day !== undefined) {
    if (!Number.isInteger(day) || day < 1 || day > MAX_PERIOD_START_DAY) {
      return `день начала периода бывает от 1 до ${MAX_PERIOD_START_DAY}`
    }
  }

  const goal = draft.savingsGoal
  if (goal !== undefined) {
    // Цель — доля, а не проценты: 0.2 значит «откладывать 20%». Единица —
    // «откладывать всё», и это уже не цель, а опечатка.
    if (!(goal >= 0 && goal < 1)) return 'цель — доля дохода от 0 до 1: 0,2 значит «откладывать 20%»'
  }

  return null
}

/** Записать настройки: правим ту же запись, а не заводим вторую. */
export function saveProfile(current: Profile | null, draft: ProfileDraft): Profile {
  const profile: Profile = {
    id: current?.id ?? ulid(),
    updatedAt: nowIso(),
    baseCurrency: draft.baseCurrency,
  }
  if (draft.showCurrency) profile.showCurrency = draft.showCurrency
  if (draft.periodStartDay !== undefined && draft.periodStartDay !== DEFAULT_PERIOD_START_DAY) {
    profile.periodStartDay = draft.periodStartDay
  }
  if (draft.savingsGoal !== undefined) profile.savingsGoal = draft.savingsGoal
  return profile
}

/**
 * Что записать при сохранении настроек: сама запись и надгробия лишним.
 *
 * Единственность записи держит код, а не тип (Р-12, п. 9). Синхронизация
 * умеет слить правки одной записи, но не выбрать между двумя разными:
 * настройки, заведённые на двух устройствах до первого обмена, спорили бы
 * вечно. Здесь лишние уходят надгробиями, и побеждает сохранённая сейчас.
 */
export function profileWrites(
  list: readonly Profile[],
  current: Profile | null,
  draft: ProfileDraft,
): { saved: Profile; records: Profile[] } {
  const saved = saveProfile(current, draft)
  const others = list.filter((each) => !each.deleted && each.id !== saved.id)
  return { saved, records: [saved, ...others.map((each) => ({ ...each, deleted: true }))] }
}

/** С какого числа считается месяц. Настройки нет — календарный. */
export function periodStartDay(profile: Profile | null): number {
  return profile?.periodStartDay ?? DEFAULT_PERIOD_START_DAY
}
