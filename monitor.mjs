import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const PUBLIC_ORIGIN='https://bonewizardry.com';
export const TARGETS=Object.freeze([
 `${PUBLIC_ORIGIN}/`,
 `${PUBLIC_ORIGIN}/start`,
 `${PUBLIC_ORIGIN}/pricing`,
]);
const MAX_LINKS=250;
const MAX_HTML_BYTES=2*1024*1024;
const OUTPUT_DIR=process.env.BW_MONITOR_OUTPUT_DIR||path.join(os.tmpdir(),'bw-public-monitor');

export function outputDirectory(){return OUTPUT_DIR;}

function decodeAttribute(value){
 return value.replace(/&amp;/gi,'&').replace(/&#0*38;/g,'&')
  .replace(/&quot;/gi,'"').replace(/&#0*39;|&#x0*27;/gi,"'");
}

export function safePublicLink(raw,baseUrl){
 try{
  const url=new URL(decodeAttribute(raw),baseUrl);
  if(url.protocol!=='https:'||url.origin!==PUBLIC_ORIGIN||url.username||url.password)return null;
  const decodedPath=decodeURIComponent(url.pathname);
  if(/(?:^|\/)(?:api|admin|manage(?:ment)?|auth|login|log-in|pro-login|logout|sign-?up|account|dashboard|student|students|qbank|lesson|lessons|billing|checkout|payment|purchase|recording|recordings|livekit|cdn-cgi)(?:\/|$)/i.test(decodedPath))return null;
  url.search='';url.hash='';
  return {url:url.href,path:url.pathname};
 }catch{return null;}
}

export function extractPublicLinks(html,baseUrl){
 const unique=new Map();
 for(const anchor of html.matchAll(/<a\b[^>]*>/gi)){
  const attr=anchor[0].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  const raw=attr?.[1]??attr?.[2]??attr?.[3];
  if(raw===undefined)continue;
  const link=safePublicLink(raw,baseUrl);
  if(link&&!unique.has(link.url))unique.set(link.url,link);
 }
 return [...unique.values()];
}

function withTimeout(timeoutMs){
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),timeoutMs);
 return {signal:controller.signal,close:()=>clearTimeout(timer)};
}

export async function probe(url,{fetchImpl=fetch,timeoutMs=8000}={}){
 if(!TARGETS.includes(url))throw new Error('Only preapproved public URLs may be checked');
 const timeout=withTimeout(timeoutMs);
 try{
  const response=await fetchImpl(url,{method:'HEAD',redirect:'manual',
   headers:{Accept:'*/*'},signal:timeout.signal,cache:'no-store'});
  const rawStatus=Number(response.status);
  const status=Number.isFinite(rawStatus)?rawStatus:null;
  return {path:new URL(url).pathname,status,ok:status!==null&&status>=200&&status<400};
 }catch{return {path:new URL(url).pathname,status:null,ok:false};}
 finally{timeout.close();}
}

async function readHtml(url,{fetchImpl,timeoutMs}){
 let current=url;
 for(let redirectCount=0;redirectCount<=3;redirectCount++){
  const timeout=withTimeout(timeoutMs);
  try{
   const response=await fetchImpl(current,{method:'GET',redirect:'manual',
    headers:{Accept:'text/html'},signal:timeout.signal,cache:'no-store'});
   const rawStatus=Number(response.status);
   const status=Number.isFinite(rawStatus)?rawStatus:null;
   if(status===null)return {ok:false,status:null,links:[]};
   if(status>=300&&status<400){
    const location=response.headers?.get?.('location');
    const safe=location&&safePublicLink(location,current);
    if(!safe)return {ok:false,status,links:[]};
    current=safe.url;continue;
   }
   if(status<200||status>=300)return {ok:false,status,links:[]};
   const type=response.headers?.get?.('content-type')||'';
   if(!/^text\/html(?:;|$)/i.test(type)||!response.body?.getReader)
    return {ok:false,status,links:[]};
   const reader=response.body.getReader(),chunks=[];
   let size=0;
   while(true){
    const {value,done}=await reader.read();
    if(done)break;
    const remaining=MAX_HTML_BYTES-size;
    if(value.byteLength>remaining){
     await reader.cancel();
     return {ok:false,status,links:[]};
    }
    chunks.push(value);size+=value.byteLength;
   }
   const bytes=new Uint8Array(size);let offset=0;
   for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
   return {ok:true,status,links:extractPublicLinks(new TextDecoder().decode(bytes),current)};
  }catch{return {ok:false,status:null,links:[]};}
  finally{timeout.close();}
 }
 return {ok:false,status:null,links:[]};
}

async function mapLimit(items,limit,operation){
 const results=new Array(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
  while(next<items.length){const index=next++;results[index]=await operation(items[index]);}
 }));
 return results;
}

export async function checkAll({fetchImpl=fetch,timeoutMs=5000}={}){
 const pages=[];
 const discovered=new Map();
 let linksTruncated=false;
 for(const target of TARGETS){
  const head=await probe(target,{fetchImpl,timeoutMs});
  const page={...head,scanned:false,linksFound:0};
  if(head.ok){
   let html;
   try{html=await readHtml(target,{fetchImpl,timeoutMs});}
   catch{html={ok:false,status:null,links:[]};}
   page.ok=html.ok&&head.ok;page.scanStatus=html.ok?'ok':'failed';
   if(html.ok){
    page.linksFound=html.links.length;
    for(const link of html.links){
     if(TARGETS.includes(link.url)||discovered.has(link.url))continue;
     if(discovered.size<MAX_LINKS)discovered.set(link.url,link);
     else linksTruncated=true;
    }
   }
  }else page.scanStatus='skipped';
  page.scanned=page.scanStatus==='ok';
  pages.push(page);
 }
 const links=await mapLimit([...discovered.values()],12,async link=>{
  const timeout=withTimeout(timeoutMs);
  try{
   const response=await fetchImpl(link.url,{method:'HEAD',redirect:'manual',
    headers:{Accept:'*/*'},signal:timeout.signal,cache:'no-store'});
   const rawStatus=Number(response.status);
   const status=Number.isFinite(rawStatus)?rawStatus:null;
   return {path:link.path,status,ok:status!==null&&status>=200&&status<400};
  }catch{return {path:link.path,status:null,ok:false};}
  finally{timeout.close();}
 });
 return {checkedAt:new Date().toISOString(),pages,links,linksTruncated,
  ok:!linksTruncated&&pages.every(page=>page.ok)&&links.every(link=>link.ok)};
}

export async function writeReport(report,outputDir=OUTPUT_DIR){
 await fs.mkdir(outputDir,{recursive:true});
 await fs.writeFile(path.join(outputDir,'report.json'),JSON.stringify(report,null,2)+'\n');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const report=await checkAll();
 await writeReport(report);
 for(const page of report.pages)
  console.log([page.ok?'PASS':'FAIL','PAGE',page.path,page.status??'unreachable'].join(' '));
 for(const link of report.links)
  console.log([link.ok?'PASS':'FAIL','LINK',link.path,link.status??'unreachable'].join(' '));
 console.log(`Checked ${report.pages.length} public pages and ${report.links.length} same-site links; truncated=${report.linksTruncated}`);
 if(!report.ok)process.exitCode=1;
}
