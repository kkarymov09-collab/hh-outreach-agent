#!/usr/bin/env python3
"""
ig_followup.py — follow-up DM через 2–3 дня после первого касания

Отправляет тем, кому ушёл первый DM, но нет ответа.
Запуск аналогичен ig_sender.py:
  IG_USER=username IG_PASS=password python ig_followup.py
  IG_USER=username IG_PASS=password python ig_followup.py --dry-run
  IG_USER=username IG_PASS=password python ig_followup.py --limit 10
"""

import json
import os
import sys
import time
import random
import datetime
from pathlib import Path

try:
    from instagrapi import Client
    from instagrapi.exceptions import UserNotFound, ClientError, RateLimitError
except ImportError:
    print("❌ instagrapi не установлен. Запусти: pip install instagrapi")
    sys.exit(1)

# ─── Конфигурация ──────────────────────────────────────────────────────────
CONTACTS_FILE  = Path(__file__).parent / 'ig_contacts.json'
SEND_LOG_FILE  = Path(__file__).parent / 'ig_send_log.json'
FU_LOG_FILE    = Path(__file__).parent / 'ig_followup_log.json'
SESSION_FILE   = Path(__file__).parent / '.ig_session.json'

IG_USER = os.environ.get('IG_USER', '')
IG_PASS = os.environ.get('IG_PASS', '')

MIN_DELAY   = 60
MAX_DELAY   = 120
DAILY_LIMIT = 20

DRY_RUN = '--dry-run' in sys.argv
LIMIT   = None
if '--limit' in sys.argv:
    idx   = sys.argv.index('--limit')
    LIMIT = int(sys.argv[idx + 1])
# ──────────────────────────────────────────────────────────────────────────

# Дни после первого DM, после которых шлём follow-up
FOLLOWUP_AFTER_DAYS = 2

PORTFOLIO_URL = 'https://your-portfolio.com'  # замени на свой


def build_followup(contact: dict) -> str:
    type_ = contact.get('type', 'food')
    has_site = bool(contact.get('website'))

    if not has_site:
        return f"""Привет! Писал недавно про сайт для вашего заведения 🙌

Просто хотел уточнить — актуально? Делаю лендинги для кафе и ресторанов Казахстана быстро и по хорошей цене.

Примеры: {PORTFOLIO_URL}

Если сейчас не время — скажите, не буду беспокоить 👇"""

    return f"""Привет! Писал насчёт обновления дизайна 🎨

Один вопрос: есть ли что-то, с чем хотели бы помочь — меню онлайн, новый лендинг, QR-меню для столиков?

{PORTFOLIO_URL}

Готов обсудить без лишних обязательств 👇"""


def load_json(p: Path) -> list:
    if p.exists():
        try:
            return json.loads(p.read_text('utf-8'))
        except Exception:
            pass
    return []


def save_json(p: Path, data: list) -> None:
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')


def ig_login(cl: Client) -> bool:
    if SESSION_FILE.exists():
        try:
            cl.load_settings(SESSION_FILE)
            cl.login(IG_USER, IG_PASS)
            cl.dump_settings(SESSION_FILE)
            print("✅ Залогинились (сессия восстановлена)")
            return True
        except Exception:
            pass
    try:
        cl.login(IG_USER, IG_PASS)
        cl.dump_settings(SESSION_FILE)
        print("✅ Залогинились")
        return True
    except Exception as e:
        print(f"❌ Ошибка входа: {e}")
        return False


def send_dm(cl: Client, username: str, message: str) -> tuple[bool, str]:
    try:
        user_id = cl.user_id_from_username(username)
        cl.direct_send(message, user_ids=[user_id])
        return True, ''
    except UserNotFound:
        return False, 'пользователь не найден'
    except RateLimitError:
        return False, 'rate limit'
    except Exception as e:
        return False, str(e)


def main():
    if not CONTACTS_FILE.exists():
        print("❌ ig_contacts.json не найден.")
        sys.exit(1)

    contacts  = load_json(CONTACTS_FILE)
    send_log  = load_json(SEND_LOG_FILE)
    fu_log    = load_json(FU_LOG_FILE)

    now = datetime.datetime.now()
    cutoff = now - datetime.timedelta(days=FOLLOWUP_AFTER_DAYS)

    # Кому уже ушёл первый DM (и когда)
    first_sent = {}
    for e in send_log:
        if e.get('ok') and not e.get('dry_run'):
            ts = datetime.datetime.fromisoformat(e['ts'])
            if e['username'] not in first_sent or ts > first_sent[e['username']]:
                first_sent[e['username']] = ts

    # Кому уже ушёл follow-up
    fu_sent = {e['username'] for e in fu_log if e.get('ok') and not e.get('dry_run')}

    # Цели: первый DM ≥ N дней назад, follow-up ещё не отправляли
    targets = [
        c for c in contacts
        if c['username'] in first_sent
        and first_sent[c['username']] <= cutoff
        and c['username'] not in fu_sent
    ]

    if LIMIT:
        targets = targets[:LIMIT]

    print(f"\n📩 Follow-up кандидатов : {len(targets)}")
    if DRY_RUN:
        print("🔍 DRY-RUN — сообщения НЕ отправляются\n")
    print("─" * 60)

    if not DRY_RUN and (not IG_USER or not IG_PASS):
        print("\n❌ IG_USER и IG_PASS обязательны")
        sys.exit(1)

    if not DRY_RUN:
        cl = Client()
        cl.delay_range = [2, 5]
        print(f"\nВходим как @{IG_USER}...")
        if not ig_login(cl):
            sys.exit(1)
        print()

    sent = skipped = failed = 0

    for i, contact in enumerate(targets):
        username = contact['username']
        message  = build_followup(contact)

        print(f"\n[{i+1}/{len(targets)}] @{username}")
        print(f"  Первый DM был: {first_sent[username].strftime('%d.%m.%Y')}")

        if DRY_RUN:
            lines = message.split('\n')
            print('\n'.join(f"  {l}" for l in lines[:3]))
            print("  ...")
            fu_log.append({'ts': now.isoformat(), 'username': username, 'dry_run': True, 'ok': False})
            sent += 1
            continue

        if sent >= DAILY_LIMIT:
            print(f"\n⚠️  Дневной лимит {DAILY_LIMIT} достигнут.")
            break

        ok, error = send_dm(cl, username, message)
        entry = {
            'ts':       now.isoformat(),
            'username': username,
            'ok':       ok,
        }
        if error:
            entry['error'] = error

        if ok:
            print("  ✅ Follow-up отправлен")
            sent += 1
        else:
            print(f"  ❌ Ошибка: {error}")
            failed += 1

        fu_log.append(entry)
        save_json(FU_LOG_FILE, fu_log)

        if i < len(targets) - 1:
            delay = random.randint(MIN_DELAY, MAX_DELAY)
            print(f"  Пауза {delay}с...")
            time.sleep(delay)

    print(f"\n{'─' * 60}")
    print(f"✅ Follow-up отправлено : {sent}")
    print(f"❌ Ошибок              : {failed}")
    if not DRY_RUN:
        print(f"📋 Лог                 : ig_followup_log.json")


if __name__ == '__main__':
    main()
