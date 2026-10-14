/**
 * 演示租户规模化数据（演示数据种子第 1 段）：职务体系、各组织编制表与确定性生成的员工。
 * 全部是合成数据：姓名由固定的姓氏 / 名字表按固定随机种子组合，邮箱 example.com，不含手机号 / 证件号。
 * 同一份代码在任何机器上生成同一批人（工号 DEMO-0001…），幂等判定与测试断言都依赖这一点。
 */
import {
  DEMO_ORGS,
  DEMO_PERSONA_HEADS,
  DEMO_POSITIONS,
  DEMO_POSTS,
  type DemoPostDef,
  type OrgKey,
  type PostKey,
} from './data.js';

/** 租户全部员工数（9 个演示身份里 7 个有人员档案 + 生成员工）。 */
export const DEMO_EMPLOYEE_TARGET = 200;
const PERSONA_EMPLOYEES = 7;

// ---- 职层 / 职等 / 职级类别 / 职级 ----
export const DEMO_LAYERS = [
  { key: 1, name: '基层', code: 'DEMO_LAYER_1' },
  { key: 2, name: '中层', code: 'DEMO_LAYER_2' },
  { key: 3, name: '高层', code: 'DEMO_LAYER_3' },
] as const;
/** 职等 1–9：1–4 基层、5–7 中层、8–9 高层。 */
const LAYER_OF_GRADE = [1, 1, 1, 1, 2, 2, 2, 3, 3] as const;
export const DEMO_GRADES = Array.from({ length: 9 }, (_, index) => ({
  grade: index + 1,
  name: `${index + 1}职等`,
  code: `DEMO_GRADE_${String(index + 1).padStart(2, '0')}`,
  layer: LAYER_OF_GRADE[index]!,
}));
export const DEMO_LEVEL_TYPES = [
  { key: 'P', name: '专业类职级', code: 'DEMO_LT_P' },
  { key: 'M', name: '管理类职级', code: 'DEMO_LT_M' },
] as const;
export const DEMO_LEVELS = [
  ...Array.from({ length: 6 }, (_, index) => ({ track: 'P' as const, level: index + 1 })),
  ...Array.from({ length: 3 }, (_, index) => ({ track: 'M' as const, level: index + 1 })),
].map((item) => ({ ...item, name: `${item.track}${item.level}`, code: `DEMO_LEVEL_${item.track}${item.level}` }));
/** 职级对应的职等：专业类 P1→3 职等…，管理类 M1→5 职等…。 */
export const gradeOfLevel = (track: 'P' | 'M', level: number): number => level + (track === 'P' ? 2 : 4);

// ---- 编制表：各组织的成员职务（组织负责人另有负责人职位）----
const MEMBER_POSTS: Readonly<Record<OrgKey, readonly PostKey[]>> = {
  frontend: ['engineer', 'testEngineer'],
  backend: ['engineer', 'testEngineer'],
  infra: ['architect', 'engineer'],
  dataplat: ['dataEngineer', 'engineer'],
  algo: ['algoEngineer', 'dataEngineer'],
  pm: ['productManager'],
  design: ['designer'],
  brand: ['marketer'],
  growth: ['marketer'],
  east: ['salesRep', 'salesManager'],
  north: ['salesRep', 'salesManager'],
  south: ['salesRep', 'salesManager'],
  impl: ['implConsultant'],
  support: ['csManager'],
  recruit: ['recruiter', 'hrSpecialist'],
  comp: ['hrSpecialist'],
  acct: ['accountant'],
  budget: ['finAnalyst', 'accountant'],
  office: ['adminClerk'],
  legal: ['legalClerk'],
};
/** 直属研发部、不占职位的生成员工（调动演示的被调动人，与演示员工甲乙丙同一做法）：组织 → 人数、职务。 */
const DIRECT_STAFF: Readonly<Record<OrgKey, { count: number; post: PostKey }>> = {
  platform: { count: 8, post: 'engineer' },
  data: { count: 8, post: 'dataEngineer' },
};

const orgName = (key: OrgKey) => DEMO_ORGS.find((org) => org.key === key)!.name;
const postDef = (key: PostKey): DemoPostDef => DEMO_POSTS.find((post) => post.key === key)!;
const hasChildren = (key: OrgKey) => DEMO_ORGS.some((org) => org.parent === key);
const isLeaf = (key: OrgKey) => !hasChildren(key);

