/**
 * expand.js — расширенный поиск контактов
 * Сканирует ВСЕ компании Астаны (мин. 1 вакансия),
 * пропускает уже обработанные, добавляет новые в contacts.json
 *
 * Запуск: node expand.js
 */

'use strict';
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

// ─── Конфигурация ─────────────────────────────────────────────────────────────
const MIN_VACANCIES = 1;
const MAX_PAGES     = 40;
const PER_PAGE      = 50;
const AREA          = 159;      // 159 = Астана
const DELAY_MS      = 450;
const PAGE_TIMEOUT  = 8000;
const CONTACTS_FILE = path.join(__dirname, 'contacts.json');
// ──────────────────────────────────────────────────────────────────────────────

const COOKIE_FILE = path.join(__dirname, '.hh_cookie');
const HH_COOKIE   = process.env.HH_COOKIE
  || (fs.existsSync(COOKIE_FILE) ? fs.readFileSync(COOKIE_FILE, 'utf8').trim() : null);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── HTTP/HTTPS с таймаутом и редиректами ─────────────────────────────────
function fetchUrl(rawUrl, extraHeaders = {}, redirects = 3) {
  return new Promise(resolve => {
    if (redirects < 0) return resolve({ status: 0, body: '' });
    let parsed;
    try { parsed = new url.URL(rawUrl); } catch { return resolve({ status: 0, body: '' }); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const headers = { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'ru-RU,ru;q=0.9', ...extraHeaders };
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

// ─── hh.kz HTML scraping ──────────────────────────────────────────────────
function extractVacancies(html) {
  const marker = '"vacancies":[{';
  const idx = html.indexOf(marker);
  if (idx < 0) return [];
  const chunk = html.slice(idx + 12);
  let depth = 0, end = 0;
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] === '[') depth++;
    else if (chunk[i] === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (!end) return [];
  try { return JSON.parse(chunk.slice(0, end)); } catch { return []; }
}

function extractJson(html, marker) {
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  const start = html.indexOf('{', idx + marker.length);
  if (start < 0) return null;
  let depth = 0, i = start;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  try { return JSON.parse(html.slice(start, i)); } catch { return null; }
}

// ─── Телефоны и Email ──────────────────────────────────────────────────────
const KZ_MOBILE = new Set(['700','701','702','705','706','707','708',
  '747','750','751','760','761','762','763','764',
  '771','775','776','777','778']);
const PHONE_BLACKLIST = new Set();

function normalizePhone(raw) {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) return '+7' + digits.slice(1);
  if (digits.length === 10 && digits[0] !== '0') return '+7' + digits;
  return null;
}

function extractPhones(text, mobileOnly = false) {
  const re = /(?:\+7|8|\b7)[\s\-()]?(?:\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}|\d{10})/g;
  const found = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = normalizePhone(m[0]);
    if (!n || n === '+70000000000') continue;
    if (PHONE_BLACKLIST.has(n)) continue;
    if (mobileOnly && !KZ_MOBILE.has(n.slice(2, 5))) continue;
    found.add(n);
  }
  return [...found];
}

function extractEmails(text) {
  const re = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const ignoreDomains = ['example.com','domain.com','email.com','sentry.io','yandex-team','w3.org','hh.ru','hh.kz'];
  // Расширения файлов — это не email-домены
  const imageExts = /\.(png|jpg|jpeg|webp|gif|svg|ico|bmp|tiff|avif|pdf|zip|mp4|mov)$/i;
  const found = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const e = m[0].toLowerCase();
    if (ignoreDomains.some(i => e.includes(i))) continue;
    if (imageExts.test(e)) continue;  // logo@2x.png, icons@2x.webp и т.п.
    if (e.split('@')[1]?.includes('x.')) continue; // 2x.png, 1x.webp паттерны
    found.add(e);
  }
  return [...found];
}

