import assert from 'node:assert/strict';
import test from 'node:test';
import { createInboundImageStager, extractInboundImageUrls, decodeCqParameter, redactInboundMediaText, INBOUND_IMAGE_LIMITS } from '../dist/src/inboundMedia.js';
import { fetchRemoteMedia, saveMediaBuffer } from 'openclaw/plugin-sdk/media-runtime';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const event = (urls, id = 1) => ({ message_id: id, user_id: 42, message_type: 'private', message: urls.map(url => ({ type: 'image', data: { url } })) });
const fakeSave = async (_b, contentType) => ({ path: '/media/image.png', contentType });

test('structured image/mface order; CQ fallback decodes once without splitting escaped commas', () => {
  assert.deepEqual(extractInboundImageUrls({ message: [{type:'text',data:{text:'hi'}},{type:'image',data:{url:'https://a/?a=1&b=2'}},{type:'mface',data:{url:'https://b/'}}], raw_message:'[CQ:image,url=https://duplicate/]'}), ['https://a/?a=1&b=2','https://b/']);
  assert.deepEqual(extractInboundImageUrls({raw_message:'hi[CQ:image,url=https://a/?x=1&amp;y=2&#44;3][CQ:mface,url=https://b/&#91;x&#93;]'}), ['https://a/?x=1&y=2,3','https://b/[x]']);
  assert.equal(decodeCqParameter('&amp;#44;'), '&#44;');
  assert.equal(redactInboundMediaText('hi[CQ:image,url=https://a/?secret=x]'), 'hi[图片]');
});

test('single/multiple ordered local payload, real SDK store, duplicate in-flight reuse', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'napcat-inbound-'));
  const old = process.env.OPENCLAW_STATE_DIR; process.env.OPENCLAW_STATE_DIR = dir;
  let calls = 0;
  try {
    const stage = createInboundImageStager({ fetch: async options => { calls++; assert.equal(options.maxRedirects,0); assert.equal(options.timeoutMs,10000); assert.equal(options.maxBytes,10485760); return {buffer:png}; }, save:saveMediaBuffer });
    const e = event(['https://a.test/1','https://a.test/2']);
    const [a,b] = await Promise.all([stage(e),stage(e)]);
    assert.equal(calls,2); assert.deepEqual(a,b); assert.equal(a.payload.MediaPaths.length,2);
    assert.notEqual(a.payload.MediaPaths[0],a.payload.MediaPaths[1]);
    assert.equal(a.payload.MediaPath,a.payload.MediaPaths[0]);
    assert.deepEqual(a.payload.MediaTypes,['image/png','image/png']);
    for (const path of a.payload.MediaPaths) assert.deepEqual(await readFile(path),png);
    assert.equal((await stage(event(['https://a.test/one'],2))).payload.MediaPaths.length,1);
  } finally { if(old === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR=old; await rm(dir,{recursive:true,force:true}); }
});

test('failure/expired/timeout/write failure and spoofed MIME degrade safely', async () => {
  for (const code of ['http_error','fetch_failed','max_bytes']) {
    const stage=createInboundImageStager({fetch:async()=>{throw Object.assign(new Error('https://secret/?credential=bad'),{code});},save:fakeSave});
    const result=await stage(event(['https://a.test/'])); assert.deepEqual(result.failures,['image_1:'+code]); assert.equal(result.payload.MediaPath,undefined);
  }
  const writeFail=createInboundImageStager({fetch:async()=>({buffer:png}),save:async()=>{throw new Error('EACCES secret');}});
  assert.deepEqual((await writeFail(event(['https://a.test/']))).failures,['image_1:store_failed']);
  const html=createInboundImageStager({fetch:async()=>({buffer:Buffer.from('<html>bad</html>'),contentType:'image/png'}),save:fakeSave});
  assert.deepEqual((await html(event(['https://a.test/a.png']))).failures,['image_1:unsupported_image']);
});

