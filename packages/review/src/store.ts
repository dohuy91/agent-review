import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { CommentInput, ReviewComment, Repository, ReviewObservation, FileDiff, CommentStatus, CommentSeverity } from '../../shared/src/index.js';
import { saveReviewHistory, reviewHistory } from './history.js';
import { makeAnchor, invalid } from './anchors.js';
export class ReviewStore {
 readonly db:DatabaseSync;
 constructor(dataDir:string) {
 mkdirSync(dataDir,{recursive:true,mode:0o700});
 this.db=new DatabaseSync(join(dataDir,'review.sqlite'));chmodSync(join(dataDir,'review.sqlite'),0o600);
 const version=this.db.prepare('PRAGMA user_version').get() as {user_version:number};
 if(version.user_version>2){this.db.close();throw new Error('Unsupported review database version');}
 this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, metadata TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS reviewed(repository_id TEXT NOT NULL, path TEXT NOT NULL, review_fingerprint TEXT NOT NULL, file_fingerprint TEXT NOT NULL, PRIMARY KEY(repository_id,path));
 CREATE TABLE IF NOT EXISTS profiles(scope TEXT NOT NULL, target_key TEXT NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(scope,target_key));
 CREATE TABLE IF NOT EXISTS profile_revisions(project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
 PRAGMA user_version=2;`);
 }
 history(repositoryId:string){return reviewHistory(this.db,repositoryId);}
 close(){this.db.close();}
 acceptObservation(repositoryId:string,obs:ReviewObservation) {
 saveReviewHistory(this.db,obs);
 // Acceptance clears prior comparison marks durably, including disappeared files.
 // A later return to the same fingerprint requires explicit renewed review.
 this.db.prepare('DELETE FROM reviewed WHERE repository_id=? AND review_fingerprint<>?').run(repositoryId,obs.fingerprint);
 }
 reviewed(repositoryId:string,obs:ReviewObservation) {
 if(!obs.historical)this.acceptObservation(repositoryId,obs);
 return {files:obs.files.map(file=>{const row=this.db.prepare('SELECT review_fingerprint,file_fingerprint FROM reviewed WHERE repository_id=? AND path=?').get(repositoryId,file.path) as {review_fingerprint:string;file_fingerprint:string}|undefined;return {path:file.path,fingerprint:file.fingerprint,reviewed:row?.review_fingerprint===obs.fingerprint&&row?.file_fingerprint===file.fingerprint};})};
 }
 markReviewed(repositoryId:string,obs:ReviewObservation,path:string,reviewed:boolean) {
 this.acceptObservation(repositoryId,obs);
 const file=obs.files.find(f=>f.path===path);if(!file||typeof reviewed!=='boolean')throw invalid();
 if(reviewed)this.db.prepare('INSERT INTO reviewed VALUES(?,?,?,?) ON CONFLICT(repository_id,path) DO UPDATE SET review_fingerprint=excluded.review_fingerprint,file_fingerprint=excluded.file_fingerprint').run(repositoryId,path,obs.fingerprint,file.fingerprint);
 else this.db.prepare('DELETE FROM reviewed WHERE repository_id=? AND path=?').run(repositoryId,path);
 return this.reviewed(repositoryId,obs);
 }
 list(repositoryId:string):ReviewComment[]{return (this.db.prepare('SELECT metadata FROM comments WHERE repository_id=? ORDER BY rowid').all(repositoryId) as {metadata:string}[]).map(r=>JSON.parse(r.metadata));}
 create(repo:Repository,obs:ReviewObservation,diff:FileDiff,input:CommentInput):ReviewComment {
 if(Object.keys(input).some(k=>!['reviewId','path','side','startLine','endLine','body','severity'].includes(k)))throw invalid();
 validateFields(input);
 if(!['old','new'].includes(input.side)||input.path!==diff.path||diff.unsupportedReason)throw invalid();
 const content=input.side==='old'?diff.oldContent:diff.newContent;
 if(content===null)throw invalid();
 const file=obs.files.find(f=>f.path===input.path);if(!file)throw invalid();
 const now=new Date().toISOString();
 const comment:ReviewComment={...input,id:randomUUID(),repositoryId:repo.id,projectId:repo.projectId,worktreeRoot:repo.root,mode:obs.mode,base:obs.base,mergeBase:obs.mergeBase,head:obs.head,branch:obs.branch,reviewFingerprint:obs.fingerprint,fileFingerprint:diff.fingerprint,sourceOid:input.side==='old'?file.oldOid:file.newOid,anchor:makeAnchor(content,input.startLine,input.endLine),status:'open',createdAt:now,updatedAt:now};
 this.db.prepare('INSERT INTO comments VALUES(?,?,?)').run(comment.id,repo.id,JSON.stringify(comment));return comment;
 }
 update(repositoryId:string,id:string,patch:{body?:string;severity?:CommentSeverity;status?:CommentStatus}):ReviewComment {
 if(!patch||Object.keys(patch).some(k=>!['body','severity','status'].includes(k))||!Object.keys(patch).length)throw invalid();validateFields(patch);
 const comment=this.list(repositoryId).find(c=>c.id===id);if(!comment)throw Object.assign(new Error('Unknown comment'),{statusCode:404});
 const next={...comment,...patch,updatedAt:new Date().toISOString()};this.db.prepare('UPDATE comments SET metadata=? WHERE id=? AND repository_id=?').run(JSON.stringify(next),id,repositoryId);return next;
 }
 delete(repositoryId:string,id:string){if(!this.db.prepare('DELETE FROM comments WHERE id=? AND repository_id=?').run(id,repositoryId).changes)throw Object.assign(new Error('Unknown comment'),{statusCode:404});}
}
function validateFields(value:{body?:unknown;severity?:unknown;status?:unknown}) {
 if(value.body!==undefined&&(typeof value.body!=='string'||!value.body.trim()||value.body.length>8000))throw invalid();
 if(value.severity!==undefined&&!['info','warning','error'].includes(value.severity as string))throw invalid();
 if(value.status!==undefined&&!['open','resolved'].includes(value.status as string))throw invalid();
}
