/**
 * F-476 P4 验收夹具：任职 / 离退类审批的「办理人已办 → 人事事后改单」场景。
 * 流程只有一个指定审批人节点（审批人 A）：HR 发起并提交 → A 驳回（办理份在此时冻结）→ HR 在驳回态改单。
 * 此后 A 读三个人事详情入口（任职业务 / 离职 / 退休）应读到办理时的值；HR（发起人）读现值。
 * 内容用 ZZ_ 前缀的合成文本；断言只看业务字段值与 contentView，不依赖办理份内部形状。
 */
import { randomUUID } from 'node:crypto';
import { runEmploymentActivations } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { APPROVAL_TYPES, MODULE_OBJECTS } from '@italent/domain';
import { expect } from 'vitest';
import {
  approvalWorld,
  grantVisibleFields,
  permissionAdmin,
  type ApprovalWorld,
  type Person,
} from './AC-APV-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { installProbationSeeds, loginEmailOf } from './AC-EMP-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

export const EMP = '/api/tenant/employment';
export const BEFORE = 'ZZ_办理时';
export const AFTER = 'ZZ_改后';

export type ScenarioKind = 'transfer' | 'hire' | 'regularization' | 'intern_regularization' | 'leave' | 'retirement';
export const EXIT_KINDS: readonly ScenarioKind[] = ['leave', 'retirement'];

export interface Scene {
  w: ApprovalWorld;
  kind: ScenarioKind;
  approver: Person;
  subjectId: string;
  /** 退休单的交接人（办理时 / 改单后）；其余类型为空串。 */
  handover: { before: string; after: string };
  businessId: string;
  instanceId: string;
  /** 被办理人所在部门（真实授权器夹具的数据范围用）。 */
  departmentId: string;
  /** 合成自定义字段编号（SceneOptions.customField 打开时才有）；审批 / 字段权编码是 `custom:<id>`，存储键是裸 id。 */
  customFieldId: string | null;
}

/** 详情响应体里本片断言用到的字段（其余字段按未知处理）。 */
export interface Body {
  status?: string;
  record?: unknown;
  fields?: Record<string, unknown>;
  employerName?: unknown;
  handoverEmployeeId?: unknown;
  contentView?: { mode: string };
  [key: string]: unknown;
}

/** 三个人事详情入口的读取结果（状态码 + 响应体）。 */
export interface Reads {
  business: { status: number; body: Body };
  exit: { status: number; body: Body };
  retirement: { status: number; body: Body };
}

/** 业务字段 → 各入口里的“可辨认值”。任职类用地点（fields.place），离退类用扩展行的 employerName。 */
export const markerOf = (kind: ScenarioKind, reads: Reads): unknown =>
  kind === 'leave'
    ? reads.exit.body.employerName
    : kind === 'retirement'
      ? reads.retirement.body.handoverEmployeeId
      : reads.business.body.fields?.place;

const createBody = (
  kind: ScenarioKind,
  dept: string,
  subject: { employeeId: string },
  handover: string,
  extra: Record<string, unknown> = {},
  customFieldId: string | null = null,
) => {
  const base = {
    mode: 'application',
    fields: { departmentId: dept, place: BEFORE },
    ...(customFieldId ? { customFields: { [customFieldId]: BEFORE } } : {}),
  };
  switch (kind) {
    case 'hire':
      return { ...base, kind, effectiveDate: '2026-10-05', loginEmail: loginEmailOf(subject.employeeId) };
    case 'leave':
      return {
        mode: 'application',
        lastWorkDate: '2026-10-20',
        exit: { exitTypeCode: 'voluntary', employerName: BEFORE, ...extra },
      };
    case 'retirement':
      return { mode: 'application', lastWorkDate: '2026-10-20', exit: { handoverEmployeeId: handover, ...extra } };
    case 'regularization':
      return { ...base, kind, effectiveDate: '2026-10-05', probationResult: 'normal' };
    case 'intern_regularization':
      return { ...base, kind, effectiveDate: '2026-10-05', probation: false };
    default:
      return { ...base, kind, effectiveDate: '2026-10-05' };
  }
};

