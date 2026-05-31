'use strict';
/**
 * ig_enricher.js — обогащает профили Instagram и оценивает потенциал для дизайн-питча
 *
 * Запуск: node ig_enricher.js
 *
 * Читает:  ig_accounts.json
 * Пишет:   ig_enriched.json, ig_enriched.csv
 *
 * Оценка (score) — чем выше, тем ценнее лид:
 *   +3  нет сайта (главная возможность для лендинга)
 *   +2  категория еда/кофе/ресторан
 *   +2  100–10 000 подписчиков (растущий аккаунт, ещё не профессиональный)
 *   +1  10 000–50 000 подписчиков (уже серьёзный, но может апгрейдиться)
 *   +1  короткое или пустое bio (слабый брендинг)
 *   +1  20–300 постов (активны, но не профи)
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// --- Конфигурация ---
const CONCURRENCY = 3;    // Instagram не любит много параллельных запросов
const DELAY_MS    = 1200; // задержка между батчами
const MIN_SCORE   = 3;    // минимальный score для попадания в результат
const MAX_FOLLOWERS = 100000; // крупные аккаунты пропускаем

const INPUT_FILE = path.join(__dirname, 'ig_accounts.json');
const OUT_JSON   = path.join(__dirname, 'ig_enriched.json');
const OUT_CSV    = path.join(__dirname, 'ig_enriched.csv');
const IG_APP_ID  = '936619743392459';

const COOKIE_FILE = path.join(__dirname, '.ig_cookie');
const IG_COOKIE   = process.env.IG_COOKIE
  || (fs.existsSync(COOKIE_FILE) ? fs.readFileSync(COOKIE_FILE, 'utf8').trim() : null);

const FOOD_KEYWORDS = [
  'restaurant', 'cafe', 'coffee', 'coffeeshop', 'food', 'bar', 'bakery',
  'pizza', 'sushi', 'burger', 'grill', 'bistro', 'eatery', 'diner',
  'ресторан', 'кафе', 'кофе', 'кофейн', 'еда', 'пицц', 'суши', 'бар',
  'пекарн', 'кондитер', 'завтрак', 'бургер', 'стейк', 'шашлык',
];

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
        'Accept':           'application/json, */*',
        'Accept-Language':  'ru-RU,ru;q=0.9',
        'Cookie':           IG_COOKIE || '',
        'Referer':          'https://www.instagram.com/',
        'sec-fetch-site':   'same-origin',
        'sec-fetch-mode':   'cors',
      },
    };

    const timer = setTimeout(() => resolve({ status: 0, data: null }), 10000);
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => { chunks.push(c); });
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

async function fetchProfile(username) {
  const res = await igGet(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);
  if (res.status !== 200 || !res.data?.data?.user) return null;

  const u = res.data.data.user;
  return {
    id:          u.id,
    username:    u.username,
    full_name:   u.full_name   || '',
    bio:         u.biography   || '',
    website:     u.external_url || '',
    followers:   u.edge_followed_by?.count || 0,
    following:   u.edge_follow?.count      || 0,
    posts:       u.edge_owner_to_timeline_media?.count || 0,
    is_business: u.is_business_account || false,
    is_private:  u.is_private           || false,
    category:    u.category_name        || '',
    profile_pic: u.profile_pic_url      || '',
    ig_url:      `https://www.instagram.com/${u.username}/`,
  };
}

function scoreProfile(p) {
  let score = 0;
  const reasons = [];

  if (!p.website) {
    score += 3;
    reasons.push('нет сайта');
  }

  const searchText = `${p.category} ${p.bio} ${p.full_name}`.toLowerCase();
  if (FOOD_KEYWORDS.some(k => searchText.includes(k))) {
    score += 2;
    reasons.push('еда/ресторан/кафе');
  }

  if (p.followers >= 100 && p.followers <= 10000) {
    score += 2;
    reasons.push(`${p.followers} подписчиков`);
  } else if (p.followers > 10000 && p.followers <= 50000) {
    score += 1;
    reasons.push(`${p.followers} подписчиков`);
  }

  if (p.bio.length < 60) {
    score += 1;
    reasons.push('короткое описание');
  }

  if (p.posts >= 20 && p.posts <= 300) {
    score += 1;
    reasons.push(`${p.posts} постов`);
  }

  return { score, reasons };
}

