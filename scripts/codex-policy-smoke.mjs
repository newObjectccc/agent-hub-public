import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {CodexDriverHub} from '../server/dist/adapters/codex-driver.js';
import {buildCodexNewRollout} from '../server/dist/adapters/codex-rollout.js';
// 显式指定二进制；所有会话、配置与日志均在自有临时 CODEX_HOME，不读私人会话。
const args=process.argv.slice(2),binary=args[args.indexOf('--bin')+1];
if(!args.includes('--bin')||!binary||binary.startsWith('--'))throw Error('Usage: node scripts/codex-policy-smoke.mjs --bin /path/to/codex [--output result.json]');
const {execFileSync}=await import('node:child_process');
const version=execFileSync(binary,['--version'],{encoding:'utf8',timeout:5000}).match(/\b\d+\.\d+\.\d+(?:[-+][^\s]+)?/)?.[0];
if(!version)throw Error('Unable to determine Codex version');
const cases=[];const pause=()=>new Promise(r=>setTimeout(r,20));
async function released(hub,id){for(let i=0;i<150;i++){if(!hub.isBusy(id))return true;await pause();}return false;}
async function run(name,initial,requested,expected){
 const home=await mkdtemp(join(tmpdir(),'hub-policy-owned-'));const cwd=join(home,'work');await mkdir(cwd);const date=new Date().toISOString(),id=randomUUID();const dir=join(home,'sessions',...new Date().toISOString().slice(0,10).split('-'));await mkdir(dir,{recursive:true});
 await writeFile(join(home,'config.toml'),`approval_policy="${initial.approval}"\nsandbox_mode="${initial.sandbox}"\n`);
 const sessionFile=join(dir,`rollout-${date.slice(0,10)}T00-00-00-${id}.jsonl`);await writeFile(sessionFile,buildCodexNewRollout({sessionId:id,cwd,timestamp:date,cliVersion:version,modelProvider:'openai'}));
 // 初始文件代表已空闲线程；保留生产默认静默窗，复测 resume 自身更新后的二次接管。
 await utimes(sessionFile,new Date(Date.now()-10_000),new Date(Date.now()-10_000));
 let processes=0;const events=[];const hub=new CodexDriverHub({emit:(_id,event)=>events.push(event),codexBin:binary,...requested,idleDetachMs:0,prepareEnv:async()=>({PATH:process.env.PATH,HOME:process.env.HOME,CODEX_HOME:home}),spawnFn:(bin,args,opts)=>{if(args[0]==='app-server')processes++;return spawn(bin,args,opts)}});
 let result;
 try{await hub.attach(id,{cwd,sessionFile});const p=hub.statusFor(id).effectivePolicy;result={name,attached:true,approval:p?.approval,sandbox:p?.sandbox,processes,expectedMatched:p?.approval===expected?.approval&&p?.sandbox===expected?.sandbox};}
 catch(error){result={name,attached:false,rejected:error.code==='INVALID_REQUEST',rejectionCode:error.code,rejectionStatus:error.statusCode,processes,expectedMatched:expected==='reject'&&error.code==='INVALID_REQUEST'};}
 finally{hub.detach(id);result.released=await released(hub,id);result.modelTurnsStarted=events.filter(e=>e.type==='message_start').length;hub.disposeAll();await rm(home,{recursive:true,force:true});}
 if(!result.expectedMatched||!result.released||result.modelTurnsStarted!==0)process.exitCode=1;cases.push(result);
}
await run('tighten',{approval:'on-request',sandbox:'workspace-write'},{approvalPolicy:'untrusted',sandbox:'read-only'},{approval:'untrusted',sandbox:'read-only'});
await run('reject-widening',{approval:'on-request',sandbox:'read-only'},{sandbox:'workspace-write'},'reject');
await run('inherit',{approval:'on-request',sandbox:'workspace-write'},{},{approval:'on-request',sandbox:'workspace-write'});
const report={date:new Date().toISOString(),binaryVersion:version,externalQuietMs:3000,scope:'本机真实 app-server；自有临时 CODEX_HOME 与线程；生产默认静默窗；仅验证权限握手和进程释放；未调用模型或触发真实审批',cases};
if(args.includes('--output')){
 const output=args[args.indexOf('--output')+1];if(!output||output.startsWith('--'))throw Error('--output needs a path');
 const {dirname}=await import('node:path');await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify(report,null,2));