test('local paths, schemes and URL credentials never reach fetch', async () => {
  let calls=0; const stage=createInboundImageStager({fetch:async()=>{calls++;return {buffer:png};},save:fakeSave});
  for(const url of ['/etc/passwd','file:///etc/passwd','data:image/png;base64,abc','https://user:pass@example.com/']) assert.equal((await stage(event([url]))).failures.length,1);
  assert.equal(calls,0);
});

test('real SDK blocks private/loopback targets before transport and rejects redirects', async () => {
  for(const url of ['http://127.0.0.1/x','http://169.254.169.254/x','http://[::1]/x']) {
    let called=false;
    await assert.rejects(fetchRemoteMedia({url,fetchImpl:async()=>{called=true;return new Response(png);},maxRedirects:0,timeoutMs:1000}));
    assert.equal(called,false);
  }
  let called=0;
  await assert.rejects(fetchRemoteMedia({url:'https://8.8.8.8/image',fetchImpl:async()=>{called++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});},maxRedirects:0,timeoutMs:1000}));
  assert.equal(called,1);
});

test('count and global concurrency are bounded; partial success keeps order', async () => {
  let calls=0; const ordered=[];
  const stage=createInboundImageStager({fetch:async({url})=>{calls++;ordered.push(url);return {buffer:png};},save:fakeSave});
  const result=await stage(event(Array.from({length:10},(_,i)=>'https://a.test/'+i)));
  assert.equal(calls,INBOUND_IMAGE_LIMITS.count); assert.ok(result.failures.includes('image_count_limit'));
  assert.deepEqual(ordered,Array.from({length:8},(_,i)=>'https://a.test/'+i));
  let release; const gate=new Promise(r=>release=r);
  const busy=createInboundImageStager({fetch:async()=>{await gate;return {buffer:png};},save:fakeSave});
  const pending=Array.from({length:4},(_,i)=>busy(event(['https://a.test/'+i],i)));
  assert.deepEqual((await busy(event(['https://a.test/5'],5))).failures,['image_1:busy']); release(); await Promise.all(pending);
});

test('SDK bounds oversized and expired bodies and aborts stalled response', async () => {
  const base={url:'https://8.8.8.8/image',maxRedirects:0,timeoutMs:40,maxBytes:16};
  await assert.rejects(fetchRemoteMedia({...base,fetchImpl:async()=>new Response(Buffer.alloc(32))}), e=>e.code==='max_bytes');
  await assert.rejects(fetchRemoteMedia({...base,fetchImpl:async()=>new Response('expired',{status:403})}), e=>e.code==='http_error');
  const started=Date.now();
  // Keep the test process alive while the SDK's unref deadline expires.
  const keepAlive=setInterval(()=>{},100);
  try {
    await assert.rejects(fetchRemoteMedia({...base,fetchImpl:async(_url,init)=>new Promise((_,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});})}));
    assert.ok(Date.now()-started<2000);
  } finally {clearInterval(keepAlive);}
});

test('a failed middle attachment does not reorder later successes', async()=>{
 let i=0;
 const stage=createInboundImageStager({fetch:async({url})=>{if(url.endsWith('/2')) throw new Error('expired');return {buffer:png};},save:async()=>({path:'/media/'+(++i)+'.png'})});
 const result=await stage(event(['https://a.test/1','https://a.test/2','https://a.test/3']));
 assert.deepEqual(result.payload.MediaPaths,['/media/1.png','/media/2.png']);
 assert.deepEqual(result.failures,['image_2:download_failed']);
});

