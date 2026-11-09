export default [
    ['RDP audio: real offline Web Audio renders converted stereo PCM with volume and timing preserved', `
        const rd=await until(()=>window.__remoteDesktop?.audio)
        const offline=new OfflineAudioContext(2,256,48000)
        const Actual=window.AudioContext
        const context={destination:offline.destination,state:'running',get currentTime(){return offline.currentTime},
            createGain:()=>offline.createGain(),createBuffer:(...args)=>offline.createBuffer(...args),
            createBufferSource:()=>offline.createBufferSource(),resume:()=>Promise.resolve(),close:()=>Promise.resolve()}
        const starts=[]
        const original=context.createBufferSource
        context.createBufferSource=()=>{const node=original(),start=node.start.bind(node);node.start=(time)=>{starts.push(time);start(time)};return node}
        window.AudioContext=function(){return context}
        const player=new rd.AudioPlayer()
        try {
            const pcm=new Int16Array(512)
            for(let i=0;i<256;i++){pcm[i*2]=i%2?-32768:32767;pcm[i*2+1]=i*100-12000}
            for(let part=0;part<2;part++)player.callback({type:'wave',channels:2,sampleRate:48000,data:new Uint8Array(pcm.buffer,part*512,512)})
            player.callback({type:'volume',left:0.5,right:0})
            const rendered=await offline.startRendering()
            for(let c=0;c<2;c++)for(let i=0;i<256;i++){
                if(rendered.getChannelData(c)[i]!==Math.fround(pcm[i*2+c]/32768*0.25))throw Error('Offline PCM mismatch at '+c+':'+i)
            }
            if(starts.length!==2||starts[0]!==0||starts[1]!==128/48000||player.received!==256/48000||player.peak!==1)throw Error('Playback timing or counters changed')
            player.callback({type:'close'})
            return true
        } finally {player.close();window.AudioContext=Actual}
    `],
    ['RDP audio: synthetic microphone samples retain phase, copies and accounting across reset and send failure', `
        const rd=await until(()=>window.__remoteDesktop?.audio),sent=[]
        let fail=false
        const mic=new rd.Microphone(pcm=>{if(fail)throw Error('synthetic send failure');sent.push(pcm)},()=>{},()=>{},()=>{})
        const input=new Float32Array([0,0.5,1,-0.5,-1])
        try {
            mic.format={sampleRate:48000,channels:2}
            mic.captured([input],48000)
            if(JSON.stringify(Array.from(sent[0]))!==JSON.stringify([0,0,16384,16384,32767,32767,-16383,-16383]))throw Error('Stereo conversion changed')
            const retained=Array.from(sent[0]),before=mic.sent
            fail=true;mic.captured([input],48000)
            if(mic.sent!==before||mic.peak!==32767/32768)throw Error('Failed send changed elapsed time or peak')
            mic.stop();fail=false;mic.captured([input],48000)
            if(JSON.stringify(Array.from(sent[1]))!==JSON.stringify(retained)||JSON.stringify(Array.from(sent[0]))!==JSON.stringify(retained))throw Error('Reset or output lifetime changed')
            if(mic.sent!==2*4/48000)throw Error('Sent duration changed')
            mic.close();mic.captured([input],48000)
            if(sent.length!==2)throw Error('Closed capture sent audio')
            return true
        } finally {mic.close()}
    `],
]
