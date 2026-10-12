import assert from 'node:assert/strict';
import test from 'node:test';
import {ALERT_TITLE,syncAlert} from '../report-status.mjs';

function response(body,status=200){
 return {ok:status>=200&&status<300,status,json:async()=>body};
}

test('a failed public run opens one issue with status-only details',async()=>{
 const calls=[];
 const fetchImpl=async(url,options)=>{
  calls.push({url,method:options.method,body:options.body});
  if(options.method==='GET')return response([]);
  return response({number:41},201);
 };
 const result=await syncAlert({repository:'mnaqq/bw-public-monitor',token:'token',failed:true,
  details:['- page /pricing: 503'],runUrl:'https://github.com/mnaqq/bw-public-monitor/actions/runs/123',fetchImpl});
 assert.deepEqual(result,{action:'created',number:41});
 assert.deepEqual(calls.map(call=>call.method),['GET','POST']);
 const body=JSON.parse(calls[1].body);
 assert.equal(body.title,ALERT_TITLE);
 assert.match(body.body,/page \/pricing: 503/);
 assert.doesNotMatch(body.body,/HTML|cookie=|Authorization/);
});

test('recovery comments once and closes the existing monitor issue',async()=>{
 const calls=[];
 const fetchImpl=async(url,options)=>{
  calls.push({url,method:options.method,body:options.body});
  if(options.method==='GET')return response([{number:41,title:ALERT_TITLE}]);
  return response(null,204);
 };
 const result=await syncAlert({repository:'mnaqq/bw-public-monitor',token:'token',failed:false,
  details:[],runUrl:'https://github.com/mnaqq/bw-public-monitor/actions/runs/124',fetchImpl});
 assert.deepEqual(result,{action:'closed',number:41});
 assert.deepEqual(calls.map(call=>call.method),['GET','POST','PATCH']);
 assert.match(JSON.parse(calls[1].body).body,/recovered/);
 assert.equal(JSON.parse(calls[2].body).state,'closed');
});
