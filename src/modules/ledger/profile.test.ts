import { describe, expect, it } from 'vitest'
import type { Profile } from '../../app/model.ts'
import {
  DEFAULT_PERIOD_START_DAY,
  extraProfiles,
  MAX_PERIOD_START_DAY,
  periodStartDay,
  profileProblem,
  profileWrites,
  readProfile,
  saveProfile,
} from './profile.ts'

const CURRENCIES = [{ code: 'RUB' }, { code: 'USD' }, { code: 'EUR', deleted: true }]

function profile(fields: Partial<Profile> & { id: string; updatedAt: string }): Profile {
  return { baseCurrency: 'RUB', ...fields }
}

describe('одна запись настроек', () => {
  it('нет записи — нет и догадки: null, а не выдуманный рубль', () => {
    expect(readProfile([])).toBeNull()
    expect(readProfile([profile({ id: 'a', updatedAt: '2026-09-01T00:00:00.000Z', deleted: true })])).toBeNull()
  })

  it('записей две — побеждает поздняя, тем же правилом, что у синхронизации', () => {
    const list = [
      profile({ id: 'a', updatedAt: '2026-09-01T00:00:00.000Z', baseCurrency: 'USD' }),
      profile({ id: 'b', updatedAt: '2026-09-20T00:00:00.000Z', baseCurrency: 'RUB' }),
    ]
    expect(readProfile(list)?.id).toBe('b')
    expect(extraProfiles(list).map((each) => each.id)).toEqual(['a'])
  })

  it('запись одна — убирать нечего', () => {
    expect(extraProfiles([profile({ id: 'a', updatedAt: '2026-09-01T00:00:00.000Z' })])).toEqual([])
  })

  it('правка не заводит вторую запись', () => {
    const was = profile({ id: 'a', updatedAt: '2026-09-01T00:00:00.000Z' })
    expect(saveProfile(was, { baseCurrency: 'USD' }).id).toBe('a')
  })
})

describe('лишние записи настроек уходят надгробиями', () => {
  it('одна запись — писать только её', () => {
    const was = profile({ id: 'a', updatedAt: '2026-09-01T00:00:00.000Z' })
    const { records } = profileWrites([was], was, { baseCurrency: 'USD' })
    expect(records).toHaveLength(1)
    expect(records[0]?.deleted).toBeUndefined()
  })

  it('две записи с двух устройств — вторая уходит надгробием', () => {
    const mine = profile({ id: 'a', updatedAt: '2026-09-01T00:00:00.000Z' })
    const theirs = profile({ id: 'b', updatedAt: '2026-09-02T00:00:00.000Z', baseCurrency: 'USD' })
    const { saved, records } = profileWrites([mine, theirs], mine, { baseCurrency: 'RUB' })
    expect(saved.id).toBe('a')
    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({ id: 'b', deleted: true })
  })

  it('надгробие второй раз не ставится', () => {
    const mine = profile({ id: 'a', updatedAt: '2026-09-01T00:00:00.000Z' })
    const gone = profile({ id: 'b', updatedAt: '2026-09-02T00:00:00.000Z', deleted: true })
    expect(profileWrites([mine, gone], mine, { baseCurrency: 'RUB' }).records).toHaveLength(1)
  })

  it('первой записи ещё нет — пишется только она', () => {
    expect(profileWrites([], null, { baseCurrency: 'RUB' }).records).toHaveLength(1)
  })
})

describe('проверка настроек', () => {
  it('валюта обязательна и обязана быть в справочнике', () => {
    expect(profileProblem({ baseCurrency: '' }, CURRENCIES)).toContain('не выбрана валюта')
    expect(profileProblem({ baseCurrency: 'BTC' }, CURRENCIES)).toBe('валюты BTC нет в справочнике')
  })

  it('удалённая валюта справочником не считается', () => {
    expect(profileProblem({ baseCurrency: 'EUR' }, CURRENCIES)).toBe('валюты EUR нет в справочнике')
  })

  it('вторая валюта не совпадает с основной', () => {
    expect(profileProblem({ baseCurrency: 'RUB', showCurrency: 'RUB' }, CURRENCIES)).toContain('совпадает')
    expect(profileProblem({ baseCurrency: 'RUB', showCurrency: 'USD' }, CURRENCIES)).toBeNull()
  })

  it('начало периода дальше 28-го не ставится: такого числа может не быть в феврале', () => {
    expect(profileProblem({ baseCurrency: 'RUB', periodStartDay: MAX_PERIOD_START_DAY }, CURRENCIES)).toBeNull()
    expect(profileProblem({ baseCurrency: 'RUB', periodStartDay: 29 }, CURRENCIES)).toContain(
      `от 1 до ${MAX_PERIOD_START_DAY}`,
    )
    expect(profileProblem({ baseCurrency: 'RUB', periodStartDay: 0 }, CURRENCIES)).not.toBeNull()
  })

  it('цель — доля, а не проценты: 20 вместо 0,2 не проходит', () => {
    expect(profileProblem({ baseCurrency: 'RUB', savingsGoal: 0.2 }, CURRENCIES)).toBeNull()
    expect(profileProblem({ baseCurrency: 'RUB', savingsGoal: 20 }, CURRENCIES)).toContain('доля дохода')
    expect(profileProblem({ baseCurrency: 'RUB', savingsGoal: 1 }, CURRENCIES)).not.toBeNull()
    expect(profileProblem({ baseCurrency: 'RUB', savingsGoal: 0 }, CURRENCIES)).toBeNull()
  })
})

describe('запись настроек', () => {
  it('пустые поля не пишутся вовсе, а не пишутся пустыми', () => {
    const saved = saveProfile(null, { baseCurrency: 'RUB' })
    expect(Object.keys(saved).sort()).toEqual(['baseCurrency', 'id', 'updatedAt'])
  })

  it('календарный месяц не пишется в запись: он и есть значение по умолчанию', () => {
    const saved = saveProfile(null, { baseCurrency: 'RUB', periodStartDay: DEFAULT_PERIOD_START_DAY })
    expect('periodStartDay' in saved).toBe(false)
    expect(periodStartDay(saved)).toBe(DEFAULT_PERIOD_START_DAY)
  })

  it('свой отчётный период пишется и читается', () => {
    const saved = saveProfile(null, { baseCurrency: 'RUB', periodStartDay: 10 })
    expect(periodStartDay(saved)).toBe(10)
  })

  it('настроек нет — месяц календарный', () => {
    expect(periodStartDay(null)).toBe(DEFAULT_PERIOD_START_DAY)
  })
})
