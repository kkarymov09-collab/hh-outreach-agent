const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

// ─── Конфигурация ─────────────────────────────────────────────────────────────
const DELAY_MS    = 400;
const PAGE_TIMEOUT = 6000;
const INPUT_FILE  = path.join(__dirname, 'enriched.json');
const OUT_JSON    = path.join(__dirname, 'contacts.json');
const OUT_CSV     = path.join(__dirname, 'contacts.csv');
// ──────────────────────────────────────────────────────────────────────────────

const COOKIE_FILE = path.join(__dirname, '.hh_cookie');
const HH_COOKIE   = process.env.HH_COOKIE
  || (fs.existsSync(COOKIE_FILE) ? fs.readFileSync(COOKIE_FILE, 'utf8').trim() : null);

const UA_BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchUrl(rawUrl, extraHeaders = {}, redirects = 3) {
  return new Promise((resolve) => {
    if (redirects < 0) return resolve({ status: 0, body: '' });
    let parsed;
    try { parsed = new url.URL(rawUrl); } catch { return resolve({ status: 0, body: '' }); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const headers = { 'User-Agent': UA_BROWSER, 'Accept': 'text/html', 'Accept-Language': 'ru-RU,ru;q=0.9', ...extraHeaders };

    const timer = setTimeout(() => resolve({ status: 0, body: '' }), PAGE_TIMEOUT);

    try {
      lib.get({ hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers }, res => {
        clearTimeout(timer);
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          const loc = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
          return resolve(fetchUrl(loc, extraHeaders, redirects - 1));
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }).on('error', () => { clearTimeout(timer); resolve({ status: 0, body: '' }); });
    } catch { clearTimeout(timer); resolve({ status: 0, body: '' }); }
  });
}

// Нормализация телефона → +7XXXXXXXXXX
function normalizePhone(raw) {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) {
    return '+7' + digits.slice(1);
  }
  if (digits.length === 10 && digits[0] !== '0') return '+7' + digits;
  return null;
}

// KZ мобильные префиксы (для WhatsApp — только мобильные)
const KZ_MOBILE = new Set(['700','701','702','705','706','707','708',
  '747','750','751','760','761','762','763','764',
  '771','775','776','777','778']);

// Телефоны которые встречаются на hh.kz как UI-элементы (не контакты компаний)
const PHONE_BLACKLIST = new Set();

// Извлечь все телефоны из текста (только KZ мобильные для WhatsApp)
function extractPhones(text, mobileOnly = false) {
  const re = /(?:\+7|8|\b7)[\s\-()]?(?:\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}|\d{10})/g;
  const found = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = normalizePhone(m[0]);
    if (!n || n === '+70000000000') continue;
    if (PHONE_BLACKLIST.has(n)) continue;
    const prefix = n.slice(2, 5); // после +7
    if (mobileOnly && !KZ_MOBILE.has(prefix)) continue;
    found.add(n);
  }
  return [...found];
}

// Извлечь все email из текста
function extractEmails(text) {
  const re = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const ignoreDomains = ['example.com','domain.com','email.com','sentry.io','yandex-team','w3.org','hh.ru','hh.kz'];
  const imageExts = /\.(png|jpg|jpeg|webp|gif|svg|ico|bmp|tiff|avif|pdf|zip|mp4|mov)$/i;
  const found = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const e = m[0].toLowerCase();
    if (ignoreDomains.some(i => e.includes(i))) continue;
    if (imageExts.test(e)) continue;
    if (e.split('@')[1]?.includes('x.')) continue;
    found.add(e);
  }
  return [...found];
}

// Скрейп страницы hh.kz — ТОЛЬКО email и имя рекрутера
// Телефоны НЕ берём: hh.kz встраивает в страницу телефон залогиненного юзера
async function scrapeHH(empId) {
  const res = await fetchUrl(`https://astana.hh.kz/employer/${empId}`, { Cookie: HH_COOKIE });
  if (res.status !== 200) return {};

  const html = res.body;

  // Определяем телефон залогиненного пользователя и добавляем в blacklist
  const loginPhoneM = html.match(/"login-field-value"\s*:\s*"(\d{10,11})"/);
  if (loginPhoneM) {
    const lp = normalizePhone(loginPhoneM[1]);
    if (lp) PHONE_BLACKLIST.add(lp);
  }

  // Email только из employerInfo JSON (не из всей страницы)
  const emails = [];
  const emailM = html.match(/"email"\s*:\s*"([^"]{3,}@[^"]{3,})"/);
  if (emailM && !emailM[1].includes('sentry') && !emailM[1].includes('hh.')) {
    emails.push(emailM[1]);
  }

  // Имя рекрутера из видимых контактов
  const recruiterM = html.match(/(?:Контактное лицо|Менеджер по|HR)[^:]*:\s*<[^>]+>([^<]{3,60})</i);
  const recruiter  = recruiterM ? recruiterM[1].trim() : null;

  return { phones: [], emails, recruiter };
}