function detectType(p) {
  const text = `${p.category} ${p.bio} ${p.full_name}`.toLowerCase();
  if (text.match(/\b(coffee|кофе|кофейн|капучин|латте|эспрессо|cafe\b)/)) return 'cafe';
  if (text.match(/\b(ресторан|restaurant|dining)/))                          return 'restaurant';
  if (text.match(/\b(pizza|пицц)/))                                          return 'pizza';
  if (text.match(/\b(sushi|суши|роллы)/))                                    return 'sushi';
  if (text.match(/\b(bakery|пекарн|кондитер|торт|cake)/))                   return 'bakery';
  if (text.match(/\b(bar|бар|cocktail)/))                                    return 'bar';
  if (text.match(/\b(burger|бургер)/))                                       return 'burger';
  return 'food';
}

async function processBatch(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array(concurrency).fill(null).map(worker));
  return results;
}

async function enrich() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error('ig_accounts.json не найден. Запусти сначала: node ig_scanner.js');
    process.exit(1);
  }

  const accounts = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  console.log(`Аккаунтов к обработке : ${accounts.length}`);
  console.log(`Параллельность        : ${CONCURRENCY}\n`);

  let completed = 0;

  const rawResults = await processBatch(accounts, CONCURRENCY, async (acc, idx) => {
    // Разный старт для воркеров чтобы не стартовали одновременно
    if (idx < CONCURRENCY) await new Promise(r => setTimeout(r, idx * 400));

    const profile = await fetchProfile(acc.username);
    completed++;

    if (!profile) {
      process.stdout.write(`\r[${String(completed).padStart(3)}/${accounts.length}] ⚪ ${acc.username.slice(0, 32).padEnd(32)}`);
      return null;
    }

    if (profile.is_private) {
      process.stdout.write(`\r[${String(completed).padStart(3)}/${accounts.length}] 🔒 ${acc.username.slice(0, 32).padEnd(32)}`);
      return null;
    }

    if (profile.followers > MAX_FOLLOWERS) {
      process.stdout.write(`\r[${String(completed).padStart(3)}/${accounts.length}] 🔵 ${acc.username.slice(0, 32).padEnd(32)} (${profile.followers} — слишком крупный)`);
      return null;
    }

    const { score, reasons } = scoreProfile(profile);
    const type    = detectType(profile);
    const icon    = score >= 7 ? '🎯' : score >= 5 ? '🟢' : score >= MIN_SCORE ? '🟡' : '⚪';
    process.stdout.write(`\r[${String(completed).padStart(3)}/${accounts.length}] ${icon} ${acc.username.slice(0, 28).padEnd(28)} score:${score} ${type.padEnd(10)}`);

    // Небольшая задержка между запросами
    await new Promise(r => setTimeout(r, DELAY_MS));

    return { ...profile, score, reasons, type };
  });

  console.log('\n');

  const filtered = rawResults
    .filter(r => r && r.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);

  fs.writeFileSync(OUT_JSON, JSON.stringify(filtered, null, 2), 'utf8');

  const header = 'Username,Имя,Тип,Подписчики,Постов,Категория,Сайт,Оценка,Причины,Instagram\n';
  const rows   = filtered.map(r => {
    const q = s => `"${String(s || '').replace(/"/g, '""')}"`;
    return [
      q(r.username), q(r.full_name), q(r.type), r.followers, r.posts,
      q(r.category), q(r.website), r.score, q(r.reasons.join('; ')), q(r.ig_url),
    ].join(',');
  });
  fs.writeFileSync(OUT_CSV, '﻿' + header + rows.join('\n'), 'utf8');

  const byType = {};
  filtered.forEach(r => { byType[r.type] = (byType[r.type] || 0) + 1; });

  console.log('─── Итог ──────────────────────────────────────────────────');
  console.log(`Обработано            : ${accounts.length}`);
  console.log(`Прошли фильтр (≥${MIN_SCORE})   : ${filtered.length}`);
  console.log(`Без сайта             : ${filtered.filter(r => !r.website).length}`);
  console.log(`Топ по типам          :`);
  Object.entries(byType).sort((a, b) => b[1] - a[1]).forEach(([t, n]) =>
    console.log(`  ${t.padEnd(14)} : ${n}`)
  );
  console.log('\nСохранено в: ig_enriched.json, ig_enriched.csv');
  console.log('\nСледующий шаг: node ig_outreach.js --dry-run');
}

enrich().catch(err => { console.error('Ошибка:', err.message); process.exit(1); });
