const https = require('https');
const fs   = require('fs');
const path = require('path');

// ─── Конфигурация ─────────────────────────────────────────────────────────────
const AREA         = 159;   // 159 = Астана
const PER_PAGE     = 50;    // hh.kz отдаёт max 50 в HTML
const MAX_PAGES    = 40;    // 40 × 50 = 2000 вакансий максимум
const DELAY_MS     = 400;
const MIN_VACANCIES = 3;
// ──────────────────────────────────────────────────────────────────────────────

// Читаем cookie из файла (сохранён get_token.py) или из env
const COOKIE_FILE = path.join(__dirname, '.hh_cookie');
const HH_COOKIE   = process.env.HH_COOKIE
  || (fs.existsSync(COOKIE_FILE) ? fs.readFileSync(COOKIE_FILE, 'utf8').trim() : null);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function get(hostname, urlPath, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ru-RU,ru;q=0.9',
      ...extraHeaders,
    };
    if (HH_COOKIE) headers['Cookie'] = HH_COOKIE;
    https.get({ hostname, path: urlPath, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

// Загружаем справочник профессиональных ролей с api.hh.ru (публичный endpoint)
async function loadRoles() {
  const res = await get('api.hh.ru', '/professional_roles', { Accept: 'application/json' });
  if (res.status !== 200) return {};
  const data = JSON.parse(res.body);
  const map = {};
  for (const cat of data.categories || []) {
    for (const role of cat.roles || []) {
      map[String(role.id)] = role.name;
    }
  }
  return map;
}

// Извлекаем массив vacancies из HTML-страницы
function extractVacancies(html) {
  const marker = '"vacancies":[{';
  const idx = html.indexOf(marker);
  if (idx < 0) return [];

  const chunk = html.slice(idx + 12); // начиная с [
  let depth = 0, end = 0;
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] === '[') depth++;
    else if (chunk[i] === ']') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (!end) return [];
  try {
    return JSON.parse(chunk.slice(0, end));
  } catch {
    return [];
  }
}

// Проверяем есть ли следующая страница
function hasNextPage(html, currentPage) {
  // hh.kz показывает пагинацию, ищем ссылку на следующую страницу
  return html.includes(`"page":${currentPage + 1}`) ||
         html.includes(`page=${currentPage + 1}"`);
}

async function scan() {
  if (!HH_COOKIE) {
    console.error('Нет cookies! Запусти сначала: python3 get_token.py');
    process.exit(1);
  }

  console.log('Загружаем справочник профессиональных ролей...');
  const rolesMap = await loadRoles();
  console.log(`Загружено ролей: ${Object.keys(rolesMap).length}`);

  const employers = new Map();
  let totalVacancies = 0;
  let emptyPages = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `/search/vacancy?area=${AREA}&per_page=${PER_PAGE}&page=${page}`;
    let res;
    try {
      res = await get('astana.hh.kz', url);
    } catch (err) {
      console.error(`\nОшибка на стр. ${page + 1}: ${err.message}`);
      break;
    }

    if (res.status !== 200) {
      console.error(`\nHTTP ${res.status} на стр. ${page + 1}`);
      break;
    }

    const vacancies = extractVacancies(res.body);

    if (vacancies.length === 0) {
      emptyPages++;
      if (emptyPages >= 2) {
        process.stdout.write(`\n`);
        console.log('Вакансии закончились.');
        break;
      }
      await sleep(DELAY_MS);
      continue;
    }
    emptyPages = 0;
    totalVacancies += vacancies.length;

    for (const v of vacancies) {
      const emp = v.company || {};
      const empId   = String(emp.id || '');
      const empName = emp.visibleName || emp.name || '';
      if (!empId) continue;

      // Роли — список ID в professionalRoleIds[0].professionalRoleId[]
      const roleIds = (v.professionalRoleIds || [])
        .flatMap(r => r.professionalRoleId || []);
      const roleNames = roleIds
        .map(id => rolesMap[String(id)] || `Роль #${id}`);

      if (!employers.has(empId)) {
        employers.set(empId, { id: empId, name: empName, count: 0, roles: new Set() });
      }
      const entry = employers.get(empId);
      entry.count += 1;
      roleNames.forEach(r => entry.roles.add(r));
    }

    const qualifying = [...employers.values()].filter(e => e.count >= MIN_VACANCIES).length;
    process.stdout.write(
      `\rСтраница ${String(page + 1).padStart(2)}/${MAX_PAGES}  |  вакансий: ${totalVacancies}  |  компаний ${MIN_VACANCIES}+: ${qualifying}   `
    );

    if (vacancies.length < PER_PAGE && !hasNextPage(res.body, page)) {
      process.stdout.write('\n');
      console.log('Достигнут конец списка.');
      break;
    }

    if (page < MAX_PAGES - 1) await sleep(DELAY_MS);
  }

  process.stdout.write('\n');

  const result = [...employers.values()]
    .filter(e => e.count >= MIN_VACANCIES)
    .sort((a, b) => b.count - a.count)
    .map(e => ({
      name: e.name,
      id: e.id,
      vacancies: e.count,
      roles: [...e.roles],
      url: `https://hh.kz/employer/${e.id}`,
    }));

  // CSV (BOM для корректного открытия в Excel)
  const csvHeader = 'Название,Вакансий,Направления,Ссылка\n';
  const csvRows = result.map(e => {
    const name  = `"${e.name.replace(/"/g, '""')}"`;
    const roles = `"${e.roles.join('; ').replace(/"/g, '""')}"`;
    return `${name},${e.vacancies},${roles},"${e.url}"`;
  });
  const outDir = __dirname;
  fs.writeFileSync(path.join(outDir, 'companies.csv'), '﻿' + csvHeader + csvRows.join('\n'), 'utf8');
  fs.writeFileSync(path.join(outDir, 'companies.json'), JSON.stringify(result, null, 2), 'utf8');

  console.log('\n─── Итог ───────────────────────────────────────────────');
  console.log(`Всего вакансий просканировано  : ${totalVacancies}`);
  console.log(`Уникальных работодателей       : ${employers.size}`);
  console.log(`Компаний с ${MIN_VACANCIES}+ вакансий        : ${result.length}`);
  console.log('Сохранено: companies.csv, companies.json');
  console.log('────────────────────────────────────────────────────────');

  if (result.length > 0) {
    console.log('\nТОП-15:');
    result.slice(0, 15).forEach((e, i) =>
      console.log(`  ${String(i + 1).padStart(2)}. ${e.name.padEnd(35)} — ${e.vacancies} вак.`)
    );
  }
}

scan().catch(err => {
  console.error('\nКритическая ошибка:', err.message);
  process.exit(1);
});
