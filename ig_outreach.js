'use strict';
/**
 * ig_outreach.js — генерирует персонализированные DM для Instagram-рассылки
 *
 * Запуск:
 *   node ig_outreach.js                 # генерирует ig_contacts.json + ig_contacts.csv
 *   node ig_outreach.js --dry-run       # предпросмотр сообщений без сохранения
 *   node ig_outreach.js --limit 30      # только первые 30
 *
 * Читает:  ig_enriched.json
 * Пишет:   ig_contacts.json, ig_contacts.csv
 *
 * Настрой PORTFOLIO_URL, YOUR_NAME, TELEGRAM_HANDLE ниже перед запуском.
 */

'use strict';
const fs   = require('fs');
const path = require('path');

// ─── Твои данные — обязательно заполни ────────────────────────────────────
const YOUR_NAME        = 'Имя';               // замени на своё имя
const TELEGRAM_HANDLE  = '@your_telegram';    // замени на свой Telegram
const PORTFOLIO_URL    = 'https://your-portfolio.com'; // замени на свой сайт-портфолио
// ──────────────────────────────────────────────────────────────────────────

const INPUT_FILE = path.join(__dirname, 'ig_enriched.json');
const OUT_JSON   = path.join(__dirname, 'ig_contacts.json');
const OUT_CSV    = path.join(__dirname, 'ig_contacts.csv');

const DRY_RUN  = process.argv.includes('--dry-run');
const limitIdx = process.argv.indexOf('--limit');
const LIMIT    = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1]) : Infinity;

// ─── Шаблоны DM по типу заведения ─────────────────────────────────────────

function buildMessage(p) {
  const nameRaw = p.full_name?.trim() || p.username;
  // Берём первое слово имени для обращения (убираем эмодзи и символы)
  const firstName = nameRaw.replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/)[0] || nameRaw;

  const hasWebsite = Boolean(p.website);
  const type = p.type;

  // ── Кофейня, нет сайта ──
  if (!hasWebsite && (type === 'cafe' || type === 'coffee')) {
    return `Привет! Увидел вашу кофейню в Instagram — очень уютно ☕

Заметил, что нет сайта. Сделаю красивый лендинг с вашим меню, фото и кнопкой записи/заказа. Всё в стиле вашего бренда, выглядит профессионально.

Примеры работ: ${PORTFOLIO_URL}

Делаю быстро — 3–5 дней, цена ниже рынка (хочу кейс в сфере кофеен). Если интересно — напишите, обсудим 🙌`;
  }

  // ── Ресторан / бар, нет сайта ──
  if (!hasWebsite && (type === 'restaurant' || type === 'bar')) {
    return `Привет! Наткнулся на ваш ресторан в Instagram — понравилась концепция 🍽️

Вижу, что нет сайта. Сделаю стильный лендинг с онлайн-меню, фотогалереей и контактами. Помогает находить вас через Google и добавляет доверие новым гостям.

Примеры: ${PORTFOLIO_URL}

3–5 дней, цена ниже рынка. Напишите — обсудим детали 👇`;
  }

  // ── Пиццерия / суши / бургер, нет сайта ──
  if (!hasWebsite && ['pizza', 'sushi', 'burger'].includes(type)) {
    const label = type === 'pizza' ? 'пиццерию' : type === 'sushi' ? 'суши-ресторан' : 'бургерную';
    return `Привет! Увидел вашу ${label} в Instagram — аппетитно 🤤

Нет сайта — значит теряете гостей, которые ищут через Google. Сделаю лендинг с меню, фото блюд и кнопкой заказа/доставки. Смотрится современно и работает на вас 24/7.

Примеры: ${PORTFOLIO_URL}

Готово за 3–5 дней. Пишите — обсудим 👇`;
  }

  // ── Пекарня / кондитерская, нет сайта ──
  if (!hasWebsite && type === 'bakery') {
    return `Привет! Наткнулся на вашу пекарню в Instagram — выглядит вкусно 🥐

Замечаю, что нет сайта. Сделаю красивый лендинг с каталогом выпечки, ценами и формой заказа. Идеально для привлечения корпоративных клиентов и частных заказов на торты.

Примеры: ${PORTFOLIO_URL}

3–5 дней, доступная цена. Напишите если интересно 🙌`;
  }

  // ── Любой тип, нет сайта (дефолт) ──
  if (!hasWebsite) {
    return `Привет! Увидел ваш профиль в Instagram — интересное заведение 🌿

Заметил, что нет сайта. Делаю красивые лендинги для кафе, ресторанов и кофеен Казахстана: онлайн-меню, фото, контакты, бронирование. Быстро, доступно, со вкусом.

Примеры работ: ${PORTFOLIO_URL}

Если интересно — напишите, обсудим детали 👇`;
  }

  // ── Есть сайт, высокий score — питч редизайна ──
  if (p.score >= 5) {
    return `Привет! Наткнулся на ваш профиль — приятное заведение 🙌

Посмотрел ваш сайт и подумал: можно сделать его заметно современнее и продающим. Обновлю дизайн, улучшу меню онлайн, добавлю нужные блоки.

Примеры: ${PORTFOLIO_URL}

Работаю быстро, цена адекватная. Напишите если интересно 👇`;
  }

  // ── Есть сайт, средний score — питч доп. материалов ──
  return `Привет! Увидел ваш профиль в Instagram — классно 🍜

Делаю цифровые меню, QR-меню для столиков, аватарки и шаблоны для Stories для кафе и ресторанов Казахстана. Если понадобится обновить визуал — пишите, помогу 👇

Примеры: ${PORTFOLIO_URL}`;
}

