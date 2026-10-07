/**
 * 本地演示种子（F-025）：建一个演示租户，让 R1 调动主线的各角色入口都能用。可重复执行：租户已完整存在时
 * 只重新导出演示身份清单，不重复写数据；半途失败留下的不完整租户会报错并提示 `pnpm demo:reset`。
 *
 * 租户开通走平台开通命令（R1-T17，与 POST /api/platform/tenants 同一实现）；其余业务数据一律走公开租户接口，
 * 使用真实权限授权器与签名开发身份（不注入“全部允许”），因此业务规则、审计与 outbox 和真实操作一致。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  approvalProcesses,
  createUser,
  type Db,
  eq,
  inArray,
  tenants,
  users,
  withPlatform,
  withTenant,
} from '@italent/db';
import { TRANSFER_FORM_FIELDS } from '@italent/domain';
import { createApp } from '../app.js';
import { createDevIdentityResolver, devIdentityHeaders } from '../identity.js';
import { provisionTenant } from '../modules/platform/provisioning.js';
import {
  DEMO_DATES,
  DEMO_ORG_ROLES,
  DEMO_ORGS,
  DEMO_PEOPLE,
  DEMO_POSITIONS,
  DEMO_POSTS,
  DEMO_SEQUENCES,
  DEMO_TENANT,
  DEMO_TRANSFER_PROCESS_CODE,
  type DemoPersonDef,
  ROLE_ENTRIES,
  ROLE_LABELS,
} from './data.js';

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
}

export interface SeedResult {
  readonly created: boolean;
  readonly manifest: DemoManifest;
}

export class DemoSeedIncompleteError extends Error {
  constructor() {
    super('演示租户已存在但数据不完整（上次种子中途失败）：请先停掉 pnpm demo，再运行 pnpm demo:reset');
  }
}

export async function seedDemo(db: Db, options: SeedOptions = {}): Promise<SeedResult> {
  const existing = await findDemoTenant(db);
  if (existing) {
    if (!(await isComplete(db, existing))) throw new DemoSeedIncompleteError();
    return { created: false, manifest: await buildManifest(db, existing) };
  }
  const clock = options.clock ?? (() => new Date());
  const api = demoApi(db, clock, options.nodeEnv);
  const tenantId = await provision(db, clock());
  await new DemoWorld(db, api, tenantId).build();
  return { created: true, manifest: await buildManifest(db, tenantId) };
}

async function findDemoTenant(db: Db): Promise<string | null> {
  const [row] = await withPlatform(db, (tx) =>
    tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, DEMO_TENANT.code)),
  );
  return row?.id ?? null;
}

/** 演示调动流程的发布是最后一步：已发布，说明整套种子已完成。 */
async function isComplete(db: Db, tenantId: string): Promise<boolean> {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select({ published: approvalProcesses.currentVersionId })
      .from(approvalProcesses)
      .where(eq(approvalProcesses.code, DEMO_TRANSFER_PROCESS_CODE)),
  );
  // 只建了草稿、发布前中断的也算不完整（#92 第二轮 P3）：发布是种子的最后一步
  return rows.some((row) => row.published !== null);
}

async function buildManifest(db: Db, tenantId: string): Promise<DemoManifest> {
  const emails = DEMO_PEOPLE.map((person) => person.email);
  const rows = await withPlatform(db, (tx) =>
    tx.select({ id: users.id, email: users.email }).from(users).where(inArray(users.email, emails)),
  );
  const byEmail = new Map(rows.map((row) => [row.email, row.id]));
  const personas = DEMO_PEOPLE.map((person) => {
    const userId = byEmail.get(person.email);
    if (!userId) throw new DemoSeedIncompleteError();
    const entry = ROLE_ENTRIES[person.role];
    return { userId, name: person.name, role: ROLE_LABELS[person.role], entry: entry.path, entryLabel: entry.label };
  });
  return { tenantId, personas };
}

