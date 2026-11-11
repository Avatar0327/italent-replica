/**
 * AC-DM-30-F493-36/38/40：26 列写入、没有对应字段的列、性别 / 民族 / 政治面貌选项（S3a，设计 §3.3、§3.6）。
 * 真 DB + HTTP；读写租户数据一律走 withTenant（app_owner 普通角色可过，DEC-568）。
 */
import './support/exit-gate-enforced.js';
import { sql, withTenant } from '@italent/db';
import {
  PROFILE_GENDER_OPTIONS,
  PROFILE_NATION_OPTIONS,
  PROFILE_POLITICAL_STATUS_OPTIONS,
  checkProfileOption,
} from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { E, H, importWorld, type ImportWorld } from './AC-DM-30-support.js';

const database = useTestDb();

/** B～Y 全部填满的一行（位置 / 职位 / 职级按名称匹配）。 */
const fullRow = (x: ImportWorld, deptCode: string, extra: Record<string, string | null> = {}) =>
  x.row(1, deptCode, {
    positionName: '合成职位',
    postName: '合成岗位',
    levelName: '合成职级',
    workDate: '2019/9/1',
    place: '合成办公地',
    idNumber: '110101199001010011',
    mobilePhone: '13800000001',
    personalEmail: 'syn.personal@example.com',
    gender: '女',
    birthday: '1990-01-01',
    nation: '回族',
    politicalStatus: '中共党员',
    householdAddress: '合成户籍地址',
    registAddress: '合成居住地址',
    school: '合成大学',
    major: '合成专业',
    exitTypeName: '主动离职',
    exitReasonName: '个人原因',
    whereaboutsName: '自主创业',
    ...extra,
  });

describe('AC-DM-30-F493-36 26 列写入', () => {
  it('档案字段、教育经历、任职引用与离职字典按输入写入；nationality 不填默认值', async () => {
    const x = await importWorld(database().db, '36');
    const d = await x.dept('全列部门');
    const jobs = await x.jobs(d.id);
    const batchId = await x.imported([fullRow(x, d.code, { entryDate: '2023/3/1' })]);
    const [row] = await x.rowsOfBatch(batchId);
    expect(row, JSON.stringify(row)).toMatchObject({ status: 'succeeded', errors: [] });
    const profile = await x.profileOf(row!.employee_id!);
    expect(profile).toMatchObject({
      work_date: '2019-09-01',
      id_type: 'id_card',
      id_number: '110101199001010011',
      mobile_phone: '13800000001',
      backup_mail: 'syn.personal@example.com',
      gender: '女',
      birthday: '1990-01-01',
      nation: '回族',
      political_status: '中共党员',
      household_address: '合成户籍地址',
      regist_address: '合成居住地址',
      last_school: '合成大学',
      major: '合成专业',
    });
    expect(profile.nationality).toBeNull();
    const education = await x.q(x.sql`SELECT 1 FROM personnel_education
      WHERE tenant_id=${x.tenantId} AND employee_id=${row!.employee_id}::uuid AND deleted=false`);
    expect(education).toHaveLength(1);
    const records = await x.q<{ position_id: string; post_id: string; level_id: string; place: string }>(
      x.sql`SELECT position_id::text, post_id::text, level_id::text, place FROM employment_records
        WHERE tenant_id=${x.tenantId} AND employee_id=${row!.employee_id}::uuid ORDER BY start_date`,
    );
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record).toEqual({
        position_id: jobs.position.id,
        post_id: jobs.post.id,
        level_id: jobs.level.id,
        place: '合成办公地',
      });
    }
    expect(await x.exitRowOf(row!.exit_business_id!)).toMatchObject({
      exitTypeCode: 'voluntary',
      reasonCode: 'personal',
      whereaboutsCode: 'startup',
    });
    expect((await x.businessesOf(row!.employee_id!))[0]!.effectiveDate).toBe(H);
    expect((await x.businessesOf(row!.employee_id!))[1]!.effectiveDate).toBe(E);
  });

  it('F 列同名职位两条 → REFERENCE_AMBIGUOUS（F）；W 列字典项停用 → REFERENCE_DISABLED（W）；零写入', async () => {
    const x = await importWorld(database().db, '36-ref');
    const d = await x.dept('引用部门');
    const jobs = await x.jobs(d.id);
    await x.duplicatePosition(d.id, jobs.post.id);
    await withTenant(x.db, x.tenantId, (tx) =>
      tx.execute(sql`UPDATE exit_types SET enabled=false WHERE tenant_id=${x.tenantId} AND code='involuntary'`),
    );
    const before = await x.employeeCount();
    const batchId = await x.imported([
      x.row(1, d.code, { positionName: '合成职位' }),
      x.row(2, d.code, { exitTypeName: '被动离职' }),
      x.row(3, d.code, { exitTypeName: '不存在的类型' }),
    ]);
    const rows = await x.rowsOfBatch(batchId);
    expect(rows.map((r) => [r.status, r.errors])).toEqual([
      ['failed', [{ column: 'F', reason: 'REFERENCE_AMBIGUOUS' }]],
      ['failed', [{ column: 'W', reason: 'REFERENCE_DISABLED' }]],
      ['failed', [{ column: 'W', reason: 'REFERENCE_NOT_FOUND' }]],
    ]);
    expect(await x.employeeCount()).toBe(before);
  });
});