/** 创建入口：离职 / 退休走专用入口（请求体不带 kind），其余走通用任职业务入口。 */
const createPath = (kind: ScenarioKind, employeeId: string) =>
  kind === 'leave'
    ? `${EMP}/exits/employees/${employeeId}`
    : kind === 'retirement'
      ? `${EMP}/retirements/employees/${employeeId}`
      : `${EMP}/employees/${employeeId}/businesses`;

const patchBody = (kind: ScenarioKind, handover: string, customFieldId: string | null) =>
  kind === 'leave'
    ? { employerName: AFTER }
    : kind === 'retirement'
      ? { handoverEmployeeId: handover }
      : { fields: { place: AFTER }, ...(customFieldId ? { customFields: { [customFieldId]: AFTER } } : {}) };

const patchPath = (kind: ScenarioKind, id: string) =>
  kind === 'leave'
    ? `${EMP}/exits/${id}`
    : kind === 'retirement'
      ? `${EMP}/retirements/${id}`
      : `${EMP}/businesses/${id}`;

/** 被办理人：入职 = 尚无任职的人员；转正 = 试用中的在职人员；实习转正 = 实习生；其余 = 在职人员。 */
async function subjectOf(w: ApprovalWorld, kind: ScenarioKind, dept: string): Promise<string> {
  if (kind === 'hire') return (await w.employee('待入职员工')).id;
  if (kind === 'intern_regularization') return (await w.person('实习员工', dept, { employType: 'intern' })).employeeId;
  if (kind !== 'regularization') return (await w.person('任职员工', dept)).employeeId;
  const created = await w.employee('试用员工');
  const hired = await w.request(w.hr.id, 'POST', `${EMP}/employees/${created.id}/businesses`, {
    ifMatch: 1,
    body: {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      probation: true,
      loginEmail: loginEmailOf(created.id),
      fields: { departmentId: dept },
    },
  });
  expect(hired.status, await hired.clone().text()).toBe(201);
  return created.id;
}

/** 直接调动（不走审批）：给被办理人留一条更早的任职记录。 */
async function directTransfer(w: ApprovalWorld, employeeId: string, at: { place: string; effectiveDate: string }) {
  const employee = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `${EMP}/employees/${employeeId}`),
  );
  const response = await w.request(w.hr.id, 'POST', `${EMP}/employees/${employeeId}/businesses`, {
    ifMatch: employee.revision,
    body: { kind: 'transfer', mode: 'direct', effectiveDate: at.effectiveDate, fields: { place: at.place } },
  });
  expect(response.status, await response.clone().text()).toBe(201);
}

/** 审批人节点的表单字段：审批人只看本节点表单里的字段（DEC-057），默认放开用例要对比的那个字段。 */
const defaultNodeForm = (kind: ScenarioKind): readonly string[] =>
  kind === 'leave'
    ? ['lastWorkDate', 'exitTypeCode', 'employerName']
    : kind === 'retirement'
      ? ['lastWorkDate', 'handoverEmployeeId']
      : ['effectiveDate', 'departmentId', 'place'];

export interface SceneOptions {
  /** 审批人 A 的办理动作，缺省驳回（驳回态可改单）；approve = 通过但未到生效日（批准不等于生效）。 */
  action?: 'reject' | 'approve';
  /** 审批人 A 所在节点的表单字段（缺省见 defaultNodeForm）。 */
  nodeForm?: readonly string[];
  /** 追加到创建请求 exit 对象里的字段（离职 / 退休）。 */
  exit?: Record<string, unknown>;
  /** 提交前先给被办理人补一条直接调动记录（生效日、地点），作为本次调动的前驱。 */
  predecessor?: { place: string; effectiveDate: string };
  /** 建一个合成自定义字段并在申请里填值（仅任职类）：node = 并入审批人节点表单；hidden = 不并入。 */
  customField?: 'node' | 'hidden';
}

