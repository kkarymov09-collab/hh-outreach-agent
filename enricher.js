const https = require('https');
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const INPUT_FILE = path.join(__dirname, 'companies.json');
const OUT_JSON = path.join(__dirname, 'enriched.json');
const OUT_CSV = path.join(__dirname, 'enriched.csv');
const CONCURRENCY = 10;
const MIN_EMPLOYEES = 50; 
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15';

const COOKIE_FILE = path.join(__dirname, '.hh_cookie');
const HH_COOKIE = process.env.HH_COOKIE || (fs.existsSync(COOKIE_FILE) ? fs.readFileSync(COOKIE_FILE, 'utf8').trim() : null);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchPage(empId, retries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = async (currentAttempt) => {
      const options = {
        hostname: 'astana.hh.kz',
        path: `/employer/${empId}`,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ru-RU,ru;q=0.9',
        }
      };
      if (HH_COOKIE) options.headers['Cookie'] = HH_COOKIE;

      https.get(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', async () => {
          if (res.statusCode === 200) {
            resolve(data);
          } else if (res.statusCode === 429 || res.statusCode >= 500 || res.statusCode === 403) {
            if (currentAttempt < retries) {
              await sleep(Math.pow(2, currentAttempt) * 1000);
              attempt(currentAttempt + 1);
            } else { resolve(null); }
          } else {
            resolve(null);
          }
        });
      }).on('error', async () => {
        if (currentAttempt < retries) {
          await sleep(Math.pow(2, currentAttempt) * 1000);
          attempt(currentAttempt + 1);
        } else { resolve(null); }
      });
    };
    attempt(0);
  });
}

const SIZE_MAP = {
  'microBusiness':  { min: 1,    label: 'до 10 человек' },
  'smallBusiness':  { min: 11,   label: '10–50 человек' },
  'mediumBusiness': { min: 51,   label: '50–250 человек' },
  'largeBusiness':  { min: 251,  label: '250+ человек' },
};

function parseSize(employerInfoJson) {
  const sc = employerInfoJson?.sizeCategory;
  if (sc && SIZE_MAP[sc]) return SIZE_MAP[sc];
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
  if (!html) return empty;
  const obj = extractJson(html, '"employerInfo":');
  if (!obj) return empty;
  try {
    const site = obj.site?.href || (obj.site?.hostname ? `https://${obj.site.hostname}` : '') || '';
    const industry = (obj.industries || [])[0]?.trl || 'не указано';
    let desc = (obj.description || '')
      .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
      .replace(/&quot;/g,'"').replace(/&#\d+;/g,'').replace(/&nbsp;/g,' ')
      .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    desc = desc.slice(0, 400) + (desc.length > 400 ? '…' : '');
    return { site, industry, description: desc, size: parseSize(obj) };
  } catch { return empty; }
}

async function processBatch(items, concurrency, asyncFn) {
  const results = [];
  let index = 0;
  
  const worker = async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await asyncFn(items[i], i, items.length);
    }
  };
  
  const workers = Array(concurrency).fill(null).map(worker);
  await Promise.all(workers);
  return results;
}

async function enrich() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error('File not found:', INPUT_FILE);
    process.exit(1);
  }

  const companies = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  console.log(`Loaded companies: ${companies.length}`);
  console.log(`Processing with concurrency: ${CONCURRENCY}\n`);

  let completed = 0;

  const rawResults = await processBatch(companies, CONCURRENCY, async (c, idx, total) => {
    const html = await fetchPage(c.id);
    const info = extractEmployerInfo(html);
    
    completed++;
    const indicator = info.size.min === null ? '⚪' : info.size.min < MIN_EMPLOYEES ? '🔴' : '🟢';
    process.stdout.write(`\r[${String(completed).padStart(3)}/${total}] ${indicator} ${c.name.slice(0,35).padEnd(35)}`);

    return {
      ...c,
      site:         info.site        || '',
      industry:     info.industry    || 'не указано',
      description:  info.description || '',
      employees:    info.size.label,
      employeesMin: info.size.min,
    };
  });

  console.log('\n');
  
  const allKept = rawResults.filter(r => r.employeesMin === null || r.employeesMin >= MIN_EMPLOYEES);
  const skipped = rawResults.length - allKept.length;

  fs.writeFileSync(OUT_JSON, JSON.stringify(allKept, null, 2), 'utf8');

  const header = 'Название,Вакансий,Сотрудники,Отрасль,Сайт,Направления,Ссылка HH\n';
  const rows = allKept.map(e => {
    const q = s => `"${String(s || '').replace(/"/g,'""')}"`;
    return [
      q(e.name), e.vacancies, q(e.employees), q(e.industry),
      q(e.site), q(e.roles.join('; ')), q(e.url)
    ].join(',');
  });
  
  fs.writeFileSync(OUT_CSV, '\uFEFF' + header + rows.join('\n'), 'utf8');

  console.log('─── Summary ────────────────────────────────────────────────');
  console.log(`Companies processed       : ${companies.length}`);
  console.log(`Filtered out              : ${skipped}`);
  console.log(`Saved to enriched.json/csv: ${allKept.length} companies`);
  console.log('─────────────────────────────────────────────────────────');

  const withSite = allKept.filter(e => e.site);
  if (withSite.length > 0) {
    console.log('\nTOP-10 with websites:');
    withSite.slice(0, 10).forEach((e, i) =>
      console.log(`  ${String(i+1).padStart(2)}. ${e.name.slice(0,30).padEnd(30)} | ${e.site}`)
    );
  }
}

enrich().catch(err => {
  console.error('\nCritical Error:', err.message);
  process.exit(1);
});