// Скрейп сайта компании — пробуем главную + /contacts
async function scrapeSite(siteUrl) {
  if (!siteUrl) return {};
  const base = siteUrl.replace(/\/$/, '');
  const paths = ['', '/contacts', '/contact', '/kontakty', '/o-nas', '/about',
                 '/о-компании', '/kontakt', '/ru/contacts', '/ru/contact'];

  const emails = new Set();
  const phones = new Set();

  for (const p of paths) {
    const res = await fetchUrl(base + p);
    if (res.status !== 200 || !res.body) continue;

    const chunk = res.body.slice(0, 60000);
    extractEmails(chunk).forEach(e => emails.add(e));
    extractPhones(chunk, true).forEach(ph => phones.add(ph));

    // Нашли контакты — дальше не идём
    if (emails.size > 0 || phones.size > 0) break;
    if (p !== '') await sleep(200);
  }

  return {
    emails: [...emails].slice(0, 3),
    phones: [...phones].slice(0, 3),
  };
}

// Определить вариант шаблона по отрасли и ролям
function chooseVariant(industry, roles) {
  const ind = (industry || '').toLowerCase();
  const rol = (roles || []).join(' ').toLowerCase();
  const combined = ind + ' ' + rol;

  const recruitingKw = ['информационные технологии','розничная торговля','автомобильный','банк',
    'финансы','строительство','производство','логистика','рекрутинг','менеджер по продажам'];
  const onboardingKw = ['ресторан','гостиниц','общепит','кофе','food','торговля','охрана',
    'клинин','сервис','курьер','кассир','официант','образован'];

  if (onboardingKw.some(k => combined.includes(k))) return 'B';
  if (recruitingKw.some(k => combined.includes(k))) return 'A';
  return Math.random() > 0.5 ? 'A' : 'B'; // 50/50 для неопределённых
}

// Шаблоны (WhatsApp)
function buildTemplate(variant, companyName, vacCount, roles) {
  const topRole = (roles || [])[0] || 'специалистов';
  const N = vacCount;
  const name = companyName.split(' ')[0]; // первое слово как краткое имя

  if (variant === 'A') {
    return `Здравствуйте! Алихан, AdaptAI 👋

Заметил что ${name} сейчас активно нанимает — ${N} открытых вакансий на hh.kz, в основном ${topRole}.

На каждую вакансию обычно 100+ откликов, HR тратит дни на ручной отбор. Наш AI делает это за час: ставит % совпадения, автоматически отсеивает слабых, отправляет тест в WhatsApp.

Работает в Казпочте и Трубном заводе.

Скиньте ссылку на одну вакансию — за 24 часа покажу AI-отчёт по реальным откликам. Бесплатно 🙌`;
  } else {
    return `Здравствуйте! Алихан, AdaptAI 👋

Вижу ${name} сейчас нанимает ${N} человек. Через месяц все они будут одновременно адаптироваться и дёргать коллег с одними и теми же вопросами 😅

Мы делаем AI-наставника: отвечает на вопросы новичков по вашим регламентам, ведёт чек-лист с геймификацией (XP, лидерборд). Среднее время адаптации сократили с 4 недель до 9 дней.

Пилоты: Казпочта, HR Partners, Трубный завод.

Пришлите 1 регламент или инструкцию — за день сделаю AI-чат на ваших данных, покажу команде. Бесплатно 👇`;
  }
}

function waLink(phone, text) {
  const clean = phone.replace(/\D/g, '');
  return `https://wa.me/${clean}?text=${encodeURIComponent(text)}`;
}