/** 建场景：发起 → 提交 → A 驳回；不改单（改单由 changeAfterHandled 单独做，便于测“办理后”时点）。 */
export async function handledScene(
  db: Parameters<typeof approvalWorld>[0],
  label: string,
  kind: ScenarioKind,
  options: SceneOptions = {},
): Promise<Scene> {
  const w = await approvalWorld(db, label);
  if (EXIT_KINDS.includes(kind)) await installExitSeeds(db, w.tenant.id);
  if (kind === 'regularization') await installProbationSeeds(db, w.tenant.id);
  const dept = await w.org('合成部门');
  const approver = await w.person('审批人A', dept);
  const customFieldId = options.customField ? await createCustomField(w) : null;
  const code = APPROVAL_TYPES[kind].defaultProcessCode;
  await w.publishedProcess({
    approvalType: kind,
    conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: code }] },
    nodes: [
      {
        key: 'review',
        name: '审核',
        approver: { type: 'specified', value: approver.userId },
        formFields: [
          ...(options.nodeForm ?? defaultNodeForm(kind)),
          ...(customFieldId && options.customField === 'node' ? [`custom:${customFieldId}`] : []),
        ],
      },
    ],
  });
  const subjectId = await subjectOf(w, kind, dept);
  const handover = {
    before: kind === 'retirement' ? (await w.person('交接人甲', dept)).employeeId : '',
    after: kind === 'retirement' ? (await w.person('交接人乙', dept)).employeeId : '',
  };
  if (options.predecessor) await directTransfer(w, subjectId, options.predecessor);
  const current = await w.json<{ revision: number }>(await w.request(w.hr.id, 'GET', `${EMP}/employees/${subjectId}`));
  const created = await w.json<{ id: string; revision: number }>(
    await w.request(w.hr.id, 'POST', createPath(kind, subjectId), {
      ifMatch: current.revision,
      body: createBody(kind, dept, { employeeId: subjectId }, handover.before, options.exit, customFieldId),
    }),
    201,
  );
  const view = await w.submit(created);
  const task = w.pending(view)[0]!;
  const action = options.action ?? 'reject';
  const done = await w.taskAction(approver.userId, task.id, action, view.revision, { comment: '合成意见' });
  expect(done.status, await done.clone().text()).toBe(200);
  return {
    w,
    kind,
    approver,
    subjectId,
    handover,
    businessId: created.id,
    instanceId: view.id,
    departmentId: dept,
    customFieldId,
  };
}

async function createCustomField(w: ApprovalWorld): Promise<string> {
  const created = await w.json<{ id: string }>(
    await w.request(w.hr.id, 'POST', `${EMP}/custom-fields`, {
      ifMatch: 0,
      body: { name: '合成自定义字段', valueType: 'text', objectType: 'employment' },
    }),
    201,
  );
  return created.id;
}

