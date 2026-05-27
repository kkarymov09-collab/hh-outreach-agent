/**
 * send_emails.js — автоматическая рассылка через Gmail SMTP
 * Только встроенные модули Node.js (tls, net, fs, path)
 *
 * Запуск:
 *   GMAIL_USER=you@gmail.com GMAIL_PASS=xxxx-xxxx-xxxx-xxxx node send_emails.js
 *
 * Как получить App Password:
 *   myaccount.google.com → Безопасность → Двухэтапная аутентификация
 *   → Пароли приложений → «Другое» → дать имя → скопировать 16 символов
 *
 * Флаги:
 *   --dry-run   Показывает письма, не отправляет
 *   --limit N   Отправить только первые N писем
 */

'use strict';
const tls  = require('tls');
const net  = require('net');
const fs   = require('fs');
const path = require('path');

// ─── Конфигурация ─────────────────────────────────────────────────────────────
const GMAIL_USER    = process.env.GMAIL_USER;
const GMAIL_PASS    = process.env.GMAIL_PASS;
const FROM_NAME     = 'Алихан | AdaptAI';
const DELAY_MS      = 6000;          // 6 сек между письмами
const CONTACTS_FILE = path.join(__dirname, 'contacts.json');
const LOG_FILE      = path.join(__dirname, 'send_log.json');
// ──────────────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');
const limitIdx = process.argv.indexOf('--limit');
const LIMIT   = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1]) : Infinity;

// ─── Email тема по варианту ────────────────────────────────────────────────
function buildSubject(variant, companyName) {
  // Пропускаем служебные слова в начале названия (The, New, A, An, ТОО и т.п.)
  const skip = new Set(['the','new','a','an','тоо','ип','ао','ооо']);
  const words = companyName.split(/\s+/);
  let short = words[0];
  if (skip.has(short.toLowerCase()) && words.length > 1) short = words[1];
  // Убираем запятую, скобки и подобное
  short = short.replace(/[,()&]+$/, '').trim();

  if (variant === 'A') {
    return `${short}: AI закрывает вакансии за 1 день — показать?`;
  }
  return `${short}: AI-наставник сокращает адаптацию с 4 недель до 9 дней`;
}

// ─── Обёртка base64 по 76 символов (RFC 2822) ─────────────────────────────
function wrapB64(b64) {
  return b64.match(/.{1,76}/g).join('\r\n');
}

// ─── Encoded-word для темы письма (RFC 2047) ──────────────────────────────
function encodeSubject(s) {
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

// ─── Форматировать тело письма для email ──────────────────────────────────
function buildEmailBody(contact) {
  const recruiter = contact.recruiter ? `\nКому: ${contact.recruiter}` : '';
  return contact.template
    + `\n\n──────────────────\nАлихан Карымов\nAdaptAI — автоматизация подбора и адаптации персонала\nTelegram: @alikkhan_k\nhttps://adaptai.kz${recruiter}`;
}

// ─── Собрать MIME-сообщение ────────────────────────────────────────────────
function buildMime({ from, fromName, to, subject, body }) {
  const bodyB64 = wrapB64(Buffer.from(body, 'utf8').toString('base64'));
  return [
    `From: ${fromName} <${from}>`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    `X-Mailer: AdaptAI-Mailer/1.0`,
    ``,
    bodyB64,
  ].join('\r\n');
}

// ─── Отправить одно письмо через Gmail SMTP (STARTTLS:587) ─────────────────
function smtpSend({ user, pass, fromName, to, subject, body }) {
  return new Promise((resolve, reject) => {
    const authStr  = Buffer.from(`\0${user}\0${pass}`).toString('base64');
    const mimeMsg  = buildMime({ from: user, fromName, to, subject, body });

    let state = 'GREETING';
    let plainSocket = null;
    let activeSocket = null;
    let buf = '';
    let done = false;

    function finish(err) {
      if (done) return;
      done = true;
      try { activeSocket && activeSocket.destroy(); } catch {}
      try { plainSocket && !activeSocket && plainSocket.destroy(); } catch {}
      if (err) reject(err); else resolve();
    }

    function write(cmd) { activeSocket.write(cmd + '\r\n'); }

    function onLine(code, text) {
      if (code >= 400) { finish(new Error(`SMTP ${code}: ${text}`)); return; }

      switch (state) {
        case 'GREETING':
          state = 'EHLO1';
          write('EHLO gmail.com');
          break;

        case 'EHLO1':
          state = 'STARTTLS';
          write('STARTTLS');
          break;

        case 'STARTTLS':
          // Снимаем слушателя с plain-сокета — TLS возьмёт его на себя
          plainSocket.removeListener('data', onData);
          state = 'EHLO2';
          {
            const tlsSock = tls.connect(
              { socket: plainSocket, host: 'smtp.gmail.com', servername: 'smtp.gmail.com' },
              () => {
                activeSocket = tlsSock;
                tlsSock.on('data', onData);
                tlsSock.on('error', finish);
                write('EHLO gmail.com');
              }
            );
            tlsSock.on('error', finish);
          }
          break;

        case 'EHLO2':
          state = 'AUTH';
          write(`AUTH PLAIN ${authStr}`);
          break;

        case 'AUTH':
          state = 'MAIL_FROM';
          write(`MAIL FROM:<${user}>`);
          break;

        case 'MAIL_FROM':
          state = 'RCPT_TO';
          write(`RCPT TO:<${to}>`);
          break;

        case 'RCPT_TO':
          state = 'DATA';
          write('DATA');
          break;

        case 'DATA':
          // 354 — сервер ждёт сообщение
          state = 'MESSAGE';
          activeSocket.write(mimeMsg + '\r\n.\r\n');
          break;

        case 'MESSAGE':
          // 250 — письмо принято
          state = 'QUIT';
          write('QUIT');
          break;

        case 'QUIT':
          finish(null);
          break;

        default:
          finish(new Error(`Unexpected state: ${state}`));
      }
    }

    function onData(chunk) {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!line) continue;
        const code   = parseInt(line.slice(0, 3), 10);
        const isLast = line[3] !== '-';   // '-' = многострочный ответ
        if (isLast && !isNaN(code)) onLine(code, line.slice(4));
      }
    }

    plainSocket   = net.connect(587, 'smtp.gmail.com');
    activeSocket  = plainSocket;

    plainSocket.setTimeout(25000, () => finish(new Error('SMTP timeout')));
    plainSocket.on('error', finish);
    plainSocket.on('data',  onData);
  });
}

