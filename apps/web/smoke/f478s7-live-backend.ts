/**
 * F-478 S7 浏览器集成专用：全新隔离数据库、合成数据（邮箱 example.com）、真实审批定义 / 办理路由；不连接开发库。
 * - 两个退休场景（返聘 / 不返聘各一张单据，已推进到 HRBP 节点），流程经真实 HTTP 保存业务出口与分支后发布；
 * - 返聘场景的 HR 开通租户管理员并授予流程对象全部权限，真实权限快照驱动设计器可编辑；每个设计器用例各用一张草稿，互不干扰；
 * - 维度用例的草稿在业务维度启用时合法保存了业务组织引用，建好后关闭业务维度（行政组织不受影响，其余用例不用扩展维度）。
 * 身份按代理传入的 x-smoke-user 签名；唯一的控制口 /__smoke/revoke 只把合成指定审批人的租户成员资格置为 revoked。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { sql, withTenant } from '@italent/db';
import { APPROVAL_OBJECTS, APPROVAL_PROCESS_OBJECT, MAX_ROUTE_CONDITION_ITEMS } from '@italent/domain';
import { permissionAdmin, type NodeInput, type ProcessView } from '../../../tests/acceptance/AC-APV-support.js';
import { createProfile, grant, makeGrantable, setObjectPermission } from '../../../tests/acceptance/AC-PRM-support.js';
import { cloneForPut, putDraft, withRoutesOn } from '../../../tests/acceptance/AC-APV-F478-s2-support.js';
import { dimensions, orgVersion } from '../../../tests/acceptance/AC-APV-F318c-support.js';
import { retireScene, type RetireScene } from '../../../tests/acceptance/AC-APV-F478-s4-support.js';
import { uniqueSuffix } from '../../../tests/acceptance/support/unique.js';
import { createTestDb } from '../../../packages/testkit/src/test-db.js';

// 只转发业务头；浏览器的来源类头（origin / referer / sec-fetch-*）不进测试应用，身份由 x-smoke-user 重新签名
const SKIPPED = new Set(['host', 'connection', 'content-length', 'content-type', 'cookie', 'origin', 'referer']);
const forwarded = (key: string) => !SKIPPED.has(key) && !key.startsWith('sec-') && key !== 'x-smoke-user';
const loose = { avoidSelf: false, avoidSubjects: false };
const PROCESS = APPROVAL_OBJECTS.find((object) => object.code === APPROVAL_PROCESS_OBJECT)!;

async function bodyOf(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as unknown) : undefined;
}

/** 退休流程（与 AC-APV-F478-09 同形，节点取可读名称）：HRBP 面谈两个业务出口，不返聘 → 结束，返聘 → 返聘后经理。 */
async function publishRetireFlow(s: RetireScene) {
  const nodes: NodeInput[] = [
    { key: 'direct_head', name: '直线经理审批', approver: { type: 'object_field', value: 'direct_manager' } },
    {
      key: 'hr_interview',
      name: 'HRBP面谈',
      approver: { type: 'department', value: 'record_department_hrbp' },
      exits: ['approve_no_rehire', 'approve_rehire'],
    },
    {
      key: 'rehire_manager',
      name: '返聘后经理确认',
      approver: { type: 'department', value: 'record_department_head' },
    },
  ].map((node) => ({ ...node, actions: loose }) as NodeInput);
  const created = await s.w.createProcess({
    name: '合成退休流程',
    approvalType: 'retirement',
    conditions: { items: [] },
    isFallback: true,
    nodes,
  });
  const routes = {
    hr_interview: [
      { exit: 'approve_no_rehire', branches: [{ kind: 'direct', target: 'END' }] },
      { exit: 'approve_rehire', branches: [{ kind: 'direct', target: 'rehire_manager' }] },
    ],
  };
  const body = cloneForPut(created.latestVersion, {
    nodes: withRoutesOn(created.latestVersion.nodes, routes as never),
  });
  return s.w.publish(await s.w.json<ProcessView>(await putDraft(s.w, created, body)));
}

