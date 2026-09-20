import { describe, expect, it } from 'vitest'
import help from './Help.tsx?raw'
import welcome from './Welcome.tsx?raw'

/**
 * Сторож цифр: в справке и приветствии числа собираются из констант кода,
 * а не вписываются руками (CLAUDE.md, «Правила интерфейса»). Поменяли срок
 * годности курса — текст меняется сам, а не расходится с поведением молча.
 *
 * Импорты, комментарии и имена тегов не в счёт: в комментариях — номера
 * решений, в разметке — `<h1>` и `<h3>`, а не текст для человека.
 *
 * Устройство сторожа — «Трапезы», у неё — из «Делу Время» и «Дневников».
 */
function typedNumbers(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(import\b|\/\/)/.test(line))
    .filter((line) => /\d/.test(line.replace(/<\/?[A-Za-z][A-Za-z0-9]*/g, '')))
    .map((line) => line.trim())
}

describe('справка и приветствие — числа только из констант', () => {
  it.each([
    ['Help.tsx', help],
    ['Welcome.tsx', welcome],
  ])('в %s ни одна цифра не вписана руками', (_name, source) => {
    expect(typedNumbers(source)).toEqual([])
  })

  it('сторож ловит вписанное число и не трогает комментарии, импорты и разметку', () => {
    const sample = [
      "import { A1 } from './x.ts'",
      '/* Р-12 */',
      '// Р-04',
      '<h3>Справка</h3>',
      '<p>не старше 31 дня</p>',
      '<p>не старше {days(RATE_MAX_AGE_DAYS)}</p>',
    ].join('\n')

    expect(typedNumbers(sample)).toEqual(['<p>не старше 31 дня</p>'])
  })
})
