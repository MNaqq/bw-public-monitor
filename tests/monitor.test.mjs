import assert from 'node:assert/strict';
import test from 'node:test';
import {TARGETS,probe,checkAll,extractPublicLinks} from '../monitor.mjs';

function htmlResponse(html){
 const bytes=new TextEncoder().encode(html);let sent=false;
 return {status:200,headers:{get:name=>name.toLowerCase()==='content-type'?'text/html; charset=utf-8':null},
  body:{getReader:()=>({read:async()=>sent?{done:true}:(sent=true,{value:bytes,done:false}),cancel:async()=>{sent=true;}})}};
}

test('anonymous checks scan only approved pages and HEAD-check unique same-site links',async()=>{
 const calls=[];
 const fetchImpl=async(url,opts)=>{
  calls.push({url,method:opts.method,redirect:opts.redirect,headers:opts.headers,body:opts.body});
  if(opts.method==='HEAD')return {status:url.endsWith('/start')?308:200,
   get body(){throw new Error('Must never inspect a HEAD response body');}};
  return htmlResponse('<a href="/about">About</a><a href="/about#top">Duplicate</a><a href="https://outside.invalid/">External</a>');
 };
 const result=await checkAll({fetchImpl});
 assert.equal(result.pages.length,3);
 assert.ok(result.ok);
 assert.ok(result.pages.every(page=>page.ok&&page.scanned));
 assert.equal(result.links.length,1);
 assert.deepEqual(result.links[0],{path:'/about',status:200,ok:true});
 assert.ok(calls.every(call=>['HEAD','GET'].includes(call.method)&&call.body===undefined));
 assert.ok(calls.every(call=>!('Cookie' in call.headers)&&!('Authorization' in call.headers)));
 assert.ok(calls.filter(call=>call.method==='GET').every(call=>TARGETS.includes(call.url)));
 assert.ok(calls.every(call=>call.redirect==='manual'));
});

test('public HTML links reject external and insecure destinations and strip query data',()=>{
 assert.deepEqual(extractPublicLinks(
  '<a href="/about?email=private#section">About</a><a href="http://bonewizardry.com/no">No</a><a href="//outside.invalid/">No</a><a href="/account/profile">No</a><a href="/%6cogin">No</a><a href="/pro-login">No</a><a href="/manage">No</a><a href="/cdn-cgi/l/email-protection">No</a>',
  TARGETS[0]),[{url:'https://bonewizardry.com/about',path:'/about'}]);
});

test('a public page redirect cannot make the monitor fetch an external host',async()=>{
 const calls=[];
 const fetchImpl=async(url,opts)=>{
  calls.push({url,method:opts.method});
  if(opts.method==='HEAD')return {status:200};
  return {status:302,headers:{get:name=>name.toLowerCase()==='location'?'https://outside.invalid/':null}};
 };
 const result=await checkAll({fetchImpl});
 assert.equal(result.ok,false);
 assert.ok(result.pages.every(page=>page.scanStatus==='failed'));
 assert.ok(calls.every(call=>new URL(call.url).origin==='https://bonewizardry.com'));
});

test('public probes reject unapproved URLs and never inspect a HEAD response body',async()=>{
 let called=false;
 await assert.rejects(probe('https://example.com/private',{fetchImpl:async()=>{called=true;}}),/preapproved/);
 assert.equal(called,false);
 assert.equal((await probe(TARGETS[0],{fetchImpl:async()=>({status:503,
  get body(){throw new Error('Must never inspect HEAD body');}})})).ok,false);
});

test('network failures report only pathname and status',async()=>{
 assert.deepEqual(await probe(TARGETS[1],{fetchImpl:async()=>{throw Error('private diagnostic');}}),
  {path:'/start',status:null,ok:false});
});
test('link scan fails closed when more than 250 safe links are discovered',async()=>{
 const html=Array.from({length:251},(_,index)=>`<a href="/about/${index}">Link</a>`).join('');
 const fetchImpl=async(url,opts)=>opts.method==='HEAD'?{status:200}:htmlResponse(html);
 const result=await checkAll({fetchImpl});
 assert.equal(result.links.length,250);
 assert.equal(result.linksTruncated,true);
 assert.equal(result.ok,false);
});
test('oversized landing-page responses are cancelled and fail closed',async()=>{
 let cancelled=0;
 const bytes=new Uint8Array(2*1024*1024+1);
 const fetchImpl=async(url,opts)=>opts.method==='HEAD'?{status:200}:
  {status:200,headers:{get:name=>name.toLowerCase()==='content-type'?'text/html':null},
   body:{getReader:()=>({read:async()=>({value:bytes,done:false}),cancel:async()=>{cancelled++;}})}};
 const result=await checkAll({fetchImpl});
 assert.equal(cancelled,3);
 assert.ok(result.pages.every(page=>page.scanStatus==='failed'));
 assert.equal(result.ok,false);
});
