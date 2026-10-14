/**
 * F-048 PR-1 跨升级的命令重放（DEC-067「幂等」；PR #135 第 1 轮审查 P2）：升级前已入台账的流程新建 / 草稿保存命令，
 * 升级后按同键同内容重放必须返回首次结果（201 / 200），同键异内容仍报 409 IDEMPOTENCY_CONFLICT。
 * 新增的 avoidSubjectsResult / actions.avoidSubjects 不给时不得改变请求指纹。
 *
 * 历史台账夹具：下面两个 LEGACY_* 是升级前解析器（d6df303 的 createSchema / definitionSchema）对同一请求体的解析结果，
 * 原样冻结在这里；台账指纹按当时的格式（commands.ts commandHash）计算后写回，模拟升级前写入的台账行。
 */
import { createHash } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, type ApprovalWorld } from './AC-APV-support.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

const CREATE_BODY = {
  code: 'F048_REPLAY',
  name: 'F-048 升级前重放',
  approvalType: 'transfer',
  exceptionAdminUserId: null,
  conditions: { items: [] },
  nodes: [
    { key: 'n1', approver: 'owner', actions: { copySend: true } },
    { key: 'cs', kind: 'countersign', approvers: ['owner', 'record_department_head'] },
  ],
};

const DRAFT_BODY = {
  name: 'F-048 升级前草稿',
  exceptionAdminUserId: null,
  nodes: [{ key: 'n1', approver: 'owner', actions: { avoidSelf: true } }],
};

const LEGACY_NODE_TAIL = {
  exits: ['approve'],
  noAssignee: 'exception_admin',
  sameAssigneeSkip: false,
  historySameAssigneeSkip: false,
  sameAssigneeResult: 'approve',
  historySameAssigneeResult: 'approve',
  formFields: [],
  editableFields: [],
  editMode: 'none',
};
const LEGACY_ACTIONS = { transfer: false, addSign: false, copySend: false, retrieve: false, reject: true };
const LEGACY_NODE_END = {
  rejectCommentRequired: false,
  hideRecords: false,
  rejectResubmit: 'restart',
  messageRules: [],
};
const LEGACY_HEAD = {
  priority: 0,
  isFallback: false,
  exceptionAdminUserId: null,
  urgeEnabled: true,
  hideRecordsFromInitiator: false,
  conditions: { items: [], expression: '' },
};

/** 升级前 createSchema.parse(CREATE_BODY)（键顺序即当时的输出顺序，指纹按 JSON 序列化计算）。 */
const LEGACY_CREATE = {
  name: CREATE_BODY.name,
  ...LEGACY_HEAD,
  nodes: [
    {
      key: 'n1',
      kind: 'single',
      approver: 'owner',
      ...LEGACY_NODE_TAIL,
      actions: { ...LEGACY_ACTIONS, copySend: true, urge: 'inherit' },
      ...LEGACY_NODE_END,
    },
    {
      key: 'cs',
      kind: 'countersign',
      approvers: ['owner', 'record_department_head'],
      ...LEGACY_NODE_TAIL,
      actions: { ...LEGACY_ACTIONS, urge: 'inherit' },
      ...LEGACY_NODE_END,
    },
  ],
  code: CREATE_BODY.code,
  approvalType: CREATE_BODY.approvalType,
};

/** 升级前 definitionSchema.parse(DRAFT_BODY)。 */
const LEGACY_DRAFT = {
  name: DRAFT_BODY.name,
  ...LEGACY_HEAD,
  nodes: [
    {
      key: 'n1',
      kind: 'single',
      approver: 'owner',
      ...LEGACY_NODE_TAIL,
      actions: { ...LEGACY_ACTIONS, urge: 'inherit', avoidSelf: true },
      ...LEGACY_NODE_END,
    },
  ],
};

/** 升级前的台账指纹格式（apps/api/src/commands.ts commandHash 与审批路由的 fingerprint 结构）。 */
function legacyHash(userId: string, method: string, path: string, revision: number, input: unknown) {
  const fingerprint = { method, path, revision, input };
  return createHash('sha256').update(JSON.stringify({ userId, fingerprint })).digest('hex');
}

/** 可信夹具：把本租户某条台账的指纹改成升级前格式（连接角色、带租户上下文，真 PG 强制 RLS）。 */
async function rewriteLedgerHash(w: ApprovalWorld, commandId: string, requestHash: string) {
  await w.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${w.tenant.id}, true)`);
    await tx.execute(sql`UPDATE command_ledger SET request_hash=${requestHash}
      WHERE tenant_id=${w.tenant.id} AND command_id=${commandId}`);
  });
}

async function errorCode(response: Response) {
  return { status: response.status, code: ((await response.json()) as { error?: { code?: string } }).error?.code };
}

describe('F-048 跨升级重放：新建流程', () => {
  it('升级前入台账的新建命令，同键同内容重放 → 201 与首次结果相同；同键异内容 → 409', async () => {
    const w = await approvalWorld(database().db, 'f048-replay-create');
    const key = 'f048-legacy-create';
    const path = `${BASE}/processes`;
    const first = await w.json<object>(
      await w.request(w.hr.id, 'POST', path, { ifMatch: 0, idempotencyKey: key, body: CREATE_BODY }),
      201,
    );
    await rewriteLedgerHash(w, key, legacyHash(w.hr.id, 'POST', path, 0, LEGACY_CREATE));

    const replay = await w.request(w.hr.id, 'POST', path, { ifMatch: 0, idempotencyKey: key, body: CREATE_BODY });
    expect(await w.json<object>(replay, 201)).toEqual(first);

    const other = await w.request(w.hr.id, 'POST', path, {
      ifMatch: 0,
      idempotencyKey: key,
      body: { ...CREATE_BODY, name: '另一份内容' },
    });
    expect(await errorCode(other)).toEqual({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });
});

describe('F-048 跨升级重放：草稿保存', () => {
  it('升级前入台账的草稿保存命令，同键同内容重放 → 200 与首次结果相同；同键异内容 → 409', async () => {
    const w = await approvalWorld(database().db, 'f048-replay-draft');
    const created = await w.createProcess({ nodes: [{ key: 'n1', approver: 'owner' }] });
    const key = 'f048-legacy-draft';
    const path = `${BASE}/processes/${created.id}/draft`;
    const request = { ifMatch: created.revision, idempotencyKey: key, body: DRAFT_BODY };
    const first = await w.json<object>(await w.request(w.hr.id, 'PUT', path, request));
    await rewriteLedgerHash(w, key, legacyHash(w.hr.id, 'PUT', path, created.revision, LEGACY_DRAFT));

    expect(await w.json<object>(await w.request(w.hr.id, 'PUT', path, request))).toEqual(first);

    const other = await w.request(w.hr.id, 'PUT', path, {
      ...request,
      body: { ...DRAFT_BODY, nodes: [{ key: 'n1', approver: 'owner', actions: { avoidSelf: false } }] },
    });
    expect(await errorCode(other)).toEqual({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });
});
