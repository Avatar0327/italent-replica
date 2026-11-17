/**
 * F-326 F3 浏览器集成专用：全新隔离数据库、合成数据、真实审批路由、真实权限快照与真实授权；不连接开发库。
 * 种子经 S4 验收夹具造数：公共人员 / 多人变量、调动应用的应用变量、单人与允许多人两张矩阵；
 * 三个调动流程草稿（单人节点）、一个调动流程草稿（两行来源的会签节点）与一个 Offer 流程草稿（多主体类型，矩阵不可选）。夹具 HR 引导为租户管理员并授予流程对象编辑身份后，
 * 浏览器流量走另一个应用实例的真实授权器（createPermissionAuthorizer）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  matrix,
  s4World,
  saveNodes,
  variable,
  varSource,
  type S4World,
} from '../../../tests/acceptance/AC-APV-F326-S4-support.js';
import { createTestDb } from '../../../packages/testkit/src/test-db.js';
import { createPermissionAuthorizer } from '../../../apps/api/src/modules/permission/authorizer.js';
import { objectCatalog } from '../../../apps/api/src/modules/permission/catalog.js';
import { permissionAdmin } from '../../../tests/acceptance/AC-APV-support.js';
import { createProfile, grant, makeGrantable, setObjectPermission } from '../../../tests/acceptance/AC-PRM-support.js';
import { tenantApi } from '../../../tests/acceptance/support/tenant-api.js';

// 只转发业务头；浏览器的来源类头不进测试应用，身份由 x-smoke-user 重新签名
const SKIPPED = new Set(['host', 'connection', 'content-length', 'content-type', 'cookie', 'origin', 'referer']);
const forwarded = (key: string) => !SKIPPED.has(key) && !key.startsWith('sec-') && key !== 'x-smoke-user';

async function bodyOf(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as unknown) : undefined;
}

async function created(response: Response) {
  if (response.status !== 201) throw new Error(`process save failed ${response.status}: ${await response.text()}`);
  return ((await response.json()) as { id: string }).id;
}

async function seed(db: Parameters<typeof s4World>[0]) {
  const w = await s4World(db, 'F3');
  const person = await variable(w, { codeSuffix: 'SmokePerson', name: '合成公共审批人' });
  const persons = await variable(w, {
    codeSuffix: 'SmokePersons',
    name: '合成公共多人',
    dataType: 'persons',
    defaultValue: [w.near.userId],
  });
  await variable(w, { scope: 'application', codeSuffix: 'SmokeApp', name: '合成调动对接人' });
  const single = await matrix(w, { rows: [{ cond: [], role: [w.near.userId] }], allowMultiple: false });
  const many = await matrix(w, { rows: [{ cond: [], role: [w.near.userId] }], allowMultiple: true });
  await rename(w, single.id, '合成单人矩阵');
  await rename(w, many.id, '合成多人矩阵');
  const approver = varSource('public_variable', person.id);
  // 每条冒烟各用一个流程草稿，用例之间不依赖执行顺序
  const draft = (approvalType = 'transfer') =>
    saveNodes(w, [{ key: 'n1', name: '合成单人节点', kind: 'single', approver }], approvalType).then(created);
  const processes = {
    display: await draft(),
    variables: await draft(),
    matrix: await draft(),
    offer: await draft('offer'),
    // P2-1：两行来源的会签节点，删除前一行后核对后一行的临时矩阵选择
    rows: await saveNodes(w, [
      {
        key: 'n1',
        name: '合成会签节点',
        kind: 'countersign',
        approvers: [approver, varSource('public_variable', persons.id)],
      },
    ]).then(created),
  };
  await grantProcessEditor(w);
  return { w, processes };
}

/**
 * 设计器可编辑 = 流程管理员 + 身份对象权限（编辑数据操作、详情级 update / newVersion 按钮、nodes 可编辑）；
 * 引导为租户管理员后经真实权限接口建身份并授予，不改授权器。
 */
async function grantProcessEditor(w: S4World) {
  const world = await permissionAdmin(w);
  const definition = objectCatalog.get('TenantBase.ApprovalProcess')!;
  const profile = await createProfile(world, `f3${w.tenant.id.slice(0, 8)}`);
  const set = await setObjectPermission(
    world,
    profile,
    {
      dataOperations: { create: true, update: true, delete: false },
      fields: definition.fields.map((f) => ({ fieldCode: f.code, view: true, edit: !f.system })),
      buttons: definition.buttons.map((b) => ({ buttonCode: b.code, level: b.level })),
    },
    definition.code,
  );
  if (set.status !== 200) throw new Error(`object permission failed ${set.status}: ${await set.text()}`);
  await makeGrantable(world, [profile.id]);
  const granted = await grant(world, w.hr.id, profile.id);
  if (granted.status !== 201) throw new Error(`profile grant failed ${granted.status}: ${await granted.text()}`);
}

/** 夹具矩阵统一叫“合成矩阵”；两级选择要区分两张，经真实元数据接口改名。 */
async function rename(w: S4World, id: string, name: string) {
  const path = `/api/tenant/approval/matrices/${id}`;
  const { revision } = await w.json<{ revision: number }>(await w.request(w.hr.id, 'GET', path));
  const patched = await w.request(w.hr.id, 'PATCH', path, { body: { revision, name } });
  if (patched.status !== 200) throw new Error(`matrix rename failed ${patched.status}: ${await patched.text()}`);
}

function handler(db: Parameters<typeof s4World>[0], w: S4World) {
  const live = tenantApi(db, { clock: w.clock, authorize: createPermissionAuthorizer(db, undefined, w.clock) });
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    const body = await bodyOf(req);
    const headers = Object.fromEntries(
      Object.entries(req.headers).flatMap(([key, value]) =>
        forwarded(key) && typeof value === 'string' ? [[key, value]] : [],
      ),
    );
    const response = await live.request(req.method!, `${url.pathname}${url.search}`, {
      user: String(req.headers['x-smoke-user'] ?? ''),
      tenant: w.tenant.id,
      headers,
      body,
      idempotencyKey: null,
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}

export async function startDesignerSourcesBackend() {
  const handle = await createTestDb();
  try {
    const { w, processes } = await seed(handle.db);
    const serve = handler(handle.db, w);
    const server = createServer((req, res) => {
      serve(req, res).catch((error: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`F326F3 test backend failed: ${String(error)}`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      manifest: {
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        tenant: w.tenant.id,
        admin: w.hr.id,
        processes,
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
