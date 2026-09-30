import type {ReportField} from './r1-report-catalog';
import type {ReportCell} from './r1-report-values';
const quote=(v:unknown,text=true)=>{let s=String(v??'');if(text&&/^[\s\uFEFF]*[=+@-]/u.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
export function reportCsvChunk(fields:ReportField[],rows:{cells:Record<string,ReportCell>}[],header:boolean){
 const lines:string[]=[];if(header)lines.push(fields.flatMap(f=>[quote(f.label),quote(f.label+' [state]'),quote(f.label+' [reason]')]).join(','));
 for(const row of rows)lines.push(fields.flatMap(f=>{const c=row.cells[f.fieldId];return [quote(c?.value,!['integer','decimal','money_cents'].includes(f.type)),quote(c?.state??'forbidden'),quote(c?.reasonCode??(c?'':'field_not_authorized'))];}).join(','));
 return (header?'\uFEFF':'')+lines.join('\r\n')+(lines.length?'\r\n':'');
}
export async function byteDigest(bytes:Uint8Array){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource))].map(n=>n.toString(16).padStart(2,'0')).join('');}
export type ReportObjectStore={put:(key:string,bytes:Uint8Array)=>Promise<void>;get:(key:string)=>Promise<Uint8Array|null>};
