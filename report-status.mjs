import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {outputDirectory} from './monitor.mjs';

const API='https://api.github.com';
export const ALERT_TITLE='Public live monitor: site check failed';

function safePath(value){
 return typeof value==='string'?value.replace(/[^A-Za-z0-9_./%-]/g,'?').slice(0,120):'/';
}

function failures(report){
 const rows=[];
 for(const item of report?.pages||[])if(!item.ok){
  const scope=item.viewport?`screenshot ${item.viewport}`:'page';
  let result=item.status===null||item.status===undefined?'unreachable':String(item.status);
  if(item.scanStatus==='failed')result=`HEAD ${result}; HTML scan failed`;
  rows.push(`- ${scope} ${safePath(item.path)}: ${result}`);
 }
 for(const item of report?.links||[])if(!item.ok)rows.push(`- link ${safePath(item.path)}: ${item.status??'unreachable'}`);
 if(report?.linksTruncated)rows.push('- link scan exceeded its bounded check limit.');
 return rows;
}

function headers(token){
 return {Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,
  'Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'};
}

async function jsonRequest(fetchImpl,url,token,method='GET',body){
 const response=await fetchImpl(url,{method,headers:headers(token),...(body?{body:JSON.stringify(body)}:{})});
 if(!response.ok)throw new Error('GitHub issue update failed');
 return response.status===204?null:response.json();
}

export async function syncAlert({repository,token,failed,details,runUrl,fetchImpl=fetch}){
 if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)||!token)
  throw new Error('Missing monitor issue configuration');
 const base=`${API}/repos/${repository}/issues`;
 const open=await jsonRequest(fetchImpl,`${base}?state=open&per_page=100`,token);
 const issue=(open||[]).find(item=>!item.pull_request&&item.title===ALERT_TITLE);
 if(failed&&!issue){
  const lines=details.length?details.join('\n'):'- The monitor process failed before it could write a status report.';
  const created=await jsonRequest(fetchImpl,base,token,'POST',{title:ALERT_TITLE,
   body:`## Public check failure\n\n${lines}\n\nRun: ${runUrl}\n\nOnly anonymous checks of the approved public pages and same-site link statuses are included. No page response bodies, cookies, or authorization data are stored.`});
  return {action:'created',number:created.number};
 }
 if(!failed&&issue){
  await jsonRequest(fetchImpl,`${base}/${issue.number}/comments`,token,'POST',
   {body:`The public monitor recovered. Run: ${runUrl}`});
  await jsonRequest(fetchImpl,`${base}/${issue.number}`,token,'PATCH',{state:'closed'});
  return {action:'closed',number:issue.number};
 }
 return {action:issue?'already-open':'no-change',number:issue?.number??null};
}

async function readJson(file){
 try{return JSON.parse(await fs.readFile(file,'utf8'));}catch{return null;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const directory=outputDirectory();
 const report=await readJson(path.join(directory,'report.json'));
 const capture=await readJson(path.join(directory,'capture.json'));
 const monitorFailed=process.env.MONITOR_OUTCOME!=='success'||report?.ok!==true;
 const captureFailed=['failure','cancelled'].includes(process.env.CAPTURE_OUTCOME)||capture?.ok===false;
 const failed=monitorFailed||captureFailed;
 const details=[...failures(report),...failures(capture)];
 if(captureFailed&&!failures(capture).length)details.push('- The scheduled screenshot check failed.');
 const server=(process.env.GITHUB_SERVER_URL||'https://github.com').replace(/\/$/,'');
 const repository=process.env.GITHUB_REPOSITORY||'';
 const runId=process.env.GITHUB_RUN_ID||'';
 if(!/^https:\/\/[A-Za-z0-9.-]+$/.test(server)||!/^\d+$/.test(runId))
  throw new Error('Missing monitor run context');
 const result=await syncAlert({repository,token:process.env.GH_TOKEN,failed,details,
  runUrl:`${server}/${repository}/actions/runs/${runId}`});
 console.log(`Alert ${result.action}${result.number?` #${result.number}`:''}`);
}
