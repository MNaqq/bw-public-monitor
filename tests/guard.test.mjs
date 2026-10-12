import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validateBundle} from '../guard.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function copyForTest(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bw-pubmon-'));
 fs.cpSync(ROOT,dir,{recursive:true,filter:source=>!source.split(path.sep).some(part=>part==='node_modules'||part==='.git')});
 return dir;
}
test('the only exportable files match the approved manifest',()=>{
 const result=validateBundle(ROOT);
 assert.deepEqual(result.errors,[]);
 assert.equal(result.ok,true);
});
test('an unexpected lesson or sample file fails closed',t=>{
 const dir=copyForTest();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'lesson-sample.json'),'{}');
 assert.ok(validateBundle(dir).errors.includes('unapproved_file:lesson-sample.json'));
});
test('changing even an approved README requires a new reviewed digest',t=>{
 const dir=copyForTest();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.appendFileSync(path.join(dir,'README.md'),'a local edit\n');
 assert.ok(validateBundle(dir).errors.includes('unreviewed_bytes:README.md'));
});
test('an embedded protected-teaching marker is rejected even if manifest is repinned',t=>{
 const dir=copyForTest();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const src=path.join(dir,'README.md');fs.appendFileSync(src,'\ndata-'+'lesson-section\n');
 const manifestPath=path.join(dir,'release-manifest.json');
 const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
 manifest.files['README.md']=createHash('sha256').update(fs.readFileSync(src)).digest('hex');
 fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
 assert.ok(validateBundle(dir).errors.includes('forbidden_payload:README.md'));
});
