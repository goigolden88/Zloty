/**
 * Итог комнаты текстом — то, что уходит друзьям (Р-01, вариант А).
 *
 * Друзья получают снимок, а не живую комнату: вести её может только один
 * человек, пока нет сервера. Поэтому текст обязан быть самодостаточным —
 * с основаниями, а не с одними числами: сколько потрачено, по скольким
 * событиям, у кого какой итог и кто кому переводит.
 *
 * Собирается по кнопке, а не при каждой перерисовке: пока его не попросили,
 * он никому не нужен.
 */

import type { Currency, Person, RoomEvent, RoomSpend, RoomTransfer } from '../../app/model.ts'
import { formatDateLong, plural } from '../../shared/core/dates.ts'
import { formatMoney } from '../money/money.ts'
import { roomBalances, settle, spentTotal } from './balance.ts'

export type RoomText = {
  name: string
  personIds: readonly string[]
  people: readonly Person[]
  events: readonly RoomEvent[]
  spends: readonly RoomSpend[]
  transfers: readonly RoomTransfer[]
  code: string
  currency: Currency | null
}

/** Итог комнаты, готовый к отправке. */
export function roomText(input: RoomText): string {
  const { name, personIds, people, events, spends, transfers, code, currency } = input
  const money = (amount: number) => formatMoney({ amount, currency: code }, currency)
  const nameOf = (id: string) => people.find((each) => each.id === id)?.name ?? 'кто-то удалённый'

  const lines: string[] = [`${name} — кто кому должен`, '']

  lines.push(
    `Потрачено всего ${money(spentTotal(spends))} — ` +
      `${events.length} ${plural(events.length, ['событие', 'события', 'событий'])}, ` +
      `${spends.length} ${plural(spends.length, ['трата', 'траты', 'трат'])}.`,
  )

  const balances = roomBalances(personIds, spends, transfers)
  lines.push('', 'Итог по участникам:')
  for (const [personId, amount] of balances) {
    const tail = amount === 0 ? 'в расчёте' : amount > 0 ? `получит ${money(amount)}` : `должен ${money(-amount)}`
    lines.push(`— ${nameOf(personId)}: ${tail}`)
  }

  const left = settle(balances)
  lines.push('', left.length === 0 ? 'Переводить нечего: все в расчёте.' : 'Чтобы закрыть всё:')
  for (const line of left) {
    lines.push(`— ${nameOf(line.fromId)} → ${nameOf(line.toId)}: ${money(line.amount)}`)
  }

  if (transfers.length > 0) {
    lines.push('', 'Уже перевели:')
    for (const transfer of transfers) {
      const bank = transfer.note ? `, ${transfer.note}` : ''
      lines.push(
        `— ${nameOf(transfer.fromId)} → ${nameOf(transfer.toId)}: ${money(transfer.amount)}, ` +
          `${formatDateLong(transfer.date)}${bank}`,
      )
    }
  }

  return `${lines.join('\n')}\n`
}
