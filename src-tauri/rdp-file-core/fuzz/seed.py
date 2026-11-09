#!/usr/bin/env python3
"""Synthetic public-boundary seeds; never remote captures or credentials."""
import sys
from pathlib import Path

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
text = ('full address:s:[::1]:3390\r\nusername:s:synthetic\r\ndomain:s:EXAMPLE\r\n'
        'server port:i:0xd3d\r\ndesktopscalefactor:i:150\r\nredirectclipboard:i:-000\r\n'
        'redirectclipboard:i:1\r\ngatewayhostname:s:gateway.example\r\ngatewayusagemethod:i:4\r\n'
        'promptcredentialonce:i:0\r\ngatewaycredentialssource:i:5\r\nscreen mode id:i:1\r\n'
        'desktopwidth:i:1024\r\naudiocapturemode:i:1\r\ndrivestoredirect:s:*\r\n'
        'redirectprinters:i:1\r\nremoteapplicationmode:i:1\r\nalternate shell:s:synthetic\r\n')
seeds = {'utf8': text.encode(), 'utf8-bom': b'\xef\xbb\xbf' + text.encode(),
         'utf16le': b'\xff\xfe' + text.encode('utf-16le'), 'utf16be': b'\xfe\xff' + text.encode('utf-16be'),
         'no-bom': text.encode('utf-16le'), 'odd-be': b'\xfe\xff\0',
         'bad-utf8': b'full address:s:desktop\nusername:s:\xf0\x80\x80\x80',
         'surrogates': b'\xff\xfe' + 'full address:s:desktop\nusername:s:\ud800\ud801'.encode('utf-16le', 'surrogatepass'),
         'proto': b'full address:s:desktop\n__proto__:s:bad\nconstructor:s:bad\n',
         'separator': b'full address:s:desktop#other\n', 'empty': b''}
for i in [1, 2, 3, 17, 31, 77, len(seeds['utf16be']) - 1]:
    seeds[f'truncated-{i}'] = seeds['utf16be'][:i]
prefix = b'full address:s:desktop\n'
for name, unit in [('spaces', b' '), ('newlines', b'\n')]:
    seeds[f'limit-{name}'] = prefix + unit * (1048576 - len(prefix))
seeds['limit-radix'] = b'full address:s:desktop\ndesktopscalefactor:i:0x' + b'f' * 1024
seeds['over-limit'] = b' ' * 1048577
for name, value in seeds.items():
    (out / name).write_bytes(value)