type Tier = 'bu' | 'dept' | 'group';
/** 组织层级：事业部（挂在租户根下）/ 部门（下面还有小组）/ 小组。 */
function tierOf(key: OrgKey): Tier {
  if (DEMO_ORGS.find((item) => item.key === key)!.parent === null) return 'bu';
  return hasChildren(key) ? 'dept' : 'group';
}
const HEAD_POST: Readonly<Record<Tier, PostKey>> = { bu: 'buHead', dept: 'deptHead', group: 'groupLead' };
/** 负责人职级：事业部 M3、部门 M2、小组 M1。 */
const HEAD_LEVEL: Readonly<Record<Tier, number>> = { bu: 3, dept: 2, group: 1 };

/** 组织负责人的职务：事业部总经理 / 部门经理 / 小组长。 */
const headPostOf = (key: OrgKey): PostKey => HEAD_POST[tierOf(key)];

export interface DemoPositionDef {
  readonly key: string;
  readonly name: string;
  readonly org: OrgKey;
  readonly post: PostKey;
}

/** 全部职位 = 原有 7 个 + 各组织负责人职位 + 各小组成员职位（每个末级组织 2–3 个）。 */
export const DEMO_ALL_POSITIONS: readonly DemoPositionDef[] = (() => {
  const result: DemoPositionDef[] = [...DEMO_POSITIONS];
  const exists = (org: OrgKey, post: PostKey) => result.some((item) => item.org === org && item.post === post);
  for (const org of DEMO_ORGS) {
    if (!DEMO_PERSONA_HEADS[org.key]) {
      const post = headPostOf(org.key);
      result.push({ key: `${org.key}:head`, name: `${org.name}${postDef(post).name}`, org: org.key, post });
    }
    for (const post of MEMBER_POSTS[org.key] ?? []) {
      if (!exists(org.key, post)) {
        result.push({ key: `${org.key}:${post}`, name: `${org.name}${postDef(post).name}`, org: org.key, post });
      }
    }
  }
  return result;
})();

/** 某组织 + 职务对应的职位键（原有职位优先）。 */
export function positionKeyOf(org: OrgKey, post: PostKey): string | undefined {
  return DEMO_ALL_POSITIONS.find((item) => item.org === org && item.post === post)?.key;
}

// ---- 生成员工 ----
export interface DemoStaffDef {
  readonly code: string;
  readonly name: string;
  readonly email: string;
  readonly org: OrgKey;
  readonly post: PostKey;
  /** 职位键；直属研发部的被调动人不占职位。 */
  readonly position?: string;
  readonly hired: string;
  readonly level: { track: 'P' | 'M'; level: number };
  /** 本组织负责人：其余员工的直线经理；生成的负责人由 DEMO_ORG_HEADS 汇总。 */
  readonly isHead: boolean;
  /** 直线经理：生成员工的工号，或演示身份 key（平台 / 数据研发部经理）。 */
  readonly manager?: { code: string } | { persona: string };
  readonly employType: 'internal' | 'intern';
  readonly place: string;
}

const SURNAMES =
  '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾萧田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤';
const GIVEN =
  '伟芳娜敏静丽强磊军洋勇艳杰涛明超秀英华慧巧美娟玲桂荣建国志宇浩然轩子萱欣怡思远嘉怀瑾瑜泽楷安琪雨晨俊熙诗涵博文昊天宁清扬帆航悦嘉豪翔锐诚毅恒晴岚彤雪梦琳瑶钰淑婷';
const PLACES = ['上海', '北京', '深圳', '杭州', '成都'] as const;

/** mulberry32：固定种子的确定性随机数。 */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const addDays = (date: string, days: number): string => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** 平台 / 数据研发部经理（演示身份）的入职日；其下的生成员工晚于此日入职。 */
const PERSONA_MANAGER_HIRED = '2024-01-01';

/** 负责人的入职窗口：事业部 2019 年初、部门 2019 年春、小组 2019 年中–2020 年；演示经理之下的小组晚于经理入职。 */
const HEAD_HIRE_WINDOW: Readonly<Record<Tier, readonly [string, string]>> = {
  bu: ['2019-01-01', '2019-02-28'],
  dept: ['2019-03-01', '2019-05-31'],
  group: ['2019-06-01', '2020-12-31'],
};
function headHireWindow(key: OrgKey, underPersona: boolean): readonly [string, string] {
  return underPersona ? ['2024-02-01', '2024-06-30'] : HEAD_HIRE_WINDOW[tierOf(key)];
}

type StaffExtras = Pick<DemoStaffDef, 'hired' | 'level' | 'isHead'> & Partial<DemoStaffDef>;

function managerOf(parentHead: DemoStaffDef | undefined, persona: string | undefined): DemoStaffDef['manager'] {
  if (parentHead) return { code: parentHead.code };
  return persona ? { persona } : undefined;
}

class StaffBuilder {
  readonly staff: DemoStaffDef[] = [];
  private readonly heads = new Map<OrgKey, DemoStaffDef>();
  private readonly names = new Set<string>();
  private readonly rand = random(20261013);

