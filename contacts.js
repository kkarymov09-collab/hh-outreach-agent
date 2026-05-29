const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

// --- Configuration ---
const DELAY_MS    = 200;
const PAGE_TIMEOUT = 6000;
const CONCURRENCY = 10;
const INPUT_FILE  = path.join(__dirname, 'enriched.json');
const OUT_JSON    = path.join(__dirname, 'contacts.json');
const OUT_CSV     = path.join(__dirname, 'contacts.csv');

const COOKIE_FILE = path.join(__dirname, '.hh_cookie');
const HH_COOKIE   = process.env.HH_COOKIE
  || (fs.existsSync(COOKIE_FILE) ? fs.readFileSync(COOKIE_FILE, 'utf8').trim() : null);

const UA_BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function fetchUrl(rawUrl, extraHeaders = {}, redirects = 3) {
  return new Promise((resolve) => {
    if (redirects < 0) return resolve({ status: 0, body: '' });
    let parsed;
    try { parsed = new url.URL(rawUrl); } catch { return resolve({ status: 0, body: '' }); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const headers = { 'User-Agent': UA_BROWSER, 'Accept': 'text/html', 'Accept-Language': 'ru-RU,ru;q=0.9', ...extraHeaders };

    const timer = setTimeout(() => resolve({ status: 0, body: '' }), PAGE_TIMEOUT);

    try {
      const req = lib.get({ hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers, timeout: PAGE_TIMEOUT }, res => {
        clearTimeout(timer);
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          const loc = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
          return resolve(fetchUrl(loc, extraHeaders, redirects - 1));
        }
        const chunks = [];
        let length = 0;
        res.on('data', c => {
          chunks.push(c);
          length += c.length;
          if (length > 200000) { // Limit to 200kb to prevent memory bloat
             res.destroy();
          }
        });
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('close', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }).on('error', () => { clearTimeout(timer); resolve({ status: 0, body: '' }); });
      req.on('timeout', () => { req.destroy(); clearTimeout(timer); resolve({ status: 0, body: '' }); });
    } catch { clearTimeout(timer); resolve({ status: 0, body: '' }); }
  });
}

function normalizePhone(raw) {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) {
    return '+7' + digits.slice(1);
  }
  if (digits.length === 10 && digits[0] !== '0') return '+7' + digits;
  return null;
}

const KZ_MOBILE = new Set(['700','701','702','705','706','707','708',
  '747','750','751','760','761','762','763','764',
  '771','775','776','777','778']);

const PHONE_BLACKLIST = new Set();

function extractPhones(text, mobileOnly = false) {
  const re = /(?:\+7|8|\b7)[\s\-()]?(?:\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}|\d{10})/g;
  const found = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = normalizePhone(m[0]);
    if (!n || n === '+70000000000') continue;
    if (PHONE_BLACKLIST.has(n)) continue;
    const prefix = n.slice(2, 5); 
    if (mobileOnly && !KZ_MOBILE.has(prefix)) continue;
    found.add(n);
  }
  return [...found];
}

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

