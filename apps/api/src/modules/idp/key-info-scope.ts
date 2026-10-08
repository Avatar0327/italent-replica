/**
 * 关键信息的范围谓词（IDP-R21 / R22；PR #115 第 2 轮 P2-1）：记录涉及的全部员工（带教双方）与组织（轮岗部门）都在范围内
 * 才可见。直接读取、列表、计划详情聚合与审计共用这一个谓词，任一方在范围外都和直接读取一样不可见。
 */
import { sql } from '@italent/db';
import type { IdpObject } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { scopeSql, type ModuleScope } from '../permission/module-access.js';

export type KeyInfoKind = 'tutorship' | 'career' | 'workShift';

export interface KeyInfoSpec {
  readonly object: IdpObject & KeyInfoKind;
  readonly table: string;
  /** 字段 → 列。 */
  readonly columns: Readonly<Record<string, string>>;
  /** 须在范围内的员工字段（第一个是审计归属）。 */
  readonly persons: readonly string[];
  /** 须在范围内的组织字段。 */
  readonly orgs: readonly string[];
  readonly duplicate: string;
  readonly label: string;
}

const dated = { startDate: 'start_date', endDate: 'end_date' };

export const KEY_INFO: Readonly<Record<KeyInfoKind, KeyInfoSpec>> = {
  tutorship: {
    object: 'tutorship',
    table: 'idp_tutorships',
    columns: { tutorEmployeeId: 'tutor_employee_id', tuteeEmployeeId: 'tutee_employee_id', remark: 'remark', ...dated },
    persons: ['tuteeEmployeeId', 'tutorEmployeeId'],
    orgs: [],
    duplicate: 'IDP_TUTORSHIP_DUPLICATE',
    label: '带教信息',
  },
  career: {
    object: 'career',
    table: 'idp_careers',
    columns: {
      employeeId: 'employee_id',
      targetPositionId: 'target_position_id',
      strengths: 'strengths',
      developmentItems: 'development_items',
      intendedCity: 'intended_city',
      ...dated,
    },
    persons: ['employeeId'],
    orgs: [],
    duplicate: 'IDP_CAREER_DUPLICATE',
    label: '职业发展信息',
  },
  workShift: {
    object: 'workShift',
    table: 'idp_work_shifts',
    columns: {
      employeeId: 'employee_id',
      orgId: 'org_id',
      positionId: 'position_id',
      mentorEmployeeId: 'mentor_employee_id',
      ...dated,
    },
    persons: ['employeeId'],
    orgs: ['orgId'],
    duplicate: 'IDP_WORK_SHIFT_DUPLICATE',
    label: '轮岗信息',
  },
};

export const KEY_INFO_KINDS = Object.keys(KEY_INFO) as KeyInfoKind[];

/**
 * 记录在范围内的谓词；value(field) 给出该字段的 uuid 表达式（表列、字面量或审计快照里的值）。
 * 只按员工与组织判断，“使用用户”维度不放开关键信息（与业务接口一致）。
 */
export function keyInfoScopeSql(scope: ModuleScope, spec: KeyInfoSpec, value: (field: string) => SQL): SQL {
  if (scope.all) return sql`true`;
  const parts = [
    ...spec.persons.map((field) => scopeSql(scope, { person: value(field) })),
    ...spec.orgs.map((field) => scopeSql(scope, { org: value(field) })),
  ];
  return sql`(${sql.join(parts, sql` AND `)})`;
}

/** 表列（无别名）。 */
export const keyInfoColumn = (spec: KeyInfoSpec) => (field: string) => sql.raw(spec.columns[field]!);

/** 审计快照（jsonb）里的字段值。 */
export const keyInfoSnapshot = (snapshot: SQL) => (field: string) => sql`NULLIF(${snapshot}->>${field}, '')::uuid`;
