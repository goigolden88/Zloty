/**
 * Service worker «Злотых» — точка входа `injectManifest`. Кеш, работа без
 * сети, автообновление и тап по уведомлению — ядра (`shared/sw.ts`);
 * своё — о чём напоминать (`notify.ts`).
 */

import { startWorker } from './shared/sw.ts'
import { reminders } from './notify.ts'

startWorker({ remind: (registration) => reminders.remind(registration) })
