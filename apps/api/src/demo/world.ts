/**
 * 演示租户的搭建（组织 → 职务体系 → 员工 → 授权）。每个阶段都按自然键“先查后建”：组织编码、职务体系编码、工号；
 * 重复运行只补缺失，半途失败后再运行从缺失处继续，不需要重置。写入一律走公开租户接口（见 client.ts）。
 */
import { type Db, eq, users, withPlatform } from '@italent/db';
import { QUALIFICATION_OBJECTS } from '@italent/domain';
import { type Call, type Guarded, type Json, listAll } from './client.js';
import { seedR3 } from './r3-seed.js';
import {
  DEMO_DATES,
  DEMO_HRBP_KEY,
  DEMO_ORGS,
  DEMO_PEOPLE,
  DEMO_PERSONA_HEADS,
  DEMO_QUALIFICATION_LAYERS,
  DEMO_POSTS,
  DEMO_SEQUENCES,
  type DemoPersonDef,
} from './data.js';
import {
  DEMO_ALL_POSITIONS,
  DEMO_GENERATED_HEADS,
  DEMO_GRADES,
  DEMO_LAYERS,
  DEMO_LEVEL_TYPES,
  DEMO_LEVELS,
  DEMO_STAFF,
  type DemoStaffDef,
  gradeOfLevel,
} from './scale-data.js';

export type SeedPhase = 'orgs' | 'jobs' | 'employees' | 'access' | 'qualification' | 'r3' | 'transfers';
export interface SeedStep {
  readonly phase: SeedPhase;
  /** 刚写入的对象的自然键（组织 / 职务体系编码、工号…）。 */
  readonly key: string;
}
export type StepHook = (step: SeedStep) => void | Promise<void>;

export class DemoSeedIncompleteError extends Error {
  constructor(detail = '演示身份缺失') {
    super(`演示租户数据不完整（${detail}）：请再运行一次 pnpm demo:seed 补齐；仍失败再运行 pnpm demo:reset`);
  }
}

export type Ref = { id: string; revision: number };
const str = (row: Json, key: string): string => String(row[key]);

export class DemoWorld {
  /** 本次运行写入的对象数；为 0 表示一切都已存在。 */
  written = 0;
  readonly orgs = new Map<string, Ref>();
  readonly posts = new Map<string, string>();
  readonly sequences = new Map<string, string>();
  readonly positions = new Map<string, string>();
  /** 演示身份 key / 生成员工工号 → 人员档案 ID。 */
  readonly employees = new Map<string, string>();
  /** 演示身份 key → 账号 ID。 */
  readonly accounts = new Map<string, string>();
  private readonly layers = new Map<number, string>();
  private readonly levelTypes = new Map<string, string>();
  private readonly levels = new Map<string, string>();
  private readonly grades = new Map<number, string>();
  private profiles = new Map<string, string>();

  constructor(
    readonly db: Db,
    readonly call: Call,
    readonly tenantId: string,
    /** 受保护写入（client.ts）：调动单据的审批 / 驳回 / 撤回经它与接管复核落在同一事务。 */
    readonly guarded: Guarded,
    private readonly onStep?: StepHook,
  ) {}

  get admin(): string {
    return this.accounts.get('admin')!;
  }

  as(path: string, method: string, body?: unknown, ifMatch?: number) {
    return this.call(this.admin, method, `/api/tenant/${path}`, body, ifMatch);
  }

  async wrote(phase: SeedPhase, key: string): Promise<void> {
    this.written += 1;
    await this.onStep?.({ phase, key });
  }

  /** 入职时按登录邮箱开通 / 复用的全局账号（user-provisioning.ts）。 */
  async lookup(email: string): Promise<string> {
    const [row] = await withPlatform(this.db, (tx) =>
      tx.select({ id: users.id }).from(users).where(eq(users.email, email)),
    );
    if (!row) throw new DemoSeedIncompleteError(`账号 ${email} 缺失`);
    return row.id;
  }

  async build(): Promise<void> {
    await this.loadAdmin();
    await this.grantAdminSeeAll();
    await this.createOrgs();
    await this.createJobs();
    await this.hireEveryone();
    await this.assignOrgRoles();
    await this.setupHr();
    await this.setupAuditor();
    await this.seedQualificationLayers();
    await seedR3(this);
  }