/** 平台开通：租户 + 首位租户管理员 + 异常管理员 + 标准身份 + 预置流程（R1-T17）。 */
async function provision(db: Db, now: Date): Promise<string> {
  const meta = () => ({ actorUserId: null, commandId: randomUUID() });
  const account = (key: string) => {
    const person = DEMO_PEOPLE.find((p) => p.key === key)!;
    return createUser(db, { email: person.email, displayName: person.name }, meta());
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

interface Response {
  readonly status: number;
  readonly ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
type Call = (
  userId: string,
  method: string,
  path: string,
  body?: unknown,
  ifMatch?: number,
) => Promise<Record<string, unknown>>;

/** 进程内调用公开接口：随机密钥只存在于本次运行内存，签名身份头与 vite 开发代理同一方案。 */
function demoApi(db: Db, clock: () => Date, nodeEnv?: string): (tenantId: string) => Call {
  const secret = randomBytes(32).toString('hex');
  const identity = createDevIdentityResolver({ secret, nodeEnv });
  const app = createApp({ db, identity, clock });
  return (tenantId) => async (userId, method, path, body, ifMatch) => {
    const headers: Record<string, string> = { ...devIdentityHeaders(secret, userId), 'x-tenant-id': tenantId };
    if (method !== 'GET') headers['idempotency-key'] = randomUUID();
    if (ifMatch !== undefined) headers['if-match'] = `"${ifMatch}"`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const init = { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const response: Response = await app.request(path, init);
    if (!response.ok)
      throw new Error(`演示种子调用失败：${method} ${path} → ${response.status} ${await response.text()}`);
    return (await response.json()) as Record<string, unknown>;
  };
}

type Ref = { id: string; revision: number };

class DemoWorld {
  private readonly call: Call;
  private readonly orgs = new Map<string, Ref>();
  private readonly sequences = new Map<string, string>();
  private readonly posts = new Map<string, string>();
  private readonly positions = new Map<string, string>();
  /** 人员 key → 人员档案 ID / 账号 ID。 */
  private readonly employees = new Map<string, string>();
  private readonly accounts = new Map<string, string>();
  private profiles = new Map<string, string>();
  private adminRecord: { id: string; revision: number } = { id: '', revision: 0 };

  constructor(
    private readonly db: Db,
    api: (tenantId: string) => Call,
    private readonly tenantId: string,
  ) {
    this.call = api(tenantId);
  }

  private get admin(): string {
    return this.accounts.get('admin')!;
  }

  private as(path: string, method: string, body?: unknown, ifMatch?: number) {
    return this.call(this.admin, method, `/api/tenant/${path}`, body, ifMatch);
  }

  async build(): Promise<void> {
    await this.loadAdmin();
    await this.grantAdminSeeAll();
    await this.createOrgs();
    await this.createJobs();
    await this.hirePeople();
    await this.assignOrgRoles();
    await this.setupHr();
    await this.setupAuditor();
    await this.publishTransferProcess();
  }

  private async loadAdmin(): Promise<void> {
    for (const key of ['admin', 'exception']) {
      const email = DEMO_PEOPLE.find((p) => p.key === key)!.email;
      this.accounts.set(key, await this.lookup(email));
    }
    const admins = (await this.as('permission/admins', 'GET')) as unknown as { items?: AdminRow[] } | AdminRow[];
    const list = Array.isArray(admins) ? admins : (admins.items ?? []);
    const record = list.find((row) => row.userId === this.admin)!;
    this.adminRecord = { id: record.id, revision: record.revision };
    const profiles = (await this.as('permission/profiles', 'GET')) as unknown as { items?: Profile[] } | Profile[];
    const rows = Array.isArray(profiles) ? profiles : (profiles.items ?? []);
    this.profiles = new Map(rows.map((row) => [row.code, row.id]));
  }

  /** 入职时按登录邮箱开通 / 复用的全局账号（user-provisioning.ts）。 */
  private async lookup(email: string): Promise<string> {
    const [row] = await withPlatform(this.db, (tx) =>
      tx.select({ id: users.id }).from(users).where(eq(users.email, email)),
    );
    if (!row) throw new DemoSeedIncompleteError();
    return row.id;
  }

  /** 首位租户管理员的标准身份不带数据范围（硬规则：默认空）；演示管理员要建档入职，显式授“看全部”。 */
  private async grantAdminSeeAll(): Promise<void> {
    const profileId = this.profiles.get('standard_org_system_admin')!;
    await this.as(
      `permission/profiles/${profileId}/data-scopes/TenantBase`,
      'PUT',
      {
        targetKind: 'app',
        targetCode: '',
        seeAll: true,
      },
      0,
    );
  }

  private async createOrgs(): Promise<void> {
    for (const org of DEMO_ORGS) {
      const parentId = org.parent ? this.orgs.get(org.parent)!.id : this.tenantId;
      const created = await this.as(
        'org/organizations',
        'POST',
        { name: org.name, establishedOn: DEMO_DATES.established, parents: { admin: { parentId } } },
        0,
      );
      this.orgs.set(org.key, { id: String(created.id), revision: Number(created.revision) });
    }
  }

  private async createJobs(): Promise<void> {
    const startDate = DEMO_DATES.established;
    for (const sequence of DEMO_SEQUENCES) {
      const created = await this.as(
        'job/sequences',
        'POST',
        { name: sequence.name, code: sequence.code, startDate },
        0,
      );
      this.sequences.set(sequence.key, String(created.id));
    }
    for (const post of DEMO_POSTS) {
      const sequenceId = this.sequences.get(post.sequence)!;
      const created = await this.as(
        'job/posts',
        'POST',
        { name: post.name, code: post.code, sequenceId, startDate },
        0,
      );
      this.posts.set(post.key, String(created.id));
    }
    for (const position of DEMO_POSITIONS) {
      const postId = this.posts.get(position.post)!;
      const orgId = this.orgs.get(position.org)!.id;
      const created = await this.as('job/positions', 'POST', { name: position.name, orgId, postId, startDate }, 0);
      this.positions.set(position.key, String(created.id));
    }
  }

  /** 建档 + 入职（带登录邮箱：同事务开通账号、成员关系与账号绑定，DEC-128 / DEC-140）。 */
  private async hirePeople(): Promise<void> {
    let serial = 0;
    for (const person of DEMO_PEOPLE.filter((p) => p.job)) {
      serial += 1;
      const code = `DEMO${String(serial).padStart(3, '0')}`;
      const employee = await this.as('employment/employees', 'POST', { code, name: person.name }, 0);
      const id = String(employee.id);
      await this.as(`employment/employees/${id}/businesses`, 'POST', this.hireBody(person), Number(employee.revision));
      this.employees.set(person.key, id);
      this.accounts.set(person.key, await this.lookup(person.email));
    }
  }

  private hireBody(person: DemoPersonDef) {
    const job = person.job!;
    const post = DEMO_POSTS.find((p) => p.key === job.post)!;
    return {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: DEMO_DATES.hired,
      loginEmail: person.email,
      fields: {
        departmentId: this.orgs.get(job.org)!.id,
        postId: this.posts.get(post.key),
        sequenceId: this.sequences.get(post.sequence),
        ...(job.position ? { positionId: this.positions.get(job.position) } : {}),
        ...(job.managerKey ? { directManagerId: this.employees.get(job.managerKey) } : {}),
      },
    };
  }

  /** 部门负责人与 HRBP（组织新版本，生效日 = 入职日：负责人须为当日在职的内部员工，DEC-135）。 */
  private async assignOrgRoles(): Promise<void> {
    for (const role of DEMO_ORG_ROLES) {
      const org = this.orgs.get(role.org)!;
      const body = {
        effectiveDate: DEMO_DATES.hired,
        ...(role.head ? { personInChargeId: this.employees.get(role.head) } : {}),
        ...(role.hrbp ? { hrbpId: this.employees.get(role.hrbp) } : {}),
      };
      const updated = await this.as(`org/organizations/${org.id}`, 'PATCH', body, org.revision);
      this.orgs.set(role.org, { id: org.id, revision: Number(updated.revision) });
    }
  }

  /** 一级组织（含下级）= 演示租户全部组织；HR、审计管理员按此授数据范围（身份 × 应用一份，DEC-043）。 */
  private async scopeAll(userId: string): Promise<void> {
    const orgRanges = DEMO_ORGS.filter((org) => !org.parent).map((org) => ({
      orgId: this.orgs.get(org.key)!.id,
      includeDescendants: true,
    }));
    await this.as(`permission/scopes/${userId}/TenantBase`, 'PUT', { kind: 'org_range', orgRanges }, 0);
  }

  private async grant(userId: string, profileCode: string): Promise<void> {
    await this.as('permission/grants', 'POST', { userId, profileId: this.profiles.get(profileCode)! });
  }

  /** HR：标准 HR 管理员身份（含 Transfer.Hr 等全部任职按钮）+ 全部组织的数据范围。 */
  private async setupHr(): Promise<void> {
    const hr = this.accounts.get('hr')!;
    await this.grant(hr, 'standard_hr_admin');
    await this.scopeAll(hr);
  }

  /** 审计管理员：管理员角色 audit_admin 看日志入口；只读身份 + 数据范围决定能看到哪些业务行（audit/visibility.ts）。 */
  private async setupAuditor(): Promise<void> {
    const auditor = this.accounts.get('auditor')!;
    await this.as('permission/admins', 'POST', {
      userId: auditor,
      role: 'audit_admin',
      grantableAdminRoles: [],
      grantableProfileIds: [],
    });
    await this.grant(auditor, 'standard_manager');
    await this.scopeAll(auditor);
  }

  /**
   * 演示调动流程：直接上级审批 → 调入部门 HRBP 审核。复刻首版没有“直接上级”审批人表达式（REQ-APV-002），
   * 与预置离职流程相同，用“最新任职记录部门负责人”近似（DEC-230，表达式待 F-028）；演示数据里员工的直线经理即部门负责人。
   * 优先级 -1 先于出厂预置的标准调动流程（同为 TransferProcessNew 发起条件，DEC-017 按优先级取第一个）。
   */
  private async publishTransferProcess(): Promise<void> {
    const node = (key: string, name: string, approver: string) => ({
      key,
      name,
      approver,
      formFields: TRANSFER_FORM_FIELDS,
    });
    const process = await this.as(
      'approval/processes',
      'POST',
      {
        code: DEMO_TRANSFER_PROCESS_CODE,
        name: '演示调动流程',
        approvalType: 'transfer',
        priority: -1,
        exceptionAdminUserId: this.accounts.get('exception'),
        conditions: {
          items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }],
          expression: '1',
        },
        nodes: [
          node('direct_head', '直接上级审批', 'latest_record_department_head'),
          node('in_hrbp', '调入部门HRBP审核', 'record_department_hrbp'),
        ],
      },
      0,
    );
    await this.as(`approval/processes/${String(process.id)}/publish`, 'POST', undefined, Number(process.revision));
  }
}

interface AdminRow {
  readonly id: string;
  readonly userId: string;
  readonly revision: number;
}
interface Profile {
  readonly id: string;
  readonly code: string;
}
