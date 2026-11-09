#!/usr/bin/env python3
import sys
from pathlib import Path
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
seeds = {'empty': b'', 'text': 'α😀\n'.encode(), 'malformed': b'\xf0\x80\x80\x80\xff',
         'marker': b'before__trd_exec_end__after__trd_exec_end__\n',
         'partial-marker': b'__trd_exec_en', 'truncated-utf8': b'\xf0\x9f',
         'tail': b'x' * 4095 + '😀'.encode(), 'lifecycle': bytes(range(64)),
         'limit': b'x' * 4194304, 'over-limit': b'x' * 4194305}
for name, value in seeds.items(): (out / name).write_bytes(value)
