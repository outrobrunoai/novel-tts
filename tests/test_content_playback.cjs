const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','content-playback.js'),'utf8');
const item=(id='a',overrides={})=>({id,text:`text-${id}`,voice:'voice',language:'pt',temperature:.9,seed:1,instructions:'calm',cacheLimitMb:10,...overrides});

function make(options={}) {
  const context={NovelLocalReader:{},crypto:{randomUUID:()=> 'x'},AudioContext:class{},console};
  context.globalThis=context; vm.createContext(context); vm.runInContext(source,context);
  const calls=[]; const sources=[]; const runtime={register(){},timer:(set,clear,fn,ms)=>set(fn,ms)};
  const audio={state:'running',currentTime:0,destination:{},createGain:()=>({gain:{value:1},connect(){}}),
    createBufferSource:()=>{const source=options.source?.() || {playbackRate:{},connect(){},disconnect(){},start(){},stop(){}};sources.push(source);return source;},
    decodeAudioData:options.decode || (async()=>({duration:1}))};
  audio.suspend=async()=>{audio.state='suspended';}; audio.resume=options.resume || (async()=>{audio.state='running';});
  const send=options.send || (async message=>{calls.push(message);return {ok:true,buffer:new ArrayBuffer(1)};});
  const playback=context.NovelLocalReader.playback.create({runtime,audioFactory:()=>audio,
    getProfile:async()=>options.profile || 'profile',getConfig:()=>({volume:1,playbackRate:1,cacheWarming:options.cacheWarming!==false}),send,
    onEnded:options.onEnded,onError:options.onError});
  return {playback,calls,audio,sources};
}

test('identical keys share pending work and exact synthesis payload',async()=>{
  let resolve; const h=make({send:message=>{h.calls.push(message);return new Promise(r=>{resolve=r;});}});
  const a=h.playback.prefetch(item()), b=h.playback.prefetch(item());
  await new Promise(setImmediate); assert.equal(h.calls.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])),{type:'synthesize',priority:0,payload:{text:'text-a',voice:'voice',instructions:'calm',temperature:.9,seed:1,cacheLimitMb:10}});
  resolve({ok:true,buffer:new ArrayBuffer(1)}); assert.equal((await a).duration,1); assert.equal((await b).duration,1);
  assert.equal(h.playback.snapshot().pendingCount,0);
});

test('different text or synthesis settings use distinct keys',async()=>{
  const h=make(); await Promise.all([h.playback.prefetch(item('a')),h.playback.prefetch(item('a',{text:'other'})),h.playback.prefetch(item('a',{voice:'other'}))]);
  assert.equal(h.calls.length,3); assert.equal(h.playback.snapshot().bufferCount,3);
});

test('decode rejection and invalid response never enter cache',async()=>{
  const bad=make({decode:async()=>{throw new Error('decode');}}); await assert.rejects(bad.playback.prefetch(item()),/decode/);
  assert.equal(bad.playback.snapshot().bufferCount,0); assert.equal(bad.playback.snapshot().pendingCount,0);
  const invalid=make({send:async()=>({ok:true})}); await assert.rejects(invalid.playback.prefetch(item()),/não retornou/);
  assert.equal(invalid.playback.snapshot().bufferCount,0);
});

test('invalidation during decode discards the stale result',async()=>{
  let finish; const h=make({decode:()=>new Promise(resolve=>{finish=resolve;})}); const pending=h.playback.prefetch(item());
  await new Promise(setImmediate); h.playback.stop({clearBuffers:true}); finish({duration:1}); await assert.rejects(pending,/substituída/);
  assert.equal(h.playback.snapshot().bufferCount,0);
});

test('prune preserves current window and invalidation clears all buffers',async()=>{
  const h=make(); for(let i=0;i<7;i++) await h.playback.prefetch(item(`scope:${i}`));
  h.playback.pruneAround(3,1); assert.equal(h.playback.snapshot().bufferCount,5);
  h.playback.stop({clearBuffers:true}); assert.equal(h.playback.snapshot().bufferCount,0);
});

test('dispose clears private state and is idempotent',()=>{const h=make();assert.equal(h.playback.dispose(),true);assert.equal(h.playback.dispose(),false);assert.equal(h.playback.snapshot().bufferCount,0);});
test('warm never returns audio and capability false is a no-op',async()=>{const h=make({cacheWarming:false});const result=await h.playback.warm([item()]);assert.equal(result.available,false);assert.equal(h.calls.length,0);});

test('warm validates metadata, deduplicates and never decodes or creates a source',async()=>{
  let decoded=0; const h=make({decode:async()=>{decoded++;return {duration:1};},send:async message=>{h.calls.push(message);return {status:'ready',cached:false,duration:1,elapsed:.1,fingerprint:'f'};}});
  const result=await h.playback.warm([item(),item()]);
  assert.equal(result.available,true); assert.equal(h.calls.length,1); assert.equal(h.calls[0].type,'warm-cache');
  assert.equal(decoded,0); assert.equal(h.sources.length,0); assert.equal('buffer' in result,false);
});

test('warm invalidation prevents stale completion from becoming reusable',async()=>{
  let resolve; const h=make({send:message=>{h.calls.push(message);return h.calls.length===1?new Promise(r=>{resolve=r;}):Promise.resolve({status:'ready',cached:false});}});
  const warming=h.playback.warm([item()]); await new Promise(setImmediate); h.playback.stop({clearBuffers:true});
  resolve({status:'ready',cached:false}); await warming; await h.playback.warm([item()]); assert.equal(h.calls.length,2);
});

test('stale ended after replacement or stop cannot advance',async()=>{
  let ended=0; const h=make({onEnded:()=>ended++}); await h.playback.play(item('a')); const old=h.sources[0];
  await h.playback.play(item('b')); old.onended?.(); assert.equal(ended,0); h.playback.stop(); h.sources[1].onended?.(); assert.equal(ended,0);
});

test('pause, elapsed, local volume and rate do not synthesize again',async()=>{
  const h=make(); await h.playback.play(item()); h.audio.currentTime=.5; assert.equal(h.playback.elapsed(),.5);
  await h.playback.pause(); assert.equal(h.playback.snapshot().playing,false); const before=h.calls.length;
  h.playback.setVolume(0); h.playback.setRate(1.5); assert.equal(h.calls.length,before);
});

test('source and context failures are contained and reported',async()=>{
  let errors=0; const start=make({source:()=>({playbackRate:{},connect(){},disconnect(){},start(){throw new Error('start');},stop(){throw new Error('stop');}}),onError:()=>errors++});
  assert.equal(await start.playback.play(item()),null); assert.equal(errors,1); assert.doesNotThrow(()=>start.playback.stop());
  const suspended=make({resume:async()=>{throw new Error('autoplay');},onError:()=>errors++}); suspended.audio.state='suspended';
  assert.equal(await suspended.playback.play(item()),null); assert.equal(errors,2);
});