  private async loadAdmin(): Promise<void> {
    for (const key of ['admin', 'exception']) {
      this.accounts.set(key, await this.lookup(DEMO_PEOPLE.find((p) => p.key === key)!.email));
    }
    const profiles = await listAll(this.call, this.admin, '/api/tenant/permission/profiles');
    this.profiles = new Map(profiles.map((row) => [str(row, 'code'), str(row, 'id')]));
  }

  /** 首位租户管理员的标准身份不带数据范围（硬规则：默认空）；演示管理员要建档入职，显式授“看全部”。 */
  private async grantAdminSeeAll(): Promise<void> {
    const path = `permission/profiles/${this.profiles.get('standard_org_system_admin')!}/data-scopes/TenantBase`;
    const current = await this.as(path, 'GET');
    if (current.seeAll === true) return;
    await this.as(path, 'PUT', { targetKind: 'app', targetCode: '', seeAll: true }, Number(current.revision ?? 0));
    await this.wrote('access', 'admin-see-all');
  }

  // ---- 组织 ----
  async loadOrgs(): Promise<Map<string, Json>> {
    const rows = await listAll(this.call, this.admin, '/api/tenant/org/organizations?includeDisabled=true');
    const byCode = new Map(rows.map((row) => [str(row, 'code'), row]));
    for (const org of DEMO_ORGS) {
      const row = byCode.get(org.code);
      if (row) this.orgs.set(org.key, { id: str(row, 'id'), revision: Number(row.revision) });
    }
    return byCode;
  }

  private async createOrgs(): Promise<void> {
    await this.loadOrgs();
    for (const org of DEMO_ORGS) {
      if (this.orgs.has(org.key)) continue;
      const parentId = org.parent ? this.orgs.get(org.parent)!.id : this.tenantId;
      const created = await this.as(
        'org/organizations',
        'POST',
        {
          name: org.name,
          code: org.code,
          establishedOn: DEMO_DATES.established,
          parents: { admin: { parentId } },
        },
        0,
      );
      this.orgs.set(org.key, { id: str(created, 'id'), revision: Number(created.revision) });
      await this.wrote('orgs', org.code);
    }
  }

  // ---- 职务体系 ----
  /** 按编码查已有对象，缺失才建；返回 ID。 */
  private async ensureJob(kind: string, existing: Map<string, string>, body: Json & { code: string }) {
    let id = existing.get(body.code);
    if (!id) {
      const created = await this.as(`job/${kind}`, 'POST', { startDate: DEMO_DATES.established, ...body }, 0);
      id = str(created, 'id');
      existing.set(body.code, id);
      await this.wrote('jobs', body.code);
    }
    return id;
  }

  private async existingJobs(kind: string): Promise<Map<string, string>> {
    const rows = await listAll(this.call, this.admin, `/api/tenant/job/${kind}?includeDisabled=true`);
    return new Map(rows.map((row) => [str(row, 'code'), str(row, 'id')]));
  }

  private async createJobs(): Promise<void> {
    const layers = await this.existingJobs('layers');
    for (const item of DEMO_LAYERS) {
      const id = await this.ensureJob('layers', layers, { name: item.name, code: item.code, layerLevel: item.key });
      this.layers.set(item.key, id);
    }
    const grades = await this.existingJobs('grades');
    for (const item of DEMO_GRADES) {
      const layerId = this.layers.get(item.layer)!;
      const body = { name: item.name, code: item.code, grade: item.grade, layerId };
      this.grades.set(item.grade, await this.ensureJob('grades', grades, body));
    }
    const levelTypes = await this.existingJobs('level-types');
    for (const item of DEMO_LEVEL_TYPES) {
      this.levelTypes.set(
        item.key,
        await this.ensureJob('level-types', levelTypes, { name: item.name, code: item.code }),
      );
    }
    const levels = await this.existingJobs('levels');
    for (const item of DEMO_LEVELS) {
      const levelTypeId = this.levelTypes.get(item.track)!;
      const id = await this.ensureJob('levels', levels, {
        name: item.name,
        code: item.code,
        level: item.level,
        levelTypeId,
      });
      this.levels.set(item.name, id);
    }
    const sequences = await this.existingJobs('sequences');
    for (const item of DEMO_SEQUENCES) {
      this.sequences.set(item.key, await this.ensureJob('sequences', sequences, { name: item.name, code: item.code }));
    }
    const posts = await this.existingJobs('posts');
    for (const item of DEMO_POSTS) {
      const max = item.track === 'P' ? 'P6' : 'M3';
      const body = {
        name: item.name,
        code: item.code,
        sequenceId: this.sequences.get(item.sequence)!,
        levelTypeId: this.levelTypes.get(item.track)!,
        minLevelId: this.levels.get(`${item.track}1`)!,
        maxLevelId: this.levels.get(max)!,
      };
      this.posts.set(item.key, await this.ensureJob('posts', posts, body));
    }
    const positions = await this.existingJobs('positions');
    for (const item of DEMO_ALL_POSITIONS) {
      const code = `DEMO_POS_${item.key.replace(':', '_').toUpperCase()}`;
      const orgId = this.orgs.get(item.org)!.id;
      const postId = this.posts.get(item.post)!;
      this.positions.set(
        item.key,
        await this.ensureJob('positions', positions, { name: item.name, code, orgId, postId }),
      );
    }
  }

