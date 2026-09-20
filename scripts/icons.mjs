/**
 * Иконки PWA «Злотых» из геометрии public/favicon.svg.
 *
 * Растеризатор и PNG — ядра (`shared/scripts/icons.mjs`); здесь — свои цвет
 * и рисунок. Запускается руками (`npm run icons`), результат коммитится.
 * В сборку не входит: иконка меняется раз в год.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BACKGROUND, INK, writeIcons } from '../src/shared/scripts/icons.mjs'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

/**
 * Акцент «Злотых» — пурпур. Золото напрашивалось по имени, но «Делу Время»
 * уже янтарное: две тёплые иконки на одном телефоне различались бы плохо.
 * Фон общий у всей семьи, акцент у каждого свой — синий, янтарный, зелёный,
 * пурпурный.
 */
const ACCENT = [0xc0, 0x7a, 0xe8]

/**
 * Те же фигуры, что в favicon.svg. Расходиться им нельзя.
 *
 * Три растущих столбика — то, ради чего приложение заводится: видно, что
 * откладывается. Всё внутри безопасной зоны maskable: круга в 80% стороны,
 * который система не обрежет никогда.
 */
const SHAPES = [
  // Столбики, слева направо — выше и ярче
  { x: 128, y: 250, w: 56, h: 110, r: 28, color: ACCENT, alpha: 0.5 },
  { x: 228, y: 200, w: 56, h: 160, r: 28, color: ACCENT, alpha: 0.75 },
  { x: 328, y: 150, w: 56, h: 210, r: 28, color: ACCENT, alpha: 1 },
  // Черта основания: столбики стоят на ней, а не висят
  { x: 118, y: 378, w: 276, h: 16, r: 8, color: INK, alpha: 1 },
]

writeIcons({ out: OUT, shapes: SHAPES, background: BACKGROUND })