// ─── Обогащение: сайт + отрасль ───────────────────────────────────────────
async function enrichCompany(empId) {
  const res = await fetchUrl(`https://astana.hh.kz/employer/${empId}`, { Cookie: HH_COOKIE });
  if (res.status !== 200) return { site: '', industry: 'не указано', emails: [], phones: [] };
  const html = res.body;

  // Blacklist телефона залогиненного пользователя
  const loginPhoneM = html.match(/"login-field-value"\s*:\s*"(\d{10,11})"/);
  if (loginPhoneM) { const lp = normalizePhone(loginPhoneM[1]); if (lp) PHONE_BLACKLIST.add(lp); }

  const obj = extractJson(html, '"employerInfo":');
  const site     = obj?.site?.href || (obj?.site?.hostname ? `https://${obj.site.hostname}` : '') || '';
  const industry = (obj?.industries || [])[0]?.trl || 'не указано';

  // Email только из employerInfo JSON
  const emails = [];
  const emailM = html.match(/"email"\s*:\s*"([^"]{3,}@[^"]{3,})"/);
  if (emailM && !emailM[1].includes('sentry') && !emailM[1].includes('hh.')) emails.push(emailM[1]);

  const recruiterM = html.match(/(?:Контактное лицо|Менеджер по|HR)[^:]*:\s*<[^>]+>([^<]{3,60})</i);
  const recruiter  = recruiterM ? recruiterM[1].trim() : '';

  return { site, industry, emails, phones: [], recruiter };
}

// ─── Сайт компании: телефоны + email ──────────────────────────────────────
async function scrapeSite(siteUrl) {
  if (!siteUrl) return {};
  const base  = siteUrl.replace(/\/$/, '');
  const paths = ['', '/contacts', '/contact', '/kontakty', '/o-nas', '/about',
                 '/kontakt', '/ru/contacts', '/ru/contact'];
  const emails = new Set();
  const phones = new Set();
  for (const p of paths) {
    const res = await fetchUrl(base + p);
    if (res.status !== 200 || !res.body) continue;
    const chunk = res.body.slice(0, 60000);
    extractEmails(chunk).forEach(e => emails.add(e));
    extractPhones(chunk, true).forEach(ph => phones.add(ph));
    if (emails.size > 0 || phones.size > 0) break;
    if (p !== '') await sleep(200);
  }
  return { emails: [...emails].slice(0, 3), phones: [...phones].slice(0, 3) };
}

// ─── Профессиональные роли ──────────────────────────────────────────────────
async function loadRoles() {
  const res = await fetchUrl('https://api.hh.ru/professional_roles', { Accept: 'application/json' });
  if (res.status !== 200) return {};
  try {
    const data = JSON.parse(res.body);
    const map = {};
    for (const cat of data.categories || []) {
      for (const role of cat.roles || []) map[String(role.id)] = role.name;
    }
    return map;
  } catch { return {}; }
}

// ─── A/B вариант и шаблон ─────────────────────────────────────────────────
function chooseVariant(industry, roles) {
  const combined = ((industry || '') + ' ' + (roles || []).join(' ')).toLowerCase();
  const recruitingKw = ['информационные технологии','розничная торговля','автомобильный','банк',
    'финансы','строительство','производство','логистика','рекрутинг','менеджер по продажам'];
  const onboardingKw = ['ресторан','гостиниц','общепит','кофе','food','торговля','охрана',
    'клинин','сервис','курьер','кассир','официант','образован'];
  if (onboardingKw.some(k => combined.includes(k))) return 'B';
  if (recruitingKw.some(k => combined.includes(k))) return 'A';
  return Math.random() > 0.5 ? 'A' : 'B';
}

