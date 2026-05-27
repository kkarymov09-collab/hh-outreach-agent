import struct, os, sys

def read_safari_cookies(path):
    with open(path, 'rb') as f:
        data = f.read()
    if data[:4] != b'cook':
        return []
    num_pages = struct.unpack('>I', data[4:8])[0]
    page_sizes = [struct.unpack('>I', data[8+i*4:12+i*4])[0] for i in range(num_pages)]
    cookies = []
    offset = 8 + num_pages * 4
    for page_size in page_sizes:
        page = data[offset:offset+page_size]
        offset += page_size
        if page[:4] != b'\x00\x00\x01\x00':
            continue
        num_cookies = struct.unpack('<I', page[4:8])[0]
        cookie_offsets = [struct.unpack('<I', page[8+i*4:12+i*4])[0] for i in range(num_cookies)]
        for co in cookie_offsets:
            c = page[co:]
            try:
                cd        = c[:struct.unpack('<I', c[0:4])[0]]
                url_off   = struct.unpack('<I', cd[16:20])[0]
                name_off  = struct.unpack('<I', cd[20:24])[0]
                value_off = struct.unpack('<I', cd[28:32])[0]
                def s(d, o):
                    end = d.index(b'\x00', o)
                    return d[o:end].decode('utf-8', errors='replace')
                cookies.append((s(cd, url_off), s(cd, name_off), s(cd, value_off)))
            except Exception:
                pass
    return cookies

path = os.path.expanduser(
    '~/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies'
)
if not os.path.exists(path):
    print("Файл cookies не найден.")
    sys.exit(1)

all_cookies = read_safari_cookies(path)

# Собираем все cookies для hh.ru (исключая hh.kz чтобы не дублировать)
KEEP = {'hhtoken', 'hhuid', '__ddg1_', '__ddg8_', '__ddg9_', '__ddg10_',
        'cfidsgib-w-hh', 'gsscgib-w-hh', 'fgsscgib-w-hh', '__zzatgib-w-hh',
        'domain_sid', '_xsrf', 'session_language'}

seen = {}
for url, name, val in all_cookies:
    # Берём только с hh.ru (не hh.kz), приоритет первому вхождению
    if 'hh.ru' in url and name in KEEP and name not in seen:
        seen[name] = val

if not seen:
    print("Cookies hh.ru не найдены. Открой hh.ru в Safari и залогинься.")
    sys.exit(1)

cookie_str = '; '.join(f'{k}={v}' for k, v in seen.items())

print("Найдено cookies:", len(seen))
for k, v in seen.items():
    print(f"  {k:30s} = {v[:50]}")

print("\n" + "="*60)
print("Запусти сканер командой:")
print()
print(f'HH_COOKIE="{cookie_str}" node ~/hh\\ агент/scanner.js')
print("="*60)

# Сохраняем в файл для удобства
with open(os.path.expanduser('~/hh агент/.hh_cookie'), 'w') as f:
    f.write(cookie_str)
print("\nCookie также сохранён в: ~/hh агент/.hh_cookie")