async function main() {
  const companies = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  console.log(`Компаний для обработки: ${companies.length}\n`);

  const results = [];
  let found = 0;

  for (let i = 0; i < companies.length; i++) {
    const c = companies[i];
    process.stdout.write(`\r[${String(i+1).padStart(3)}/${companies.length}] ${c.name.slice(0,32).padEnd(32)} `);

    const variant = chooseVariant(c.industry, c.roles);
    const template = buildTemplate(variant, c.name, c.vacancies, c.roles);

    // 1. hh.kz страница работодателя
    const hhData = await scrapeHH(c.id);
    await sleep(DELAY_MS);

    // 2. Сайт компании
    const siteData = c.site ? await scrapeSite(c.site) : {};
    if (c.site) await sleep(DELAY_MS);

    // Объединяем и дедублируем
    const phones = [...new Set([...(hhData.phones||[]), ...(siteData.phones||[])])].slice(0, 3);
    const emails = [...new Set([...(hhData.emails||[]), ...(siteData.emails||[])])].slice(0, 3);

    const entry = {
      name:      c.name,
      id:        c.id,
      vacancies: c.vacancies,
      industry:  c.industry,
      site:      c.site || '',
      roles:     c.roles,
      recruiter: hhData.recruiter || '',
      phones,
      emails,
      variant,
      template,
      wa_links:  phones.map(p => waLink(p, template)),
      hh_url:    c.url,
    };

    results.push(entry);
    if (phones.length || emails.length) {
      found++;
      const indicator = phones.length ? `📱${phones[0]}` : `📧${emails[0]}`;
      process.stdout.write(`✅ ${indicator}`);
    } else {
      process.stdout.write(`⚪ нет контактов`);
    }

    // Сохраняем после каждой компании — чтобы не терять данные при остановке
    fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2), 'utf8');
  }

  console.log(`\n\nНайдено контактов: ${found}/${results.length}\n`);

  // Сохраняем JSON
  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2), 'utf8');

  // CSV
  const header = [
    'Компания','Вакансий','Отрасль','Шаблон','Рекрутер',
    'Телефон 1','Телефон 2','Email 1','Email 2',
    'WA-ссылка (кликабельная)','Сайт','hh.kz'
  ].join(',') + '\n';

  const rows = results.map(r => {
    const q = s => `"${String(s||'').replace(/"/g,'""')}"`;
    return [
      q(r.name), r.vacancies, q(r.industry), q('Вариант ' + r.variant), q(r.recruiter),
      q(r.phones[0]||''), q(r.phones[1]||''),
      q(r.emails[0]||''), q(r.emails[1]||''),
      q(r.wa_links[0]||''), q(r.site), q(r.hh_url)
    ].join(',');
  });

  fs.writeFileSync(OUT_CSV, '﻿' + header + rows.join('\n'), 'utf8');

  // Итог
  const withPhone = results.filter(r => r.phones.length > 0).length;
  const withEmail = results.filter(r => r.emails.length > 0).length;
  const withWA    = results.filter(r => r.wa_links.length > 0).length;
  const varA      = results.filter(r => r.variant === 'A').length;
  const varB      = results.filter(r => r.variant === 'B').length;

  console.log('─── Итог ───────────────────────────────────────────────');
  console.log(`📱 С телефоном (WA)  : ${withPhone}  →  ${withWA} готовых WA-ссылок`);
  console.log(`📧 С email           : ${withEmail}`);
  console.log(`🅰️  Вариант A (рекрут): ${varA}`);
  console.log(`🅱️  Вариант B (онборд): ${varB}`);
  console.log(`Без контактов        : ${results.length - found}`);
  console.log('────────────────────────────────────────────────────────');
  console.log('Сохранено: contacts.json + contacts.csv');
  console.log('\n💡 В contacts.csv колонка "WA-ссылка" — кликай и шаблон уже вставлен.');

  // Топ готовых к отправке
  const ready = results
    .filter(r => r.wa_links.length > 0)
    .sort((a,b) => b.vacancies - a.vacancies)
    .slice(0, 10);

  if (ready.length) {
    console.log('\nТОП-10 готовых к WA-рассылке:');
    ready.forEach((r,i) =>
      console.log(`  ${String(i+1).padStart(2)}. ${r.name.slice(0,30).padEnd(31)} ${r.phones[0]}  [${r.variant}]`)
    );
  }
}

main().catch(err => { console.error('\nОшибка:', err.message); process.exit(1); });