// ─── Утилиты ──────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadLog() {
  if (fs.existsSync(LOG_FILE)) {
    try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
  }
  return [];
}

function saveLog(log) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2), 'utf8');
}

// ─── Главная функция ───────────────────────────────────────────────────────
async function main() {
  // Проверка credentials
  if (!DRY_RUN && (!GMAIL_USER || !GMAIL_PASS)) {
    console.error(`
❌  Укажи Gmail-credentials перед запуском:
    GMAIL_USER=you@gmail.com GMAIL_PASS=xxxx-xxxx-xxxx-xxxx node send_emails.js

Как получить App Password (пароль приложения):
  1. myaccount.google.com → Безопасность
  2. Двухэтапная аутентификация → Пароли приложений
  3. «Другое» → назвать «AdaptAI» → скопировать 16 символов
  4. Убедись что 2FA включена — без неё App Password не появится
`);
    process.exit(1);
  }

  const companies = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
  const targets   = companies.filter(c => c.emails && c.emails.length > 0);

  console.log(`\n📧 Контактов с email: ${targets.length}`);
  if (DRY_RUN) console.log('🔍 DRY-RUN режим — письма НЕ отправляются\n');
  console.log('─'.repeat(60));

  const log      = loadLog();
  const sentSet  = new Set(log.filter(l => l.ok).map(l => `${l.company}|${l.email}`));

  let sent = 0, skipped = 0, failed = 0;

  for (const c of targets) {
    if (sent >= LIMIT) break;

    for (const email of c.emails) {
      if (sent >= LIMIT) break;

      const key = `${c.name}|${email}`;

      if (sentSet.has(key)) {
        console.log(`⏭️  Пропуск (уже отправлено): ${c.name} → ${email}`);
        skipped++;
        continue;
      }

      const subject = buildSubject(c.variant, c.name);
      const body    = buildEmailBody(c);

      console.log(`\n[${sent + 1}] ${c.name.slice(0, 38)}`);
      console.log(`    📬 ${email}  |  Вариант ${c.variant}  |  ${c.vacancies} вакансий`);
      console.log(`    📝 ${subject}`);

      if (DRY_RUN) {
        console.log(`\n──── Тело письма ───────────────────────────────────────`);
        console.log(body);
        console.log(`────────────────────────────────────────────────────────\n`);
        log.push({ ts: new Date().toISOString(), company: c.name, email, variant: c.variant, ok: false, dryRun: true });
        sent++;
        continue;
      }

      const entry = { ts: new Date().toISOString(), company: c.name, email, variant: c.variant };
      try {
        await smtpSend({
          user: GMAIL_USER, pass: GMAIL_PASS,
          fromName: FROM_NAME,
          to: email, subject, body,
        });
        entry.ok = true;
        console.log(`    ✅ Отправлено`);
        sent++;
        sentSet.add(key);
      } catch (err) {
        entry.ok    = false;
        entry.error = err.message;
        console.log(`    ❌ Ошибка: ${err.message}`);
        failed++;
      }

      log.push(entry);
      saveLog(log);

      if (sent < targets.length) await sleep(DELAY_MS);
    }
  }

  // Итог
  console.log('\n' + '─'.repeat(60));
  console.log(`📊 Итог:`);
  console.log(`   ✅ Отправлено  : ${sent}`);
  console.log(`   ⏭️  Пропущено  : ${skipped}  (уже было)`);
  console.log(`   ❌ Ошибок     : ${failed}`);
  if (!DRY_RUN) console.log(`   📋 Лог        : send_log.json`);
  console.log('─'.repeat(60));

  // Показать письма которые не ушли
  if (failed > 0) {
    console.log('\nНе отправлено:');
    log.filter(l => !l.ok && !l.dryRun).forEach(l =>
      console.log(`  • ${l.company} → ${l.email}: ${l.error}`)
    );
  }
}

main().catch(err => {
  console.error('\n💥 Критическая ошибка:', err.message);
  process.exit(1);
});
