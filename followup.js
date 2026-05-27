/**
 * followup.js — follow-up письма через 1-2 дня после первого касания
 * Отправляет только тем, кто получил первое письмо (нет bounce) и не ответил
 *
 * Запуск: GMAIL_USER=... GMAIL_PASS=... node followup.js
 * Предпросмотр: node followup.js --dry-run
 */

'use strict';
const tls  = require('tls');
const net  = require('net');
const fs   = require('fs');
const path = require('path');

const GMAIL_USER    = process.env.GMAIL_USER;
const GMAIL_PASS    = process.env.GMAIL_PASS;
const FROM_NAME     = 'Алихан | AdaptAI';
const DELAY_MS      = 7000;
const CONTACTS_FILE = path.join(__dirname, 'contacts.json');
const LOG_FILE      = path.join(__dirname, 'send_log.json');
const FU_LOG_FILE   = path.join(__dirname, 'followup_log.json');

const DRY_RUN = process.argv.includes('--dry-run');

// ─── Известные отбившиеся email (из mailer-daemon) ────────────────────────
const BOUNCED = new Set([
  '85d71a895e71448591e0e0b21fa9e7af@stacks.vk-portal.net',
  'mail@mail.mail',
  'info@qdesign.kz',
  'info@kazgisa.kz',
  'mim-kz@yandex.ru',
  'logo@2x.png',
  'logo_ss_wizard@1x.png',
  'logo_ss_wizard@2x.webp',
  'logo_ss_wizard@1x.webp',
  'info@nickol.kz',
  'rating@mail.ru',
  'm19@2x-768x576.jpg',
  'm19@2x-800x600.jpg',
  'bdm@tvin-imc.kz',
  'get_price@snabtechmet.kz',
  'team@lionerpublishing.com',
  'arrow@2x.png',
  'person@2x.png',
  'diamond@2x.png',
  'hello@comboards.com',
  'info@seiflombard.kz',
  'admin@max-smartservice.ru',
  'icons@2x.png',
  'sales1@megaart.kz',
  'sales1b2b@megasmart.kz',
  'sales2b2b@megasmart.kz',
  // Ответившие (не слать follow-up)
  'support@tlight.biz',       // отказ — не беспокоим
  'info@cse.ru',              // авто-тикет
  'pr.central-asia@antal.com',// обещали ответить сами
]);

// ─── Follow-up шаблоны — короткие, личные ─────────────────────────────────
function buildFollowup(variant, companyName, roles) {
  const name    = companyName.split(' ')[0];
  const topRole = (roles || [])[0] || 'специалистов';

  if (variant === 'A') {
    return `Здравствуйте!

Отправлял письмо про AI-скрининг кандидатов для ${name}.

Один вопрос: у вашего HR сейчас успевает обрабатывать все отклики по ${topRole}, или есть очередь?

Если есть узкое место — за 15 минут покажу как решается. Без питча, просто разберём вашу ситуацию.

Алихан, AdaptAI
Telegram: @alikkhan_k`;
  } else {
    return `Здравствуйте!

Писал про AI-наставника для новых сотрудников ${name}.

Быстрый вопрос: сколько новых людей выходит у вас в среднем в месяц?

Спрашиваю чтобы понять подходит ли наш инструмент — у нас есть порог при котором это реально окупается.

Алихан, AdaptAI
Telegram: @alikkhan_k`;
  }
}

function buildSubject(variant, companyName) {
  const skip  = new Set(['the','new','a','an','тоо','ип','ао','ооо']);
  const words = companyName.split(/\s+/);
  let short   = words[0];
  if (skip.has(short.toLowerCase()) && words.length > 1) short = words[1];
  short = short.replace(/[,()&]+$/, '').trim();

  if (variant === 'A') return `Re: ${short} — один вопрос про HR`;
  return `Re: ${short} — один вопрос`;
}

// ─── SMTP (идентично send_emails.js) ──────────────────────────────────────
function wrapB64(b64) { return b64.match(/.{1,76}/g).join('\r\n'); }
function encodeSubject(s) { return `=?UTF-8?B?${Buffer.from(s,'utf8').toString('base64')}?=`; }

function buildMime({ from, fromName, to, subject, body }) {
  return [
    `From: ${fromName} <${from}>`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    wrapB64(Buffer.from(body,'utf8').toString('base64')),
  ].join('\r\n');
}

