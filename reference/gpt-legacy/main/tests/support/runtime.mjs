import {registerHooks} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,dirname} from 'node:path';
import ts from 'typescript';
import {DatabaseSync} from 'node:sqlite';
const root=fileURLToPath(new URL('../../',import.meta.url));
globalThis.p2env={HRIS_SETUP_OWNER_EMAIL:'owner@example.com'};
globalThis.p2headers=new Headers();
registerHooks({
 resolve(specifier,context,next){
  if(specifier==='cloudflare:workers')return {url:'data:text/javascript,export const env=globalThis.p2env;',shortCircuit:true};
  if(specifier==='next/headers')return {url:'data:text/javascript,export async function headers(){return globalThis.p2headers}',shortCircuit:true};
  if(specifier==='next/navigation')return {url:'data:text/javascript,export function redirect(path){throw new Error(path)}',shortCircuit:true};
  let path;if(specifier.startsWith('@/'))path=resolve(root,specifier.slice(2));else if(specifier.startsWith('.')&&context.parentURL?.startsWith('file:')&&!context.parentURL.includes('/node_modules/'))path=resolve(dirname(fileURLToPath(context.parentURL)),specifier);
  if(path){if(existsSync(path)&&/\.[cm]?[jt]sx?$/.test(path))return {url:pathToFileURL(path).href,shortCircuit:true};for(const suffix of ['.ts','.tsx','.mjs'])if(existsSync(path+suffix))return {url:pathToFileURL(path+suffix).href,shortCircuit:true};}
  return next(specifier,context);
 },
 load(url,context,next){if(url.startsWith('file:')&&url.endsWith('.ts')&&!url.includes('/node_modules/'))return {format:'module',source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText,shortCircuit:true};return next(url,context);}
});
export function database(path=':memory:'){
 const sqlite=new DatabaseSync(path);sqlite.exec('PRAGMA foreign_keys=ON');
 class Statement{
  constructor(sql){this.sql=sql;this.args=[];}
  bind(...args){this.args=args;return this;}
  execute(){try{const s=sqlite.prepare(this.sql);let results=[],changes=0;if(s.columns().length)results=s.all(...this.args);else changes=Number(s.run(...this.args).changes);return {results,success:true,meta:{changes}};}catch(e){e.message+=`\nSQL: ${this.sql}`;throw e;}}
  async all(){return this.execute();}
  async first(column){const row=this.execute().results[0]??null;return column?row?.[column]??null:row;}
  async run(){return this.execute();}
 }
 const db={prepare:sql=>new Statement(sql),batch:async statements=>{sqlite.exec('BEGIN');try{const result=statements.map(s=>s.execute());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 return {db,sqlite};
}
export function act(id,email=id+'@example.com'){globalThis.p2headers=new Headers({'oai-authenticated-user-id':id,'oai-authenticated-user-email':email});}
export const request=(path,body)=>new Request('https://hris.example'+path,body===undefined?undefined:{method:'POST',headers:{Origin:'https://hris.example','Content-Type':'application/json'},body:JSON.stringify(body)});
