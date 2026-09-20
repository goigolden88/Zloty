import { useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { config } from './app/config.ts'
import { db, sync } from './app/core.ts'
import { CoreProvider } from './shared/ui/core.tsx'
import { Layout, type Tab } from './shared/ui/Layout.tsx'
import { Books } from './screens/Books.tsx'
import { Entries } from './screens/Entries.tsx'
import { Help } from './screens/Help.tsx'
import { Month } from './screens/Month.tsx'
import { Settings } from './screens/Settings.tsx'

/**
 * Роутинг через хеш: на GitHub Pages обычные пути дают 404 при обновлении
 * страницы — сервер ищет файл, которого нет. Всё после # до сервера не доходит.
 *
 * Синхронизация запускается здесь, один раз на приложение: проход идёт по
 * таймеру и по событиям и не зависит от того, какой экран открыт. Не настроена —
 * проход ничего не делает и в сеть не ходит (Р-11: подключается в Этапе 1).
 *
 * Общий интерфейс ядра — шапка, «Настройки синхронизации», «Что нового» —
 * берёт базу и синхронизацию из `CoreProvider` (Я-03 «FamilyCore»); вкладки —
 * пропсом: их названия у приложения свои.
 */
const TABS: readonly Tab[] = [
  // Внизу — то, что открывают каждый день. «Счета и категории» туда не идут:
  // их заводят один раз, и они живут ссылкой из шапки.
  { to: '/', name: 'Месяц', end: true },
  { to: '/entries', name: 'Операции', end: false },
]

export function App() {
  useEffect(() => sync.startAutoSync(), [])

  return (
    <CoreProvider value={{ config, db, sync }}>
      <HashRouter>
        <Routes>
          <Route path="/" element={<Layout tabs={TABS} />}>
            <Route index element={<Month />} />
            {/* Справочники учёта: заводят один раз, правят редко — потому
                ссылкой из шапки «Месяца», а не вкладкой. */}
            <Route path="entries" element={<Entries />} />
            <Route path="books" element={<Books />} />
            <Route path="settings" element={<Settings />} />
            {/* Справка: вход — «?» в шапке «Месяца». */}
            <Route path="help" element={<Help />} />
            {/* Незнакомый адрес — на главный: приложение открывается,
                а не показывает пустоту. */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </HashRouter>
    </CoreProvider>
  )
}
