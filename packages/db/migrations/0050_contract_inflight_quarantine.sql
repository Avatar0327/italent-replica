-- DEC-190：升级前的重复在途组全部隔离，不选择获胜者，不改批准载荷/状态/签订次数。
-- 复用合同失败待办的持久记录；quarantine 标记不会被 activate 的重试覆盖或因只剩一份而解除。
WITH pending AS (
  SELECT q.*,count(*) OVER (PARTITION BY tenant_id,employee_id,type_id) AS group_size
  FROM contract_requests q
  WHERE status IN ('in_review','approved') AND operation IN ('create','renew','change','edit')
)
INSERT INTO contract_job_attempts(tenant_id,object_id,employee_id,kind,state,error,command_id)
SELECT tenant_id,id,employee_id,'quarantine','failed','CONTRACT_IN_FLIGHT_QUARANTINED',
  'ct-quarantine:'||id::text FROM pending WHERE group_size>1
ON CONFLICT (tenant_id,object_id,kind) DO NOTHING;
--> statement-breakpoint
INSERT INTO audit_events(tenant_id,actor_user_id,action,object_type,object_id,"before","after",command_id)
SELECT q.tenant_id,NULL,'contract.request.quarantine','TenantBase.EmploymentContract',q.id::text,
  to_jsonb(q),to_jsonb(q)||jsonb_build_object('quarantined',true,'reason',a.error),a.command_id
FROM contract_requests q JOIN contract_job_attempts a ON a.tenant_id=q.tenant_id AND a.object_id=q.id
WHERE a.kind='quarantine' AND a.command_id='ct-quarantine:'||q.id::text;
--> statement-breakpoint
INSERT INTO contract_outbox(tenant_id,object_id,event_type,command_id,payload)
SELECT q.tenant_id,q.id,'contract.request.quarantine',a.command_id,
  jsonb_build_object('employeeId',q.employee_id,'typeId',q.type_id,'request',to_jsonb(q),
    'reason',a.error,'requiresResubmission',true)
FROM contract_requests q JOIN contract_job_attempts a ON a.tenant_id=q.tenant_id AND a.object_id=q.id
WHERE a.kind='quarantine' AND a.command_id='ct-quarantine:'||q.id::text;
