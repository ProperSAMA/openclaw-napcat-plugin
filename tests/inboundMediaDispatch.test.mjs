import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveMediaBuffer } from 'openclaw/plugin-sdk/media-runtime';
import { createInboundImageStager } from '../dist/src/inboundMedia.js';
import { handleNapCatWebhook } from '../dist/src/webhook.js';
import { setNapCatConfig, setNapCatRuntime } from '../dist/src/runtime.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const secret='fixture-secret';
async function deliver(event,stage,valid=true) {
 const raw=Buffer.from(JSON.stringify(event)); const req=Readable.from([raw]);
 Object.assign(req,{url:'/napcat',method:'POST',headers:{'x-signature':'sha1='+createHmac('sha1',valid?secret:'wrong').update(raw).digest('hex')}});
 const res={statusCode:200,setHeader(){},end(){}}; await handleNapCatWebhook(req,res,stage); return res;
}
test('authenticated dispatch receives readable ordered images; denied messages never stage',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'napcat-dispatch-')); const old=process.env.OPENCLAW_STATE_DIR; process.env.OPENCLAW_STATE_DIR=dir;
 let downloads=0; const contexts=[];
 const base={webhookSecret:secret,enableInboundLogging:false,enablePrivateTypingStatus:false,conversationConfigDir:''};
 setNapCatRuntime({config:{current:()=>({})},channel:{routing:{resolveAgentRoute:()=>({agentId:'main',accountId:'default',sessionKey:'fixture'})},reply:{createReplyDispatcher:o=>o,dispatchReplyFromConfig:async({ctx})=>contexts.push(ctx)}}});
 const stage=createInboundImageStager({fetch:async()=>{downloads++;return {buffer:png};},save:saveMediaBuffer});
 const event={post_type:'message',message_type:'private',user_id:123,message_id:901,self_id:456,message:[{type:'text',data:{text:'看图'}},{type:'image',data:{url:'https://example.com/1'}},{type:'mface',data:{url:'https://example.com/2'}}]};
 try {
  setNapCatConfig(base); await deliver(event,stage);
  assert.equal(contexts.length,1); assert.match(contexts[0].BodyForAgent,/看图/); assert.equal(contexts[0].MessageSid,'901');
  assert.equal(contexts[0].MediaPaths.length,2); assert.deepEqual(contexts[0].MediaTypes,['image/png','image/png']);
  for(const path of contexts[0].MediaPaths) assert.deepEqual(await readFile(path),png);
  await deliver(event,stage); assert.equal(downloads,2);
  for(const [config,change,valid] of [[base,{},false],[{...base,allowUsers:['999']},{},true],[{...base,enableGroupMessages:false},{message_type:'group',group_id:1},true],[{...base,enableGroupMessages:true,groupWhitelist:['2']},{message_type:'group',group_id:1},true],[{...base,enableGroupMessages:true},{message_type:'group',group_id:1},true]]) {
   let stageCalls=0;
   setNapCatConfig(config); await deliver({...event,...change,message_id:902},async()=>{stageCalls++; return {payload:{},failures:[]};},valid);
   assert.equal(stageCalls,0,'denied event must not stage media');
  }
  assert.equal(contexts.length,2);
  setNapCatConfig(base);
  const fail=createInboundImageStager({fetch:async()=>{throw new Error('expired signed secret');},save:saveMediaBuffer});
  await deliver({...event,message_id:903},fail); assert.equal(contexts.length,3); assert.match(contexts[2].BodyForAgent,/图片附件不可用/); assert.equal(contexts[2].MediaPath,undefined);
  await deliver({...event,message_id:904,message:'plain text'},stage); assert.equal(contexts[3].Body,'plain text'); assert.equal(contexts[3].MediaPath,undefined);
 } finally {if(old===undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR=old; await rm(dir,{recursive:true,force:true});}
});

test('literal CQ text survives body and command dispatch; real CQ media stays redacted',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'napcat-text-'));const contexts=[];let downloads=0;
 setNapCatRuntime({config:{current:()=>({})},channel:{routing:{resolveAgentRoute:()=>({agentId:'main',accountId:'default',sessionKey:'fixture'})},reply:{createReplyDispatcher:o=>o,dispatchReplyFromConfig:async({ctx})=>contexts.push(ctx)}}});
 setNapCatConfig({webhookSecret:secret,enableInboundLogging:true,inboundLogDir:dir,enablePrivateTypingStatus:false,conversationConfigDir:''});
 const stage=createInboundImageStager({fetch:async()=>{downloads++;throw new Error('signed-token');},save:saveMediaBuffer});
 const base={post_type:'message',message_type:'private',user_id:123,self_id:456};
 try {
  for(const [i,text] of ['请解释 [CQ:image,file=abc] 的语法','/help [CQ:image,file=abc]'].entries()) {
   await deliver({...base,message_id:1000+i,message:[{type:'text',data:{text}}],raw_message:text.replace('[','&#91;').replace(']','&#93;')},stage);
   assert.equal(contexts[i].Body,text);assert.equal(contexts[i].CommandBody,text);
   assert.ok(contexts[i].BodyForAgent.endsWith(text));assert.equal(contexts[i].MediaPath,undefined);
  }
  assert.equal(downloads,0);
  const raw='看图[CQ:image,url=https://example.com/x?token=signed-token]';
  await deliver({...base,message_id:1002,message:raw,raw_message:raw},stage);
  await deliver({...base,message_id:1003,message:[{type:'text',data:{text:'看图'}},{type:'image',data:{url:'https://example.com/x?token=signed-token'}}],raw_message:raw},stage);
  for(const ctx of contexts.slice(2)) {
   assert.ok(ctx.Body.startsWith('看图[图片]'));assert.equal(ctx.RawBody,'看图[图片]');
   assert.ok(!JSON.stringify(ctx).includes('signed-token'));
  }
  assert.equal(downloads,2);
  assert.ok(!(await readFile(join(dir,'qq-123.log'),'utf8')).includes('signed-token'));
 } finally {await rm(dir,{recursive:true,force:true});}
});
