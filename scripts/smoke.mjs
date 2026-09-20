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
    entries: [
      { kind: 'expense', account: 'Синий банк', amount: 120.5, date: '2026-09-18', category: 'Транспорт', bankText: 'МЕТРО 120.50' },
      { kind: 'income', account: 'Синий банк', amount: 30, date: '2026-09-18', category: 'Кэшбэк', bankText: 'КЭШБЭК' },
    ],
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

  // Промпт обязан знать мои счета и категории — иначе беседа разложит наугад.
  await act(`startsWith('.fold__btn', 'Как подготовить файл').click();`)
  await sleep(400)
  await act(`startsWith('.fold__btn', 'Показать промпт').click();`)
  await sleep(400)
  const prompt = await screen()
  check('промпт знает мои счета', has(prompt, '«Синий банк» (RUB)'), line(prompt, 'Синий банк» (RUB)'))
  check('промпт знает мои категории', has(prompt, 'Расходные категории'), line(prompt, 'Расходные категории'))

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
  check(
    'счёт истории в список выписок не попал',
    !has(history, 'Старая таблица'),
    'выписки на счёт истории не грузятся никогда',
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