  private pick(text: string): string {
    return text[Math.floor(this.rand() * text.length)]!;
  }

  private nextName(): string {
    for (;;) {
      const name = `${this.pick(SURNAMES)}${this.pick(GIVEN)}${this.pick(GIVEN)}`;
      if (!this.names.has(name)) {
        this.names.add(name);
        return name;
      }
    }
  }

  /** lo–hi 之间的一天；skew > 1 时偏向较早的日期（让 2019–2025 的入职分布不过分集中在最后两年）。 */
  private between(lo: string, hi: string, skew = 1): string {
    return addDays(lo, Math.floor(this.rand() ** skew * (daysBetween(lo, hi) + 1)));
  }

  private add(org: OrgKey, post: PostKey, extras: StaffExtras): DemoStaffDef {
    const digits = String(this.staff.length + 1).padStart(4, '0');
    const item: DemoStaffDef = {
      code: `DEMO-${digits}`,
      name: this.nextName(),
      email: `demo.s${digits}@example.com`,
      org,
      post,
      employType: 'internal',
      place: PLACES[Math.floor(this.rand() * PLACES.length)]!,
      ...extras,
    };
    this.staff.push(item);
    return item;
  }

  /** 各组织负责人（树的创建顺序保证上级先于下级入职）。 */
  buildHeads(): void {
    for (const org of DEMO_ORGS) {
      if (DEMO_PERSONA_HEADS[org.key]) continue;
      const post = headPostOf(org.key);
      const parentHead = org.parent ? this.heads.get(org.parent) : undefined;
      const personaParent = org.parent ? DEMO_PERSONA_HEADS[org.parent] : undefined;
      const [lo, hi] = headHireWindow(org.key, personaParent !== undefined);
      const manager = managerOf(parentHead, personaParent);
      this.heads.set(
        org.key,
        this.add(org.key, post, {
          position: `${org.key}:head`,
          hired: this.between(lo, hi),
          level: { track: postDef(post).track, level: HEAD_LEVEL[tierOf(org.key)] },
          isHead: true,
          ...(manager ? { manager } : {}),
        }),
      );
    }
  }

  private members(org: OrgKey, count: number, posts: readonly PostKey[], withPosition: boolean): void {
    const head = this.heads.get(org);
    const floor = head ? head.hired : PERSONA_MANAGER_HIRED;
    for (let index = 0; index < count; index += 1) {
      const post = posts[index % posts.length]!;
      const intern = this.rand() < 0.04;
      this.add(org, post, {
        ...(withPosition ? { position: positionKeyOf(org, post)! } : {}),
        hired: this.between(addDays(floor, 1), '2025-12-31', 1.6),
        level: { track: postDef(post).track, level: 1 + Math.floor(this.rand() * 4) },
        isHead: false,
        manager: head ? { code: head.code } : { persona: DEMO_PERSONA_HEADS[org]! },
        ...(intern && withPosition ? { employType: 'intern' as const } : {}),
      });
    }
  }

  /** 把剩余人数摊给直属研发部的被调动人与各末级组织。 */
  buildMembers(): void {
    const direct = Object.values(DIRECT_STAFF).reduce((sum, item) => sum + item.count, 0);
    const remaining = DEMO_EMPLOYEE_TARGET - PERSONA_EMPLOYEES - this.staff.length - direct;
    const leaves = DEMO_ORGS.filter((org) => isLeaf(org.key));
    for (const [org, { count, post }] of Object.entries(DIRECT_STAFF)) this.members(org, count, [post], false);
    leaves.forEach((org, index) => {
      const count = Math.floor(remaining / leaves.length) + (index < remaining % leaves.length ? 1 : 0);
      this.members(org.key, count, MEMBER_POSTS[org.key]!, true);
    });
  }
}

function buildStaff(): readonly DemoStaffDef[] {
  const builder = new StaffBuilder();
  builder.buildHeads();
  builder.buildMembers();
  return builder.staff;
}

export const DEMO_STAFF: readonly DemoStaffDef[] = buildStaff();

/** 组织 → 其生成的负责人（演示经理负责的研发部不在其中）。 */
export const DEMO_GENERATED_HEADS: ReadonlyMap<OrgKey, DemoStaffDef> = new Map(
  DEMO_STAFF.filter((item) => item.isHead).map((item) => [item.org, item]),
);

/** 直属研发部、不占职位的生成员工（调动演示的被调动人），按组织分组、保持工号顺序。 */
export function transferSubjects(org: OrgKey): readonly DemoStaffDef[] {
  return DEMO_STAFF.filter((item) => item.org === org && !item.position && !item.isHead);
}

export { orgName };
