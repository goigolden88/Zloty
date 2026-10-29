import { describe, expect, it } from 'vitest'
import { notSaved, oneAtATime } from './once.ts'

/** Запись, которую тест отпускает сам: так видно, что второй тап пришёл раньше конца первой. */
function pending() {
  let finish: () => void = () => {}
  let fail: (error: Error) => void = () => {}
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  return { done, finish, fail }
}

describe('одна запись за раз (Р-60)', () => {
  it('второй тап, пока идёт первая запись, ничего не пишет', async () => {
    const seen: boolean[] = []
    const once = oneAtATime((busy) => seen.push(busy))
    const write = pending()
    let writes = 0

    const first = once(() => {
      writes += 1
      return write.done
    })
    const second = once(async () => {
      writes += 1
    })
    write.finish()
    await Promise.all([first, second])

    expect(writes).toBe(1)
    expect(seen).toEqual([true, false])
  })

  it('после записи следующий тап снова пишет', async () => {
    const once = oneAtATime(() => {})
    let writes = 0
    await once(async () => {
      writes += 1
    })
    await once(async () => {
      writes += 1
    })
    expect(writes).toBe(2)
  })

  it('сбой отдаётся форме, а кнопка снова доступна', async () => {
    const seen: boolean[] = []
    const once = oneAtATime((busy) => seen.push(busy))
    const write = pending()

    const first = once(() => write.done)
    write.fail(new Error('база недоступна'))
    await expect(first).rejects.toThrow('база недоступна')
    expect(seen).toEqual([true, false])

    let writes = 0
    await once(async () => {
      writes += 1
    })
    expect(writes).toBe(1)
  })

  it('текст сбоя — один на всех экранах', () => {
    expect(notSaved(new Error('база недоступна'))).toBe('не записалось: Error: база недоступна')
  })
})