/** 退休单推进到 HRBP 节点（直线经理先同意）。 */
async function retireAtHrbp(db: Parameters<typeof retireScene>[0], label: string, reEmployed: boolean) {
  const s = await retireScene(db, label);
  await publishRetireFlow(s);
  const view = await s.advance(await s.retire(reEmployed));
  const task = s.w.pending(view)[0]!;
  if (task.nodeKey !== 'hr_interview') throw new Error(`退休单未停在 HRBP 节点：${task.nodeKey}`);
  return { s, instanceId: view.id, hrbp: task.assigneeUserId };
}

/** 设计器操作人：租户管理员（含流程矩阵菜单）+ 流程对象全部数据操作、字段与按钮。 */
async function designerAdmin(s: RetireScene) {
  const world = await permissionAdmin(s.w);
  const profile = await createProfile(world, `f478s7${uniqueSuffix()}`);
  const response = await setObjectPermission(
    world,
    profile,
    {
      dataOperations: { create: true, update: true, delete: true },
      fields: PROCESS.fields.map((field) => ({ fieldCode: field.code, view: true, edit: !field.system })),
      buttons: PROCESS.buttons.map((button) => ({ buttonCode: button.code, level: button.level })),
    },
    APPROVAL_PROCESS_OBJECT,
  );
  if (response.status !== 200) throw new Error(`流程对象授权失败 ${response.status}: ${await response.text()}`);
  await makeGrantable(world, [profile.id]);
  const granted = await grant(world, s.w.hr.id, profile.id);
  if (granted.status !== 201) throw new Error(`授予身份失败 ${granted.status}: ${await granted.text()}`);
}

type Approver = NonNullable<NodeInput['approver']>;
const NAMES = ['合成首节点', '合成次节点', '合成末节点'];
const head: Approver = { type: 'department', value: 'record_department_head' };
const FIXED: Approver[] = [
  { type: 'object_field', value: 'direct_manager' },
  { type: 'department', value: 'record_department_hrbp' },
  head,
];
/** 三节点调动草稿（未发布）：各设计器用例各用一张，互不干扰；approvers 依次是三个节点的审批人。 */
async function designerDraft(s: RetireScene, name: string, approvers = FIXED) {
  const nodes = approvers.map(
    (approver, index) => ({ key: `n${index + 1}`, name: NAMES[index]!, approver, actions: loose }) as NodeInput,
  );
  return s.w.createProcess({ name, nodes });
}

/**
 * 422 不猜定位的前置：首节点是固定表达式“任职记录—部门负责人”，次节点（及多引用用例的末节点）引用业务组织；
 * 业务维度关闭后保存，真实 assertSourceReferences 返回 APPROVAL_SOURCE_DIMENSION_DISABLED。
 */
async function dimensionDrafts(s: RetireScene) {
  await dimensions(s.w);
  const org = await s.w.org('合成业务组织');
  await orgVersion(s.w, org, {}, { business: s.w.tenant.id });
  const business: Approver = { type: 'business_org', value: org };
  const manager = FIXED[0]!;
  const drafts = {
    dimensionLater: (await designerDraft(s, '合成维度关闭流程', [head, business, manager])).id,
    dimensionEdited: (await designerDraft(s, '合成维度关闭改来源流程', [head, business, manager])).id,
    dimensionAmbiguous: (await designerDraft(s, '合成维度关闭多引用流程', [head, business, business])).id,
  };
  await dimensions(s.w, false);
  return drafts;
}

