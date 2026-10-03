import { test, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, readFile, realpath, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../apps/server/src/app.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive:true, force:true }))); });
async function setup() {
 const root=await mkdtemp(join(tmpdir(),'comments-repo-')); roots.push(root);
 const dataDir=await mkdtemp(join(tmpdir(),'comments-data-')); roots.push(dataDir);
 const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
 git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.com');
 await writeFile(join(root,'a.txt'),'one\ntwo\nthree\nfour\nfive\nsix\n');git('add','.');git('commit','-qm','base');git('branch','base');
 await writeFile(join(root,'a.txt'),'one\ntwo\nchanged\nfour\nfive\nsix\n');
 async function launch() {
 const app=await createApp({port:7373,token:'test-token',dataDir,repositoryPath:root,base:'base'});
 const session=await app.inject({method:'POST',url:'/api/session',headers:{host:'localhost:7373',origin:'http://localhost:7373'},payload:{token:'test-token'}});
 const cookie=session.headers['set-cookie']!.toString().split(';')[0]!;
 const headers={host:'localhost:7373',origin:'http://localhost:7373',cookie};
 const repos=(await app.inject({url:'/api/repositories',headers})).json();const id=repos.selectedRepositoryId;
 const call=(method:any,url:string,payload?:any)=>app.inject({method,url:`/api/repositories/${id}/${url}`,headers,payload});
 const review=async(mode='full')=>(await call('GET',`review?base=base&mode=${mode}`)).json();
 return {app,call,review,id}; }
 return {root,dataDir,git,launch};
}
test('old deleted range and single comments survive actual service close/reopen with no source persisted',async()=>{
 const f=await setup(); await rm(join(f.root,'a.txt'));
 let a=await f.launch();let r=await a.review();
 for(const [startLine,endLine] of [[2,4],[5,5]]) {
 const res=await a.call('POST','comments',{reviewId:r.id,path:'a.txt',side:'old',startLine,endLine,body:'Please explain',severity:'warning'});
 expect(res.statusCode).toBe(201);expect(res.json().side).toBe('old'); }
 await a.app.close();a=await f.launch();r=await a.review();
 const res=await a.call('GET',`comments?reviewId=${r.id}`);expect(res.statusCode).toBe(200);
 expect(res.json().comments.map((c:any)=>[c.startLine,c.endLine,c.attachment])).toEqual([[2,4,'current'],[5,5,'current']]);
 await a.app.close(); const db=await readFile(join(f.dataDir,'review.sqlite'));expect(db.includes(Buffer.from('three'))).toBe(false);expect(db.includes(Buffer.from('Please explain'))).toBe(true);
});
test('range bounds, stale mutation, edit resolve reopen and repository scoped delete',async()=>{
 const f=await setup();const a=await f.launch();const r=await a.review();
 const input={reviewId:r.id,path:'a.txt',side:'new',startLine:3,endLine:3,body:'Fix',severity:'error'};
 expect((await a.call('POST','comments',{...input,endLine:99})).statusCode).toBe(400);
 const c=(await a.call('POST','comments',input)).json();expect(c.id).toBeTypeOf('string');
 expect((await a.call('PATCH',`comments/${c.id}`,{body:'Changed',status:'resolved',severity:'info'})).json().status).toBe('resolved');
 expect((await a.call('PATCH',`comments/${c.id}`,{status:'open'})).json().status).toBe('open');
 expect((await a.call('PATCH',`comments/${c.id}`,{severity:'critical'})).statusCode).toBe(400);
 await writeFile(join(f.root,'a.txt'),'altered\n');expect((await a.call('POST','comments',input)).statusCode).toBe(409);
 expect((await a.call('DELETE',`comments/${c.id}`)).statusCode).toBe(204);await a.app.close();
});
test('unique shifted context reattaches; ambiguous and modified mutable sources become unavailable outdated',async()=>{
 const f=await setup();const a=await f.launch();let r=await a.review();
 const c=(await a.call('POST','comments',{reviewId:r.id,path:'a.txt',side:'new',startLine:3,endLine:3,body:'Fix',severity:'warning'})).json();expect(c.id).toBeTypeOf('string');
 await writeFile(join(f.root,'a.txt'),'prefix\none\ntwo\nchanged\nfour\nfive\nsix\n');r=await a.review();
 let list=(await a.call('GET',`comments?reviewId=${r.id}`)).json().comments;
 expect(list[0].attachment).toBe('current');expect(list[0].attachedRange).toEqual({startLine:4,endLine:4});expect(list[0].startLine).toBe(3);
 await writeFile(join(f.root,'a.txt'),'one\ntwo\nchanged\nfour\nfive\nsix\none\ntwo\nchanged\nfour\nfive\nsix\n');r=await a.review();
 list=(await a.call('GET',`comments?reviewId=${r.id}`)).json().comments;expect(list[0].attachment).toBe('outdated');expect(list[0].historicalContent).toBe('unavailable');
 await writeFile(join(f.root,'a.txt'),'modified\n');r=await a.review();expect((await a.call('GET',`comments?reviewId=${r.id}`)).json().comments[0].attachment).toBe('outdated');await a.app.close();
});
test('reviewed fingerprints reset for content, comparison base and mode; durable unchanged review survives restart',async()=>{
 const f=await setup();let a=await f.launch();let r=await a.review();
 expect((await a.call('PUT','reviewed',{reviewId:r.id,path:'a.txt',reviewed:true})).statusCode).toBe(200);
 expect((await a.call('GET',`reviewed?reviewId=${r.id}`)).json().files[0].reviewed).toBe(true);
 await a.app.close();a=await f.launch();r=await a.review();expect((await a.call('GET',`reviewed?reviewId=${r.id}`)).json().files[0].reviewed).toBe(true);
 const other=await a.review('working');expect((await a.call('GET',`reviewed?reviewId=${other.id}`)).json().files[0].reviewed).toBe(false);
 await writeFile(join(f.root,'a.txt'),'changed again\n');r=await a.review();expect((await a.call('GET',`reviewed?reviewId=${r.id}`)).json().files[0].reviewed).toBe(false);
 await a.app.close();
});
test('project branch worktree profiles resolve with branch isolation and durable revisions; export freezes identifiers only',async()=>{
 const f=await setup();let a=await f.launch();let r=await a.review();
 const profile=(name:string)=>({locator:`skill://${name}`,digest:'a'.repeat(64)});
 const put=async(scope:string,p:any)=>(await a.call('PUT','profiles',{reviewId:r.id,scope,profile:p}));
 expect((await put('project',profile('project'))).statusCode).toBe(200);
 let p=(await a.call('GET',`profiles?reviewId=${r.id}`)).json();expect(p.effective.locator).toBe('skill://project');expect(p.source).toBe('project');
 await put('branch',profile('branch'));await put('worktree',profile('worktree'));
 p=(await a.call('GET',`profiles?reviewId=${r.id}`)).json();expect(p.source).toBe('worktree');expect(p.effective.locator).toBe('skill://worktree');expect(p.revision).toBe(3);
 const c=(await a.call('POST','comments',{reviewId:r.id,path:'a.txt',side:'new',startLine:3,endLine:3,body:'Export me',severity:'info'})).json();
 const exp=(await a.call('GET',`export?reviewId=${r.id}`)).json();expect(exp.schemaVersion).toBe(1);expect(exp.target).toMatchObject({repositoryId:a.id,worktreeRoot:await realpath(f.root),branch:r.branch,head:r.head,reviewFingerprint:r.fingerprint});expect(exp.profile.revision).toBe(3);expect(exp.comments[0].id).toBe(c.id);expect(JSON.stringify(exp)).not.toContain('changed');
 await a.app.close();a=await f.launch();r=await a.review();expect((await a.call('GET',`profiles?reviewId=${r.id}`)).json().revision).toBe(3);
 f.git('checkout','-qb','other');r=await a.review();p=(await a.call('GET',`profiles?reviewId=${r.id}`)).json();expect(p.source).toBe('project');expect(p.effective.locator).toBe('skill://project');
 f.git('checkout','--detach','-q');r=await a.review();expect((await a.call('PUT','profiles',{reviewId:r.id,scope:'branch',profile:profile('bad')})).statusCode).toBe(400);
 expect((await a.call('PUT','profiles',{reviewId:r.id,scope:'project',profile:{locator:'skill://bad',digest:'invalid'}})).statusCode).toBe(400);await a.app.close();
});
test('reject state directories inside reviewed roots and arbitrary persisted comment metadata',async()=>{
 const f=await setup();const rejected=await createApp({port:7373,token:'x',dataDir:join(f.root,'.review-state'),repositoryPath:f.root}).then(async app=>{await app.close();return false;},e=>/outside/i.test(e.message));expect(rejected).toBe(true);
 const a=await f.launch();const r=await a.review();expect((await a.call('POST','comments',{reviewId:r.id,path:'a.txt',side:'new',startLine:3,endLine:3,body:'Safe',severity:'info',sourceSnapshot:'private code'})).statusCode).toBe(400);await a.app.close();
});
test('exact unchanged endpoint preserves location even for duplicate text contexts',async()=>{
 const f=await setup();await writeFile(join(f.root,'a.txt'),'a\nb\nx\ny\nz\na\nb\nx\ny\nz\n');const a=await f.launch();const r=await a.review();
 const created=await a.call('POST','comments',{reviewId:r.id,path:'a.txt',side:'new',startLine:3,endLine:3,body:'First occurrence',severity:'info'});expect(created.statusCode).toBe(201);
 const c=(await a.call('GET',`comments?reviewId=${r.id}`)).json().comments[0];expect(c.attachment).toBe('current');expect(c.attachedRange.startLine).toBe(3);await a.app.close();
});