function buildTemplate(variant, companyName, vacCount, roles) {
  const topRole = (roles || [])[0] || 'специалистов';
  const name    = companyName.split(' ')[0];
  if (variant === 'A') {
    return `Здравствуйте! Алихан, AdaptAI 👋\n\nЗаметил что ${name} сейчас активно нанимает — ${vacCount} открытых вакансий на hh.kz, в основном ${topRole}.\n\nНа каждую вакансию обычно 100+ откликов, HR тратит дни на ручной отбор. Наш AI делает это за час: ставит % совпадения, автоматически отсеивает слабых, отправляет тест в WhatsApp.\n\nРаботает в Казпочте и Трубном заводе.\n\nСкиньте ссылку на одну вакансию — за 24 часа покажу AI-отчёт по реальным откликам. Бесплатно 🙌`;
  } else {
    return `Здравствуйте! Алихан, AdaptAI 👋\n\nВижу ${name} сейчас нанимает ${vacCount} человек. Через месяц все они будут одновременно адаптироваться и дёргать коллег с одними и теми же вопросами 😅\n\nМы делаем AI-наставника: отвечает на вопросы новичков по вашим регламентам, ведёт чек-лист с геймификацией (XP, лидерборд). Среднее время адаптации сократили с 4 недель до 9 дней.\n\nПилоты: Казпочта, HR Partners, Трубный завод.\n\nПришлите 1 регламент или инструкцию — за день сделаю AI-чат на ваших данных, покажу команде. Бесплатно 👇`;
  }
}

