import type { Repository, ReviewObservation, SkillProfile, ProfileScope, ProfilesResponse } from '../../shared/src/index.js';
import type { ReviewStore } from './store.js';
import { invalid } from './anchors.js';
export function profileKey(repo:Repository,obs:ReviewObservation,scope:ProfileScope) {
 if(scope!=='project'&&!obs.branch)throw invalid();
 return JSON.stringify(scope==='project'?[repo.projectId]:scope==='branch'?[repo.projectId,obs.branch]:[repo.projectId,repo.id,obs.branch]);
}
export function getProfiles(store:ReviewStore,repo:Repository,obs:ReviewObservation):ProfilesResponse {
 const profiles:ProfilesResponse['profiles']={};let effective:SkillProfile|null=null,source:ProfileScope|null=null;
 for(const scope of ['project','branch','worktree'] as const) {
 if(scope!=='project'&&!obs.branch)continue;
 const row=store.db.prepare('SELECT metadata FROM profiles WHERE scope=? AND target_key=?').get(scope,profileKey(repo,obs,scope)) as {metadata:string}|undefined;
 if(row){profiles[scope]=JSON.parse(row.metadata);effective=profiles[scope]!;source=scope;}
 }
 const row=store.db.prepare('SELECT revision FROM profile_revisions WHERE project_id=?').get(repo.projectId) as {revision:number}|undefined;
 return {profiles,effective,source,revision:row?.revision??0};
}
export function putProfile(store:ReviewStore,repo:Repository,obs:ReviewObservation,scope:ProfileScope,profile:SkillProfile|null) {
 if(!['project','branch','worktree'].includes(scope))throw invalid();
 const key=profileKey(repo,obs,scope);
 if(profile!==null&&(!profile||Object.keys(profile).some(k=>!['locator','digest'].includes(k))||typeof profile.locator!=='string'||!profile.locator.trim()||profile.locator.length>2048||/[\x00-\x1f]/.test(profile.locator)||typeof profile.digest!=='string'||!/^[a-f0-9]{64}$/.test(profile.digest)))throw invalid();
 store.db.exec('BEGIN IMMEDIATE');
 try{
 if(profile===null)store.db.prepare('DELETE FROM profiles WHERE scope=? AND target_key=?').run(scope,key);
 else store.db.prepare('INSERT INTO profiles VALUES(?,?,?) ON CONFLICT(scope,target_key) DO UPDATE SET metadata=excluded.metadata').run(scope,key,JSON.stringify(profile));
 store.db.prepare('INSERT INTO profile_revisions VALUES(?,1) ON CONFLICT(project_id) DO UPDATE SET revision=revision+1').run(repo.projectId);
 store.db.exec('COMMIT');
 }catch(error){store.db.exec('ROLLBACK');throw error;}
 return getProfiles(store,repo,obs);
}
