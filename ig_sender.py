#!/usr/bin/env python3
"""
ig_sender.py — отправляет Instagram DM через instagrapi

Установка: pip install instagrapi

Запуск:
  IG_USER=username IG_PASS=password python ig_sender.py
  IG_USER=username IG_PASS=password python ig_sender.py --dry-run
  IG_USER=username IG_PASS=password python ig_sender.py --limit 20

Лог отправленных сохраняется в ig_send_log.json
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
    from instagrapi.exceptions import (
        LoginRequired, UserNotFound, ClientError,
        RateLimitError, PleaseWaitFewMinutes,
    )
except ImportError:
    print("❌ instagrapi не установлен.")
    print("   Запусти: pip install instagrapi")
    sys.exit(1)

# ─── Конфигурация ──────────────────────────────────────────────────────────
CONTACTS_FILE = Path(__file__).parent / 'ig_contacts.json'
LOG_FILE      = Path(__file__).parent / 'ig_send_log.json'
SESSION_FILE  = Path(__file__).parent / '.ig_session.json'

IG_USER = os.environ.get('IG_USER', '')
IG_PASS = os.environ.get('IG_PASS', '')

# Безопасные задержки между DM (в секундах)
MIN_DELAY    = 45
MAX_DELAY    = 90
DAILY_LIMIT  = 25   # Instagram банит при >50 DM/день с нового аккаунта

DRY_RUN = '--dry-run' in sys.argv
LIMIT   = None
if '--limit' in sys.argv:
    idx   = sys.argv.index('--limit')
    LIMIT = int(sys.argv[idx + 1])
# ──────────────────────────────────────────────────────────────────────────


def load_log() -> list:
    if LOG_FILE.exists():
        try:
            return json.loads(LOG_FILE.read_text('utf-8'))
        except Exception:
            return []
    return []


def save_log(log: list) -> None:
    LOG_FILE.write_text(
        json.dumps(log, ensure_ascii=False, indent=2),
        encoding='utf-8',
    )


def ig_login(cl: Client) -> bool:
    """Логин с сохранением сессии для повторных запусков."""
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
    except LoginRequired as e:
        print(f"❌ Ошибка входа (LoginRequired): {e}")
        return False
    except Exception as e:
        print(f"❌ Ошибка входа: {e}")
        return False


def send_dm(cl: Client, username: str, message: str) -> tuple[bool, str]:
    """Отправляет DM. Возвращает (ok, error_message)."""
    try:
        user_id = cl.user_id_from_username(username)
        cl.direct_send(message, user_ids=[user_id])
        return True, ''
    except UserNotFound:
        return False, 'пользователь не найден'
    except RateLimitError:
        return False, 'rate limit — подожди несколько минут'
    except PleaseWaitFewMinutes:
        return False, 'Instagram просит подождать'
    except ClientError as e:
        return False, str(e)
    except Exception as e:
        return False, str(e)


def main():
    # ── Проверка файла контактов ──
    if not CONTACTS_FILE.exists():
        print("❌ ig_contacts.json не найден.")
        print("   Запусти сначала: node ig_outreach.js")
        sys.exit(1)

    contacts = json.loads(CONTACTS_FILE.read_text('utf-8'))
    if LIMIT:
        contacts = contacts[:LIMIT]

    print(f"\n🎯 Контактов для рассылки : {len(contacts)}")
    if DRY_RUN:
        print("🔍 DRY-RUN — сообщения НЕ отправляются\n")
    print("─" * 60)

    # ── Проверка credentials ──
    if not DRY_RUN and (not IG_USER or not IG_PASS):
        print("\n❌ Нужны Instagram-credentials:")
        print("   IG_USER=username IG_PASS=password python ig_sender.py\n")
        sys.exit(1)

    log      = load_log()
    sent_set = {e['username'] for e in log if e.get('ok') and not e.get('dry_run')}

    # ── Логин ──
    if not DRY_RUN:
        cl = Client()
        cl.delay_range = [2, 5]
        print(f"\nВходим как @{IG_USER}...")
        if not ig_login(cl):
            sys.exit(1)
        print()

    sent    = 0
    skipped = 0
    failed  = 0

    for i, contact in enumerate(contacts):
        username = contact['username']
        message  = contact['message']

        # Уже отправляли — пропускаем
        if username in sent_set:
            print(f"[{i+1}/{len(contacts)}] ⏭️  @{username} — уже отправлено")
            skipped += 1
            continue

        if sent >= DAILY_LIMIT:
            print(f"\n⚠️  Дневной лимит {DAILY_LIMIT} DM достигнут. Остановка.")
            break

        print(f"\n[{i+1}/{len(contacts)}] @{username}")
        print(f"  Тип: {contact.get('type')} | Подписчики: {contact.get('followers')} | Score: {contact.get('score')}")
        print(f"  Профиль: {contact.get('ig_profile')}")

        if DRY_RUN:
            lines = message.split('\n')
            preview = '\n'.join(f"  {l}" for l in lines[:4])
            print(f"\n  Сообщение (превью):\n{preview}\n  ...")
            log.append({
                'ts': datetime.datetime.now().isoformat(),
                'username': username,
                'type': contact.get('type'),
                'dry_run': True,
                'ok': False,
            })
            sent += 1
            continue

        ok, error = send_dm(cl, username, message)
        entry = {
            'ts':        datetime.datetime.now().isoformat(),
            'username':  username,
            'type':      contact.get('type'),
            'followers': contact.get('followers'),
            'ok':        ok,
        }
        if error:
            entry['error'] = error

        if ok:
            print(f"  ✅ Отправлено")
            sent += 1
            sent_set.add(username)
        else:
            print(f"  ❌ Ошибка: {error}")
            failed += 1

        log.append(entry)
        save_log(log)

        # Задержка между сообщениями — критично для антибана
        if i < len(contacts) - 1 and sent < DAILY_LIMIT:
            delay = random.randint(MIN_DELAY, MAX_DELAY)
            print(f"  Пауза {delay}с...")
            time.sleep(delay)

    # ── Итог ──
    print(f"\n{'─' * 60}")
    print(f"✅ Отправлено  : {sent}")
    print(f"⏭️  Пропущено  : {skipped}")
    print(f"❌ Ошибок     : {failed}")
    if not DRY_RUN:
        print(f"📋 Лог        : ig_send_log.json")
    print("─" * 60)

    if failed > 0 and not DRY_RUN:
        print("\nНе отправлено:")
        for e in log:
            if not e.get('ok') and not e.get('dry_run') and 'error' in e:
                print(f"  • @{e['username']}: {e['error']}")


if __name__ == '__main__':
    main()
