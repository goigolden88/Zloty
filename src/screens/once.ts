import { useState } from 'react'

/**
 * Одна запись за раз — на всех экранах, где тап пишет в базу (Р-60).
 *
 * Флаг ставится до первого `await`: два тапа подряд приходят раньше, чем
 * React перерисует кнопку неактивной, — `busy` только видимая часть.
 * Сбой записи флаг снимает: кнопка снова доступна, ошибка уходит наверх —
 * её показывает форма, введённое остаётся.
 */
export function oneAtATime(onBusy: (busy: boolean) => void) {
  let writing = false

  return async function once(write: () => Promise<void>): Promise<void> {
    if (writing) return
    writing = true
    onBusy(true)
    try {
      await write()
    } finally {
      writing = false
      onBusy(false)
    }
  }
}

/** `oneAtATime` для экрана: свой флаг у каждой формы и кнопки. */
export function useOnce() {
  const [busy, setBusy] = useState(false)
  const [once] = useState(() => oneAtATime(setBusy))
  return { busy, once }
}

/** Текст сбоя записи — один на всех экранах. */
export function notSaved(error: unknown): string {
  return `не записалось: ${String(error)}`
}
