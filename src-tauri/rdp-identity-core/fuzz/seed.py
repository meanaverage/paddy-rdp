#!/usr/bin/env python3
"""Synthetic JSON/UTF-16 seeds and inclusive/over-limit public requests."""
import json
import sys
from pathlib import Path
out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
def request(op, a, b='', c='', **extra):
    return json.dumps(dict(op=op, a=json.dumps(a), b=json.dumps(b), c=json.dumps(c), hasVia=False, **extra), separators=(',', ':')).encode()
seeds = {
    'configuration': request('key_from_config', 'user a#b\nhostname FE80::1%en0\nport 22', 'alias'),
    'scoped': request('key_parts', 'u@host:22#desk@user#D\\alice@gateway#gw:443'),
    'malformed-scope': request('rekeyed', 'u@h:22#desk#extra', 'u@h:22', 'new'),
    'surrogates': request('user_scope', '\ud800\udc00\ud800\ufffd'),
    'lowercase': request('key_from_config', '', 'ΟΣ\u0301\ud800İ'),
    'bad-json': b'{', 'bad-utf8': b'\xff', 'bad-inner': b'{"op":"key_fields","a":"null"}',
    'bad-escape': b'{"op":"key_fields","a":"\\\"\\\\u12\\\""}',
}
for name, value in seeds.items():
    (out/name).write_bytes(value)
    if name in ('configuration','scoped'):
        (out/(name+'-truncated')).write_bytes(value[:-3])
prefix = request('key_fields', 'a@host:22')[:-1] + b',"future":"'
for size in [(8 << 20)-1, 8 << 20, (8 << 20)+1]:
    (out/('limit-'+str(size))).write_bytes(prefix+b'x'*(size-len(prefix)-2)+b'"}')
# The identity itself, rather than just an ignored field, approaches the real limit.
value = request('user_scope', '#' * ((8 << 20)//2))
(out/'large-identity').write_bytes(value)
