/**
 * F-326 S7b 浏览器集成专用：全新隔离数据库、合成数据、真实审批路由、真实权限快照与真实授权；不连接开发库。
 * 种子经 S7a 验收夹具造数（指定人员落成自动公共变量）：
 * - echo：草稿两个单人节点，n1 指定“合成乙”，n2 已选指定人员未选人（发布被“指定人员未选择”拒）；
 * - pending：已发布流程的新草稿把 n2 改成“合成待改选人”（记待生效值），随后变量页把同一变量改成“合成变量页改的人”，
 *   发布时 409 待生效冲突。
 * 流程对象编辑身份的授予沿用 F3 夹具（f326f3-live-backend）的做法。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  autoAt,
  create,
  draftOk,
  editVariable,
  newVersion,
  placeholder,
  s4World,
  specified,
  varRow,
  type S4World,
} from '../../../tests/acceptance/AC-APV-F326-S7a-support.js';
import type { NodeInput } from '../../../tests/acceptance/AC-APV-support.js';
import { createTestDb } from '../../../packages/testkit/src/test-db.js';
import { createPermissionAuthorizer } from '../../../apps/api/src/modules/permission/authorizer.js';
import { objectCatalog } from '../../../apps/api/src/modules/permission/catalog.js';
import { permissionAdmin } from '../../../tests/acceptance/AC-APV-support.js';
import { createProfile, grant, makeGrantable, setObjectPermission } from '../../../tests/acceptance/AC-PRM-support.js';
import { tenantApi } from '../../../tests/acceptance/support/tenant-api.js';

const SKIPPED = new Set(['host', 'connection', 'content-length', 'content-type', 'cookie', 'origin', 'referer']);
const forwarded = (key: string) => !SKIPPED.has(key) && !key.startsWith('sec-') && key !== 'x-smoke-user';
const single = (key: string, name: string, approver: NodeInput['approver']): NodeInput => ({ key, name, approver });

async function bodyOf(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as unknown) : undefined;
}

async function seed(db: Parameters<typeof s4World>[0]) {
  const w = await s4World(db, 'S7b');
  const echo = await create(w, [
    single('n1', '合成上级审批', specified(w.near.userId)),
    single('n2', '合成人事审批', placeholder),
  ]);
  const later = await w.person('合成待改选人', w.staff);
  const other = await w.person('合成变量页改的人', w.staff);
  const published = await w.publish(
    await create(w, [
      single('n1', '合成上级审批', specified(w.head.userId)),
      single('n2', '合成人事审批', specified(w.near.userId)),
    ]),
  );
  const x = await autoAt(w, published.id, 'n2');
  const draft = await newVersion(w, published);
  const pending = await draftOk(w, draft, [
    single('n1', '合成上级审批', specified(w.head.userId)),
    single('n2', '合成人事审批', specified(later.userId)),
  ]);
  const edited = await editVariable(w, await varRow(w, x.id), { defaultValue: other.userId });
  if (edited.status !== 200) throw new Error(`variable edit failed ${edited.status}: ${await edited.text()}`);
  await grantProcessEditor(w);
  return { w, processes: { echo: echo.id, pending: pending.id }, variable: x.code };
}

/** 同 F3 夹具：流程管理员 + 流程对象身份权限（含 publish 详情按钮），经真实权限接口授予。 */
async function grantProcessEditor(w: S4World) {
  const world = await permissionAdmin(w);
  const definition = objectCatalog.get('TenantBase.ApprovalProcess')!;
  const profile = await createProfile(world, `s7b${w.tenant.id.slice(0, 8)}`);
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

export async function startAutoVariableBackend() {
  const handle = await createTestDb();
  try {
    const { w, processes, variable } = await seed(handle.db);
    const serve = handler(handle.db, w);
    const server = createServer((req, res) => {
      serve(req, res).catch((error: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`F326S7b test backend failed: ${String(error)}`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      manifest: {
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        tenant: w.tenant.id,
        admin: w.hr.id,
        processes,
        variable,
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