/** 发起人在驳回态下改单（审批人 A 已办理）：把可辨认值从 BEFORE 改成 AFTER。 */
export async function changeAfterHandled(scene: Scene): Promise<void> {
  const { w, kind, businessId } = scene;
  const current = await w.business(businessId);
  const response = await w.request(w.hr.id, 'PATCH', patchPath(kind, businessId), {
    ifMatch: current.revision,
    body: patchBody(kind, scene.handover.after, scene.customFieldId),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** 发起人在驳回态下把最后工作日改到别的日子（离职 / 退休）。 */
export async function changeLastWorkDate(scene: Scene, lastWorkDate: string): Promise<void> {
  const { w, kind, businessId } = scene;
  const current = await w.business(businessId);
  const response = await w.request(w.hr.id, 'PATCH', patchPath(kind, businessId), {
    ifMatch: current.revision,
    body: { lastWorkDate },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** 业务批准后到生效日由定时任务落地（审批通过 ≠ 生效）。 */
export async function activateOn(scene: Scene, day: string): Promise<void> {
  const run = await runEmploymentActivations(
    scene.w.db,
    cmd(),
    { tenantId: scene.w.tenant.id },
    { clock: () => new Date(`${day}T01:00:00.000Z`) },
  );
  expect(run.runs[0]?.activated.length, JSON.stringify(run)).toBeGreaterThan(0);
}

const read = async (scene: Scene, user: string, path: string) => {
  const response = await scene.w.request(user, 'GET', path);
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Body) : {} };
};

/** 某人读三个人事详情入口。 */
export async function readsBy(scene: Scene, user: string): Promise<Reads> {
  const id = scene.businessId;
  return {
    business: await read(scene, user, `${EMP}/businesses/${id}`),
    exit: await read(scene, user, `${EMP}/exits/${id}`),
    retirement: await read(scene, user, `${EMP}/retirements/${id}`),
  };
}

export type Entry = 'business' | 'exit' | 'retirement' | 'inFlight';
export type Result = { status: number; body: Body };
type Fetcher = (user: string, path: string) => Promise<Response>;

const entryPath = (scene: Scene, entry: Entry): string =>
  ({
    business: `${EMP}/businesses/${scene.businessId}`,
    exit: `${EMP}/exits/${scene.businessId}`,
    retirement: `${EMP}/retirements/${scene.businessId}`,
    inFlight: `${EMP}/retirements/employees/${scene.subjectId}/in-flight`,
  })[entry];

/** 本类型的人事详情入口（含退休的员工在途入口）。 */
export const detailEntries = (kind: ScenarioKind): Entry[] =>
  kind === 'leave'
    ? ['business', 'exit']
    : kind === 'retirement'
      ? ['business', 'retirement', 'inFlight']
      : ['business'];

/** 读若干入口；在途入口的响应体是 `{ item }`，这里取出 item 方便与详情同形比较。 */
export async function readEntries(
  scene: Scene,
  user: string,
  entries: readonly Entry[] = detailEntries(scene.kind),
  fetcher: Fetcher = (who, path) => scene.w.request(who, 'GET', path),
): Promise<Partial<Record<Entry, Result>>> {
  const result: Partial<Record<Entry, Result>> = {};
  for (const entry of entries) {
    const response = await fetcher(user, entryPath(scene, entry));
    const text = await response.text();
    const raw = text ? (JSON.parse(text) as Body) : {};
    const item = entry === 'inFlight' && response.status === 200 ? ((raw.item as Body | null) ?? {}) : raw;
    result[entry] = { status: response.status, body: item };
  }
  return result;
}

/**
 * 真实授权器夹具：与 allowAll 的 `scene.w.request` 并存，另起一个不注入授权器的应用；
 * 读者的对象 / 字段权限走权限模块的身份，数据范围走管理单元（permission_mous）挂到“用户 × 应用”。
 */
export async function realWorld(scene: Scene) {
  const { w } = scene;
  const world = await permissionAdmin(w);
  const api = tenantApi(w.db, { authorize: undefined, clock: w.clock });
  const mous = new Map<string, string>();
  const codes = (definition: { fields: readonly { code: string }[] }) => definition.fields.map((f) => f.code);
  return {
    /** 授予人事对象与人员对象的全部字段查看权（只有对象 / 字段权，不含数据范围）。 */
    async grantRead(userId: string) {
      await grantVisibleFields(world, userId, codes(MODULE_OBJECTS.employmentRecord));
      await grantVisibleFields(world, userId, codes(MODULE_OBJECTS.employee), MODULE_OBJECTS.employee);
    },
    /** contains = 范围含被办理人所在部门；empty = 范围为空（管理单元停用）。 */
    async setScope(userId: string, mode: 'contains' | 'empty') {
      await withTenant(w.db, w.tenant.id, async (tx) => {
        const known = mous.get(userId);
        if (known) {
          await tx.execute(sql`UPDATE permission_mous SET status=${mode === 'contains' ? 'active' : 'disabled'}
            WHERE tenant_id=${w.tenant.id} AND id=${known}::uuid`);
          return;
        }
        if (mode === 'empty') return;
        const mou = randomUUID();
        await tx.execute(sql`INSERT INTO permission_mous(id,tenant_id,code,name)
          VALUES (${mou}::uuid,${w.tenant.id},${`P4_${mou.slice(0, 8)}`},'合成管理单元')`);
        await tx.execute(sql`INSERT INTO permission_mou_org_refs(tenant_id,mou_id,org_id,include_descendants)
          VALUES (${w.tenant.id},${mou}::uuid,${scene.departmentId}::uuid,true)`);
        await tx.execute(sql`INSERT INTO permission_user_app_scopes(tenant_id,user_id,app_code,kind,mou_id)
          VALUES (${w.tenant.id},${userId}::uuid,'TenantBase','mou',${mou}::uuid)`);
        mous.set(userId, mou);
      });
    },
    fetch: ((user, path) => api.request('GET', path, { user, tenant: w.tenant.id })) satisfies Fetcher,
  };
}

/**
 * 对办理份做“当前完整性故障”注入（新写的办理份局部缺损）：绕开只增表的触发器，直接改 JSON。
 * invalid = 把该路径改成一个不是日期、也不是对象 / 数组的字符串（结构与日期格式都不合法）。
 */
export type Damage = 'remove' | 'null' | 'invalid';
const DAMAGED_VALUE = '"ZZ_非法值"';
export async function damageCopy(scene: Scene, damage: Damage, path: readonly string[]): Promise<void> {
  const { w, approver } = scene;
  const target = `{${path.join(',')}}`;
  await w.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${w.tenant.id}, true)`);
    await tx.execute(sql`ALTER TABLE approval_handling_contents DISABLE TRIGGER USER`);
    await tx.execute(
      damage === 'remove'
        ? sql`UPDATE approval_handling_contents SET content = content #- ${target}::text[]
            WHERE actor_user_id = ${approver.userId}::uuid`
        : sql`UPDATE approval_handling_contents
            SET content = jsonb_set(content, ${target}::text[], ${damage === 'null' ? 'null' : DAMAGED_VALUE}::jsonb)
            WHERE actor_user_id = ${approver.userId}::uuid`,
    );
    await tx.execute(sql`ALTER TABLE approval_handling_contents ENABLE TRIGGER USER`);
  });
}

/** 入口只对本类型有效：任职类走 business，离职走 exit（同时也能走 business），退休走 retirement（同时也能走 business）。 */
export const entriesOf = (kind: ScenarioKind): (keyof Reads)[] =>
  kind === 'leave' ? ['business', 'exit'] : kind === 'retirement' ? ['business', 'retirement'] : ['business'];

/** 办理份读取（只经 withTenant，app_owner + FORCE RLS 下可用）。 */
export async function copyTexts(scene: Scene): Promise<string[]> {
  const { w, instanceId } = scene;
  return withTenant(w.db, w.tenant.id, async (tx) =>
    resultRows<{ text: string }>(
      await tx.execute(sql`SELECT content::text AS text FROM approval_handling_contents
        WHERE instance_id = ${instanceId}::uuid ORDER BY acted_at`),
    ).map((row) => row.text),
  );
}

/** 办理时 / 改单后各入口应读到的可辨认值。 */
export const expectedMarker = (scene: Scene, phase: 'before' | 'after'): string =>
  scene.kind === 'retirement' ? scene.handover[phase] : phase === 'before' ? BEFORE : AFTER;
