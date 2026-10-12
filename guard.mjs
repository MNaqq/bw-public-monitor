import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HOME=path.dirname(fileURLToPath(import.meta.url));
export const APPROVED=Object.freeze([
 '.gitattributes','README.md','package.json','package-lock.json',
 'monitor.mjs','capture.mjs','report-status.mjs','guard.mjs',
 '.github/workflows/check.yml','.github/workflows/monitor.yml','release-manifest.json',
 'tests/monitor.test.mjs','tests/guard.test.mjs','tests/report-status.test.mjs'
]);

export function validateBundle(root=HOME){
 const errors=[];
 const seen=[];
 const approved=new Set(APPROVED);
 const manifestPath=path.join(root,'release-manifest.json');
 let manifest=null;
 try{manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));}
 catch{errors.push('missing_or_invalid_review_manifest');}
 if(manifest?.schema!=='public-monitor-boundary/v1')errors.push('invalid_manifest_schema');
 const hashes=manifest?.files;
 if(!hashes||typeof hashes!=='object'||Array.isArray(hashes))errors.push('invalid_manifest_files');
 const expected=APPROVED.filter(x=>x!=='release-manifest.json');
 if(hashes&&JSON.stringify(Object.keys(hashes).sort())!==JSON.stringify([...expected].sort()))
  errors.push('manifest_allowlist_mismatch');
 const deny=[
  '-----'+'BEGIN PRIVATE KEY',
  'sk'+'_live_','ghp'+'_','CF'+'_API_TOKEN',
  'data-'+'lesson-section','content/'+'remakes/',
  'reference/'+'official-', 'qbank/'+'official-',
  'Authorization:'+' Bearer', '<article'+' data-case=',
 ];
 const allowedDirectories=new Set(['tests','.github','.github/workflows']);
 function visit(dir,relative=''){
  let children;
  try{children=fs.readdirSync(dir,{withFileTypes:true});}
  catch{errors.push('unreadable_directory:'+relative);return;}
  for(const entry of children){
   if(relative===''&&(entry.name==='.git'||entry.name==='node_modules'))continue;
   const rel=relative?relative+'/'+entry.name:entry.name;
   const full=path.join(dir,entry.name);
   const stat=fs.lstatSync(full);
   if(stat.isSymbolicLink()){errors.push('symlink:'+rel);continue;}
   if(stat.isDirectory()){
    if(!allowedDirectories.has(rel)){errors.push('unexpected_directory:'+rel);continue;}
    visit(full,rel);continue;
   }
   if(!stat.isFile()||!approved.has(rel)){errors.push('unapproved_file:'+rel);continue;}
   seen.push(rel);
   if(stat.size>524288){errors.push('oversize:'+rel);continue;}
   const bytes=fs.readFileSync(full);
   const content=bytes.toString('utf8');
   if(!Buffer.from(content,'utf8').equals(bytes))errors.push('non_utf8:'+rel);
   if(deny.some(fragment=>content.includes(fragment)))errors.push('forbidden_payload:'+rel);
   if(rel!=='release-manifest.json'){
    const hash=createHash('sha256').update(bytes).digest('hex');
    if(hashes?.[rel]!==hash)errors.push('unreviewed_bytes:'+rel);
   }
  }
 }
 visit(root);
 for(const rel of APPROVED)if(!seen.includes(rel))errors.push('missing_approved_file:'+rel);
 return {ok:errors.length===0,errors};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const result=validateBundle();
 console.log(result.ok?`PASS public-only boundary: ${APPROVED.length} reviewed files`:'FAIL public-only boundary: '+result.errors.join(', '));
 if(!result.ok)process.exitCode=1;
}
