/**
 * Прогон собранного приложения в настоящем браузере — обвязка.
 *
 * Отвечает на один вопрос: открывается ли приложение и не падает ли оно
 * на обычном пути. Не проверяет вёрстку и не заменяет тесты расчёта.
 *
 * Без Playwright: уже установленный браузер на Chromium и протокол отладки
 * поверх WebSocket, встроенного в Node 22+. Ни одной зависимости, кроме Vite
 * самого проекта.
 *
 * Данные не трогает: браузер запускается с пустым временным профилем.
 *
 * Запуск: `npm run smoke`. Собирает сам, поэтому проверяет ровно тот код,
 * который лежит в `src/` сейчас. Падает с кодом 1, если браузер сообщил
 * об ошибке или проверка не сошлась.
 *
 * Сценарий пишется в функции `scenario` ниже.
 */

import { spawn } from 'node:child_process'
import { build, preview } from 'vite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Адрес собранного приложения. Заполняется, когда поднимется сервер. */
let APP = ''

/** Свой порт отладки, чтобы не столкнуться с открытым браузером. */
const DEBUG_PORT = 9333

/** Где искать браузер. Годится любой на Chromium. Свой путь — CHROME_PATH. */
const BROWSERS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// ─── Запуск ────────────────────────────────────────────────────────────────

function findBrowser() {
  const found = BROWSERS.find((path) => path && existsSync(path))
  if (!found) throw new Error('Браузер на Chromium не найден. Укажите путь в переменной CHROME_PATH.')
  return found
}

/**
 * Собирает и поднимает просмотр через API Vite, а не `npm run preview`:
 * на Windows Node не запускает `.cmd` без оболочки. Адрес — у самого
 * сервера, вместе с `base` из vite.config.ts.
 *
 * Собираем сами, а не полагаемся на dist от прошлого раза: прогон, который
 * молча проверяет вчерашнюю сборку, показывает зелёное на сломанном коде.
 */
async function startServer() {
  await build({ root: ROOT, logLevel: 'warn' })
  const server = await preview({ root: ROOT })
  const url = server.resolvedUrls?.local?.[0]
  if (!url) {
    await server.close()
    throw new Error('Сервер просмотра не назвал адрес')
  }
  APP = url
  return server
}

/** Адрес вкладки в протоколе отладки. */
async function pageSocket() {
  for (let i = 0; i < 40; i++) {
    try {
      const tabs = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json())
      const page = tabs.find((tab) => tab.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {
      // Браузер ещё не открыл порт.
    }
    await sleep(250)
  }
  throw new Error('Браузер не отдал порт отладки')
}

// ─── Разговор с браузером ──────────────────────────────────────────────────

/** Ошибки, о которых сообщил сам браузер. Любая валит прогон. */
const problems = []

/** Проверки сценария. */
const checks = []

function check(what, passed, seen = '') {
  checks.push({ what, passed, seen })
}

let socket
let seq = 0
const waiting = new Map()

/**
 * Подменённый ответ публичного источника курсов (Р-38): прогон не ходит во
 * внешнюю сеть, но путь «ответ → сводка → запись» проверяет целиком.
 * Перехват включается шагом сценария, `Fetch.enable` — только на его адреса.
 */
let ratesReply = null

function connect(url) {
  socket = new WebSocket(url)

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)

    if (message.id !== undefined) {
      waiting.get(message.id)?.(message)
      waiting.delete(message.id)
      return
    }

    if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params
      if (ratesReply && request.url.includes('currency-api')) {
        void send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Access-Control-Allow-Origin', value: '*' },
          ],
          body: Buffer.from(ratesReply).toString('base64'),
        })
      } else {
        void send('Fetch.continueRequest', { requestId })
      }
      return
    }

    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails
      problems.push(details.exception?.description ?? details.text)
    }

    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      problems.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '))
    }
  }

  return new Promise((done, fail) => {
    socket.onopen = done
    socket.onerror = fail
  })
}

/** Команда протокола. Ответ с ошибкой приходит без `result` — вернётся undefined. */
function send(method, params = {}) {
  const id = ++seq
  return new Promise((done) => {
    waiting.set(id, (message) => done(message.result))
    socket.send(JSON.stringify({ id, method, params }))
  })
}

/**
 * Выполняет выражение на странице. Исключение здесь — тоже ошибка прогона:
 * не нашлась кнопка — значит экран не тот, каким его считали.
 */
async function run(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (!result) {
    problems.push(`протокол не ответил на выражение: ${expression.slice(0, 60)}`)
    return null
  }
  if (result.exceptionDetails) {
    problems.push(result.exceptionDetails.exception?.description ?? 'ошибка в сценарии')
    return null
  }
  return result.result.value
}

/**
 * Помощники внутри каждого шага.
 *
 * `set` пишет в поле как человек: React слушает не присваивание `value`,
 * а событие с нативного сеттера. `blur` — через focusout: обычный blur
 * не всплывает, и onBlur его не увидит.
 *
 * Кончаются точкой с запятой: шаг, начатый с `[` или `(`, иначе склеился бы
 * с последней строкой в одно выражение.
 */
const HELPERS = `
  const set = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const blur = (el) => {
    el.blur();
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  };
  const byText = (tag, label) =>
    [...document.querySelectorAll(tag)].find((el) => el.textContent.trim() === label);
  const startsWith = (tag, prefix) =>
    [...document.querySelectorAll(tag)].find((el) => el.textContent.trim().startsWith(prefix));
`

/** Шаг сценария: тело выполняется на странице с помощниками выше. */
const act = (body) => run(`(() => {${HELPERS}\n${body}\n})()`)

/** Текст всего экрана. По нему и делаются проверки. Корень — поправить под проект. */
const screen = () => run('document.querySelector("#root")?.innerText ?? ""')

/**
 * Есть ли на экране такой текст — без учёта регистра и неразрывных пробелов.
 * `innerText` отдаёт `text-transform`: заголовки капителью приходят прописными,
 * и проверка «этого больше нет» иначе проходит ложно.
 */
function has(text, needle) {
  const flat = (value) => value.replace(/\u00A0/g, ' ').toLowerCase()
  return flat(text).includes(flat(needle))
}

/** Строка экрана с образцом — для внятного отчёта о непрошедшем. */
function line(text, part) {
  const flat = (value) => value.replace(/\u00A0/g, ' ')
  return flat(text).split('\n').find((each) => each.toLowerCase().includes(part.toLowerCase())) ?? ''
}

/** Переход по хеш-роутингу с ожиданием перерисовки. */
async function go(hash) {
  await run(`location.hash = ${JSON.stringify(hash)}`)
  await sleep(700)
}

/** Ждёт, пока выражение на странице станет истинным. */
async function waitFor(expression, ms = 10_000) {
  for (let spent = 0; spent < ms; spent += 250) {
    if ((await run(`Boolean(${expression})`)) === true) return true
    await sleep(250)
  }
  return false
}

/** Сеть вкл/выкл — для проверки работы из кеша service worker. */
async function offline(on) {
  await send('Network.enable')
  await send('Network.emulateNetworkConditions', {
    offline: on,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  })
}

// ─── Сценарий ──────────────────────────────────────────────────────────────

/**
 * Обычный путь человека. Ровно то, что делают каждый день; экраны, куда
 * никто не ходит, сюда добавлять незачем.
 */