/** 条件编号用例的前置：首节点同意出口已有一条满 MAX_ROUTE_CONDITION_ITEMS 个条件（编号 1～上限）的条件分支 + Else。 */
async function fullConditionDraft(s: RetireScene) {
  const created = await designerDraft(s, '合成满条件流程');
  const items = Array.from({ length: MAX_ROUTE_CONDITION_ITEMS }, (_, index) => ({
    no: index + 1,
    field: 'business.kind',
    operator: 'ne',
    value: `合成${index + 1}类`,
  }));
  const condition = { expression: items.map((item) => item.no).join(' and '), items };
  const routes = {
    n1: [
      {
        exit: 'approve',
        branches: [
          { kind: 'condition', priority: 1, conditions: condition, target: 'n3' },
          { kind: 'else', target: 'n2' },
        ],
      },
    ],
  };
  const body = cloneForPut(created.latestVersion, {
    nodes: withRoutesOn(created.latestVersion.nodes, routes as never),
  });
  await s.w.json<ProcessView>(await putDraft(s.w, created, body));
  return created.id;
}

async function seed(db: Parameters<typeof retireScene>[0]) {
  const rehire = await retireAtHrbp(db, 'f478s7-rehire', true);
  const plain = await retireAtHrbp(db, 'f478s7-norehire', false);
  await designerAdmin(rehire.s);
  const specified = await rehire.s.w.person('合成指定审批人', rehire.s.home.id);
  const processes = {
    sources: (await designerDraft(rehire.s, '合成来源流程')).id,
    branches: (await designerDraft(rehire.s, '合成分支流程')).id,
    routeError: (await designerDraft(rehire.s, '合成分支报错流程')).id,
    sourceError: (await designerDraft(rehire.s, '合成来源报错流程')).id,
    conditionSlots: await fullConditionDraft(rehire.s),
    ...(await dimensionDrafts(rehire.s)),
  };
  return { rehire, plain, specified, processes };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** AC-APV-F478-26 的 422 前置：设计器已选的指定审批人被撤销成员资格（真实 assertFallbackUsers 拒绝）。 */
async function revoke(world: Seeded, userId: string) {
  const { w } = world.rehire.s;
  if (userId !== world.specified.userId) throw new Error('只允许撤销合成指定审批人');
  await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`UPDATE tenant_memberships SET status='revoked'
      WHERE tenant_id=${w.tenant.id} AND user_id=${userId}::uuid`),
  );
}

function handler(world: Seeded) {
  const worlds = new Map([world.rehire, world.plain].map((item) => [item.s.w.tenant.id, item.s.w]));
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    const body = await bodyOf(req);
    if (req.method === 'POST' && url.pathname === '/__smoke/revoke') {
      await revoke(world, (body as { userId: string }).userId);
      res.writeHead(204);
      res.end();
      return;
    }
    const tenant = String(req.headers['x-tenant-id'] ?? '');
    const w = worlds.get(tenant);
    if (!w) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'FORBIDDEN', message: '未知合成租户' } }));
      return;
    }
    const headers = Object.fromEntries(
      Object.entries(req.headers).flatMap(([key, value]) =>
        forwarded(key) && typeof value === 'string' ? [[key, value]] : [],
      ),
    );
    const user = String(req.headers['x-smoke-user'] ?? '');
    const response = await w.request(user, req.method!, `${url.pathname}${url.search}`, {
      headers,
      body,
      idempotencyKey: null,
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}

const persona = (tenant: string, userId: string) => ({ tenant, userId });

export async function startF478S7Backend() {
  const handle = await createTestDb();
  try {
    const world = await seed(handle.db);
    const serve = handler(world);
    const server = createServer((req, res) => {
      serve(req, res).catch((error: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`F478S7 test backend failed: ${String(error)}`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { rehire, plain } = world;
    const tenant = rehire.s.w.tenant.id;
    return {
      manifest: {
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        designer: { ...persona(tenant, rehire.s.w.hr.id), processes: world.processes },
        specified: { userId: world.specified.userId, name: '合成指定审批人' },
        rehire: { hrbp: persona(tenant, rehire.hrbp), instanceId: rehire.instanceId },
        plain: { hrbp: persona(plain.s.w.tenant.id, plain.hrbp), instanceId: plain.instanceId },
      },
      async close() {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await handle.close();
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
