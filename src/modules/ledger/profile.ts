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
import type { CurrencyCode, Profile } from '../../app/model.ts'

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

/** С какого числа считается месяц. Настройки нет — календарный. */
export function periodStartDay(profile: Profile | null): number {
  return profile?.periodStartDay ?? DEFAULT_PERIOD_START_DAY
}
