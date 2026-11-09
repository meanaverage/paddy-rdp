#!/usr/bin/env python3
"""Synthetic observation envelopes, malformed encodings and real request limits."""
import json
import sys
from pathlib import Path
out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
def txt(value):return ['s',json.dumps(value)]
def obj(value):return ['o',[[json.dumps(k),v] for k,v in value.items()]]
def request(op,*args):return json.dumps(dict(op=op,args=args),separators=(',',':')).encode()
seeds={
 'spec':request('spec',obj({'host':txt('desk'),'port':txt('0xD3D'),'clipboard':txt('off')})),
 'consent':request('xrdp_from_host',obj({'kind':txt('xrdp'),'kindFromHost':['b',True]})),
 'surrogate':request('config_text',txt(chr(0xd800))),
 'negative-zero':request('config_number',['n','-0']),
 'nonfinite':request('config_number',['n','Infinity']),
 'missing':request('own_clipboard',['u']),
 'malformed':b'{','invalid-utf8':bytes([255]),
 'invalid-tag':request('config_number',['n','inf']),
 'invalid-literal':request('config_text',['s','null']),
}
for name,value in seeds.items():
 (out/name).write_bytes(value)
 if name in ('spec','consent'):(out/(name+'-truncated')).write_bytes(value[:-2])
prefix=request('config_text',txt('x'))[:-1]+b',"future":"'
for size in [(8<<20)-1,8<<20,(8<<20)+1]:
 (out/('bound-'+str(size))).write_bytes(prefix+b'x'*(size-len(prefix)-2)+b'"}')
(out/'large-number').write_bytes(request('config_number',txt('0x1'+'0'*((8<<20)-128))))

(out/'many-fields').write_bytes(request('hyperv_spec',txt('id'),txt('name'),obj({('field'+str(n)):txt('x') for n in range(50000)})))
