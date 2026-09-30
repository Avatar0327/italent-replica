'use client';
import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import type {DevelopmentRecord} from '@/lib/hris/development';
type Event={revision:number;action:string;actorId:string;at:string;snapshot:DevelopmentRecord};
export default function ProcessHistory({id,updatedAt}:{id:string;updatedAt:string}){
 const [items,setItems]=useState<Event[]>([]),[page,setPage]=useState(1),[more,setMore]=useState(false),[error,setError]=useState('');
 useEffect(()=>{setPage(1);},[id]);useEffect(()=>{let active=true;fetch('/api/development?'+new URLSearchParams({id,page:String(page)}),{cache:'no-store'}).then(async r=>{const d=await r.json() as {error?:string;items:Event[];hasMore:boolean};if(!r.ok)throw Error(d.error);if(active){setItems(d.items);setMore(d.hasMore);setError('');}}).catch(e=>active&&setError(e.message));return()=>{active=false;};},[id,page,updatedAt]);
 return <section className="space-y-3 border-t pt-4"><h3 className="font-semibold">过程历史</h3>{error&&<p className="text-red-700" role="alert">{error}</p>}{items.map(e=><div key={e.revision} className="rounded border p-3"><p className="text-xs text-slate-500">{e.at} · {e.actorId}</p><p className="mt-1">{e.action}</p>{e.snapshot.payload.verification&&<p className="mt-1 whitespace-pre-wrap">核验：{e.snapshot.payload.verification}</p>}{e.snapshot.payload.evidence&&<p className="mt-1 whitespace-pre-wrap">依据：{e.snapshot.payload.evidence}</p>}</div>)}<div className="flex justify-end gap-2"><Button variant="outline" size="sm" disabled={page===1} onClick={()=>setPage(page-1)}>上一页</Button><Button variant="outline" size="sm" disabled={!more} onClick={()=>setPage(page+1)}>下一页</Button></div></section>;
}
