import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {outputDirectory,PUBLIC_ORIGIN,TARGETS,safePublicLink} from './monitor.mjs';

const VIEWPORTS=Object.freeze([
 {name:'mobile',width:390,height:844},
 {name:'desktop',width:1440,height:900},
]);
const ROUTE_NAMES=new Map([
 ['/', 'home'],
 ['/start', 'start'],
 ['/pricing', 'pricing'],
]);
const ALLOWED_NAVIGATION_PATHS=new Set(['/','/start','/start/','/pricing','/pricing/']);

function approvedNavigation(raw){
 try{
  const url=new URL(raw);
  return url.protocol==='https:'&&url.origin===PUBLIC_ORIGIN&&ALLOWED_NAVIGATION_PATHS.has(url.pathname)&&url.search===''&&url.hash==='';
 }catch{return false;}
}

function safeAssetRequest(request){
 if(!['GET','HEAD'].includes(request.method()))return false;
 const safe=safePublicLink(request.url(),TARGETS[0]);
 if(!safe)return false;
 const url=new URL(request.url());
 return ![...url.searchParams.keys()].some(key=>/token|secret|auth|session|credential|password|email|user|code|key/i.test(key));
}

export async function captureScreenshots({chromiumImpl=chromium,outputDir=outputDirectory()}={}){
 const directory=path.join(outputDir,'screenshots');
 await fs.mkdir(directory,{recursive:true});
 const browser=await chromiumImpl.launch({headless:true});
 const results=[];
 try{
  for(const target of TARGETS){
   const targetPath=new URL(target).pathname;
   const routeName=ROUTE_NAMES.get(targetPath);
   if(!routeName)throw new Error('Unapproved screenshot target');
   for(const viewport of VIEWPORTS){
    const context=await browser.newContext({viewport:{width:viewport.width,height:viewport.height},serviceWorkers:'block'});
    try{
     await context.clearCookies();
     const page=await context.newPage();
     await page.route('**/*',async route=>{
      const request=route.request();
      if(request.isNavigationRequest()){
       if(request.frame()!==page.mainFrame()||!approvedNavigation(request.url()))return route.abort();
      }else if(!safeAssetRequest(request))return route.abort();
      const headers={...request.headers()};
      for(const name of Object.keys(headers))if(name.toLowerCase()==='cookie'||name.toLowerCase()==='authorization')delete headers[name];
      return route.continue({headers});
     });
     let response=null;
     try{response=await page.goto(target,{waitUntil:'domcontentloaded',timeout:30000});}catch{}
     const status=response?.status()??null;
     const file=`${routeName}-${viewport.name}.png`;
     const ok=status!==null&&status>=200&&status<400&&approvedNavigation(page.url());
     if(ok)await page.screenshot({path:path.join(directory,file),fullPage:false,animations:'disabled',timeout:15000});
     results.push({path:targetPath,viewport:viewport.name,status,ok,screenshot:ok?file:null});
    }finally{await context.close();}
   }
  }
 }finally{await browser.close();}
 const report={capturedAt:new Date().toISOString(),pages:results,ok:results.length===TARGETS.length*VIEWPORTS.length&&results.every(item=>item.ok)};
 await fs.writeFile(path.join(outputDir,'capture.json'),JSON.stringify(report,null,2)+'\n');
 return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const report=await captureScreenshots();
 for(const item of report.pages)
  console.log([item.ok?'PASS':'FAIL','SCREENSHOT',item.path,item.viewport,item.status??'unreachable'].join(' '));
 if(!report.ok)process.exitCode=1;
}