function smtpSend({ user, pass, fromName, to, subject, body }) {
  return new Promise((resolve, reject) => {
    const authStr = Buffer.from(`\0${user}\0${pass}`).toString('base64');
    const mime    = buildMime({ from: user, fromName, to, subject, body });
    let state = 'GREETING', plainSocket = null, activeSocket = null, buf = '', done = false;

    function finish(err) {
      if (done) return; done = true;
      try { activeSocket?.destroy(); } catch {}
      if (err) reject(err); else resolve();
    }
    function write(cmd) { activeSocket.write(cmd + '\r\n'); }

    function onLine(code) {
      if (code >= 400) { finish(new Error(`SMTP ${code}`)); return; }
      switch (state) {
        case 'GREETING':  state='EHLO1';     write('EHLO gmail.com'); break;
        case 'EHLO1':     state='STARTTLS';  write('STARTTLS'); break;
        case 'STARTTLS':
          plainSocket.removeListener('data', onData);
          state = 'EHLO2';
          const tls2 = tls.connect({ socket: plainSocket, host: 'smtp.gmail.com', servername: 'smtp.gmail.com' }, () => {
            activeSocket = tls2; tls2.on('data', onData); tls2.on('error', finish);
            write('EHLO gmail.com');
          });
          tls2.on('error', finish);
          break;
        case 'EHLO2':     state='AUTH';      write(`AUTH PLAIN ${authStr}`); break;
        case 'AUTH':      state='MAIL_FROM'; write(`MAIL FROM:<${user}>`); break;
        case 'MAIL_FROM': state='RCPT_TO';   write(`RCPT TO:<${to}>`); break;
        case 'RCPT_TO':   state='DATA';      write('DATA'); break;
        case 'DATA':      state='MESSAGE';   activeSocket.write(mime + '\r\n.\r\n'); break;
        case 'MESSAGE':   state='QUIT';      write('QUIT'); break;
        case 'QUIT':      finish(null); break;
      }
    }

    function onData(chunk) {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (!line) continue;
        const code = parseInt(line.slice(0,3), 10);
        if (line[3] !== '-' && !isNaN(code)) onLine(code);
      }
    }

    plainSocket = net.connect(587, 'smtp.gmail.com');
    activeSocket = plainSocket;
    plainSocket.setTimeout(25000, () => finish(new Error('Timeout')));
    plainSocket.on('error', finish);
    plainSocket.on('data', onData);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Главная ───────────────────────────────────────────────────────────────
async function main() {
  if (!DRY_RUN && (!GMAIL_USER || !GMAIL_PASS)) {
    console.error('Нужны GMAIL_USER и GMAIL_PASS');
    process.exit(1);
  }

  const contacts  = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
  const sendLog   = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  const fuLog     = fs.existsSync(FU_LOG_FILE)
    ? JSON.parse(fs.readFileSync(FU_LOG_FILE, 'utf8')) : [];

  // Кому уже ушёл follow-up
  const fuSent = new Set(fuLog.filter(l=>l.ok && !l.dryRun).map(l=>`${l.company}|${l.email}`));

  // Кому отправляли первое письмо
  const firstSent = new Set(sendLog.filter(l=>l.ok && !l.dryRun).map(l=>l.email));

  // Цели: отправлено первое + не отбилось + не follow-up уже
  const targets = contacts.filter(c =>
    c.emails.some(e => firstSent.has(e) && !BOUNCED.has(e))
  );

  console.log(`\n📧 Кандидатов на follow-up: ${targets.length}`);
  if (DRY_RUN) console.log('🔍 DRY-RUN — не отправляем\n');
  console.log('─'.repeat(58));

  let sent = 0, skipped = 0, failed = 0;

  for (const c of targets) {
    const validEmails = c.emails.filter(e => firstSent.has(e) && !BOUNCED.has(e));

    for (const email of validEmails) {
      const key = `${c.name}|${email}`;
      if (fuSent.has(key)) { skipped++; continue; }

      const subject = buildSubject(c.variant, c.name);
      const body    = buildFollowup(c.variant, c.name, c.roles);

      console.log(`\n[${sent+1}] ${c.name.slice(0,38)}`);
      console.log(`    📬 ${email}  [${c.variant}]`);
      console.log(`    📝 ${subject}`);

      if (DRY_RUN) {
        console.log('\n' + body.split('\n').map(l=>'    '+l).join('\n') + '\n');
        fuLog.push({ ts: new Date().toISOString(), company: c.name, email, variant: c.variant, ok: false, dryRun: true });
        sent++; continue;
      }

      const entry = { ts: new Date().toISOString(), company: c.name, email, variant: c.variant };
      try {
        await smtpSend({ user: GMAIL_USER, pass: GMAIL_PASS, fromName: FROM_NAME, to: email, subject, body });
        entry.ok = true;
        console.log(`    ✅ Отправлено`);
        sent++;
        fuSent.add(key);
      } catch(err) {
        entry.ok = false; entry.error = err.message;
        console.log(`    ❌ ${err.message}`);
        failed++;
      }

      fuLog.push(entry);
      fs.writeFileSync(FU_LOG_FILE, JSON.stringify(fuLog, null, 2));
      await sleep(DELAY_MS);
    }
  }

  console.log(`\n${'─'.repeat(58)}`);
  console.log(`✅ Follow-up отправлено : ${sent}`);
  console.log(`⏭️  Уже отправлялось   : ${skipped}`);
  console.log(`❌ Ошибок              : ${failed}`);
  if (!DRY_RUN) console.log(`📋 Лог: followup_log.json`);
}

main().catch(err => { console.error('Ошибка:', err.message); process.exit(1); });
