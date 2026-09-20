import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { App } from './app.tsx'
import { db } from './app/core.ts'
import { listenInstall } from './shared/ui/install.ts'
import { listenErrors } from './shared/ui/report.ts'
// Каркас стилей ядра — первым, свой акцент — после.
import './shared/styles.css'
import './styles.css'

// До первого экрана: Chrome присылает событие установки рано и один раз.
listenInstall()

// Тоже до первого экрана: ошибка при отрисовке должна попасть в журнал.
listenErrors(db.settings)

const root = document.getElementById('root')
if (!root) throw new Error('Не найден #root')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Постоянное хранилище: без него браузер вправе стереть базу при нехватке
// места. Отказ — не ошибка, работать можно и так.
void db.persist()

registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    // Установленное приложение на телефоне может неделями не запускаться
    // с нуля. Без периодической проверки оно не узнает о новой сборке:
    // запрос на обновление уходит только при холодном старте.
    if (!registration) return
    setInterval(
      () => {
        void registration.update()
      },
      60 * 60 * 1000,
    )
  },
})
