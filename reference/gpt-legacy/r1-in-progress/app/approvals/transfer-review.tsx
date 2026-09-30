'use client';
import {useState} from 'react';
import {Button} from '@/components/ui/button';
import {businessDate} from '@/lib/hris/business-time';
import {transferAwaitingExecution} from '@/lib/hris/personnel-transfer';
import type {Approval,State} from '@/lib/hris/model';
export function approvalStatus(a:Approval){const t=a.details?.transfer;return a.status==='approved'&&t?{waiting:'已批准 · 待生效',failed:'已批准 · 生效失败',applied:'已生效',cancelled:'已批准 · 已取消生效'}[t.execution]:{pending:'待审批',approved:'已通过',rejected:'已驳回',withdrawn:'已撤回'}[a.status];}
const time=(s?:string)=>s?new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+' 北京时间':'—';
export default function TransferReview({approval:a,state:s,userId,canMaintain,canDecide,viewLevel,busy,mutate,resubmit}:{approval:Approval;state?:State;userId?:string;canMaintain:boolean;canDecide:boolean;viewLevel:boolean;busy:boolean;mutate:(c:unknown)=>Promise<void>;resubmit:(a:Approval)=>void}){
 const [reason,setReason]=useState('');const t=a.details?.transfer,e=s?.employees.find(e=>e.id===a.employeeId);
 const waiting=transferAwaitingExecution(a),hasBoth=!!t&&[t.source.orgId,t.target.orgId].every(id=>s?.orgs.some(o=>o.id===id));
 const mayHandle=canMaintain&&hasBoth&&(!t?.gradeChanged||viewLevel);
 const late=!!t&&t.effectiveOn<businessDate(),blind=!!t?.gradeChanged&&!viewLevel;
 const terminal=['rejected','withdrawn'].includes(a.status)||t?.execution==='cancelled';
 return <div className="detail-body"><h2>{t?.employeeName??e?.name??'受限员工'} · {a.kind==='transfer'?'调动申请':a.kind==='regularize'?'转正申请':'离职申请'}</h2><p className="status blue">{approvalStatus(a)}</p><dl><div><dt>申请编号</dt><dd className="break-all">{a.id}</dd></div><div><dt>提交时间</dt><dd>{time(a.created)}</dd></div><div><dt>申请原因</dt><dd>{a.reason}</dd></div>{a.details?.previousApprovalId&&<div><dt>关联原单</dt><dd className="break-all">{a.details.previousApprovalId}</dd></div>}</dl>
 {t&&<><p className="muted">仅显示本申请审批所需的任职快照；不授予其他人员或档案附件访问权。</p><table className="w-full text-sm"><thead><tr><th>任职信息</th><th>调动前</th><th>调动后</th></tr></thead><tbody>{[['组织',t.source.orgName,t.target.orgName],['岗位',t.source.job,t.target.job],['职级',viewLevel?t.source.level||'未设置':'无读取权限',viewLevel?t.target.level||'未设置':'无读取权限']].map(([label,from,to])=><tr key={label}><th>{label}</th><td>{from}</td><td>{to}</td></tr>)}</tbody></table><dl><div><dt>业务生效日</dt><dd>{t.effectiveOn}（北京时间）</dd></div><div><dt>最早执行时点</dt><dd>{time(t.eligibleAt)}</dd></div><div><dt>最终批准时间</dt><dd>{time(a.decided)}</dd></div><div><dt>实际生效时间</dt><dd>{time(t.appliedAt)}</dd></div><div><dt>执行次数</dt><dd>{t.attempts}</dd></div></dl><p>批准后不会自动修改档案。到期由覆盖双方组织的授权HR执行，成功时同步更新任职、历史与审计；不回写过去的历史。</p>{t.failure&&<p role="alert">生效失败：{t.failure}。档案尚未变更；修复原因后重试。若需改日期或任职方案，先取消生效再关联新申请。</p>}{t.cancelReason&&<p>取消生效原因：{t.cancelReason}</p>}</>}
 {!t&&a.kind==='transfer'&&a.status==='pending'&&<p role="alert">历史申请缺少生效约定，请发起者撤回，再关联新申请。</p>}
 {a.details?.rejectionReason&&<p>驳回原因：{a.details.rejectionReason}</p>}
 {a.steps?.map((step,i)=><div className="audit-row" key={step.userId}><span>第{i+1}级{t?(i===0?' · 调出方':' · 调入方'):''} · {step.name}</span><b>{step.decision==='approved'?'已通过':step.decision==='rejected'?'已驳回':a.status==='pending'&&i===(a.currentStep??0)?'处理中':'未处理'}</b></div>)}
 {a.status==='pending'&&a.createdBy===userId&&<Button variant="outline" disabled={busy} onClick={()=>mutate({action:'withdraw',id:a.id})}>撤回申请（改日期须重新审批）</Button>}
 {canDecide&&a.status==='pending'&&a.steps?.[a.currentStep??0]?.userId===userId&&<>{late&&<p role="alert">生效日已过，不能晚批追溯生效。请发起者撤回，更新日期并关联新申请。</p>}{blind&&<p role="alert">申请包含职级变化，但当前无读取权限。禁止盲审，需由管理员核对授权。</p>}<label className="field"><span>驳回原因（驳回时必填，2–500字）</span><textarea value={reason} onChange={e=>setReason(e.target.value)} maxLength={500} rows={3}/></label><div className="form-actions"><Button variant="outline" disabled={busy||blind||reason.trim().length<2} onClick={()=>mutate({action:'decide',id:a.id,decision:'rejected',decisionReason:reason})}>驳回</Button><Button disabled={busy||blind||late||(a.kind==='transfer'&&!t)} onClick={()=>mutate({action:'decide',id:a.id,decision:'approved'})}>通过本级审批</Button></div></>}
 {waiting&&mayHandle&&<><label className="field"><span>取消生效原因（改日期时必填，2–500字）</span><textarea value={reason} onChange={e=>setReason(e.target.value)} maxLength={500} rows={3}/></label><div className="form-actions"><Button variant="outline" disabled={busy||reason.trim().length<2} onClick={()=>mutate({action:'cancelTransfer',id:a.id,reason})}>取消生效</Button><Button disabled={busy||Date.now()<Date.parse(t!.eligibleAt)} onClick={()=>mutate({action:'executeTransfer',id:a.id})}>{t?.execution==='failed'?'重试生效':'执行生效'}</Button></div><p className="muted">如请求结果不明，先刷新核对状态；显示已生效时不要重复执行。</p></>}
 {terminal&&e&&canMaintain&&<Button disabled={busy} onClick={()=>resubmit(a)}>关联原单发起新申请（完整重审）</Button>}
 </div>;
}
