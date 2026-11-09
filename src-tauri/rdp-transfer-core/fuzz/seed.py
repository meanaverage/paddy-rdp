#!/usr/bin/env python3
"""Synthetic vendor observations, decoder errors and inclusive production bounds."""
import json
import sys
from pathlib import Path
out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
def request(stream=7,size=16777216,flags=2):return dict(streamId=stream,index=0,flags=flags,position=0,size=size)
seeds={
 'range':dict(op='admit',request=request()),
 'size':dict(op='admit',request=request(size=8,flags=1)),
 'reserve':dict(op='reserve',request=request(stream=4294967295,size=4294967295)),
 'signed-index':dict(op='admit',request={**request(), 'index':-1}),
 'large-position':dict(op='admit',request={**request(),'position':18446744073709551616}),
 'bad-size':dict(op='admit',request=request(size=-1)),
 'bad-stream':dict(op='admit',request=request(stream=4294967296)),
 'expired':dict(op='expire',now=65000),
 'old-response':dict(op='answered',number=9007199254740991),
 'dispose':dict(op='dispose'),
}
for name,value in seeds.items():
 data=json.dumps(value,separators=(',',':')).encode();(out/name).write_bytes(data)
 if name in ('range','reserve'):(out/(name+'-truncated')).write_bytes(data[:-2])
(out/'invalid-utf8').write_bytes(bytes([255]))
(out/'malformed').write_bytes(b'{')
prefix=b'{"op":"waiting","future":"'
for size in [(8<<20)-1,8<<20,(8<<20)+1]:
 (out/('bound-'+str(size))).write_bytes(prefix+b'x'*(size-len(prefix)-2)+b'"}')
(out/'dense-array').write_bytes(b'{"op":"waiting","future":['+b'0,'*4000000+b'0]}')
(out/'lifecycle-sequence').write_bytes(bytes(range(256))*4)
