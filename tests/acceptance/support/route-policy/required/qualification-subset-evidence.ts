/**
 * 任职资格子集策略（R3-T02 C1-1）的 F-039 证据片段：personnel.ts（HR 写入口、申请准入）与 approval.ts（同单重提）共用。
 */
import type { Evidence } from './types.js';

export const QL_POLICY = 'apps/api/src/modules/qualification/subset-policy.ts';
/**
 * 任职资格子集策略（R3-T02 C1-1）的证据：注册关系（常量 + 登记函数）与落地前复核里各道拦截的所在行。
 * 通用钩子证据只证明“钩子被调用”，策略里的拦截被删掉时它仍然成立，所以每道拦截单独带锚点。
 */
const QL_REGISTRATION: Evidence[] = [
  {
    role: 'impl',
    unit: `${QL_POLICY}#installQualificationSubsetPolicy`,
    anchor: "registerSubsetPolicy('qualification', QUALIFICATION_POLICY)",
  },
  {
    role: 'const',
    unit: `${QL_POLICY}#QUALIFICATION_POLICY`,
    anchor: 'beforeRequest: qualificationBeforeRequest, beforeSave: qualificationBeforeSave',
  },
];
export const QL_SAVE = (anchor: string): Evidence => ({
  role: 'impl',
  unit: `${QL_POLICY}#qualificationBeforeSave`,
  anchor,
});
/** 落地前复核里的拦截：自助落地、SW74 锁、新引用校验（三者都在 qualificationBeforeSave）。 */
export const QL_SAVE_EVIDENCE: Evidence[] = [
  ...QL_REGISTRATION,
  QL_SAVE("if (source.type === 'self_service') throw SELF_SERVICE_CLOSED();"),
  QL_SAVE('if (human && before?.isAutoSync === true) await assertAutoSyncEditable(tx, ctx);'),
  {
    role: 'impl',
    unit: `${QL_POLICY}#assertAutoSyncEditable`,
    anchor: "reason: 'QUALIFICATION_SUBSET_LOCKED'",
  },
  QL_SAVE('if (human) await assertRefs(tx, ctx, newRefs(before, row));'),
];
/** 申请准入（首次提交与同单重提共用）：一律拒绝。 */
export const QL_REQUEST_EVIDENCE: Evidence[] = [
  ...QL_REGISTRATION,
  { role: 'impl', unit: `${QL_POLICY}#qualificationBeforeRequest`, anchor: 'throw SELF_SERVICE_CLOSED();' },
];