test('transient download/store failures retry immediately; partial successes remain reusable', async () => {
  const dir=await mkdtemp(join(tmpdir(),'napcat-retry-'));
  const old=process.env.OPENCLAW_STATE_DIR; process.env.OPENCLAW_STATE_DIR=dir;
  try {
    for (const phase of ['download','store']) {
      let failing=true, downloads=0;
      const stage=createInboundImageStager({fetch:async()=>{downloads++;if(failing && phase==='download') throw new Error('network');return {buffer:png};},save:async(...args)=>{if(failing && phase==='store') throw new Error('disk');return saveMediaBuffer(...args);}});
      const e=event(['https://a.test/retry']);
      assert.equal((await stage(e)).failures.length,1);
      failing=false;
      assert.deepEqual((await stage(e)).failures,[]); assert.equal(downloads,2);
      await stage(e); assert.equal(downloads,2);
    }
    let failing=true; const calls=[];
    const stage=createInboundImageStager({fetch:async({url})=>{calls.push(url);if(failing && url.endsWith('/2')) throw new Error('network');return {buffer:png};},save:saveMediaBuffer});
    const e=event(['https://a.test/1','https://a.test/2','https://a.test/3']);
    const first=await stage(e); assert.equal(first.failures.length,1);
    failing=false; const second=await stage(e);
    assert.deepEqual(second.failures,[]); assert.equal(second.payload.MediaPaths.length,3);
    assert.equal(second.payload.MediaPaths[0],first.payload.MediaPaths[0]);
    assert.equal(second.payload.MediaPaths[2],first.payload.MediaPaths[1]);
    assert.deepEqual(calls,['https://a.test/1','https://a.test/2','https://a.test/3','https://a.test/2']);
  } finally {if(old===undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR=old;await rm(dir,{recursive:true,force:true});}
});

test('busy is not cached after capacity recovers', async()=>{
  let release;const gate=new Promise(r=>release=r);let calls=0;
  const stage=createInboundImageStager({fetch:async()=>{calls++;await gate;return {buffer:png};},save:fakeSave});
  const pending=Array.from({length:4},(_,i)=>stage(event(['https://a.test/'+i],i)));
  const e=event(['https://a.test/retry'],9);
  assert.deepEqual((await stage(e)).failures,['image_1:busy']);release();await Promise.all(pending);
  assert.deepEqual((await stage(e)).failures,[]);assert.equal(calls,5);
});

test('deleted SDK cache files are restaged once across concurrent retries', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'napcat-cleanup-'));const old=process.env.OPENCLAW_STATE_DIR;process.env.OPENCLAW_STATE_DIR=dir;
  try {
    let calls=0;const stage=createInboundImageStager({fetch:async()=>{calls++;return {buffer:png};},save:saveMediaBuffer});
    const e=event(['https://a.test/1','https://a.test/2']);const first=await stage(e);
    await rm(first.payload.MediaPaths[0]);
    const [a,b]=await Promise.all([stage(e),stage(e)]);
    assert.deepEqual(a,b);assert.equal(calls,3);
    assert.notEqual(a.payload.MediaPaths[0],first.payload.MediaPaths[0]);
    assert.equal(a.payload.MediaPaths[1],first.payload.MediaPaths[1]);
    for(const path of a.payload.MediaPaths) assert.deepEqual(await readFile(path),png);
  } finally {if(old===undefined) delete process.env.OPENCLAW_STATE_DIR;else process.env.OPENCLAW_STATE_DIR=old;await rm(dir,{recursive:true,force:true});}
});

test('structured text CQ examples do not become attachments through raw fallback',()=>{
  assert.deepEqual(extractInboundImageUrls({message:[{type:'text',data:{text:'请解释 [CQ:image,file=abc] 的语法'}}],raw_message:'请解释 [CQ:image,file=abc] 的语法'}),[]);
});

test('SDK full download deadline aborts a stalled body after headers (not only header wait)', {timeout:3000}, async()=>{
  const keepAlive=setInterval(()=>{},100); let headers=false, aborted=false;
  const started=Date.now();
  try {
   for(const status of [200,403]) {
    aborted=false;
    await assert.rejects(fetchRemoteMedia({url:'https://8.8.8.8/image',maxRedirects:0,timeoutMs:40,maxBytes:1024,
      fetchImpl:async(_url,init)=>{
        headers=true;
        return new Response(new ReadableStream({start(controller){
          controller.enqueue(png.subarray(0,8));
          init.signal.addEventListener('abort',()=>{aborted=true;controller.error(init.signal.reason);},{once:true});
        }}),{status});
      }}));
    assert.equal(headers,true);assert.equal(aborted,true);assert.ok(Date.now()-started<2000);
   }
  } finally {clearInterval(keepAlive);}
});
