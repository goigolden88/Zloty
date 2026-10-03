/**
 * Данные расчёта «Месяца» — так, как их собирает экран.
 *
 * Здесь, а не в экране, по двум причинам. Своя доля связанных операций
 * считается по долгам (Р-31), а учёт про них не знает — свести их может
 * только сводка. И пропущенное поле здесь видно тестом: без периодов
 * все расчёты «Месяца» считали особыми только траты с флагом (Р-55),
 * и экран не показывал этого ничем.
 */

import type { Currency, Entry, Rate, SpecialPeriod } from '../app/model.ts'
import type { DebtsData } from '../modules/debts/summary.ts'
import type { MonthData } from '../modules/ledger/month.ts'
import { liveSpecials } from '../modules/ledger/specials.ts'
import { ownShares } from './shares.ts'

export function monthData(input: {
  entries: readonly Entry[]
  currencies: readonly Currency[]
  rates: readonly Rate[]
  base: string
  debts: DebtsData
  specials: readonly SpecialPeriod[]
}): MonthData {
  return {
    entries: input.entries,
    currencies: input.currencies,
    rates: input.rates,
    base: input.base,
    // Связанная операция входит в поток долей, а не суммой (Р-31).
    shares: ownShares(input.entries, input.debts).amounts,
    // Расход с датой внутри живого периода — особый (Р-55).
    specials: liveSpecials(input.specials),
  }
}