function waLink(phone, text) {
  return `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
}

// ─── Главная функция ───────────────────────────────────────────────────────
async function main() {
  if (!HH_COOKIE) {
    console.error('Нет cookie! Запусти: python3 get_token.py');
    process.exit(1);
  }

  // Загружаем уже обработанные компании
  const existing = fs.existsSync(CONTACTS_FILE)
    ? JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'))
    : [];
  const existingIds = new Set(existing.map(c => String(c.id)));
  console.log(`Уже обработано: ${existingIds.size} компаний`);

  // Загружаем роли
  process.stdout.write('Загружаем справочник ролей... ');
  const rolesMap = await loadRoles();
  console.log(`${Object.keys(rolesMap).length} ролей`);

  // ── Этап 1: Сканируем все страницы hh.kz ──────────────────────────────
  console.log(`\nСканирование hh.kz (MIN=${MIN_VACANCIES} вакансия)...\n`);
  const employers = new Map();
  let totalVac = 0;
  let emptyPages = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const urlPath = `/search/vacancy?area=${AREA}&per_page=${PER_PAGE}&page=${page}`;
    const res = await fetchUrl(`https://astana.hh.kz${urlPath}`, { Cookie: HH_COOKIE });
    if (res.status !== 200) { console.log(`\nHTTP ${res.status} на стр.${page+1}, стоп.`); break; }

    const vacs = extractVacancies(res.body);
    if (vacs.length === 0) { if (++emptyPages >= 2) break; await sleep(DELAY_MS); continue; }
    emptyPages = 0;
    totalVac += vacs.length;

    for (const v of vacs) {
      const emp = v.company || {};
      const empId = String(emp.id || '');
      if (!empId || existingIds.has(empId)) continue;
      const roleIds   = (v.professionalRoleIds || []).flatMap(r => r.professionalRoleId || []);
      const roleNames = roleIds.map(id => rolesMap[String(id)] || `Роль #${id}`);
      if (!employers.has(empId)) {
        employers.set(empId, { id: empId, name: emp.visibleName || emp.name || '', count: 0, roles: new Set() });
      }
      const e = employers.get(empId);
      e.count += 1;
      roleNames.forEach(r => e.roles.add(r));
    }

    const newQual = [...employers.values()].filter(e => e.count >= MIN_VACANCIES).length;
    process.stdout.write(`\rСтр. ${page+1}/${MAX_PAGES} | вакансий: ${totalVac} | новых компаний: ${newQual}   `);

    if (vacs.length < PER_PAGE) { process.stdout.write('\n'); console.log('Конец списка.'); break; }
    await sleep(DELAY_MS);
  }
  process.stdout.write('\n');

  const newCompanies = [...employers.values()]
    .filter(e => e.count >= MIN_VACANCIES)
    .sort((a, b) => b.count - a.count)
    .map(e => ({ ...e, roles: [...e.roles], url: `https://hh.kz/employer/${e.id}` }));

  console.log(`\nНовых компаний: ${newCompanies.length}\n`);
  if (newCompanies.length === 0) { console.log('Нет новых компаний.'); return; }

  // ── Этап 2: Обогащение + поиск контактов ──────────────────────────────
  console.log('Обогащение и поиск контактов...\n');
  const newResults = [];
  let foundCount = 0;

  for (let i = 0; i < newCompanies.length; i++) {
    const c = newCompanies[i];
    process.stdout.write(`\r[${String(i+1).padStart(4)}/${newCompanies.length}] ${c.name.slice(0,30).padEnd(30)} `);

    // hh.kz employer page
    const hhData = await enrichCompany(c.id);
    await sleep(DELAY_MS);

    // Сайт компании
    const siteData = hhData.site ? await scrapeSite(hhData.site) : {};
    if (hhData.site) await sleep(DELAY_MS);

    const phones = [...new Set([...(hhData.phones||[]), ...(siteData.phones||[])])].slice(0, 3);
    const emails = [...new Set([...(hhData.emails||[]), ...(siteData.emails||[])])].slice(0, 3);

    const variant  = chooseVariant(hhData.industry, c.roles);
    const template = buildTemplate(variant, c.name, c.count, c.roles);

    const entry = {
      name:      c.name,
      id:        c.id,
      vacancies: c.count,
      industry:  hhData.industry,
      site:      hhData.site || '',
      roles:     c.roles,
      recruiter: hhData.recruiter || '',
      phones,
      emails,
      variant,
      template,
      wa_links:  phones.map(p => waLink(p, template)),
      hh_url:    c.url,
    };

    newResults.push(entry);

    if (phones.length || emails.length) {
      foundCount++;
      const tag = phones.length ? `📱${phones[0]}` : `📧${emails[0]}`;
      process.stdout.write(`✅ ${tag}`);
    } else {
      process.stdout.write(`⚪ нет`);
    }

    // Сохраняем после каждой компании
    const allResults = [...existing, ...newResults];
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(allResults, null, 2), 'utf8');
  }

  // ── Этап 3: Сохранение CSV ──────────────────────────────────────────────
  const allResults = [...existing, ...newResults];
  const csvPath = path.join(__dirname, 'contacts.csv');
  const header = [
    'Компания','Вакансий','Отрасль','Шаблон','Рекрутер',
    'Телефон 1','Телефон 2','Email 1','Email 2',
    'WA-ссылка (кликабельная)','Сайт','hh.kz'
  ].join(',') + '\n';
  const rows = allResults.map(r => {
    const q = s => `"${String(s||'').replace(/"/g,'""')}"`;
    return [
      q(r.name), r.vacancies, q(r.industry), q('Вариант ' + r.variant), q(r.recruiter||''),
      q(r.phones[0]||''), q(r.phones[1]||''),
      q(r.emails[0]||''), q(r.emails[1]||''),
      q(r.wa_links[0]||''), q(r.site||''), q(r.hh_url)
    ].join(',');
  });
  fs.writeFileSync(csvPath, '﻿' + header + rows.join('\n'), 'utf8');

  // ── Итог ──────────────────────────────────────────────────────────────
  const newWithEmail = newResults.filter(r => r.emails.length > 0);
  const newWithPhone = newResults.filter(r => r.phones.length > 0);

  console.log(`\n\n${'─'.repeat(58)}`);
  console.log(`Новых компаний обработано  : ${newResults.length}`);
  console.log(`📧 Новых с email           : ${newWithEmail.length}`);
  console.log(`📱 Новых с телефоном (WA)  : ${newWithPhone.length}`);
  console.log(`Итого в contacts.json      : ${allResults.length} компаний`);
  console.log('─'.repeat(58));

  if (newWithEmail.length > 0) {
    console.log('\nНовые email-контакты:');
    newWithEmail.forEach((r, i) =>
      console.log(`  ${String(i+1).padStart(2)}. ${r.name.slice(0,33).padEnd(34)} ${r.emails[0]}  [${r.variant}]`)
    );
    console.log(`\n✅ Отправь письма: node send_emails.js`);
    console.log('   (уже отправленные пропустятся автоматически)');
  } else {
    console.log('\n⚠️  Новых email не найдено.');
    console.log('   Большинство KZ-компаний не публикуют контакты онлайн.');
    console.log('   Вариант: искать вручную в 2GIS или корпоративных справочниках.');
  }
}

main().catch(err => { console.error('\nОшибка:', err.message); process.exit(1); });