  // ---- 员工 ----
  /** 演示身份的工号沿用原有的 DEMO001…（按有档案的顺序编号）。 */
  personaCode(key: string): string {
    const index = DEMO_PEOPLE.filter((p) => p.job).findIndex((p) => p.key === key);
    return `DEMO${String(index + 1).padStart(3, '0')}`;
  }

  private async hireEveryone(): Promise<void> {
    const rows = await listAll(this.call, this.admin, '/api/tenant/employment/employees');
    const existing = new Map(rows.map((row) => [str(row, 'code').toLowerCase(), row]));
    for (const person of DEMO_PEOPLE.filter((p) => p.job)) {
      const code = this.personaCode(person.key);
      await this.hire(existing.get(code.toLowerCase()), code, person.name, person.key, this.personaHire(person));
      this.accounts.set(person.key, await this.lookup(person.email));
    }
    for (const staff of DEMO_STAFF) {
      await this.hire(
        existing.get(staff.code.toLowerCase()),
        staff.code,
        staff.name,
        staff.code,
        this.staffHire(staff),
      );
    }
  }

  /** 建档 + 入职（带登录邮箱：同事务开通账号、成员关系与账号绑定，DEC-128 / DEC-140）；已入职的跳过。 */
  private async hire(row: Json | undefined, code: string, name: string, key: string, body: Json): Promise<void> {
    let id = row ? str(row, 'id') : '';
    if (row && row.status !== 'pending') {
      this.employees.set(key, id);
      return;
    }
    let revision = Number(row?.revision);
    if (!row) {
      const created = await this.as('employment/employees', 'POST', { code, name }, 0);
      id = str(created, 'id');
      revision = Number(created.revision);
    }
    await this.as(`employment/employees/${id}/businesses`, 'POST', body, revision);
    this.employees.set(key, id);
    await this.wrote('employees', code);
  }

