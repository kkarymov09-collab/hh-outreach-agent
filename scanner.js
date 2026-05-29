const https = require('https');
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const AREA = 159; // Astana
const PER_PAGE = 50; 
const MAX_PAGES = 40; // 40 * 50 = 2000
const DELAY_MS = 400; 
const MIN_VACANCIES = 3; 
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15';

const COOKIE_FILE = path.join(__dirname, '.hh_cookie');
const HH_COOKIE = process.env.HH_COOKIE || (fs.existsSync(COOKIE_FILE) ? fs.readFileSync(COOKIE_FILE, 'utf8').trim() : null);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchHTML(hostname, urlPath, retries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = async (currentAttempt) => {
      const options = {
        hostname,
        path: urlPath,
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
            } else {
              reject(new Error(`HTTP ${res.statusCode} after ${retries} retries.`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode} for ${urlPath}`));
          }
        });
      }).on('error', async (err) => {
        if (currentAttempt < retries) {
          await sleep(Math.pow(2, currentAttempt) * 1000);
          attempt(currentAttempt + 1);
        } else {
          reject(err);
        }
      });
    };
    attempt(0);
  });
}

async function loadRoles() {
  try {
    const html = await fetchHTML('api.hh.ru', '/professional_roles');
    const data = JSON.parse(html);
    const map = {};
    for (const cat of data.categories || []) {
      for (const role of cat.roles || []) {
        map[String(role.id)] = role.name;
      }
    }
    return map;
  } catch (err) {
    console.error('Failed to load professional roles, skipping...', err.message);
    return {};
  }
}

function extractVacancies(html) {
  const marker = '"vacancies":[{';
  const idx = html.indexOf(marker);
  if (idx < 0) return [];

  const chunk = html.slice(idx + 12); 
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

function hasNextPage(html, currentPage) {
  return html.includes(`"page":${currentPage + 1}`) || html.includes(`page=${currentPage + 1}"`);
}

async function scan() {
  console.log('Loading professional roles dictionary...');
  const rolesMap = await loadRoles();
  console.log(`Loaded roles.\n`);

  const employers = new Map();
  let totalVacancies = 0;
  let emptyPages = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `/search/vacancy?area=${AREA}&per_page=${PER_PAGE}&page=${page}`;
    let html;
    try {
      html = await fetchHTML('astana.hh.kz', url);
    } catch (err) {
      console.error(`\nFatal error on page ${page + 1}: ${err.message}`);
      break;
    }

    const vacancies = extractVacancies(html);
    if (vacancies.length === 0) {
      emptyPages++;
      if (emptyPages >= 2) break;
      await sleep(DELAY_MS);
      continue;
    }
    emptyPages = 0;
    totalVacancies += vacancies.length;

    for (const v of vacancies) {
      const emp = v.company || {};
      const empId = String(emp.id || '');
      const empName = emp.visibleName || emp.name || '';
      if (!empId) continue;

      const roleIds = (v.professionalRoleIds || []).flatMap(r => r.professionalRoleId || []);
      const roleNames = roleIds.map(id => rolesMap[String(id)] || `Role #${id}`);

      if (!employers.has(empId)) {
        employers.set(empId, { id: empId, name: empName, count: 0, roles: new Set() });
      }
      const entry = employers.get(empId);
      entry.count += 1;
      roleNames.forEach(r => entry.roles.add(r));
    }

    const qualifying = [...employers.values()].filter(e => e.count >= MIN_VACANCIES).length;
    process.stdout.write(
      `\rPage ${String(page + 1).padStart(2)}/${MAX_PAGES} | Vacancies: ${totalVacancies} | Employers ${MIN_VACANCIES}+: ${qualifying}   `
    );

    if (vacancies.length < PER_PAGE && !hasNextPage(html, page)) break;
    if (page < MAX_PAGES - 1) await sleep(DELAY_MS);
  }

  console.log('\n');
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

  const csvHeader = 'Name,Vacancies,Roles,URL\n';
  const csvRows = result.map(e => {
    const name = `"${e.name.replace(/"/g, '""')}"`;
    const roles = `"${e.roles.join('; ').replace(/"/g, '""')}"`;
    return `${name},${e.vacancies},${roles},"${e.url}"`;
  });
  
  const outDir = __dirname;
  fs.writeFileSync(path.join(outDir, 'companies.csv'), '\uFEFF' + csvHeader + csvRows.join('\n'), 'utf8');
  fs.writeFileSync(path.join(outDir, 'companies.json'), JSON.stringify(result, null, 2), 'utf8');

  console.log('─── Summary ──────────────────────────────────────────────');
  console.log(`Total vacancies scanned        : ${totalVacancies}`);
  console.log(`Unique employers               : ${employers.size}`);
  console.log(`Employers with ${MIN_VACANCIES}+ vacancies   : ${result.length}`);
  console.log('Saved to: companies.csv, companies.json');
}

scan().catch(err => {
  console.error('\nCritical Error:', err.message);
  process.exit(1);
});
