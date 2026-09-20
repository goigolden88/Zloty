/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { configDefaults } from 'vitest/config'
import { familyVite } from './src/shared/scripts/vite.ts'

// GitHub Pages отдаёт сайт проекта не с корня домена, а по /<имя репозитория>/.
// Репозиторий называется Zloty → https://goigolden88.github.io/Zloty/
// Переименуете репозиторий — правьте эту строку, остальное подтянется (Р-10).
const BASE = '/Zloty/'

// Сборка, работник и манифест — фабрикой ядра; своё здесь — адрес, имя
// и описание. Ярлыков нет: вносить пока нечего, они придут с экранами
// ввода в Этапе 1.
export default defineConfig({
  ...familyVite({
    base: BASE,
    name: 'Злотые',
    description: 'Учёт денег: сколько я откладываю и хватает ли дохода. Работает без сети.',
  }),

  // Тесты ядра гоняет CI ядра; здесь — только свои (Р-52 «Трапезы»).
  test: {
    exclude: [...configDefaults.exclude, 'src/shared/**'],
  },
})