  private personaHire(person: DemoPersonDef): Json {
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

  private staffHire(staff: DemoStaffDef): Json {
    const post = DEMO_POSTS.find((p) => p.key === staff.post)!;
    const manager = staff.manager;
    const managerKey = manager ? ('code' in manager ? manager.code : manager.persona) : undefined;
    const { track, level } = staff.level;
    return {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: staff.hired,
      loginEmail: staff.email,
      fields: {
        departmentId: this.orgs.get(staff.org)!.id,
        postId: this.posts.get(post.key),
        sequenceId: this.sequences.get(post.sequence),
        ...(staff.position ? { positionId: this.positions.get(staff.position) } : {}),
        ...(managerKey ? { directManagerId: this.employees.get(managerKey) } : {}),
        levelId: this.levels.get(`${track}${level}`),
        gradeId: this.grades.get(gradeOfLevel(track, level)),
        place: staff.place,
        employType: staff.employType,
      },
    };
  }

  // ---- 负责人 / HRBP / 授权 ----
  /** 部门负责人与 HRBP（组织新版本，生效日 = 相关人员都已入职的日期：负责人须为当日在职的内部员工，DEC-135）。 */
  private async assignOrgRoles(): Promise<void> {
    const current = await this.loadOrgs();
    const hrbp = this.employees.get(DEMO_HRBP_KEY)!;
    for (const org of DEMO_ORGS) {
      const persona = DEMO_PERSONA_HEADS[org.key];
      const generated = DEMO_GENERATED_HEADS.get(org.key);
      const head = persona ? this.employees.get(persona)! : this.employees.get(generated!.code)!;
      const row = current.get(org.code)!;
      if (row.personInChargeId === head && row.hrbpId === hrbp) continue;
      const hired = generated ? generated.hired : DEMO_DATES.hired;
      const ref = this.orgs.get(org.key)!;
      const body = {
        effectiveDate: hired > DEMO_DATES.hired ? hired : DEMO_DATES.hired,
        personInChargeId: head,
        hrbpId: hrbp,
      };
      const updated = await this.as(`org/organizations/${ref.id}`, 'PATCH', body, ref.revision);
      this.orgs.set(org.key, { id: ref.id, revision: Number(updated.revision) });
      await this.wrote('access', `${org.code}:roles`);
    }
  }

  /** 一级组织（含下级）= 演示租户全部组织；HR、审计管理员按此授数据范围（身份 × 应用一份，DEC-043）。 */
  private async scopeAll(userId: string): Promise<void> {
    const path = `permission/scopes/${userId}/TenantBase`;
    const current = await this.as(path, 'GET');
    if (current.kind === 'org_range') return;
    const orgRanges = DEMO_ORGS.filter((org) => !org.parent).map((org) => ({
      orgId: this.orgs.get(org.key)!.id,
      includeDescendants: true,
    }));
    await this.as(path, 'PUT', { kind: 'org_range', orgRanges }, Number(current.revision ?? 0));
    await this.wrote('access', `${userId}:scope`);
  }

  /** 标准身份编码 → 身份 ID（loadAdmin 读入）。 */
  profileId(code: string): string {
    return this.profiles.get(code)!;
  }

  async grant(userId: string, profileCode: string): Promise<void> {
    const profileId = this.profiles.get(profileCode)!;
    const grants = await this.as(`permission/grants?userId=${userId}`, 'GET');
    if (((grants.items ?? []) as Json[]).some((row) => row.profileId === profileId && row.status !== 'revoked')) return;
    await this.as('permission/grants', 'POST', { userId, profileId });
    await this.wrote('access', `${userId}:${profileCode}`);
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
    const admins = await listAll(this.call, this.admin, '/api/tenant/permission/admins');
    if (!admins.some((row) => row.userId === auditor)) {
      await this.as('permission/admins', 'POST', {
        userId: auditor,
        role: 'audit_admin',
        grantableAdminRoles: [],
        grantableProfileIds: [],
      });
      await this.wrote('access', 'auditor-admin');
    }
    await this.grant(auditor, 'standard_manager');
    await this.scopeAll(auditor);
  }

  /**
   * 任职资格“层级”候选（F-141，DEC-500）：层级是没有组织字段的字典，新建只认看全部（DEC-121）。与 grantAdminSeeAll 同法，
   * 演示管理员先持有任职资格系统管理员身份，并在演示租户里给该身份的层级实体授看全部，再经真实接口建候选；已有同名的不重建。
   */
  private async seedQualificationLayers(): Promise<void> {
    await this.grant(this.admin, 'standard_qualification_admin');
    const profileId = this.profiles.get('standard_qualification_admin')!;
    const layerCode = QUALIFICATION_OBJECTS.layer.code;
    const layer = `targetKind=entity&targetCode=${layerCode}`;
    const scopePath = `permission/profiles/${profileId}/data-scopes/Qualification`;
    const current = await this.as(`${scopePath}?${layer}`, 'GET');
    if (current.seeAll !== true) {
      const body = { targetKind: 'entity', targetCode: layerCode, seeAll: true };
      await this.as(scopePath, 'PUT', body, Number(current.revision ?? 0));
      await this.wrote('qualification', 'layer-see-all');
    }
    const existing = await listAll(this.call, this.admin, '/api/tenant/qualification/layers');
    const names = new Set(existing.map((row) => str(row, 'name')));
    for (const item of DEMO_QUALIFICATION_LAYERS) {
      if (names.has(item.name)) continue;
      await this.as('qualification/layers', 'POST', { name: item.name, displayOrder: item.displayOrder }, 0);
      await this.wrote('qualification', `layer:${item.name}`);
    }
  }
}
