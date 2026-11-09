#!/usr/bin/env python3
from pathlib import Path
import struct,sys
out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
def write(name,data): (out/name).write_bytes(data)
def packet(channels):
    return struct.pack('<I',len(channels))+b''.join(struct.pack('<I',len(c))+b''.join(struct.pack('<f',v) for v in c) for c in channels)
write('stereo',packet([[0,0.5,-1,1],[-1,1,0.5,0]]))
write('ragged-tail',packet([[0,0],[0.25]]))
write('nonfinite',packet([[float('nan'),float('inf'),float('-inf'),0]]))
write('empty-channel',packet([[]]))
write('no-channels',struct.pack('<I',0))
write('too-many-channels',struct.pack('<I',65536))
write('channel-boundary',struct.pack('<I',65535)+bytes(4*65535))
write('truncated-length',b'\1\0\0')
write('truncated-samples',struct.pack('<II',1,0xffffffff))
write('state-sequence',bytes(range(256))*8)
limit=struct.pack('<II',1,((8<<20)-8)//4)+bytes((8<<20)-8)
for delta in [-1,0,1]:write('boundary-'+str(delta),limit[:len(limit)+delta] if delta<=0 else limit+b'\0')
