'use strict';
/**
 * ig_scanner.js — находит Instagram-аккаунты заведений по хэштегам
 *
 * Запуск: node ig_scanner.js
 *
 * Нужен файл .ig_cookie с cookie-строкой из браузера:
 *   1. Войди в instagram.com в браузере
 *   2. DevTools → Network → любой запрос → Headers → Cookie
 *   3. Скопируй всю строку Cookie: ... и сохрани в .ig_cookie
 *
 * Дополнительно: добавь usernames вручную в ig_manual.txt (по одному на строке)
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// --- Конфигурация ---
const HASHTAGS = [
  // Казахстан — общепит
  'астанакафе', 'астанакофейня', 'астанаресторан',
  'алматыкафе', 'алматыкофейня', 'алматыресторан',
  'кафеастана', 'кофейняастана', 'ресторанастана',
  'кафеалматы', 'кофейняалматы', 'ресторанбар',
  // Казахстан — английский
  'cafeastana', 'coffeekazakhstan', 'astanafood',
  'almatycafe', 'almatyfood', 'kazakhstanfood',
  'kazakhstancafe', 'kazakhstanrestaurant',
  // Еда в Казахстане
  'едаастана', 'едаалматы', 'завтракастана',
  'обедастана', 'ужинастана',
];

const DELAY_MS     = 2000;  // задержка между запросами
const OUT_FILE     = path.join(__dirname, 'ig_accounts.json');
const MANUAL_FILE  = path.join(__dirname, 'ig_manual.txt');
const IG_APP_ID    = '936619743392459';

const COOKIE_FILE = path.join(__dirname, '.ig_cookie');
const IG_COOKIE   = process.env.IG_COOKIE
  || (fs.existsSync(COOKIE_FILE) ? fs.readFileSync(COOKIE_FILE, 'utf8').trim() : null);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function extractCsrf(cookie) {
  const m = (cookie || '').match(/csrftoken=([^;]+)/);
  return m ? m[1] : '';
}

function igGet(urlPath) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'www.instagram.com',
      path: urlPath,
      headers: {
        'User-Agent':       'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'x-ig-app-id':      IG_APP_ID,
        'x-csrftoken':      extractCsrf(IG_COOKIE),
        'x-requested-with': 'XMLHttpRequest',
        'Accept':           'application/json, text/plain, */*',
        'Accept-Language':  'ru-RU,ru;q=0.9,en;q=0.8',
        'Cookie':           IG_COOKIE || '',
        'Referer':          'https://www.instagram.com/',
        'sec-fetch-site':   'same-origin',
        'sec-fetch-mode':   'cors',
        'sec-fetch-dest':   'empty',
      },
    };

    const timer = setTimeout(() => resolve({ status: 0, data: null }), 10000);
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        try   { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', () => { clearTimeout(timer); resolve({ status: 0, data: null }); });
    req.end();
  });
}

async function fetchHashtagUsers(tag) {
  const res = await igGet(`/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tag)}`);
  if (res.status !== 200 || !res.data) return [];

  const users = new Set();
  const topSections    = res.data.data?.top?.sections    || [];
  const recentSections = res.data.data?.recent?.sections || [];

  for (const section of [...topSections, ...recentSections]) {
    for (const item of (section.layout_content?.medias || [])) {
      const user = item?.media?.user;
      if (user?.username) users.add(user.username);
    }
  }

  return [...users];
}

async function scan() {
  if (!IG_COOKIE) {
    console.error(`
❌ Instagram cookie не найден.

Как получить:
  1. Открой instagram.com в браузере, войди в аккаунт
  2. DevTools (F12) → Network → обнови страницу → любой запрос к instagram.com
  3. Headers → Request Headers → скопируй строку "Cookie: ..."
  4. Сохрани в файл .ig_cookie (без слова "Cookie: ", только значение)
`);
    process.exit(1);
  }

  console.log('Сканирование Instagram-аккаунтов по хэштегам...\n');
  const allUsers = new Set();

  for (let i = 0; i < HASHTAGS.length; i++) {
    const tag = HASHTAGS[i];
    process.stdout.write(`  [${String(i + 1).padStart(2)}/${HASHTAGS.length}] #${tag.padEnd(30)} `);

    const users = await fetchHashtagUsers(tag);
    users.forEach(u => allUsers.add(u));
    console.log(`+${users.length} (итого: ${allUsers.size})`);

    if (i < HASHTAGS.length - 1) await sleep(DELAY_MS);
  }

  // Добавляем ручной список если есть
  if (fs.existsSync(MANUAL_FILE)) {
    const manual = fs.readFileSync(MANUAL_FILE, 'utf8')
      .split('\n')
      .map(l => l.trim().replace('@', ''))
      .filter(Boolean);
    manual.forEach(u => allUsers.add(u));
    console.log(`\nДобавлено из ig_manual.txt: ${manual.length} аккаунтов`);
  }

  const result = [...allUsers].map(username => ({ username }));
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2), 'utf8');

  console.log('\n─────────────────────────────────────────────────');
  console.log(`Уникальных аккаунтов найдено : ${result.length}`);
  console.log('Сохранено в                  : ig_accounts.json');
  console.log('\nСледующий шаг: node ig_enricher.js');
}

scan().catch(err => { console.error('Ошибка:', err.message); process.exit(1); });
