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

function connect(url) {
  socket = new WebSocket(url)

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)

    if (message.id !== undefined) {
      waiting.get(message.id)?.(message)
      waiting.delete(message.id)
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
      { account: 'Зелёный банк', from: '2026-09-01', to: '2026-09-30', income: 0, expense: 500 },
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

  await go('/')
  await sleep(700)
  const waiting = await screen()
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
  check('видна версия схемы', has(about, 'Версия схемы данных'), line(about, 'Версия схемы данных'))

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
