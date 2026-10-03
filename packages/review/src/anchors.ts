import { createHash } from 'node:crypto';
import type { HashAnchor } from '../../shared/src/index.js';
export const invalid = () => Object.assign(new Error('Invalid review metadata'), {statusCode:400});
function lines(content:string) { const result=content.split('\n');if(result.at(-1)==='')result.pop();return result; }
const hash=(line:string)=>createHash('sha256').update(line).digest('hex');
export function makeAnchor(content:string,start:number,end:number):HashAnchor {
 const source=lines(content);
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<1||end<start||end>source.length||end-start>=1000)throw invalid();
 return {version:1,selected:source.slice(start-1,end).map(hash),before:source.slice(Math.max(0,start-3),start-1).map(hash),after:source.slice(end,end+2).map(hash)};
}
export function attach(anchor:HashAnchor,content:string|null) {
 if(content===null)return null;
 const hashes=lines(content).map(hash),matches:number[]=[];
 for(let i=0;i+anchor.selected.length<=hashes.length;i++) {
 if(i<anchor.before.length)continue;
 const equal=(a:string[],b:string[])=>a.length===b.length&&a.every((v,n)=>v===b[n]);
 if(equal(anchor.selected,hashes.slice(i,i+anchor.selected.length))&&equal(anchor.before,hashes.slice(i-anchor.before.length,i))&&equal(anchor.after,hashes.slice(i+anchor.selected.length,i+anchor.selected.length+anchor.after.length)))matches.push(i);
 }
 return matches.length===1?{startLine:matches[0]!+1,endLine:matches[0]!+anchor.selected.length}:null;
}
