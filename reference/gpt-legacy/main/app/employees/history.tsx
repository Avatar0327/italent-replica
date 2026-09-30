'use client';
import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
type Item={id:string;at:string;fromOrg:string|null;toOrg:string;fromStatus:string|null;toStatus:string;job:string;level:string};
export default function History({employeeId}:{employeeId:string}){
 const [page,setPage]=useState(1),[data,setData]=useState<{items:Item[];total:number}|null>(null),[error,setError]=useState('');
 useEffect(()=>{setPage(1);},[employeeId]);
 useEffect(()=>{let live=true;setError('');setData(null);fetch(`/api/history?employeeId=${encodeURIComponent(employeeId)}&page=${page}`,{cache:'no-store'}).then(async r=>{const d=await r.json() as {items:Item[];total:number;error?:string};if(!r.ok)throw Error(d.error);if(live)setData(d);}).catch(e=>live&&setError(e.message));return()=>{live=false;};},[employeeId,page]);
 return <section><h3>任职历史</h3>{error&&<p role="alert">{error}</p>}{!data&&!error&&<p>加载中…</p>}{data?.items.map(h=><div className="border-b py-3" key={h.id}><time className="text-slate-500">{h.at.slice(0,16).replace('T',' ')} UTC</time><p>{h.fromOrg??'新增档案'} → {h.toOrg}</p><p>{h.fromStatus??'—'} → {h.toStatus} · {h.job} {h.level}</p></div>)}{data&&!data.items.length&&<p>暂无任职变更记录</p>}{data&&data.total>20&&<div className="flex gap-2 py-3"><Button variant="outline" disabled={page===1} onClick={()=>setPage(page-1)}>上一页</Button><Button variant="outline" disabled={page*20>=data.total} onClick={()=>setPage(page+1)}>下一页</Button></div>}</section>;
}