test('comment metadata schema excludes client source fields',async()=>{const f=await setup();const a=await f.launch();const r=await a.review();expect((await a.call('POST','comments',{reviewId:r.id,path:'a.txt',side:'new',startLine:3,endLine:3,body:'Safe',severity:'info',sourceSnapshot:'private code'})).statusCode).toBe(400);await a.app.close();});

test('accepted mode and base changes permanently clear marks through A B A and restart including disappeared files',async()=>{
 const f=await setup();f.git('add','.');f.git('commit','-qm','second');
 let a=await f.launch();let r=await a.review();
 await a.call('PUT','reviewed',{reviewId:r.id,path:'a.txt',reviewed:true});
 expect((await a.call('GET',`reviewed?reviewId=${r.id}`)).json().files[0].reviewed).toBe(true);
 await a.review('branch'); // accepting comparison B must invalidate without a reviewed GET
 await a.app.close();a=await f.launch();r=await a.review();
 expect((await a.call('GET',`reviewed?reviewId=${r.id}`)).json().files[0].reviewed).toBe(false);
 await a.call('PUT','reviewed',{reviewId:r.id,path:'a.txt',reviewed:true});
 const empty=(await a.call('GET','review?base=HEAD&mode=full')).json();expect(empty.files).toHaveLength(0);
 await a.app.close();a=await f.launch();r=await a.review();
 expect((await a.call('GET',`reviewed?reviewId=${r.id}`)).json().files[0].reviewed).toBe(false);
 await a.call('PUT','reviewed',{reviewId:r.id,path:'a.txt',reviewed:true});expect((await a.call('GET',`reviewed?reviewId=${r.id}`)).json().files[0].reviewed).toBe(true);await a.app.close();
});
test('export and observation access reject moved Git directory with identical source and endpoints',async()=>{
 const f=await setup();const a=await f.launch();const r=await a.review();
 expect((await a.call('GET',`export?reviewId=${r.id}`)).statusCode).toBe(200);
 const moved=join(f.dataDir,'moved.git');await rename(join(f.root,'.git'),moved);await symlink(moved,join(f.root,'.git'));
 expect((await a.call('GET',`export?reviewId=${r.id}`)).statusCode).toBe(409);
 expect((await a.call('GET',`diff?reviewId=${r.id}&path=a.txt`)).statusCode).toBe(409);
 expect((await a.call('GET','review?base=base&mode=full')).statusCode).toBe(409);await a.app.close();
});
