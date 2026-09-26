const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(path, imports = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText,
    {exports, require: name => imports[name], Date, Map, console, process, URL, fetch: async () => new Response('{}'), Response, ...globals});
  return exports;
}
const history = load('src/lib/elevenlabs-history.ts');
test('maps saved caller identity, status, timestamp and drops tool-only turns', () => {
  const call = {conversation_id:'conv1',status:'failed',metadata:{start_time_unix_secs:100},analysis:{data_collection_results:{customer_name:{value:'Test'},phone:{value:'+100'}}},transcript:[{role:'user',message:'Hello',time_in_call_secs:2},{role:'agent',message:null,tool_calls:[{tool_name:'calculate'}],time_in_call_secs:3}]};
  const mapped = history.mapElevenLabsCall(call);
  assert.equal(mapped.id, 'elevenlabs:conv1');
  assert.equal(mapped.name, 'Test');
  assert.equal(mapped.channel, 'phone');
  assert.match(mapped.intent, /failed/);
  // A customer-facing transcript must never show raw tool_calls/tool_results
  // JSON -- a turn with no spoken message (e.g. a pure workflow/tool step)
  // is dropped entirely, not rendered as a garbled JSON message bubble.
  const messages = history.mapElevenLabsMessages(call);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].direction, 'inbound');
  assert.equal(messages[0].body, 'Hello');
  assert.equal(messages[0].created_at, new Date(102000).toISOString());
});
test('spoken turns keep their message even when tool_calls are also present', () => {
  const call = {conversation_id:'conv2',metadata:{start_time_unix_secs:0},transcript:[
    {role:'agent',message:'Great, one samosa for pickup.',tool_calls:[{tool_name:'notify_condition_1_met'}],tool_results:[{tool_name:'notify_condition_1_met'}],time_in_call_secs:5},
  ]};
  const messages = history.mapElevenLabsMessages(call);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, 'Great, one samosa for pickup.');
  assert.doesNotMatch(messages[0].body, /tool_name|Tool calls|Tool results/);
});
test('paginates saved calls and deduplicates IDs', async () => {
  const urls = [];
  const calls = await history.fetchSavedHistory(async url => {
    urls.push(url);
    return {ok:true,json:async()=>urls.length === 1 ? {conversations:[{conversation_id:'a'}],has_more:true,next_offset:100} : {conversations:[{conversation_id:'a'},{conversation_id:'b'}],has_more:false}};
  }, '/proxy');
  assert.equal(calls.length, 2);
  assert.match(urls[1], /offset=100/);
});
test('rejects broken pagination and failed history fetch', async () => {
  await assert.rejects(history.fetchSavedHistory(async()=>({ok:true,json:async()=>({conversations:[],has_more:true,next_offset:0})}), '/proxy'));
  await assert.rejects(history.fetchSavedHistory(async()=>({ok:false}), '/proxy'));
});
test('handles absent analysis and transcript', () => {
  assert.equal(history.mapElevenLabsCall({conversation_id:'x'}).name, 'Unknown caller');
  assert.equal(history.mapElevenLabsMessages({conversation_id:'x'}).length, 0);
});
test('history proxy rejects unauthenticated requests and mutation', async () => {
  const path = 'src/app/dashboard-api/elevenlabs-agent/[...path]/route.ts';
  const imports = {'next/server':{NextResponse:class extends Response { static json(body, init) {return new Response(JSON.stringify(body),init);} }}, '@/lib/auth':{SESSION_COOKIE:'dash_session',verifyAndDecodeSessionToken:async token=>token ? {sub:'test'} : null}, '@/lib/audit':{writeAuditLog:()=>{}}};
  const proxy = load(path, imports);
  const context = {params:Promise.resolve({path:['elevenlabs','saved']})};
  assert.equal((await proxy.GET({cookies:{get:()=>undefined}},context)).status,401);
  assert.equal((await proxy.POST({cookies:{get:()=>({value:'session'})}},context)).status,405);
});

test('history uses its own key and maps upstream 401 to 502', async () => {
  const calls = [];
  const proxy = load('src/app/dashboard-api/elevenlabs-agent/[...path]/route.ts', {
    'next/server':{NextResponse:class extends Response {static json(body, init) {return new Response(JSON.stringify(body),init);}}},
    '@/lib/auth':{SESSION_COOKIE:'dash_session',verifyAndDecodeSessionToken:async()=>({sub:'test'})},
    '@/lib/audit':{writeAuditLog:()=>{}},
  }, {
    process:{env:{ELEVENLABS_AGENT_INTERNAL_URL:'http://backend',ELEVENLABS_AGENT_API_KEY:'orders-key',ELEVENLABS_CONVERSATIONS_API_KEY:'history-key'}},
    console:{error:()=>{}},
    fetch:async(url, options)=>{calls.push({url:String(url),options}); return new Response('{}',{status:401});},
  });
  const response = await proxy.GET({cookies:{get:()=>({value:'session'})},nextUrl:new URL('http://dashboard/?page_size=100')}, {params:Promise.resolve({path:['elevenlabs','saved']})});
  assert.equal(response.status,502);
  assert.equal(calls[0].options.headers['X-API-Key'],'history-key');
  assert.equal(calls[0].url,'http://backend/elevenlabs/saved?page_size=100');
});