async function scenario(profile) {
  await send('Runtime.enable')
  await send('Page.enable')

  // Скачанное — во временный профиль, который удаляется после прогона.
  // Без этого headless Chrome кладёт файлы в «Загрузки» человека.
  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: profile })

  // Разрешения — до первой загрузки: уже открытая страница выданное позже не видит.
  // await send('Browser.grantPermissions', { origin: new URL(APP).origin, permissions: ['notifications'] })

  await send('Page.navigate', { url: APP })
  await sleep(2000)

  const start = await screen()
  check('главный экран открылся', start.trim().length > 0, start.replace(/\s+/g, ' ').slice(0, 80))
  check('это «Месяц»', has(start, 'Месяц'), line(start, 'Месяц'))

  // ── Приветствие первого запуска: база пуста, значит оно на месте.
  check('приветствие показано на пустой базе', has(start, 'С чего начать'), line(start, 'С чего начать'))
  await act(`byText('button', 'Понятно').click();`)
  await sleep(700)
  const afterWelcome = await screen()
  check('«Понятно» убирает приветствие', !has(afterWelcome, 'С чего начать'), line(afterWelcome, 'Месяц'))

  // ── Справочники: без них операцию некуда записать. Заводим валюту, счёт
  //    и категорию — ровно тот путь, которым человек начинает.
  await go('/books')
  const books = await screen()
  check('экран «Счета и категории» открылся', has(books, 'Счета и категории'), line(books, 'Счета и категории'))
  check('пустой справочник просит завести валюту', has(books, 'Сначала заведите валюту'), line(books, 'Сначала заведите'))

  await act(`
    set(document.querySelector('input[placeholder="RUB"]'), 'RUB');
    set(document.querySelector('input[placeholder="Рубль"]'), 'Рубль');
    byText('button', 'Добавить валюту').click();
  `)
  await sleep(700)
  const withCurrency = await screen()
  check('валюта завелась', has(withCurrency, 'RUB — Рубль'), line(withCurrency, 'RUB'))

  await act(`byText('button', 'Завести счёт').click();`)
  await sleep(500)
  await act(`
    set(document.querySelector('input[placeholder="Банк или «Наличные»"]'), 'Синий банк');
    byText('button', 'Завести').click();
  `)
  await sleep(700)
  const withAccount = await screen()
  check('счёт завёлся', has(withAccount, 'Синий банк'), line(withAccount, 'Синий банк'))

  await act(`
    const field = document.querySelector('input[placeholder="Еда, транспорт"]');
    set(field, 'Еда');
    field.closest('.row').querySelector('button').click();
  `)
  await sleep(700)
  const withCategory = await screen()
  check('категория завелась', has(withCategory, 'Еда'), line(withCategory, 'Еда'))

  // «Месяц» обязан считать ещё до того, как заданы настройки учёта:
  // валюта в справочнике одна, и выбирать не из чего. Иначе путь
  // «всё приехало импортом» упирается в пустой экран.
  await go('/')
  const beforeProfile = await screen()
  check(
    '«Месяц» считает в единственной валюте, пока настроек нет',
    has(beforeProfile, 'единственная заведённая валюта'),
    line(beforeProfile, 'единственная заведённая'),
  )
  await go('/books')
  await sleep(500)


  // Настройки учёта — свойство данных, а не устройства: базовая валюта
  // обязана сохраниться и попасть в подпись блока.
  await act(`
    const base = [...document.querySelectorAll('select')].find((each) => each.querySelector('option[value="RUB"]'));
    set(base, 'RUB');
    base.dispatchEvent(new Event('change', { bubbles: true }));
  `)
  await sleep(300)
  await act(`byText('button', 'Сохранить').click();`)
  await sleep(700)
  const saved = await screen()
  check('настройки учёта сохранились', has(saved, 'Сохранено'), line(saved, 'Сохранено'))

  // Регулярная (Р-06): шаблон, который сам ничего не пишет.
  await act(`startsWith('.fold__btn', 'Регулярные').click();`)
  await sleep(400)
  await act(`byText('button', 'Завести регулярную').click();`)
  await sleep(400)
  await act(`
    set(document.querySelector('input[placeholder="Связь"]'), 'Связь');
    set(document.querySelector('input[placeholder="1234,56"]'), '600');
    byText('button', 'Завести').click();
  `)
  await sleep(700)
  const withRecurring = await screen()
  check(
    'регулярная завелась',
    has(withRecurring, 'каждый месяц'),
    line(withRecurring, 'Связь'),
  )

  // Записанное обязано пережить перезагрузку: это IndexedDB, а не состояние
  // экрана. Проверка ловит и то, что запись вообще дошла до базы.
  await send('Page.navigate', { url: APP })
  await sleep(2000)
  await go('/books')
  const again = await screen()
  check('справочники пережили перезагрузку', has(again, 'Синий банк') && has(again, 'RUB'), line(again, 'Синий банк'))

  // Пока ни одной записи нет, главный экран обязан сказать это словами,
  // а не показать ноль: ноль значил бы «ничего не заработал» (Р-07).
  await go('/')
  const empty = await screen()
  check(
    '«Месяц» на пустой базе говорит, что дохода нет, а не показывает ноль',
    has(empty, 'Доход за этот месяц не внесён'),
    line(empty, 'не внесён'),
  )
  check(
    'и что обычный месяц считать не по чему — тоже словами',
    has(empty, 'Считать не по чему'),
    line(empty, 'Считать не по чему'),
  )

  // ── Операции: ввод руками и правило «либо итог, либо операции» (Р-02).
  //    Второе проверяется отказом: правило, которое некому нарушить,
  //    прогоном не проверено.
  await go('/entries')
  const entries = await screen()
  check('экран «Операции» открылся', has(entries, 'Операции'), line(entries, 'Операции'))

  check(
    'блок «Регулярные» говорит, чего не хватает',
    has(entries, 'не внесено 1 из 1'),
    line(entries, 'не внесено'),
  )

  // «Внести» тапом: шаблон сам ничего не пишет, запись появляется по кнопке.
  await act(`
    const row = [...document.querySelectorAll('li')].find((el) => el.textContent.includes('Связь'));
    row.querySelector('button').click();
  `)
  await sleep(800)
  const afterRecurring = await screen()
  check(
    '«Внести» закрывает регулярную',
    has(afterRecurring, 'все внесены'),
    line(afterRecurring, 'все внесены'),
  )
  check(
    'и запись действительно появилась',
    has(afterRecurring, '600,00'),
    line(afterRecurring, '600,00'),
  )

  await act(`byText('button', 'Внести').click();`)
  await sleep(500)
  await act(`
    const amount = document.querySelector('input[placeholder="1234,56"]');
    set(amount, '500');
    const category = [...document.querySelectorAll('select')].find((each) =>
      [...each.options].some((option) => option.textContent.trim() === 'Еда'));
    set(category, [...category.options].find((option) => option.textContent.trim() === 'Еда').value);
    category.dispatchEvent(new Event('change', { bubbles: true }));
  `)
  await sleep(300)
  await act(`byText('button', 'Записать').click();`)
  await sleep(700)
  const withEntry = await screen()
  check('расход внесён руками', has(withEntry, '500,00'), line(withEntry, '500,00'))
  check('вид записи назван словом, а не знаком', has(withEntry, 'расход'), line(withEntry, '500,00'))

  await act(`byText('button', 'Внести').click();`)
  await sleep(500)
  await act(`
    const kind = document.querySelectorAll('select')[0];
    set(kind, 'period');
    kind.dispatchEvent(new Event('change', { bubbles: true }));
  `)
  await sleep(400)
  await act(`
    set(document.querySelector('input[placeholder="1234,56"]'), '9000');
    byText('button', 'Записать').click();
  `)
  await sleep(700)
  const clash = await screen()
  check(
    'итог не ложится на счёт, где уже есть операции',
    has(clash, 'уже есть операции'),
    line(clash, 'уже есть операции'),
  )
  await act(`byText('button', 'Отмена').click();`)
  await sleep(400)

  // ── Импорт: единственная дверь в данные извне (Р-09). Проверяется и то,
  //    что повтор не записывается второй раз, — на этом стоит весь Р-12, п. 4.
  await go('/import')
  const importScreen = await screen()
  check('экран импорта открылся', has(importScreen, 'Загрузить выписку'), line(importScreen, 'Загрузить выписку'))
  check(
    'сказано, с какого дня брать выписку',
    has(importScreen, 'берите выписку с этого дня'),
    line(importScreen, 'берите выписку'),
  )

  // Выдуманная выписка: настоящих данных в прогоне нет и быть не должно.
  const FILE = JSON.stringify({
    format: 'zloty-import',
    version: 1,
    categories: [{ name: 'Транспорт', side: 'expense' }],
    // Второй счёт: у наличных выписки нет и не будет — на них проверяется
    // правило Р-16 «перевод проходит по сверке одной стороны».
    accounts: [{ name: 'Наличные', currency: 'RUB', kind: 'savings' }],
    entries: [
      { kind: 'expense', account: 'Синий банк', amount: 120.5, date: '2026-09-18', category: 'Транспорт', bankText: 'МЕТРО 120.50' },
      { kind: 'income', account: 'Синий банк', amount: 30, date: '2026-09-18', category: 'Кэшбэк', bankText: 'КЭШБЭК' },
    ],
    // Сверка (Р-16): без неё операции счёта не загрузятся вовсе.
    checks: [{ account: 'Синий банк', from: '2026-09-18', to: '2026-09-18', income: 30, expense: 120.5 }],
  })

  await act(`
    const field = document.querySelector('.import__text');
    set(field, ${JSON.stringify(FILE)});
  `)
  await sleep(300)
  await act(`byText('button', 'Разобрать').click();`)
  await sleep(700)
  const plan = await screen()
  check('сводка показана до записи', has(plan, 'Добавится'), line(plan, 'Добавится'))

  await act(`startsWith('button', 'Загрузить ').click();`)
  await sleep(900)
  const loaded = await screen()
  check('импорт записал', has(loaded, 'Загружено записей'), line(loaded, 'Загружено записей'))

  // Тот же файл второй раз: ext обязан отсечь всё до единой записи.
  await act(`
    const field = document.querySelector('.import__text');
    set(field, ${JSON.stringify(FILE)});
  `)
  await sleep(300)
  await act(`byText('button', 'Разобрать').click();`)
  await sleep(700)
  const repeat = await screen()
  check('повтор выписки не записывается', has(repeat, 'Добавлять нечего'), line(repeat, 'Добавлять нечего'))
  check('и про пропущенное сказано числом', has(repeat, 'Уже есть'), line(repeat, 'Уже есть'))

  // ── Сверка выписки (Р-16). Главное, чего приложение не видело раньше:
  //    беседа на большой выписке приносит часть операций и молчит об этом.
  //    Проверяется обоими отказами — сверки нет и сверка не сошлась.
  const NO_CHECKS = JSON.stringify({
    format: 'zloty-import',
    version: 1,
    entries: [
      { kind: 'expense', account: 'Синий банк', amount: 77.7, date: '2026-09-19', category: 'Транспорт', bankText: 'АВТОБУС 77.70' },
    ],
  })

  await act(`
    const field = document.querySelector('.import__text');
    set(field, ${JSON.stringify(NO_CHECKS)});
  `)
  await sleep(300)
  await act(`byText('button', 'Разобрать').click();`)
  await sleep(700)
  const without = await screen()
  check(
    'без сверки операции счёта не загружаются',
    has(without, 'Добавлять нечего'),
    line(without, 'Добавлять нечего'),
  )
  check(
    'и сказано, чего не хватает',
    has(without, 'сверки по этому счёту нет'),
    line(without, 'сверки по этому счёту нет'),
  )

  const WRONG_CHECK = JSON.stringify({
    format: 'zloty-import',
    version: 1,
    entries: [
      { kind: 'expense', account: 'Синий банк', amount: 77.7, date: '2026-09-19', category: 'Транспорт', bankText: 'АВТОБУС 77.70' },
    ],
    // Выписка говорит, что ушло 999: беседа принесла не все строки.
    checks: [{ account: 'Синий банк', from: '2026-09-19', to: '2026-09-19', income: 0, expense: 999 }],
  })

  await act(`
    const field = document.querySelector('.import__text');
    set(field, ${JSON.stringify(WRONG_CHECK)});
  `)
  await sleep(300)
  await act(`byText('button', 'Разобрать').click();`)
  await sleep(700)
  const mismatch = await screen()
  check(
    'сверка не сошлась — записи не грузятся',
    has(mismatch, 'Добавлять нечего'),
    line(mismatch, 'Добавлять нечего'),
  )
  check(
    'и разница названа суммой, а не «что-то не так»',
    has(mismatch, 'не сошлась') && has(mismatch, '999,00'),
    line(mismatch, 'не сошлась'),
  )

  // Движения внутри счёта в базу не идут (Р-12, п. 1), но остаток выписки
  //    меняют: она приходит на один договор, а счёт — банк целиком. Беседа
  //    объявляет их суммой, и только тогда сверка сходится (Р-17).
  const SKIPPED = JSON.stringify({
    format: 'zloty-import',
    version: 1,
    entries: [
      { kind: 'expense', account: 'Синий банк', amount: 40, date: '2026-09-19', category: 'Транспорт', bankText: 'ТРОЛЛЕЙБУС 40.00' },
    ],
    checks: [{ account: 'Синий банк', from: '2026-09-19', to: '2026-09-19', opening: 3000, closing: 460, skippedOut: 2500 }],
  })

  await act(`
    const field = document.querySelector('.import__text');
    set(field, ${JSON.stringify(SKIPPED)});
  `)
  await sleep(300)
  await act(`byText('button', 'Разобрать').click();`)
  await sleep(700)
  await act(`startsWith('button', 'Загрузить ').click();`)
  await sleep(900)
  const skipped = await screen()
  check(
    'объявленные движения внутри счёта сводят сверку',
    has(skipped, 'Загружено записей'),
    line(skipped, 'Загружено записей'),
  )

  // Счёт, заведённый этим же файлом, обязан называться по имени: сверка
  //    смотрит в справочники после разбора, а не до него. Иначе человек
  //    видит в отказе id вместо названия.
  const NEW_ACCOUNT = JSON.stringify({
    format: 'zloty-import',
    version: 1,
    accounts: [{ name: 'Жёлтый банк', currency: 'RUB', kind: 'savings' }],
    entries: [
      { kind: 'expense', account: 'Жёлтый банк', amount: 10, date: '2026-09-19', category: 'Транспорт', bankText: 'ТРАМВАЙ 10.00' },
    ],
  })

  await act(`
    const field = document.querySelector('.import__text');
    set(field, ${JSON.stringify(NEW_ACCOUNT)});
  `)
  await sleep(300)
  await act(`byText('button', 'Разобрать').click();`)
  await sleep(700)
  const fresh = await screen()
  check(
    'счёт из того же файла назван по имени, а не идентификатором',
    has(fresh, 'Жёлтый банк: сверки по этому счёту нет'),
    line(fresh, 'сверки по этому счёту нет'),
  )
  await act(`byText('button', 'Отмена').click();`)
  await sleep(500)

  // Внесение наличных: сверки у «Наличных» нет и не будет, но движение
  //    объясняет остаток банка — перевод проходит по сверке одной стороны.
  const CASH_IN = JSON.stringify({
    format: 'zloty-import',
    version: 1,
    entries: [
      { kind: 'transfer', account: 'Наличные', toAccount: 'Синий банк', amount: 5000, date: '2026-09-20', bankText: 'ВНЕСЕНИЕ НАЛИЧНЫХ' },
    ],
    checks: [{ account: 'Синий банк', from: '2026-09-20', to: '2026-09-20', income: 5000, expense: 0 }],
  })

  await act(`
    const field = document.querySelector('.import__text');
    set(field, ${JSON.stringify(CASH_IN)});
  `)
  await sleep(300)
  await act(`byText('button', 'Разобрать').click();`)
  await sleep(700)
  await act(`startsWith('button', 'Загрузить ').click();`)
  await sleep(900)
  const cash = await screen()
  check(
    'внесение наличных проходит по сверке одной стороны',
    has(cash, 'Загружено записей'),
    line(cash, 'Загружено записей'),
  )

  // Промпт обязан знать мои счета и категории — иначе беседа разложит наугад.
  await act(`startsWith('.fold__btn', 'Как подготовить файл').click();`)
  await sleep(400)
  await act(`startsWith('.fold__btn', 'Показать промпт').click();`)
  await sleep(400)
  const prompt = await screen()
  check('промпт знает мои счета', has(prompt, '«Синий банк» (RUB)'), line(prompt, 'Синий банк» (RUB)'))
  check('промпт знает мои категории', has(prompt, 'Расходные категории'), line(prompt, 'Расходные категории'))
  check(
    'промпт сам просит сверку, а не надеется на память человека',
    has(prompt, 'напиши строку в разделе «checks»'),
    line(prompt, 'разделе «checks»'),
  )
  check(
    'и сам говорит, как разбирать несколько выписок',
    has(prompt, 'Разбирай выписки по одной'),
    line(prompt, 'Разбирай выписки по одной'),
  )
  check(
    'промпт объясняет направление перевода: «account» — откуда',
    has(prompt, 'счёт, ОТКУДА деньги ушли'),
    line(prompt, 'ОТКУДА деньги ушли'),
  )
  // Капитал (Этап 4): снимки и заметки входят той же дверью (Р-09), и промпт
  // обязан знать, как писать отложенный платёж — иначе беседа поставит минус.
  check(
    'промпт знает снимки, отложенный платёж и заметки к капиталу',
    has(prompt, 'сколько лежало на счёте на дату') && has(prompt, 'отложенный платёж') && has(prompt, 'заметки к капиталу на дату'),
    line(prompt, 'сколько лежало на счёте'),
  )

  await go('/entries')
  const afterImport = await screen()
  check('загруженная операция видна в месяце', has(afterImport, '120,50'), line(afterImport, '120,50'))

  // ── История прежней таблицы (Р-14): счёт истории заводится тем же файлом,
  //    период приходит двумя итогами — обычным и особым.
  const HISTORY = JSON.stringify({
    format: 'zloty-import',
    version: 1,
    accounts: [{ name: 'Старая таблица', currency: 'RUB', kind: 'savings', ledgerOnly: true }],
    entries: [
      { kind: 'expense', account: 'Старая таблица', amount: 20000, periodFrom: '2026-07-01', periodTo: '2026-07-31', note: 'Обычные траты таблицы' },
      { kind: 'expense', account: 'Старая таблица', amount: 5000, periodFrom: '2026-07-01', periodTo: '2026-07-31', special: true, note: 'Особые траты таблицы' },
      // Период, заходящий в сентябрь одним днём: месяц он не забирает
      // (Р-20). Границы прежней таблицы всегда так и падают на край.
      { kind: 'expense', account: 'Старая таблица', amount: 41559, periodFrom: '2026-08-01', periodTo: '2026-09-01', note: 'Край периода' },
    ],
  })

  await go('/import')
  await act(`
    const field = document.querySelector('.import__text');
    set(field, ${JSON.stringify(HISTORY)});
  `)
  await sleep(300)
  await act(`byText('button', 'Разобрать').click();`)
  await sleep(700)
  await act(`startsWith('button', 'Загрузить ').click();`)
  await sleep(900)
  const history = await screen()
  check('история загрузилась', has(history, 'Загружено записей'), line(history, 'Загружено записей'))
  // Именно в списке «С какого дня брать выписку», а не где угодно на экране:
  // в промпте счёт истории назван законно и отдельно — на него переносят
  // прежнюю таблицу.
  const forStatements = await run(`
    (() => {
      const head = [...document.querySelectorAll('h3')].find((el) => el.textContent.includes('С какого дня'));
      return head?.nextElementSibling?.innerText ?? '';
    })()
  `)
  check(
    'счёт истории не попал в список, с какого дня брать выписку',
    typeof forStatements === 'string' && forStatements.length > 0 && !has(forStatements, 'Старая таблица'),
    forStatements.replace(/\s+/g, ' ').slice(0, 70),
  )

  await go('/books')
  const withHistory = await screen()
  check(
    'счёт истории помечен как счёт истории',
    has(withHistory, 'счёт истории'),
    line(withHistory, 'счёт истории'),
  )

  // ── «Месяц»: главный вопрос приложения. Проверяется и то, что доход,
  //    которого нет, назван честно, а не показан нулём (Р-07).
  // Вносим доход — и экран обязан ответить числом с основанием.
  await go('/entries')
  await act(`byText('button', 'Внести').click();`)
  await sleep(500)
  await act(`
    const kind = document.querySelectorAll('select')[0];
    set(kind, 'income');
    kind.dispatchEvent(new Event('change', { bubbles: true }));
  `)
  await sleep(400)
  await act(`
    set(document.querySelector('input[placeholder="1234,56"]'), '100000');
    const category = [...document.querySelectorAll('select')].find((each) =>
      [...each.options].some((option) => option.textContent.trim() === 'Кэшбэк'));
    set(category, [...category.options].find((option) => option.textContent.trim() === 'Кэшбэк').value);
    category.dispatchEvent(new Event('change', { bubbles: true }));
  `)
  await sleep(300)
  await act(`byText('button', 'Записать').click();`)
  await sleep(700)

  await go('/')
  const month = await screen()
  check('«Месяц» считает отложенное', has(month, 'Отложено'), line(month, 'Отложено'))
  check(
    'у числа есть основание — по скольким операциям',
    /по \d+ операци(и|ям)/.test(month),
    line(month, 'операциям'),
  )
  check('норма сбережений показана долей', /\d+% дохода/.test(month), line(month, '% дохода'))
  check('видно, из чего вышло', has(month, 'Расход обычный'), line(month, 'Расход обычный'))
  check('есть столбики по месяцам', has(month, 'Расход по месяцам'), line(month, 'Расход по месяцам'))
  check(
    'обычный месяц опёрся на период прежней таблицы (Р-12, п. 6)',
    has(month, 'прежней таблицы'),
    line(month, 'прежней таблицы'),
  )

  // Период, заходящий в месяц одним днём, месяц не забирает (Р-20): иначе
  // первый месяц с настоящими выписками молчит из-за одного дня.
  check(
    'край чужого периода не отнимает у месяца отложенное',
    !has(month, 'посчитать нельзя'),
    line(month, 'Отложено'),
  )
  check(
    'и задетые дни названы числом, а не словом «частью»',
    /\d+ (день|дня|дней) этого месяца из \d+/.test(month),
    line(month, 'этого месяца из'),
  )
  // Согласование: у одного дня «записан», у нескольких «записаны». Число
  // подставляется склонением, а глагол рядом склонялся не всегда.
  check(
    'и глагол согласован с числом дней',
    /1 день этого месяца из \d+ записан итогами/.test(month),
    line(month, 'этого месяца из'),
  )

  // Блок «Вышло за обычное» не исчезает молча: пустота на его месте
  // читалась бы как «всё в норме» (Р-07).
  check(
    'без прошлых месяцев «Вышло за обычное» говорит почему, а не пропадает',
    has(month, 'Вышло за обычное') && has(month, 'прошлых месяцев с операциями нет'),
    line(month, 'прошлых месяцев с операциями'),
  )

  // Месяц, расход которого записан периодом: ноль тут читался бы как
  // «не тратил», хотя правда — «записан иначе» (Р-07).
  await act(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '←').click();`)
  await sleep(500)
  await act(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '←').click();`)
  await sleep(700)
  const july = await screen()
  check(
    'месяц, покрытый периодом, не показывает расход нулём',
    has(july, 'записан периодом'),
    line(july, 'записан периодом'),
  )
  check(
    'и отложенное по нему не считается — сказано почему',
    has(july, 'посчитать нельзя'),
    line(july, 'посчитать нельзя'),
  )
  check(
    'пустой график не рисуется: он показывал бы деление в одну копейку',
    has(july, 'Рисовать нечего'),
    line(july, 'Рисовать нечего'),
  )
  // Склонение без числа даёт «за последние месяцев»: `plural` ядра
  // возвращает форму слова, а не число вместе с ней.
  check(
    'и в этом тексте число на месте, а не одно склонение',
    /за последние \d+ месяц/.test(july),
    line(july, 'Рисовать нечего'),
  )

  // ── «Вышло за обычное» по правилам Р-21. Прошлые месяцы грузятся здесь,
  //    а не раньше: июлем и августом владеют периоды прежней таблицы (Р-20),
  //    и без операций в марте — мае блоку не на что опереться. Раньше этого
  //    места они сломали бы проверку пустого графика в июле: столбики
  //    смотрят на двенадцать месяцев назад и увидели бы весну.
  //    Суммы и категории выдуманы (CLAUDE.md, «Личные данные»).
  //    «Еда» — в каждом из трёх месяцев, «Техника» — в одном: она обычной
  //    не станет ни при каком числе наблюдений.
  const PAST = JSON.stringify({
    format: 'zloty-import',
    version: 1,
    // Второй банк, чья выписка кончилась раньше: по нему и считается,
    // по какое число доведены записи (Р-24). Выписки приходят вразнобой,
    // и это не выдуманный случай, а обычный.
    // «Тетрадь» — счёт с итогом периода и БЕЗ пометки «счёт истории»:
    //    так бывает, когда галочку забыли. Его `period.to` не должен
    //    утягивать срок назад (Р-24): итог говорит «за промежуток
    //    потрачено столько-то», а не «этот день записан».
    accounts: [
      { name: 'Зелёный банк', currency: 'RUB', kind: 'savings' },
      { name: 'Тетрадь', currency: 'RUB', kind: 'savings' },
    ],
    entries: [
      { kind: 'expense', account: 'Зелёный банк', amount: 300, date: '2026-09-10', category: 'Еда' },
      { kind: 'expense', account: 'Зелёный банк', amount: 200, date: '2026-09-08', category: 'Ветеринар' },
      { kind: 'expense', account: 'Тетрадь', amount: 1000, periodFrom: '2026-08-05', periodTo: '2026-09-03' },
      { kind: 'expense', account: 'Синий банк', amount: 1000, date: '2026-03-12', category: 'Еда' },
      { kind: 'expense', account: 'Синий банк', amount: 1000, date: '2026-04-12', category: 'Еда' },
      { kind: 'expense', account: 'Синий банк', amount: 1000, date: '2026-05-12', category: 'Еда' },
      { kind: 'expense', account: 'Синий банк', amount: 20000, date: '2026-03-20', category: 'Техника' },
      { kind: 'income', account: 'Синий банк', amount: 50, date: '2026-05-14', category: 'Кэшбэк' },
    ],
    checks: [
      { account: 'Синий банк', from: '2026-03-01', to: '2026-05-31', income: 50, expense: 23000 },
      { account: 'Зелёный банк', from: '2026-09-01', to: '2026-09-10', income: 0, expense: 500 },
    ],
  })

  await go('/import')
  await act(`
    const field = document.querySelector('.import__text');
    set(field, ${JSON.stringify(PAST)});
  `)
  await sleep(300)
  await act(`byText('button', 'Разобрать').click();`)
  await sleep(700)
  await act(`startsWith('button', 'Загрузить ').click();`)
  await sleep(900)
  const past = await screen()
  check('прошлые месяцы загрузились', has(past, 'Загружено записей'), line(past, 'Загружено записей'))

  await go('/')
  await sleep(700)
  const usual = await screen()
  check('есть блок «Вышло за обычное»', has(usual, 'Вышло за обычное'), line(usual, 'Вышло за обычное'))
  check(
    'основание отклонения говорит и по скольким месяцам, и в скольких встречалась',
    /встречалась в \d+ из \d+/.test(usual),
    line(usual, 'встречалась в'),
  )
  check(
    'разовая трата обычной не считается, но и не пропадает молча',
    has(usual, 'реже чем в половине прошлых'),
    line(usual, 'реже чем в половине'),
  )
  check(
    'появившееся впервые названо отдельно, а не как отклонение от нуля',
    has(usual, 'Новое в этом месяце') && has(usual, 'сравнивать не с чем'),
    line(usual, 'Новое в этом месяце'),
  )

  // ── Месяц, который ещё идёт (Р-22). Прогон всегда открывается на текущем
  //    месяце, так что строка обязана быть — кроме первого дня месяца,
  //    когда прошедших дней ещё нет.
  const firstOfMonth = new Date().getDate() === 1
  check(
    'месяц, который ещё идёт, назван вместе с числом прожитых дней',
    firstOfMonth || /Месяц ещё идёт — прошло \d+ из \d+ дн/.test(usual),
    line(usual, 'Месяц ещё идёт'),
  )
  // Выписка всегда отстаёт от календаря, и дни после последней операции —
  // не дни без трат, а дни, которых в базе нет (Р-24).
  check(
    'экран называет, по какое число доведены записи, а не только прожитые дни',
    firstOfMonth || (has(usual, 'записи доведены только по') && /не хватает \d+ дн/.test(usual)),
    line(usual, 'записи доведены только по'),
  )
  // Без имени счёта «доведено по десятое» — загадка: непонятно, какую
  // выписку грузить (Р-24).
  check(
    'и называет счёт, который отстал сильнее всех',
    firstOfMonth || has(usual, 'по счёту «Зелёный банк»'),
    line(usual, 'по счёту'),
  )
  // Срок берётся из сверки, а не из записей: счёт, на котором в этом месяце
  // только переводили, отставшим не считается (Р-26).
  check(
    'счёт без выписок срока не задаёт',
    firstOfMonth || !has(usual, 'по счёту «Наличные»'),
    line(usual, 'записи доведены только по'),
  )
  // Первая версия Р-24 резала только обычное, и расход за весь месяц
  // сравнивался с обычным за один день.
  check(
    'и говорит, что сравнивается расход за тот же срок, а не за весь месяц',
    firstOfMonth || /сравнивается расход за эти \d+ дн/.test(usual),
    line(usual, 'сравнивается расход за эти'),
  )

  check(
    'сравнение с обычным урезано до того же срока, а не досчитано до месяца',
    firstOfMonth || (has(usual, 'а обычно за такой же срок') && !has(usual, 'на сегодняшнем темпе')),
    line(usual, 'обычно за такой же срок'),
  )

  // Слова про урезание стоят на месте и тогда, когда урезания нет: сторож
  // на текст не ловит пропавшее число. Поэтому здесь сравниваются сами
  // числа — обычный месяц целиком против него же к этому дню (Р-22).
  const toDay = await run(`
    (() => {
      const head = [...document.querySelectorAll('h2')].find((el) => el.textContent.includes('Обычный месяц'));
      const block = head?.closest('.block');
      if (!block) return null;
      const number = (text) => {
        const found = text.replace(/\\s|\\u00a0|\\u202f/g, '').match(/(\\d+(?:,\\d+)?)/);
        return found ? Number(found[1].replace(',', '.')) : null;
      };
      const whole = number(block.querySelector('.big')?.textContent ?? '');
      const line = [...block.querySelectorAll('p')].find((el) => el.textContent.includes('за такой же срок'));
      const part = line ? number(line.textContent.split('за такой же срок')[1] ?? '') : null;
      return { whole, part };
    })()
  `)
  // Слова «сравнивается расход за эти 10 дней» стоят на месте и тогда,
  // когда расход взят за весь месяц: сторож на текст пропавшее число
  // не ловит. Поэтому сравниваются сами числа (Р-24).
  const sides = await run(`
    (() => {
      const number = (text) => {
        const found = String(text).replace(/\\s|\\u00a0|\\u202f/g, '').match(/(\\d+(?:,\\d+)?)/);
        return found ? Number(found[1].replace(',', '.')) : null;
      };
      const row = [...document.querySelectorAll('li')].find((el) => el.textContent.includes('Расход обычный'));
      const whole = row ? number(row.lastElementChild?.textContent) : null;
      const head = [...document.querySelectorAll('h2')].find((el) => el.textContent.includes('Обычный месяц'));
      const line = head && [...head.closest('.block').querySelectorAll('p')]
        .find((el) => el.textContent.includes('месяца —'));
      const part = line ? number(line.textContent.split('месяца —')[1]) : null;
      return { whole, part };
    })()
  `)
  check(
    'расход для сравнения меньше расхода за весь месяц, а не равен ему',
    firstOfMonth ||
      (sides !== null &&
        typeof sides.whole === 'number' &&
        typeof sides.part === 'number' &&
        sides.part > 0 &&
        sides.part < sides.whole),
    `за месяц ${sides?.whole}, за записанный срок ${sides?.part}`,
  )

  check(
    'и урезанное обычное — число меньше целого, а не то же самое',
    firstOfMonth ||
      (toDay !== null &&
        typeof toDay.whole === 'number' &&
        typeof toDay.part === 'number' &&
        toDay.part > 0 &&
        toDay.part < toDay.whole),
    `целиком ${toDay?.whole}, к этому дню ${toDay?.part}`,
  )
  check(
    'и отклонение по категории считается от урезанного обычного',
    firstOfMonth || /обычно .+ за такой же срок — по \d+ месяц/.test(usual),
    line(usual, 'встречалась в'),
  )

  // ── Доход, которого ждали и не дождались (Р-23). Доходная регулярная,
  //    не отмеченная за месяц, — не догадка о полноте данных, а факт:
  //    шаблон сам сказал, чего ждать. Категория «Кэшбэк» к этому месту уже
  //    заведена выпиской, и она доходная.
  // Расход, который делает доход месяца заведомо неполным: доля от такого
  //    дохода уходит в сотни процентов. Вносится руками — наличные через
  //    импорт и не ходят (Р-12).
  await go('/entries')
  await act(`byText('button', 'Внести').click();`)
  await sleep(500)
  await act(`
    set(document.querySelector('input[placeholder="1234,56"]'), '2500');
    const category = [...document.querySelectorAll('select')].find((each) =>
      [...each.options].some((option) => option.textContent.trim() === 'Еда'));
    set(category, [...category.options].find((option) => option.textContent.trim() === 'Еда').value);
    category.dispatchEvent(new Event('change', { bubbles: true }));
  `)
  await sleep(300)
  await act(`byText('button', 'Записать').click();`)
  await sleep(700)

  await go('/books')
  // Блок мог остаться развёрнутым с прошлого шага: сворачивание живёт
  // в настройках устройства. Щёлкать вслепую — значит его закрыть.
  await act(`
    if (!byText('button', 'Завести регулярную')) startsWith('.fold__btn', 'Регулярные').click();
  `)
  await sleep(400)
  await act(`byText('button', 'Завести регулярную').click();`)
  await sleep(400)
  await act(`
    set(document.querySelector('input[placeholder="Связь"]'), 'Стипендия');
    const category = [...document.querySelectorAll('select')].find((each) =>
      [...each.options].some((option) => option.textContent.includes('Кэшбэк')));
    const income = [...category.options].find((option) => option.textContent.includes('Кэшбэк'));
    set(category, income.value);
    category.dispatchEvent(new Event('change', { bubbles: true }));
  `)
  await sleep(300)
  await act(`
    set(document.querySelector('input[placeholder="1234,56"]'), '25000');
    byText('button', 'Завести').click();
  `)
  await sleep(800)

  // Годовая регулярная: её доля раскладывается по месяцам в необходимом
  //    доходе, а платёж по ней выносится из обычного месяца (Р-27).
  await act(`byText('button', 'Завести регулярную').click();`)
  await sleep(400)
  await act(`
    set(document.querySelector('input[placeholder="Связь"]'), 'Страховка');
    set(document.querySelector('input[placeholder="1234,56"]'), '12000');
    const every = document.querySelector('input[type="number"]');
    set(every, '12');
    every.dispatchEvent(new Event('change', { bubbles: true }));
    // Сторону говорит категория (Р-06): с доходной шаблон в необходимый
    // доход не пойдёт вовсе, и проверять было бы нечего.
    const category = [...document.querySelectorAll('select')].find((each) =>
      [...each.options].some((option) => option.textContent.includes('Еда')));
    const spend = [...category.options].find((option) => option.textContent.includes('Еда'));
    set(category, spend.value);
    category.dispatchEvent(new Event('change', { bubbles: true }));
  `)
  await sleep(300)
  await act(`byText('button', 'Завести').click();`)
  await sleep(800)
  const yearly = await screen()
  check('годовая регулярная завелась', has(yearly, 'раз в 12 месяцев'), line(yearly, 'Страховка'))

  await go('/')
  await sleep(700)
  const waiting = await screen()
  // ── «Какой доход мне нужен» (Р-07, Р-27): каждое слагаемое названо.
  //    Снимок снят после заведения шаблонов: до них доли быть не может.
  check('есть блок «Какой доход мне нужен»', has(waiting, 'Какой доход мне нужен'), line(waiting, 'Какой доход'))
  check(
    'нужное стоит на обычном месяце и называет его суммой',
    /обычный месяц \d/.test(waiting),
    line(waiting, 'в месяц — доля'),
  )
  check(
    'доля годовой регулярной названа отдельно, а не растворена в числе',
    /плюс [^\n]* в месяц — доля \d+ регулярн/.test(waiting),
    line(waiting, 'в месяц — доля'),
  )
  check(
    'и сказано, хватает ли дохода',
    has(waiting, 'не хватает') || has(waiting, 'хватает с запасом') || has(waiting, 'доход за этот месяц не внесён'),
    line(waiting, 'доход этого месяца'),
  )

  // ── Рост обычного месяца (Р-28): личная инфляция, названная честно.
  check('есть блок «Рост обычного месяца»', has(waiting, 'Рост обычного месяца'), line(waiting, 'Рост обычного'))
  check(
    'оговорка про личную инфляцию стоит рядом с числом, а не в справке',
    has(waiting, 'рост ваших расходов, а не цен'),
    line(waiting, 'личная инфляция'),
  )
  check(
    'рост называет обе половины окна и число наблюдений',
    /позже \([^)]+\) — [^\n]*раньше \([^)]+\) — [^\n]*По \d+ и \d+ наблюдени/.test(waiting),
    line(waiting, 'позже ('),
  )
  // По категориям рост стоит только на месяцах: у итогов прежней таблицы
  // категорий нет вовсе. Месяцев в прогоне три — на порог не хватает,
  // и это обязано быть сказано числом, а не пустотой.
  check(
    'по категориям рост говорит, чего ему не хватает',
    has(waiting, 'По категориям') && /месяцев с операциями — \d+, а нужно \d+/.test(waiting),
    line(waiting, 'месяцев с операциями'),
  )

  // ── «Что улучшить» (Р-29): отчёт уезжает в беседу текстом, а не вызовом
  //    платного API. Проверяется не кнопка, а то, что она кладёт в буфер.
  check('есть блок «Что улучшить»', has(waiting, 'Что улучшить'), line(waiting, 'Что улучшить'))

  // Буфер обмена в headless-браузере недоступен: подменяем его и ловим текст.
  await run(`
    (() => {
      window.__copied = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (text) => { window.__copied = text; return Promise.resolve(); } },
      });
    })()
  `)
  await act(`byText('button', 'Скопировать отчёт').click();`)
  await sleep(600)
  const copied = await run('window.__copied')
  const said = await screen()

  check(
    'кнопка кладёт отчёт в буфер и говорит об этом',
    typeof copied === 'string' && copied.length > 0 && has(said, 'Отчёт скопирован'),
    line(said, 'Отчёт скопирован'),
  )
  check(
    'в отчёте есть месяц и итоги с основанием',
    typeof copied === 'string' &&
      copied.includes('# Деньги за') &&
      copied.includes('## Итоги месяца') &&
      /по \d+ операци/.test(copied),
    typeof copied === 'string' ? copied.split('\n')[0] : String(copied),
  )
  // Без этого раздела беседа объяснит дыры в данных привычками человека.
  check(
    'и раздел «чего приложение не знает» — он в отчёте главный',
    typeof copied === 'string' && copied.includes('## Чего приложение не знает'),
    'раздел про незнание',
  )
  check(
    'вопрос стоит после чисел и просит сомневаться',
    typeof copied === 'string' &&
      copied.indexOf('## Вопрос') > copied.indexOf('## Итоги месяца') &&
      copied.includes('В чём ты сомневаешься'),
    'вопрос в конце отчёта',
  )

  check(
    'приложение называет доход, которого ждали и не дождались',
    has(waiting, 'Доход внесён не весь') && has(waiting, 'Стипендия'),
    line(waiting, 'Доход внесён не весь'),
  )
  check(
    'и говорит, сколько по нему ждали, а не только что его нет',
    /ждали 25\s?000,00/.test(waiting.replace(/\u00a0/g, ' ')),
    line(waiting, 'ждали'),
  )
  // Доля от неполного дохода уходит в сотни процентов. В мае доход — копейки
  // против расхода: ровно тот случай, ради которого доля уступает место
  // кратности и сумме (Р-23).
  for (let step = 0; step < 4; step++) {
    await act(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '←').click();`)
    await sleep(400)
  }
  const thin = await screen()
  check(
    'норма сбережений читается: кратность и сумма вместо сотен процентов',
    has(thin, 'расход больше дохода в') && !/\u2212\d{3,}%|-\d{3,}%/.test(thin),
    line(thin, 'расход больше дохода'),
  )

  // ── Правка загруженной операции: ключ импорта обязан её пережить,
  //    иначе следующая выписка принесёт дубль (Р-12, «Цена», п. 2).
  await go('/entries')
  await act(`
    const row = [...document.querySelectorAll('li')].find((el) => el.textContent.includes('120,50'));
    [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Изменить').click();
  `)
  await sleep(600)
  await act(`
    const note = [...document.querySelectorAll('.field')].find((el) => el.textContent.includes('Заметка'));
    set(note.querySelector('input'), 'поправил руками');
    byText('button', 'Сохранить').click();
  `)
  await sleep(800)
  const edited = await screen()
  check('операцию можно поправить', has(edited, 'поправил руками'), line(edited, 'поправил руками'))

  // Та же выписка второй раз: поправленная операция обязана отсечься
  // по ключу, а не приехать второй копией.
  await go('/import')
  await act(`
    const field = document.querySelector('.import__text');
    set(field, ${JSON.stringify(FILE)});
  `)
  await sleep(300)
  await act(`byText('button', 'Разобрать').click();`)
  await sleep(700)
  const afterEdit = await screen()
  check(
    'поправленная операция не приходит выпиской второй раз',
    has(afterEdit, 'Добавлять нечего'),
    line(afterEdit, 'Добавлять нечего'),
  )

  // ── Поиск по всей истории (Р-15): отдельной вкладки «Лента» нет,
  //    ищется внутри «Операций» — и по тому, чего на экране не видно.
  await go('/entries')
  await act(`
    const field = document.querySelector('input[placeholder="Найти по всей истории"]');
    set(field, 'метро');
  `)
  await sleep(800)
  const found = await screen()
  check('поиск находит по описанию из выписки', has(found, '120,50'), line(found, '120,50'))
  check('и говорит, что искал по всей истории', has(found, 'по всей истории, а не за месяц'), line(found, 'Найдено'))

  // Найденное надо уметь поправить: «Неразобранные поступления» ищутся
  // поиском, а разбирать их было негде — кнопки правки у результата не было.
  const editable = await run(`
    (() => {
      const row = [...document.querySelectorAll('li')].find((el) => el.textContent.includes('120,50'));
      return !!(row && [...row.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Изменить'));
    })()
  `)
  check('найденную запись можно поправить прямо из поиска', editable === true, 'кнопка «Изменить» у результата')

  await act(`
    const field = document.querySelector('input[placeholder="Найти по всей истории"]');
    set(field, 'такого точно нет');
  `)
  await sleep(700)
  const empty2 = await screen()
  check('и честно говорит, когда не нашлось', has(empty2, 'Ничего не нашлось'), line(empty2, 'Ничего не нашлось'))
  await act(`byText('button', 'Сбросить').click();`)
  await sleep(500)

  // ── Долги: люди, разовый долг с возвратом, комната с событием и тратой.
  // Экранов долгов тестами не покрыть — их проверяет только этот прогон.
  await go('/debts')
  const debts0 = await screen()
  check('вкладка «Долги» открылась', has(debts0, 'Долги'), line(debts0, 'Долги'))
  check(
    'без пометки «это я» приложение говорит прямо, чего ему не хватает',
    has(debts0, 'Отметьте себя'),
    line(debts0, 'Отметьте себя'),
  )

  // Фолд может быть уже открыт: раскрываем только если кнопки не видно.
  await act(`if (!byText('button', 'Завести человека')) startsWith('.fold__btn', 'Люди').click();`)
  await sleep(400)
  await act(`byText('button', 'Завести человека').click();`)
  await sleep(400)
  await act(`
    set(document.querySelector('.form input'), 'Аня');
    document.querySelector('.form input[type="checkbox"]').click();
  `)
  await sleep(300)
  await act(`byText('button', 'Завести').click();`)
  await sleep(700)

  await act(`byText('button', 'Завести человека').click();`)
  await sleep(400)
  await act(`set(document.querySelector('.form input'), 'Боря');`)
  await sleep(300)
  await act(`byText('button', 'Завести').click();`)
  await sleep(700)

  const people = await screen()
  check('люди завелись, и «я» помечен', has(people, 'это вы'), line(people, 'это вы'))

  // Вторая пометка «я» не ставится: по ней идут все выборки «мои долги».
  await act(`byText('button', 'Завести человека').click();`)
  await sleep(400)
  await act(`
    set(document.querySelector('.form input'), 'Вера');
    document.querySelector('.form input[type="checkbox"]').click();
  `)
  await sleep(300)
  await act(`byText('button', 'Завести').click();`)
  await sleep(500)
  const second = await screen()
  check(
    'вторая пометка «это я» не ставится, и сказано, на ком стоит первая',
    has(second, 'уже стоит на'),
    line(second, 'уже стоит на'),
  )
  await act(`byText('button', 'Отмена').click();`)
  await sleep(400)

  // Разовый долг: три поля и дата сегодняшним числом.
  await act(`if (!byText('button', 'Записать долг')) startsWith('.fold__btn', 'Разовые долги').click();`)
  await sleep(400)
  await act(`byText('button', 'Записать долг').click();`)
  await sleep(400)
  await act(`
    const amount = [...document.querySelectorAll('.form input')].find((el) => el.inputMode === 'decimal');
    set(amount, '5000');
  `)
  await sleep(300)
  await act(`byText('button', 'Записать').click();`)
  await sleep(800)

  const lent = await screen()
  check('разовый долг записан и назван суммой', has(lent, '5 000'), line(lent, '5 000'))
  check('и попал в итог «кто кому должен»', has(lent, 'должен вам'), line(lent, 'должен вам'))

  // Возврат частями: остаток считается по возвратам, а не хранится.
  await act(`byText('button', 'Вернули').click();`)
  await sleep(400)
  await act(`
    const box = [...document.querySelectorAll('input')].find((el) => el.placeholder === 'сколько вернули');
    set(box, '2000');
  `)
  await sleep(300)
  await act(`byText('button', 'Записать возврат').click();`)
  await sleep(800)
  const repaid = await screen()
  check('после возврата остаётся 3 000, и видно, сколько вернули', has(repaid, '3 000'), line(repaid, '3 000'))
  check('возврат назван вместе с основанием', has(repaid, 'вернули'), line(repaid, 'вернули'))

  // Комната: заводим на двоих, идём внутрь.
  await act(`if (!byText('button', 'Завести комнату')) startsWith('.fold__btn', 'Комнаты').click();`)
  await sleep(400)
  await act(`byText('button', 'Завести комнату').click();`)
  await sleep(400)
  await act(`
    set(document.querySelector('.form input'), 'Лето');
    [...document.querySelectorAll('.form input[type="checkbox"]')].forEach((box) => {
      if (!box.checked) box.click();
    });
  `)
  await sleep(300)
  await act(`byText('button', 'Завести').click();`)
  await sleep(800)
  const rooms = await screen()
  check('комната завелась', has(rooms, 'Лето'), line(rooms, 'Лето'))

  await act(`byText('a', 'Лето').click();`)
  await sleep(800)
  const room0 = await screen()
  check('комната открылась своим адресом', has(room0, 'События и траты'), line(room0, 'участника'))
  // Число рядом со склонением: `plural` ядра отдаёт форму слова, а не число
  // вместе с ней, и потерянное число не ловит ни сторож цифр, ни проверка
  // на слова. Здесь оно проверяется прямо.
  check(
    'в шапке комнаты число стоит рядом со склонением, а не потерялось',
    /2 участника/.test(room0.replace(/ /g, ' ')),
    line(room0, 'участника'),
  )

  await act(`byText('button', 'Новое событие').click();`)
  await sleep(400)
  await act(`set(document.querySelector('.form input'), 'Корт');`)
  await sleep(300)
  await act(`byText('button', 'Завести').click();`)
  await sleep(800)
  const withEvent = await screen()
  check('событие завелось со своей датой и составом', has(withEvent, 'Корт'), line(withEvent, 'Корт'))

  await act(`byText('button', 'Добавить трату').click();`)
  await sleep(400)
  await act(`
    const fields = [...document.querySelectorAll('.form input')];
    set(fields[0], 'Мячи');
    const amount = fields.find((el) => el.inputMode === 'decimal');
    set(amount, '1000');
  `)
  await sleep(300)
  await act(`byText('button', 'Добавить').click();`)
  await sleep(900)

  const spent = await screen()
  check('трата записана', has(spent, 'Мячи'), line(spent, 'Мячи'))
  check('доли поделены поровну и названы поимённо', has(spent, '500,00'), line(spent, '500,00'))
  check('итог события называет личные расходы и оплаченное', has(spent, 'личные расходы'), line(spent, 'личные расходы'))
  check('и «кто кому должен» посчитан', has(spent, 'Боря → Аня'), line(spent, 'Боря → Аня'))

  // Галочка «перевели» — единственное, что становится записью.
  await act(`byText('button', 'Перевели').click();`)
  await sleep(900)
  const settled = await screen()
  check('после отметки о переводе все в расчёте', has(settled, 'в расчёте'), line(settled, 'в расчёте'))
  await act(`if (!byText('button', 'Записать перевод')) startsWith('.fold__btn', 'Переводы').click();`)
  await sleep(500)
  const transfers = await screen()
  check(
    'а сам перевод стал записью в комнате',
    has(transfers, 'Боря → Аня'),
    line(transfers, 'Боря → Аня'),
  )

  // ── Доля весом (Р-33): «Ане две порции, Боре одна».
  await go('/debts')
  await sleep(400)
  await act(`byText('a', 'Лето').click();`)
  await sleep(800)
  await act(`byText('button', 'Добавить трату').click();`)
  await sleep(400)
  await act(`
    const fields = [...document.querySelectorAll('.form input')];
    set(fields[0], 'Пицца');
    set(fields.find((el) => el.inputMode === 'decimal'), '900');
    const how = [...document.querySelectorAll('.form select')].find((each) =>
      [...each.options].some((option) => option.value === 'weights'));
    set(how, 'weights');
    how.dispatchEvent(new Event('change', { bubbles: true }));
  `)
  await sleep(400)
  await act(`set(document.querySelector('input[aria-label="вес у Аня"]'), '2');`)
  await sleep(300)
  await act(`byText('button', 'Добавить').click();`)
  await sleep(900)
  const weighted = await screen()
  check('трата весами подписана словом «весами»', has(weighted, 'весами'), line(weighted, 'весами'))
  check(
    'доли по весам два к одному: 600 и 300',
    /Аня 600,00/.test(weighted.replace(/ /g, ' ')) && /Боря 300,00/.test(weighted.replace(/ /g, ' ')),
    line(weighted, 'Боря 300'),
  )

  // Правка открывается с записанным, а не с пустой суммой.
  await act(`
    const row = [...document.querySelectorAll('li.line')].find((el) => el.textContent.includes('Пицца'));
    [...row.querySelectorAll('button')].find((each) => each.textContent.trim() === 'Изменить').click();
  `)
  await sleep(500)
  const opened = await run(`
    (() => {
      const amount = [...document.querySelectorAll('.form input')].find((el) => el.inputMode === 'decimal');
      const weight = document.querySelector('input[aria-label="вес у Аня"]');
      return (amount ? amount.value : '') + '|' + (weight ? weight.value : '');
    })()
  `)
  check('правка траты открывается с суммой и весом, а не с пустыми полями', opened === '900|2', String(opened))
  await act(`byText('button', 'Отмена').click();`)
  await sleep(400)

  // ── Связь операции с тратой (Р-31): в расход входит доля, а не сумма.
  await go('/entries')
  await sleep(400)
  await act(`byText('button', 'Внести').click();`)
  await sleep(500)
  await act(`
    const amount = document.querySelector('input[placeholder="1234,56"]');
    set(amount, '1000');
    const category = [...document.querySelectorAll('select')].find((each) =>
      [...each.options].some((option) => option.textContent.trim() === 'Еда'));
    set(category, [...category.options].find((option) => option.textContent.trim() === 'Еда').value);
    category.dispatchEvent(new Event('change', { bubbles: true }));
  `)
  await sleep(300)
  await act(`byText('button', 'Записать').click();`)
  await sleep(800)

  // Деньги печатаются неразрывными пробелами, и поиск по обычному не найдёт
  // ничего. Берётся та строка, у которой есть кнопка «Связать»: итог периода
  // с той же суммой её не имеет.
  await act(`
    const flat = (el) => el.textContent.replace(/ | /g, ' ');
    const row = [...document.querySelectorAll('li.line')].find((el) =>
      flat(el).includes('1 000,00') &&
      [...el.querySelectorAll('button')].some((each) => each.textContent.trim() === 'Связать'));
    [...row.querySelectorAll('button')].find((each) => each.textContent.trim() === 'Связать').click();
  `)
  await sleep(600)
  const picker = await screen()
  check('выбор связи предлагает траты комнат', has(picker, 'Мячи'), line(picker, 'Мячи'))

  await act(`
    const pick = [...document.querySelectorAll('select')].find((each) =>
      [...each.options].some((option) => option.textContent.includes('Мячи')));
    set(pick, [...pick.options].find((option) => option.textContent.includes('Мячи')).value);
    pick.dispatchEvent(new Event('change', { bubbles: true }));
  `)
  await sleep(300)
  await act(`byText('button', 'Сохранить').click();`)
  await sleep(900)

  const linked = await screen()
  check('связанная операция показывает свою долю рядом с суммой банка', has(linked, 'своя доля'), line(linked, 'своя доля'))
  check(
    'доля — половина траты, и сумма банка не подменена',
    /своя доля 500,00/.test(linked.replace(/ /g, ' ')) && has(linked, '1 000,00'),
    line(linked, 'своя доля'),
  )

  // ── Капитал (Этап 4): снимки, курсы через доллар, отложенный платёж,
  //    заметки, «Новый снимок» строкой. Экран тестами не покрыть — только
  //    прогоном. Проверяются сами числа, а не слова рядом с ними: слова
  //    остаются верными, когда число посчитано неверно (Журнал 22.09.2026).
  //    Всё выдумано (CLAUDE.md, «Личные данные»).
  await go('/capital')
  const capital0 = await screen()
  check('вкладка «Капитал» открылась и честно пуста', has(capital0, 'Снимков ещё нет'), line(capital0, 'Снимков'))

  // Капитал на 01.09 — до всех долгов прогона (они заведены сегодня), так что
  // итог считается в уме: 12 000 + 0,01 BTC × 50 000 $ × 90 + 100 $ × 90 − 5 000.
  const CAPITAL = JSON.stringify({
    format: 'zloty-import',
    version: 1,
    currencies: [
      { code: 'USD', name: 'Доллар', decimals: 2 },
      { code: 'BTC', name: 'Биткойн', decimals: 8, unit: { name: 'mBTC', factor: 100000 } },
    ],
    accounts: [
      { name: 'Кошелёк', currency: 'BTC', kind: 'savings' },
      { name: 'Площадка', currency: 'USD', kind: 'investment' },
    ],
    rates: [
      { date: '2026-09-01', from: 'USD', to: 'RUB', rate: 90 },
      { date: '2026-09-01', from: 'BTC', to: 'USD', rate: 50000 },
    ],
    balances: [
      { account: 'Синий банк', date: '2026-09-01', part: 'на счёте', amount: 12000 },
      { account: 'Синий банк', date: '2026-09-01', part: 'кредитка', amount: 5000, deferred: true },
      { account: 'Кошелёк', date: '2026-09-01', amount: 0.01 },
      { account: 'Площадка', date: '2026-09-01', amount: 100 },
    ],
    notes: [{ date: '2026-09-01', text: 'прогон: заметка из файла' }],
  })
  await go('/import')
  await act(`set(document.querySelector('.import__text'), ${JSON.stringify(CAPITAL)});`)
  await sleep(300)
  await act(`byText('button', 'Разобрать').click();`)
  await sleep(700)
  const capitalPlan = await screen()
  check(
    'сводка называет снимки и заметки числом',
    /4\s+снимка/.test(capitalPlan.replace(/ /g, ' ')) && /1\s+заметка/.test(capitalPlan.replace(/ /g, ' ')),
    line(capitalPlan, 'Добавится'),
  )
  await act(`startsWith('button', 'Загрузить ').click();`)
  await sleep(900)

  await go('/capital')
  await sleep(500)
  const capital1 = (await screen()).replace(/ /g, ' ')
  check('капитал на дату снимка — 61 000 ₽', has(capital1, 'Капитал на 01.09.2026') && has(capital1, '61 000,00 ₽'), line(capital1, '61 000'))
  check('сбережения — как лежат, кредитка внутри: 57 000 ₽', /Сбережения[\s\S]{0,40}57 000,00 ₽/.test(capital1), line(capital1, '57 000'))
  check('вложения — доллары по 90: 9 000 ₽', /Вложения[\s\S]{0,40}9 000,00 ₽/.test(capital1), line(capital1, '9 000,00'))
  check('отложенный платёж — своей строкой и с минусом', has(capital1, '−5 000,00 ₽'), line(capital1, '−5 000'))
  check('биткойн — через доллар, и оба курса названы (Р-37)', has(capital1, '50 000 USD за BTC и 90 RUB за USD'), line(capital1, 'за BTC'))
  check('счета без снимка названы, а не пропали', has(capital1, 'без снимка, в итог не входят') && has(capital1, 'Наличные'), line(capital1, 'без снимка'))
  check('заметка из файла — у своей даты', has(capital1, 'прогон: заметка из файла'), line(capital1, 'прогон: заметка'))
  check('первая точка сравнивать не с чем', has(capital1, 'первый снимок — сравнивать не с чем'), line(capital1, 'первый снимок'))

  // «Новый снимок» строкой: поля — прошлыми значениями, в единице показа.
  await act(`byText('button', 'Новый снимок').click();`)
  await sleep(500)
  const form = await act(`
    const rows = [...document.querySelectorAll('.snapshot-row')];
    const wallet = rows.find((row) => row.textContent.includes('Кошелёк'));
    return JSON.stringify({ wallet: wallet?.querySelector('input[inputmode="decimal"]')?.value ?? null, same: wallet?.textContent.includes('как в прошлый раз') ?? false });
  `)
  const prefilled = JSON.parse(form ?? '{}')
  check('поле кошелька заполнено прошлым снимком в mBTC: 10', prefilled.wallet === '10', String(prefilled.wallet))
  check('и нетронутая строка так и названа', prefilled.same === true, String(prefilled.same))

  await act(`
    const rows = [...document.querySelectorAll('.snapshot-row')];
    const platform = rows.find((row) => row.textContent.includes('Площадка'));
    set(platform.querySelector('input[inputmode="decimal"]'), '110');
  `)
  await sleep(300)
  await act(`byText('button', 'Записать снимок').click();`)
  await sleep(900)
  const capital2 = (await screen()).replace(/ /g, ' ')
  const todayShown = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
  check('снимок записан строкой на сегодня, и открыт он', has(capital2, `Капитал на ${todayShown}`), line(capital2, 'Капитал на'))
  check('площадка по новому снимку: 110 $ × 90 = 9 900 ₽', /Площадка[\s\S]{0,80}9 900,00 ₽/.test(capital2), line(capital2, '9 900'))
  check('сравнение с прошлым снимком — числом', has(capital2, 'к 01.09.2026 — было 61 000,00 ₽'), line(capital2, 'к 01.09.2026'))

  // Заметка к дате — руками.
  await act(`set(document.querySelector('.block textarea'), 'прогон: заметка руками');`)
  await sleep(200)
  await act(`byText('button', 'Добавить заметку').click();`)
  await sleep(700)
  const capital3 = await screen()
  check('заметка к дате записана', has(capital3, 'прогон: заметка руками'), line(capital3, 'заметка руками'))

  // Единица показа — словами человека, и у валюты есть «Изменить».
  await go('/books')
  await act(`if (!document.body.innerText.includes('показывается в mBTC')) startsWith('.fold__btn', 'Валюты').click();`)
  await sleep(400)
  const booksCapital = (await screen()).replace(/ /g, ' ')
  check('у биткойна видна единица показа: в одном BTC — 1000', has(booksCapital, 'показывается в mBTC: в одном BTC — 1000'), line(booksCapital, 'mBTC'))
  await act(`
    const item = [...document.querySelectorAll('.line')].find((el) => el.textContent.includes('показывается в mBTC'));
    [...item.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Изменить').click();
  `)
  await sleep(400)
  const perMajor = await act(`return document.querySelector('input[placeholder="1000"]')?.value ?? null;`)
  check('правка валюты открывается с единицей: 1000 в одном', perMajor === '1000', String(perMajor))
  await act(`byText('button', 'Отмена').click();`)
  await sleep(300)

  // Вторая валюта капитала: курс в основании называется так, как внесён, —
  // «90 RUB за USD», а не перевёрнутым «0,011111 USD за RUB».
  await act(`if (!document.body.innerText.includes('Вторая валюта капитала')) startsWith('.fold__btn', 'Настройки учёта').click();`)
  await sleep(400)
  await act(`
    const second = [...document.querySelectorAll('label')].find((el) => el.textContent.includes('Вторая валюта капитала')).querySelector('select');
    set(second, 'USD');
    second.dispatchEvent(new Event('change', { bubbles: true }));
  `)
  await sleep(300)
  await act(`
    const block = [...document.querySelectorAll('label')].find((el) => el.textContent.includes('Вторая валюта капитала')).closest('.form');
    [...block.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Сохранить').click();
  `)
  await sleep(700)
  await go('/capital')
  await sleep(500)
  const capital4 = (await screen()).replace(/ /g, ' ')
  check('итог во второй валюте — с курсом, названным как внесён: 90 RUB за USD', has(capital4, '$ по 90 RUB за USD'), line(capital4, 'за USD'))
  check('перевёрнутого курса на экране нет', !has(capital4, 'USD за RUB'), line(capital4, 'USD за RUB'))

  // Курс руками (Р-04): прямой BTC→RUB на сегодня главнее пути через доллар
  // (Р-37) — 0,01 BTC × 6 000 000 = 60 000 ₽ вместо 45 000.
  await act(`startsWith('.fold__btn', 'Курсы на').click();`)
  await sleep(400)
  await act(`
    const form = [...document.querySelectorAll('.form')].find((el) => el.textContent.includes('Курс руками'));
    const selects = form.querySelectorAll('select');
    set(selects[1], 'BTC');
    selects[1].dispatchEvent(new Event('change', { bubbles: true }));
    set(form.querySelector('input[placeholder="86,3"]'), '6000000');
  `)
  await sleep(300)
  await act(`byText('button', 'Записать курс').click();`)
  await sleep(900)
  const capital5 = (await screen()).replace(/ /g, ' ')
  check('курс руками записан и назван', has(capital5, 'Записано: 6 000 000 RUB за BTC'), line(capital5, 'Записано'))
  check(
    'прямой курс главнее пути через доллар: кошелёк — 60 000 ₽',
    /Кошелёк[\s\S]{0,160}6 000 000 RUB за BTC[\s\S]{0,80}60 000,00 ₽/.test(capital5),
    line(capital5, '60 000'),
  )

  // «Подтянуть курсы» (Р-38): в прогоне сети нет — источник обязан быть
  // назван не ответившим, а в базу не должно попасть ничего.
  await offline(true)
  await act(`byText('button', 'Подтянуть курсы').click();`)
  await waitFor(`document.body.innerText.includes('источник не ответил')`, 30_000)
  const capital6 = await screen()
  await offline(false)
  check('источник не ответил — так и сказано, по дате', has(capital6, 'сегодня: источник не ответил'), line(capital6, 'источник не ответил'))
  check('и записывать нечего', has(capital6, 'Добавлять нечего') && !has(capital6, 'Записать курсы'), line(capital6, 'Добавлять нечего'))

  // Источник ответил (ответ подменён перехватом, числа выдуманы): сводка до
  // записи называет каждый курс с датой, а после записи — куда он лёг.
  // Иначе подтянутое на сегодня не видно нигде: блок курсов показывает дату
  // открытого снимка (находка человека на телефоне, 23.09.2026).
  ratesReply = JSON.stringify({ date: '2026-09-21', rub: { usd: 0.0125, btc: 0.0000002 } })
  await send('Fetch.enable', { patterns: [{ urlPattern: '*currency-api*' }] })
  await act(`byText('button', 'Подтянуть курсы').click();`)
  await waitFor(`document.body.innerText.includes('Добавится курсов')`, 15_000)
  const fetched = (await screen()).replace(/ /g, ' ')
  check('сводка источника перечисляет курсы с датой: 21.09.2026 — 80 RUB за USD', has(fetched, '21.09.2026: 80 RUB за USD'), line(fetched, '21.09.2026'))
  await act(`byText('button', 'Записать курсы').click();`)
  await sleep(900)
  const written = (await screen()).replace(/ /g, ' ')
  await send('Fetch.disable')
  ratesReply = null
  check('после записи сказано, куда легли курсы: 2 — на 21.09.2026', has(written, 'Записано курсов: 2 — на 21.09.2026'), line(written, 'Записано курсов'))

  // ── Справка: числа в ней собираются из констант кода, и это видно глазами.
  await go('/help')
  const help = await screen()
  check('справка открылась', has(help, 'Справка'), line(help, 'Справка'))
  await act(`startsWith('.fold__btn', 'Как считаются деньги').click();`)
  await sleep(500)
  const money = await screen()
  check('в справке есть срок годности курса', has(money, 'не старше'), line(money, 'не старше'))
  check(
    'срок подставлен числом из константы',
    /не старше чем\s+\d+\s+(день|дня|дней)/i.test(money.replace(/ /g, ' ')),
    line(money, 'не старше'),
  )

  // Долги в справке: главное правило — долг не расход и не доход (Р-05, Р-31).
  await act(`startsWith('.fold__btn', 'Долги и расход месяца').click();`)
  await sleep(500)
  const helpDebts = await screen()
  check(
    'в справке сказано, что долг не расход и не доход, и как связать операцию',
    has(helpDebts, 'не расход и не доход') && has(helpDebts, 'Связать'),
    line(helpDebts, 'не расход и не доход'),
  )
  await act(`startsWith('.fold__btn', 'Что уже есть').click();`)
  await sleep(500)
  const overview = await screen()
  check(
    '«что уже есть» говорит про долги как про сделанное, а не обещает их',
    has(overview, 'Операцию, оплаченную за компанию') && !has(overview, 'Долги и капитал — следующими'),
    line(overview, 'за компанию'),
  )
  check(
    '«что уже есть» говорит про капитал как про сделанное, а не обещает его',
    has(overview, 'сколько у вас всего на дату') && !has(overview, 'Ещё нет: капитала'),
    line(overview, 'Капитал'),
  )
  // Раздел капитала: имя источника курсов — из константы, а не вписано.
  await act(`startsWith('.fold__btn', 'Капитал: откуда').click();`)
  await sleep(500)
  const helpCapital = await screen()
  check(
    'в справке про капитал — отложенный платёж и источник курсов по имени',
    has(helpCapital, 'Отложенный платёж') && has(helpCapital, 'спрашивает currency-api'),
    line(helpCapital, 'спрашивает'),
  )

  // ── Настройки: синхронизация и копия — экраны ядра, счётчики — свои.
  await go('/settings')
  const settings = await screen()
  check('в настройках есть синхронизация', has(settings, 'Синхронизация'), line(settings, 'Синхронизация'))
  // Перед первой настройкой важно, что поля вообще есть: без них человек
  // не поймёт, чего от него хотят.
  await act(`startsWith('.fold__btn', 'Синхронизация').click();`)
  await sleep(500)
  await act(`
    const box = [...document.querySelectorAll('input[type="checkbox"]')].find((each) =>
      each.closest('label').textContent.includes('приватный репозиторий'));
    box.click();
  `)
  await sleep(600)
  const sync = await run(`
    Boolean(
      document.querySelector('input[placeholder="владелец/репозиторий"]') &&
      document.querySelector('input[placeholder="github_pat_…"]')
    )
  `)
  check('включённая синхронизация просит репозиторий и токен', sync === true, 'владелец/репозиторий и github_pat_…')

  // Выключаем обратно: дальше прогон уходит в офлайн, и попытки ходить
  // в сеть сделали бы его шумным.
  await act(`
    const box = [...document.querySelectorAll('input[type="checkbox"]')].find((each) =>
      each.closest('label').textContent.includes('приватный репозиторий'));
    box.click();
  `)
  await sleep(500)
  check('в настройках есть копия данных', has(settings, 'Копия данных'), line(settings, 'Копия данных'))

  await act(`startsWith('.fold__btn', 'Напоминания').click();`)
  await sleep(500)
  const remind = await screen()
  check('в настройках есть напоминания', has(remind, 'Месяц не внесён'), line(remind, 'Месяц не внесён'))
  check(
    'и сроки в них — из констант, а не вписаны',
    /\d+-го числа/.test(remind),
    line(remind, '-го числа'),
  )

  await act(`startsWith('.fold__btn', 'О приложении').click();`)
  await sleep(500)
  const about = await screen()
  check('раздел «О приложении» разворачивается', has(about, 'Что где лежит'), line(about, 'Что где лежит'))
  // Именно строка счётчика, а не упоминание в описании приложения: без
  // двоеточия с числом проверка прошла бы по соседнему абзацу.
  check(
    'хранилища посчитаны',
    /Операции и итоги:\s*\d+/.test(about.replace(/ /g, ' ')),
    line(about, 'Операции и итоги'),
  )
  // Миграция на версию 2 (Р-30): хранилища долгов завелись, и сценарий
  // выше в них написал. Считаются именно записи — так проверка ловит и то,
  // что хранилище есть, и то, что запись до него дошла.
  const flat = about.replace(/ /g, ' ')
  check(
    'записи долгов легли в свои хранилища',
    /Люди:\s*2/.test(flat) && /Комнаты:\s*1/.test(flat) && /Переводы в комнатах:\s*1/.test(flat),
    [line(about, 'Люди:'), line(about, 'Комнаты:'), line(about, 'Переводы в комнатах')].join(' · '),
  )
  check('видна версия схемы', has(about, 'Версия схемы данных'), line(about, 'Версия схемы данных'))
  // Миграция на версию 3 (Р-36): хранилище заметок к капиталу завелось.
  // Число — само, а не слово «Версия»: слово стоит на месте при любой версии.
  check(
    'схема — версия 3, хранилище заметок есть',
    /Версия схемы данных\D*3\b/.test(flat) && /Заметки к капиталу:\s*\d+/.test(flat),
    [line(about, 'Версия схемы данных'), line(about, 'Заметки к капиталу')].join(' · '),
  )

  // ── Незнакомый адрес открывает приложение, а не пустоту.
  await go('/nope')
  const unknown = await screen()
  check('незнакомый адрес ведёт на «Месяц»', has(unknown, 'Месяц'), line(unknown, 'Месяц'))

  // ── Без сети — из кеша работника. Последним: дальше сети нет.
  const controlled = await waitFor('navigator.serviceWorker?.controller')
  await offline(true)
  await send('Page.navigate', { url: APP })
  await sleep(2000)
  const cached = await screen()
  check(
    'без сети приложение открывается из кеша',
    controlled && cached.trim().length > 0,
    `работник ${controlled ? 'управляет' : 'не управляет'} страницей`,
  )
  await offline(false)
}

// ─── Прогон ────────────────────────────────────────────────────────────────

let server
let browser
let profile

try {
  server = await startServer()
  profile = mkdtempSync(join(tmpdir(), 'smoke-'))
  browser = spawn(
    findBrowser(),
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      // Пустой временный профиль: своей базы у прогона нет и быть не должно.
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--disable-gpu',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  await connect(await pageSocket())
  await scenario(profile)
} catch (failure) {
  problems.push(failure instanceof Error ? failure.message : String(failure))
} finally {
  socket?.close()
  browser?.kill()
  await server?.close()
}

// Браузер отпускает профиль не мгновенно, и на Windows удаление сразу
// после kill падает с EPERM. Не удалось — останется во временных.
await sleep(500)
if (profile) {
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    // Уберётся с временными файлами.
  }
}

const failed = checks.filter((each) => !each.passed)

for (const each of checks) {
  console.log(`${each.passed ? '  ok' : 'НЕТ '} ${each.what}${each.seen ? ` — ${each.seen}` : ''}`)
}

if (problems.length > 0) {
  console.log('\nБраузер сообщил об ошибках:')
  for (const problem of problems) console.log(`  ${problem}`)
}

const bad = failed.length > 0 || problems.length > 0
console.log(
  bad
    ? `\nПрогон не прошёл: проверок ${checks.length}, не сошлось ${failed.length}, ошибок ${problems.length}`
    : `\nПрогон прошёл: ${checks.length} проверок, ошибок нет`,
)

process.exit(bad ? 1 : 0)
