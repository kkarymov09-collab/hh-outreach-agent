const https = require('https');
const fs   = require('fs');
const path = require('path');

// ─── Конфигурация ─────────────────────────────────────────────────────────────
const MIN_EMPLOYEES = 50;   // Фильтр: минимальный размер компании
const DELAY_MS      = 500;  // Задержка между запросами (мс)
const INPUT_FILE    = path.join(__dirname, 'companies.json');
const OUT_JSON      = path.join(__dirname, 'enriched.json');
const OUT_CSV       = path.join(__dirname, 'enriched.csv');
// ──────────────────────────────────────────────────────────────────────────────

const COOKIE_FILE = path.join(__dirname, '.hh_cookie');
const HH_COOKIE   = process.env.HH_COOKIE
  || (fs.existsSync(COOKIE_FILE) ? fs.readFileSync(COOKIE_FILE, 'utf8').trim() : null);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getPage(empId) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru-RU,ru;q=0.9',
    };
    if (HH_COOKIE) headers['Cookie'] = HH_COOKIE;
    https.get({ hostname: 'astana.hh.kz', path: `/employer/${empId}`, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

// Размер компании — ТОЛЬКО из employerInfo JSON (sizeCategory)
// Большинство компаний не заполняют → "не указано"
const SIZE_MAP = {
  // hh.ru/hh.kz возможные значения sizeCategory
  'microBusiness':  { min: 1,    label: 'до 10 человек' },
  'smallBusiness':  { min: 11,   label: '10–50 человек' },
  'mediumBusiness': { min: 51,   label: '50–250 человек' },
  'largeBusiness':  { min: 251,  label: '250+ человек' },
};

function parseSize(employerInfoJson) {
  const sc = employerInfoJson?.sizeCategory;
  if (sc && SIZE_MAP[sc]) return SIZE_MAP[sc];

  // Некоторые компании хранят numEmployees как число
  const n = employerInfoJson?.numEmployees;
  if (n && typeof n === 'number') return { min: n, label: `~${n} человек` };

  return { min: null, label: 'не указано' };
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

function extractEmployerInfo(html) {
  const empty = { site: '', industry: 'не указано', description: '', size: { min: null, label: 'не указано' } };
  const obj = extractJson(html, '"employerInfo":');
  if (!obj) return empty;
  try {
    const site     = obj.site?.href
      || (obj.site?.hostname ? `https://${obj.site.hostname}` : '') || '';
    const industry = (obj.industries || [])[0]?.trl || 'не указано';
    let desc = (obj.description || '')
      .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
      .replace(/&quot;/g,'"').replace(/&#\d+;/g,'').replace(/&nbsp;/g,' ')
      .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    desc = desc.slice(0, 400) + (desc.length > 400 ? '…' : '');
    const size = parseSize(obj);
    return { site, industry, description: desc, size };
  } catch { return empty; }
}

async function enrich() {
  if (!HH_COOKIE) {
    console.error('Нет cookie! Запусти: python3 get_token.py');
    process.exit(1);
  }

  const companies = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  console.log(`Загружено компаний: ${companies.length}`);
  console.log(`Фильтр: ${MIN_EMPLOYEES}+ сотрудников\n`);

  const results   = [];
  const skipped   = [];
  const noSizeData = [];

  for (let i = 0; i < companies.length; i++) {
    const c = companies[i];
    process.stdout.write(`\r[${String(i+1).padStart(3)}/${companies.length}] ${c.name.slice(0,35).padEnd(35)} `);

    let html = '';
    try {
      const res = await getPage(c.id);
      if (res.status !== 200) {
        process.stdout.write(`HTTP ${res.status} — пропуск`);
        await sleep(DELAY_MS);
        continue;
      }
      html = res.body;
    } catch (e) {
      process.stdout.write(`Ошибка: ${e.message.slice(0,30)}`);
      await sleep(DELAY_MS);
      continue;
    }

    const info = extractEmployerInfo(html);
    const { size } = info;

    const enriched = {
      ...c,
      site:         info.site        || '',
      industry:     info.industry    || 'не указано',
      description:  info.description || '',
      employees:    size.label,
      employeesMin: size.min,
    };

    if (size.min === null) {
      // Размер неизвестен — оставляем (большинство KZ компаний не заполняют)
      noSizeData.push(enriched);
      process.stdout.write(`⚪ размер не указан`);
    } else if (size.min < MIN_EMPLOYEES) {
      skipped.push(enriched);
      process.stdout.write(`🔴 ${size.label} — пропуск`);
    } else {
      results.push(enriched);
      process.stdout.write(`🟢 ${size.label}`);
    }

    if (i < companies.length - 1) await sleep(DELAY_MS);
  }

  console.log('\n');

  // Объединяем: прошедшие фильтр + те у кого нет данных (оставляем на усмотрение)
  const allKept = [...results, ...noSizeData];

  // JSON
  fs.writeFileSync(OUT_JSON, JSON.stringify(allKept, null, 2), 'utf8');

  // CSV
  const header = 'Название,Вакансий,Сотрудники,Отрасль,Сайт,Направления,Ссылка HH\n';
  const rows = allKept.map(e => {
    const q  = s => `"${String(s).replace(/"/g,'""')}"`;
    return [
      q(e.name), e.vacancies, q(e.employees), q(e.industry),
      q(e.site), q(e.roles.join('; ')), q(e.url)
    ].join(',');
  });
  fs.writeFileSync(OUT_CSV, '﻿' + header + rows.join('\n'), 'utf8');

  console.log('─── Итог ────────────────────────────────────────────────');
  console.log(`Исходных компаний         : ${companies.length}`);
  console.log(`🟢 Прошли фильтр (${MIN_EMPLOYEES}+)    : ${results.length}`);
  console.log(`⚪ Размер не указан       : ${noSizeData.length}`);
  console.log(`🔴 Отфильтровано (<${MIN_EMPLOYEES})   : ${skipped.length}`);
  console.log(`Сохранено в enriched.json/csv: ${allKept.length} компаний`);
  console.log('─────────────────────────────────────────────────────────');

  if (allKept.length > 0) {
    console.log('\nТОП-10 по вакансиям (с сайтами):');
    allKept
      .filter(e => e.site)
      .slice(0, 10)
      .forEach((e, i) =>
        console.log(`  ${String(i+1).padStart(2)}. ${e.name.slice(0,30).padEnd(30)} | ${e.employees.padEnd(25)} | ${e.site}`)
      );
  }
}

enrich().catch(err => {
  console.error('\nКритическая ошибка:', err.message);
  process.exit(1);
});