describe('AC-DM-30-F493-38 没有对应字段的列', () => {
  it('Z 列为空成功；Z 列有值 → failed / NOT_SUPPORTED（Z），不写任何数据', async () => {
    const x = await importWorld(database().db, '38');
    const d = await x.dept('备注部门');
    const batchId = await x.imported([x.row(1, d.code), x.row(2, d.code, { exitNote: '合成备注' })]);
    const rows = await x.rowsOfBatch(batchId);
    expect(rows[0]!.status).toBe('succeeded');
    expect(rows[1]).toMatchObject({
      status: 'failed',
      errors: [{ column: 'Z', reason: 'NOT_SUPPORTED' }],
      employee_id: null,
    });
    expect(await x.employeeCount()).toBe(1);
  });
});

describe('AC-DM-30-F493-40 性别 / 民族 / 政治面貌选项（DEC-840①）', () => {
  it('纯函数：三个常量项数 3 / 60 / 15 且无重复；前后空白去掉后通过；全角、小写报错', () => {
    expect(PROFILE_GENDER_OPTIONS).toHaveLength(3);
    expect(PROFILE_NATION_OPTIONS).toHaveLength(60);
    expect(PROFILE_POLITICAL_STATUS_OPTIONS).toHaveLength(15);
    for (const list of [PROFILE_GENDER_OPTIONS, PROFILE_NATION_OPTIONS, PROFILE_POLITICAL_STATUS_OPTIONS])
      expect(new Set(list).size).toBe(list.length);
    expect(checkProfileOption(PROFILE_GENDER_OPTIONS, ' 男 ')).toMatchObject({ ok: true, value: '男' });
    expect(checkProfileOption(PROFILE_GENDER_OPTIONS, 'Ｍ').ok).toBe(false);
    expect(checkProfileOption(PROFILE_GENDER_OPTIONS, 'm').ok).toBe(false);
  });

  it('11 行批次：成功 3 行、失败 8 行、错误 10 条；失败行零写入', async () => {
    const x = await importWorld(database().db, '40');
    const d = await x.dept('选项部门');
    const cases: [string | null, string | null, string | null][] = [
      ['男', '汉族', '群众'],
      ['M', null, null],
      ['男性', null, null],
      ['abc', null, null],
      [null, '汉', null],
      [null, 'abc', null],
      [null, null, '党员'],
      [null, null, 'abc'],
      [null, null, null],
      ['女', '回族', '中共党员'],
      ['F', 'Han', '团员'],
    ];
    const rows = cases.map(([gender, nation, politicalStatus], i) =>
      x.row(i + 1, d.code, { gender, nation, politicalStatus }),
    );
    const batchId = await x.imported(rows);
    const result = await x.rowsOfBatch(batchId);
    expect(result.map((r) => r.status)).toEqual([
      'succeeded',
      'failed',
      'failed',
      'failed',
      'failed',
      'failed',
      'failed',
      'failed',
      'succeeded',
      'succeeded',
      'failed',
    ]);
    const columnsOf = (no: number) => result[no - 1]!.errors.map((e) => e.column);
    expect([2, 3, 4, 5, 6, 7, 8].map((no) => columnsOf(no))).toEqual([['N'], ['N'], ['N'], ['P'], ['P'], ['Q'], ['Q']]);
    expect(columnsOf(11)).toEqual(['N', 'P', 'Q']);
    for (const no of [2, 3, 4, 5, 6, 7, 8, 11])
      for (const error of result[no - 1]!.errors) expect(error.reason).toBe('OPTION_NOT_FOUND');
    expect(await x.batchOf(batchId)).toMatchObject({ created_count: 3, error_row_count: 8, error_count: 10 });
    // 收尾操作日志：计数按行（8 个失败行），errorReport 按错误条（10 条，每条带原因码），设计 §10.3
    const [log] = await x.q<{ failure_count: number; error_report: { rowIndex: number; reason: string }[] }>(x.sql`
      SELECT failure_count, error_report FROM audit_operation_logs
      WHERE tenant_id=${x.tenantId} AND object_type='exit-import' AND object_id::text=${batchId}`);
    expect(log!.failure_count).toBe(8);
    expect(log!.error_report).toHaveLength(10);
    expect(log!.error_report.map((entry) => entry.rowIndex)).toEqual([1, 2, 3, 4, 5, 6, 7, 10, 10, 10]);
    for (const entry of log!.error_report) expect(entry.reason).toBe('OPTION_NOT_FOUND');
    expect(await x.employeeCount()).toBe(3);
    const profiles = await Promise.all([1, 9, 10].map((no) => x.profileOf(result[no - 1]!.employee_id!)));
    expect(profiles[0]).toMatchObject({ gender: '男', nation: '汉族', political_status: '群众' });
    expect(profiles[1]).toMatchObject({ gender: null, nation: null, political_status: null });
    expect(profiles[2]).toMatchObject({ gender: '女', nation: '回族', political_status: '中共党员' });
    for (const profile of profiles) expect(profile.nationality).toBeNull();
    for (const no of [2, 5, 7, 11]) expect(result[no - 1]!.employee_id).toBeNull();
  });
});