// ─── Главная ───────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error('ig_enriched.json не найден. Запусти: node ig_enricher.js');
    process.exit(1);
  }

  const profiles = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const targets  = profiles.slice(0, LIMIT === Infinity ? profiles.length : LIMIT);

  console.log(`\n🎯 Лидов к обработке : ${targets.length}`);
  if (DRY_RUN) console.log('🔍 DRY-RUN — изменения не сохраняются\n');
  console.log('─'.repeat(60));

  const contacts = targets.map((p, i) => {
    const message = buildMessage(p);

    if (DRY_RUN) {
      console.log(`\n[${i + 1}] @${p.username} | ${p.type} | ${p.followers} подп. | score:${p.score}`);
      console.log(`     ${p.ig_url}`);
      console.log('     Причины:', p.reasons.join(', '));
      console.log('\n─── Сообщение ─────────────────────────────────────────');
      console.log(message);
      console.log('─'.repeat(60));
    }

    return {
      username:    p.username,
      full_name:   p.full_name,
      type:        p.type,
      followers:   p.followers,
      posts:       p.posts,
      website:     p.website,
      score:       p.score,
      reasons:     p.reasons,
      message,
      ig_profile:  p.ig_url,
      ig_dm_url:   `https://www.instagram.com/direct/t/${p.username}/`,
    };
  });

  if (!DRY_RUN) {
    fs.writeFileSync(OUT_JSON, JSON.stringify(contacts, null, 2), 'utf8');

    const header = 'Username,Тип,Подписчиков,Score,Есть сайт,DM-ссылка,Профиль,Сообщение\n';
    const rows   = contacts.map(c => {
      const q = s => `"${String(s || '').replace(/"/g, '""')}"`;
      return [
        q(c.username), q(c.type), c.followers, c.score,
        c.website ? 'да' : 'нет',
        q(c.ig_dm_url), q(c.ig_profile), q(c.message),
      ].join(',');
    });
    fs.writeFileSync(OUT_CSV, '﻿' + header + rows.join('\n'), 'utf8');
  }

  if (!DRY_RUN) {
    const noSite = contacts.filter(c => !c.website).length;
    console.log('\n─── Итог ──────────────────────────────────────────────────');
    console.log(`Подготовлено DM      : ${contacts.length}`);
    console.log(`Без сайта (лендинг)  : ${noSite}`);
    console.log(`Со своим сайтом      : ${contacts.length - noSite}`);
    console.log('\nСохранено в          : ig_contacts.json, ig_contacts.csv');
    console.log('\nОтправить DM автоматически:');
    console.log('  python ig_sender.py --limit 20');
    console.log('\nОткрыть первые 5 профилей:');
    contacts.slice(0, 5).forEach(c => console.log(`  ${c.ig_profile}`));
  }
}

main();