async function scrapeHH(empId) {
  const res = await fetchUrl(`https://astana.hh.kz/employer/${empId}`, { Cookie: HH_COOKIE });
  if (res.status !== 200) return {};

  const html = res.body;

  const loginPhoneM = html.match(/"login-field-value"\s*:\s*"(\d{10,11})"/);
  if (loginPhoneM) {
    const lp = normalizePhone(loginPhoneM[1]);
    if (lp) PHONE_BLACKLIST.add(lp);
  }

  const emails = [];
  const emailM = html.match(/"email"\s*:\s*"([^"]{3,}@[^"]{3,})"/);
  if (emailM && !emailM[1].includes('sentry') && !emailM[1].includes('hh.')) {
    emails.push(emailM[1]);
  }

  const recruiterM = html.match(/(?:Контактное лицо|Менеджер по|HR)[^:]*:\s*<[^>]+>([^<]{3,60})</i);
  const recruiter  = recruiterM ? recruiterM[1].trim() : null;

  return { phones: [], emails, recruiter };
}

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

    const chunk = res.body.slice(0, 100000);
    extractEmails(chunk).forEach(e => emails.add(e));
    extractPhones(chunk, true).forEach(ph => phones.add(ph));

    if (emails.size > 0 || phones.size > 0) break;
  }

  return {
    emails: [...emails].slice(0, 3),
    phones: [...phones].slice(0, 3),
  };
}

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
  const name = companyName.split(' ')[0]; 

  if (variant === 'A') {
    return `Здравствуйте! Алихан, AdaptAI 👋\n\nЗаметил что ${name} сейчас активно нанимает — ${vacCount} открытых вакансий на hh.kz, в основном ${topRole}.\n\nНа каждую вакансию обычно 100+ откликов, HR тратит дни на ручной отбор. Наш AI делает это за час: ставит % совпадения, автоматически отсеивает слабых, отправляет тест в WhatsApp.\n\nРаботает в Казпочте и Трубном заводе.\n\nСкиньте ссылку на одну вакансию — за 24 часа покажу AI-отчёт по реальным откликам. Бесплатно 🙌`;
  } else {
    return `Здравствуйте! Алихан, AdaptAI 👋\n\nВижу ${name} сейчас нанимает ${vacCount} человек. Через месяц все они будут одновременно адаптироваться и дёргать коллег с одними и теми же вопросами 😅\n\nМы делаем AI-наставника: отвечает на вопросы новичков по вашим регламентам, ведёт чек-лист с геймификацией (XP, лидерборд). Среднее время адаптации сократили с 4 недель до 9 дней.\n\nПилоты: Казпочта, HR Partners, Трубный завод.\n\nПришлите 1 регламент или инструкцию — за день сделаю AI-чат на ваших данных, покажу команде. Бесплатно 👇`;
  }
}

function waLink(phone, text) {
  const clean = phone.replace(/\D/g, '');
  return `https://wa.me/${clean}?text=${encodeURIComponent(text)}`;
}

async function processBatch(items, concurrency, asyncFn) {
  const results = [];
  let index = 0;
  let savedCount = 0;
  
  const worker = async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await asyncFn(items[i], i, items.length);
      savedCount++;
      
      // Periodically save to disk to prevent data loss if script crashes, without blocking too much
      if (savedCount % 20 === 0) {
        fs.writeFileSync(OUT_JSON, JSON.stringify(results.filter(Boolean), null, 2), 'utf8');
      }
    }
  };
  
  const workers = Array(concurrency).fill(null).map(worker);
  await Promise.all(workers);
  return results;
}

async function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error('File not found:', INPUT_FILE);
    process.exit(1);
  }

  const companies = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  console.log(`Companies to process: ${companies.length}`);
  console.log(`Processing with concurrency: ${CONCURRENCY}\n`);

  let found = 0;
  let completed = 0;

  const results = await processBatch(companies, CONCURRENCY, async (c, idx, total) => {
    const variant = chooseVariant(c.industry, c.roles);
    const template = buildTemplate(variant, c.name, c.vacancies, c.roles);

    const hhData = await scrapeHH(c.id);
    const siteData = c.site ? await scrapeSite(c.site) : {};

    const phones = [...new Set([...(hhData.phones||[]), ...(siteData.phones||[])])].slice(0, 3);
    const emails = [...new Set([...(hhData.emails||[]), ...(siteData.emails||[])])].slice(0, 3);

    completed++;
    const indicator = phones.length ? `📱${phones[0]}` : emails.length ? `📧${emails[0]}` : `⚪`;
    process.stdout.write(`\r[${String(completed).padStart(3)}/${total}] ${c.name.slice(0,32).padEnd(32)} ${indicator} `);

    if (phones.length || emails.length) found++;

    return {
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
  });

  console.log(`\n\nContacts found: ${found}/${results.length}\n`);

  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2), 'utf8');

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

  fs.writeFileSync(OUT_CSV, '\uFEFF' + header + rows.join('\n'), 'utf8');

  console.log('─── Summary ───────────────────────────────────────────────');
  const withWA = results.filter(r => r.wa_links.length > 0).length;
  console.log(`📱 With Phone (WA)   : ${withWA}`);
  console.log(`📧 With Email        : ${results.filter(r => r.emails.length > 0).length}`);
  console.log(`Без контактов        : ${results.length - found}`);
  console.log('────────────────────────────────────────────────────────');
}

main().catch(err => { console.error('\nError:', err.message); process.exit(1); });
