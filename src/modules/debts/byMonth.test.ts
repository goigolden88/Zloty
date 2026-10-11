import { describe, expect, it } from 'vitest'
import type { RoomEvent } from '../../app/model.ts'
import { byYearMonth, lastEventDate } from './byMonth.ts'

/** Записи выдуманные: код публичный (CLAUDE.md). */
const at = '2026-09-22T10:00:00.000Z'

type Item = { id: string; date: string | null }
const dateOf = (item: Item) => item.date

describe('закрытое — по годам и месяцам', () => {
  it('годы и месяцы — свежие сверху, в году — число записей', () => {
    const out = byYearMonth<Item>(
      [
        { id: 'a', date: '2025-03-10' },
        { id: 'b', date: '2026-05-02' },
        { id: 'c', date: '2026-01-20' },
        { id: 'd', date: '2026-05-28' },
      ],
      dateOf,
    )
    expect(out.years.map((year) => [year.year, year.count])).toEqual([
      ['2026', 3],
      ['2025', 1],
    ])
    expect(out.years[0]?.months.map((month) => month.month)).toEqual(['2026-05', '2026-01'])
    expect(out.years[0]?.months[0]?.items.map((item) => item.id)).toEqual(['d', 'b'])
    expect(out.undated).toEqual([])
  })

  it('без даты и с нечитаемой датой — отдельно, а не пропадают', () => {
    const out = byYearMonth<Item>(
      [
        { id: 'a', date: null },
        { id: 'b', date: 'вчера' },
        { id: 'c', date: '2026-05-02' },
      ],
      dateOf,
    )
    expect(out.years).toHaveLength(1)
    expect(out.undated.map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('пусто — ни годов, ни «без даты»', () => {
    expect(byYearMonth<Item>([], dateOf)).toEqual({ years: [], undated: [] })
  })
})

describe('день последнего события комнаты', () => {
  function event(over: Partial<RoomEvent> & { id: string }): RoomEvent {
    return { updatedAt: at, roomId: 'room-1', name: 'Поход', date: '2026-06-01', personIds: [], ...over }
  }

  it('берётся самый поздний, удалённые и чужие комнаты не в счёт', () => {
    const events = [
      event({ id: 'e1', date: '2026-06-01' }),
      event({ id: 'e2', date: '2026-07-15' }),
      event({ id: 'e3', date: '2026-09-01', deleted: true }),
      event({ id: 'e4', date: '2026-10-01', roomId: 'room-other' }),
    ]
    expect(lastEventDate(events, 'room-1')).toBe('2026-07-15')
  })

  it('событий нет — даты нет', () => {
    expect(lastEventDate([], 'room-1')).toBeNull()
  })
})
