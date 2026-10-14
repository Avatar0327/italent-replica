/**
 * 本地演示种子（F-025 + 演示数据种子第 1 段）：建一个演示租户，约 30 个组织、200 名员工、职务体系，
 * 以及在途 / 已完成 / 驳回 / 撤回的调动审批单，让 R1 各角色入口都有可看的数据。
 *
 * 分阶段、可恢复：租户开通 → 组织 → 职务体系 → 员工 → 授权 → 调动流程与调动单；每一阶段按自然键（组织编码、
 * 职务体系编码、工号、调动单的确定性命令 ID）先查后建，重复运行只补缺失，半途失败后再运行从缺失处继续（world.ts / transfers.ts）。
 * 租户开通走平台开通命令（R1-T17，与 POST /api/platform/tenants 同一实现）；其余业务数据一律走公开租户接口，
 * 使用真实权限授权器与签名开发身份（不注入“全部允许”），因此业务规则、审计与 outbox 和真实操作一致。
 */
import { randomUUID } from 'node:crypto';
import { createUser, type Db, eq, inArray, tenants, users, withPlatform } from '@italent/db';
import { provisionTenant } from '../modules/platform/provisioning.js';
import { createDemoClient, DemoClock } from './client.js';
import { DEMO_PEOPLE, DEMO_TENANT, ROLE_ENTRIES, ROLE_LABELS } from './data.js';
import type { SeedProgress } from './progress.js';
import { seedTransfers } from './transfers.js';
import { DemoSeedIncompleteError, DemoWorld, type StepHook } from './world.js';

export { DemoSeedIncompleteError } from './world.js';
export type { SeedPhase, SeedStep } from './world.js';
export { fileProgress, memoryProgress, type SeedProgress } from './progress.js';

export interface DemoPersona {
  readonly userId: string;
  readonly name: string;
  readonly role: string;
  readonly entry: string;
  readonly entryLabel: string;
}

/** 写给 vite 开发代理与“切换演示身份”工具条的清单（`.demo/personas.json`）。 */
export interface DemoManifest {
  readonly tenantId: string;
  readonly personas: readonly DemoPersona[];
}

export interface SeedOptions {
  readonly clock?: () => Date;
  /** 签名开发身份只允许 test / development（identity.ts）；缺省取 process.env.NODE_ENV。 */
  readonly nodeEnv?: string;
  /** 每写入一个对象后回调（进度输出；测试用它在指定位置注入失败）。 */
  readonly onStep?: StepHook;
  /** 调动场景“已完成 / 已被用户接管”的记录（cli 用 `.demo/seed-state.json`）；不提供时每次重新做接管判定（DEC-477）。 */
  readonly progress?: SeedProgress;
}

export interface SeedResult {
  /** 本次运行是否写入了数据；全部已存在时为 false。 */
  readonly created: boolean;
  readonly manifest: DemoManifest;
}

export async function seedDemo(db: Db, options: SeedOptions = {}): Promise<SeedResult> {
  const clock = new DemoClock(options.clock ?? (() => new Date()));
  const client = createDemoClient(db, clock.now, options.nodeEnv);
  const existing = await findDemoTenant(db);
  const tenantId = existing ?? (await provision(db, clock.now()));
  const world = new DemoWorld(db, client.forTenant(tenantId), tenantId, client.guarded, options.onStep);
  if (!existing) world.written += 1;
  await world.build();
  await seedTransfers(world, clock, options.progress);
  return { created: world.written > 0, manifest: await buildManifest(db, tenantId) };
}

async function findDemoTenant(db: Db): Promise<string | null> {
  const [row] = await withPlatform(db, (tx) =>
    tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, DEMO_TENANT.code)),
  );
  return row?.id ?? null;
}

async function buildManifest(db: Db, tenantId: string): Promise<DemoManifest> {
  const emails = DEMO_PEOPLE.map((person) => person.email);
  const rows = await withPlatform(db, (tx) =>
    tx.select({ id: users.id, email: users.email }).from(users).where(inArray(users.email, emails)),
  );
  const byEmail = new Map(rows.map((row) => [row.email, row.id]));
  const personas = DEMO_PEOPLE.map((person) => {
    const userId = byEmail.get(person.email);
    if (!userId) throw new DemoSeedIncompleteError(`账号 ${person.email} 缺失`);
    const entry = ROLE_ENTRIES[person.role];
    return { userId, name: person.name, role: ROLE_LABELS[person.role], entry: entry.path, entryLabel: entry.label };
  });
  return { tenantId, personas };
}

/** 平台开通：租户 + 首位租户管理员 + 异常管理员 + 标准身份 + 预置流程（R1-T17）。 */
async function provision(db: Db, now: Date): Promise<string> {
  const meta = () => ({ actorUserId: null, commandId: randomUUID() });
  // 上次开通中途失败时账号可能已建好：按邮箱复用
  const account = async (key: string) => {
    const person = DEMO_PEOPLE.find((p) => p.key === key)!;
    const [found] = await withPlatform(db, (tx) =>
      tx.select({ id: users.id }).from(users).where(eq(users.email, person.email)),
    );
    return found ?? createUser(db, { email: person.email, displayName: person.name }, meta());
  };
  const admin = await account('admin');
  const exception = await account('exception');
  const result = await provisionTenant(
    db,
    { ...DEMO_TENANT, firstAdminUserId: admin.id, exceptionAdminUserId: exception.id },
    meta(),
    now,
  );
  return result.tenant.id;
}
