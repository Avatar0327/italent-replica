/**
 * F-465a / DEC-763①：人事报表目录与 8 张名册分析报表（规格 35 §2.1 预置报表）。
 * (a) 目录 12 张、无功能权的身份看不到 / 数据接口 403；(b) 数据范围先于分页、total 同谓词、范围为空 fail-closed；
 * (c) 每张报表一个口径用例；(d) 字段权：无权的列整列缺席、导出表头 = 列表列、按无权字段筛选 403。
 * 期望值一律是手写的人员集合（夹具见 AC-HA-F465a-support，租户今天 = 2026-10-06）。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  allow,
  AS_OF,
  CONTRACT_OBJECT,
  deny,
  NEW_REPORT_CODES,
  PERSON_OBJECT,
  RANGE,
  RECORD_OBJECT,
  reportsWorld,
  ROSTER_OBJECT,
  type ReportsWorld,
} from './AC-HA-F465a-support.js';
import { parseCsv, stripBom } from './AC-HA-roster-support.js';

const database = useTestDb();
const sorted = (values: readonly string[]) => [...values].sort();

/** 各报表的默认查询参数（1.07 须带时间范围）。 */
const params = (code: string) => (code === '1.07' ? [RANGE] : []);

describe('AC-HA-F465a 人事报表目录与名册分析报表', () => {
  let w: ReportsWorld;
  const c = (...people: { code: string }[]) => sorted(people.map((person) => person.code));
  beforeAll(async () => {
    w = await reportsWorld(database().db);
  }, 600_000);

  describe('(a) 目录与功能权', () => {
    it('人事管理员看到 12 张预置报表，3 个分组，全部可用，并给出数据接口', async () => {
      const { items } = await w.catalog();
      expect(items).toHaveLength(12);
      expect(items.filter((item) => item.available)).toHaveLength(12);
      expect(new Set(items.map((item) => item.group))).toEqual(new Set(['员工名册分析', '人事报表', '员工花名册']));
      for (const code of NEW_REPORT_CODES) {
        expect(items.find((item) => item.code === code)?.endpoint, code).toBe(
          `/api/tenant/hr-analysis/reports/${code}`,
        );
      }
      expect(items.find((item) => item.code === 'roster')?.endpoint).toBe('/api/tenant/hr-analysis/roster');
      expect(items.find((item) => item.code === 'monthly')?.endpoint).toBe(
        '/api/tenant/analytics/hr-movement/reports/monthly',
      );
      expect(items.find((item) => item.code === 'institution')?.endpoint).toBe(
        '/api/tenant/analytics/hr-movement/reports/institution',
      );
      expect(items.find((item) => item.code === 'quality')?.endpoint).toBe(
        '/api/tenant/analytics/hr-structure/reports/quality',
      );
    });

    it('无花名册查看权：8 张都标不可用并写明原因，数据接口与导出 403', async () => {
      const blind = w.restricted(deny(ROSTER_OBJECT));
      const { items } = await w.catalog(blind);
      for (const code of NEW_REPORT_CODES) {
        const item = items.find((entry) => entry.code === code)!;
        expect(item.available, code).toBe(false);
        expect(item.reason, code).toBeTruthy();
        expect((await blind(w.reportPath(code, ...params(code)))).status, code).toBe(403);
        expect((await w.exported(code, params(code), blind)).status, `${code} 导出`).toBe(403);
      }
    });

    it('缺任职记录对象查看权：1.07 / 1.1.01 / 1.1.02 不可用且 403，其余照常；缺合同对象：只 1.06', async () => {
      const noRecord = w.restricted(deny(RECORD_OBJECT));
      const recordItems = (await w.catalog(noRecord)).items;
      for (const code of ['1.07', '1.1.01', '1.1.02']) {
        expect(recordItems.find((item) => item.code === code)?.available, code).toBe(false);
        expect((await noRecord(w.reportPath(code, ...params(code)))).status, code).toBe(403);
      }
      for (const code of ['1.01', '1.04', '1.05', '1.06', '1.08']) {
        expect(recordItems.find((item) => item.code === code)?.available, code).toBe(true);
        expect((await noRecord(w.reportPath(code))).status, code).toBe(200);
      }
      const noContract = w.restricted(deny(CONTRACT_OBJECT));
      expect((await w.catalog(noContract)).items.find((item) => item.code === '1.06')?.available).toBe(false);
      expect((await noContract(w.reportPath('1.06'))).status).toBe(403);
      expect((await noContract(w.reportPath('1.01'))).status).toBe(200);
    });

    it('有 HrRoster / 合同 / 任职但无员工档案查看权：目录里 8 张新报表与花名册都不可用且 403，其余照常（P2-1）', async () => {
      const noPerson = w.restricted(deny(PERSON_OBJECT));
      const { items } = await w.catalog(noPerson);
      const blocked = [...NEW_REPORT_CODES, 'roster'];
      for (const code of blocked) {
        const item = items.find((entry) => entry.code === code)!;
        expect(item.available, code).toBe(false);
        expect(item.reason, code).toBeTruthy();
      }
      for (const code of NEW_REPORT_CODES) {
        expect((await noPerson(w.reportPath(code, ...params(code)))).status, code).toBe(403);
        expect((await w.exported(code, params(code), noPerson)).status, `${code} 导出`).toBe(403);
      }
      expect((await noPerson('/api/tenant/hr-analysis/roster')).status).toBe(403);
      // 入离职 / 结构报表只按各自的报表对象准入，与员工档案对象无关，目录与入口一致
      for (const code of ['monthly', 'institution', 'quality'])
        expect(items.find((entry) => entry.code === code)?.available, code).toBe(true);
    });

    it('无导出按钮权：列表可读，导出 403；未知报表编码 404', async () => {
      const noExport = w.restricted(
        (request) =>
          !(request.action === 'object.button' && String(request.resource).startsWith(`${ROSTER_OBJECT}#export`)),
      );
      expect((await noExport(w.reportPath('1.01'))).status).toBe(200);
      expect((await w.exported('1.01', [], noExport)).status).toBe(403);
      expect((await w.full(w.reportPath('9.99'))).status).toBe(404);
    });
  });

  describe('(b) 数据范围：先于分页，total 同谓词，空范围 fail-closed', () => {
    const inScope = () => [w.p.old, w.p.intern, w.p.external, w.p.m30, w.p.reg];
    // 各报表在上面 5 人范围内的期望行数（手写）：
    // 1.01 old+reg；1.04 intern；1.05 external；1.08 old+reg+intern；1.1.01 全部 5 人；
    // 1.06 old 签订 + reg 签订 + reg 续签 = 3；1.07（2026 全年）old 调动、intern 入职、external 入职、m30 入职+离职、reg 转正 = 6；
    // 1.1.02 old 入职+调动+兼职、intern、external、m30 入职+离职、reg 入职+转正 = 9
    const expected: Record<string, number> = {
      '1.01': 2,
      '1.04': 1,
      '1.05': 1,
      '1.06': 3,
      '1.07': 6,
      '1.08': 3,
      '1.1.01': 5,
      '1.1.02': 9,
    };

    it.each(NEW_REPORT_CODES)('%s：范围内人员才出现，total = 明细条数，分页不改变 total', async (code) => {
      const request = w.restricted(allow, { personIds: inScope().map((person) => person.id) });
      const page = await w.report(code, [...params(code), 'pageSize=2'], request);
      expect(page.hasDataPermission).toBe(true);
      expect(page.total, `${code} total`).toBe(expected[code]);
      expect(page.items).toHaveLength(Math.min(2, expected[code]!));
      // 读完所有页，行数 = total，且全部属于范围内人员
      const seen: string[] = [];
      for (let number = 1; number <= Math.ceil(expected[code]! / 2); number++) {
        const next = await w.report(code, [...params(code), 'pageSize=2', `page=${number}`], request);
        expect(next.total).toBe(expected[code]);
        seen.push(...w.codesOf(next));
      }
      expect(seen).toHaveLength(expected[code]!);
      const allowed = new Set(inScope().map((person) => person.code));
      for (const value of seen) expect(allowed.has(value), `${code} 范围外工号 ${value}`).toBe(true);
    });

    it.each(NEW_REPORT_CODES)('%s：范围为空 → 0 行、hasDataPermission=false，不回落到“全部”', async (code) => {
      const nobody = w.restricted(allow, { personIds: [] });
      const page = await w.report(code, params(code), nobody);
      expect(page).toMatchObject({ items: [], total: 0, hasDataPermission: false });
      const full = await w.report(code, params(code));
      expect(full.total, `${code} 全量非空`).toBeGreaterThan(0);
      // 导出同样为空（只有表头）
      const csv = parseCsv(stripBom(await (await w.exported(code, params(code), nobody)).text()));
      expect(csv, `${code} 导出`).toHaveLength(1);
    });

    it('筛选命中范围外的人也不泄露（按姓名筛范围外离职者 → 0）', async () => {
      const request = w.restricted(allow, { personIds: [w.p.old.id] });
      for (const code of ['1.01', '1.08', '1.1.01']) {
        const page = await w.report(code, [`name=${encodeURIComponent('范围外离职')}`], request);
        expect(page.total, code).toBe(0);
      }
    });
  });

  describe('(c) 各报表口径', () => {
    it('1.01 在职员工花名册：正式在职内部员工，不含实习生、外部人员、离职 / 退休；按 asOf 取时点', async () => {
      const page = await w.report('1.01', [`asOf=${AS_OF}`, 'pageSize=200']);
      expect(sorted(w.codesOf(page))).toEqual(c(w.p.base, w.p.old, w.p.oct1, w.p.reg, w.p.orgAdj));
      expect(page.total).toBe(5);
      const earlier = await w.report('1.01', ['asOf=2026-09-30', 'pageSize=200']);
      expect(sorted(w.codesOf(earlier))).toEqual(c(w.p.base, w.p.old, w.p.reg, w.p.orgAdj));
    });

    it('1.04 实习人员花名册：只有在职实习生', async () => {
      const page = await w.report('1.04', [`asOf=${AS_OF}`]);
      expect(sorted(w.codesOf(page))).toEqual(c(w.p.intern));
    });

    it('1.05 外部人员花名册：只有在职外部人员（已离职的外部人员不出现）', async () => {
      const page = await w.report('1.05', [`asOf=${AS_OF}`]);
      expect(sorted(w.codesOf(page))).toEqual(c(w.p.external));
    });

    it('1.06 合同（协议）台账：在职员工签订 / 续签的合同，带操作类型；离职员工、未签合同的人不出现', async () => {
      const page = await w.report('1.06', [`asOf=${AS_OF}`, 'pageSize=200']);
      const rows = page.items.map((item) => `${item.code}:${item.operation}`);
      expect(sorted(rows)).toEqual(
        sorted([
          `${w.p.old.code}:create`,
          `${w.p.reg.code}:create`,
          `${w.p.reg.code}:renew`,
          `${w.p.base.code}:create`,
        ]),
      );
      expect(page.total).toBe(4);
      expect(page.columns.map((column) => column.key)).toEqual(
        expect.arrayContaining(['employeeName', 'code', 'number', 'operation', 'effectiveDate', 'endDate']),
      );
    });

    it('1.07 异动人员明细：按时间范围 + 类别（入职 / 转正 / 调动 / 离职）取人，离职按最后工作日', async () => {
      const by = async (category: string, range = RANGE) =>
        sorted(w.codesOf(await w.report('1.07', [range, `category=${category}`, 'pageSize=200'])));
      expect(await by('transfer')).toEqual(c(w.p.old)); // 转正 / 组织调整引起的部门变化不算调动
      expect(await by('regularization')).toEqual(c(w.p.reg));
      // 退休与离职同为离职类（与人事看板“离职”同口径）
      expect(await by('leave')).toEqual(c(w.p.jan31, w.p.m30, w.p.m31, w.p.extLeave, w.p.hidden, w.p.retired));
      // 入职：2026 年内入职的（不含 2025 年入职者）
      expect(await by('entry')).toEqual(
        c(w.p.m30, w.p.m31, w.p.oct1, w.p.intern, w.p.external, w.p.extLeave, w.p.hidden, w.p.base),
      );
      // 时间范围收窄到 3 月：m30 的入职（3-01）+ 离职（最后工作日 3-31）
      const march = 'from=2026-03-01&to=2026-03-31';
      const all = await w.report('1.07', [march, 'pageSize=200']);
      expect(all.items.map((item) => `${item.code}:${item.category}`).sort()).toEqual(
        sorted([`${w.p.m30.code}:entry`, `${w.p.m31.code}:entry`, `${w.p.m30.code}:leave`]),
      );
      // 缺时间范围 / 范围颠倒 / 未知类别 → 400
      expect((await w.full(w.reportPath('1.07'))).status).toBe(400);
      expect((await w.full(w.reportPath('1.07', 'from=2026-10-01&to=2026-01-01'))).status).toBe(400);
      expect((await w.full(w.reportPath('1.07', RANGE, 'category=other'))).status).toBe(400);
    });

    it('1.08 在职全部人员明细（时点）：在职内部员工 + 实习生，不含外部人员', async () => {
      const page = await w.report('1.08', [`asOf=${AS_OF}`, 'pageSize=200']);
      expect(sorted(w.codesOf(page))).toEqual(c(w.p.base, w.p.old, w.p.oct1, w.p.reg, w.p.orgAdj, w.p.intern));
    });

    it('1.1.01 全部员工名册：在职、离职（含退休）员工的最新一条任职记录，含实习生与外部人员，每人一行', async () => {
      const page = await w.report('1.1.01', ['pageSize=200']);
      const everyone = [...Object.values(w.p).filter((person) => 'code' in person)] as { code: string }[];
      expect(sorted(w.codesOf(page))).toEqual(c(...everyone));
      expect(new Set(w.codesOf(page)).size).toBe(page.total);
      // 离职员工取到的是离职那条最新记录
      const left = page.items.find((item) => item.code === w.p.m30.code)!;
      expect(left.employeeStatus).toBe(8); // 8 = 离职
    });

    it('1.1.02 员工任职信息：历史全部任职记录（含兼职），每条一行，带服务类型与起止日期', async () => {
      const page = await w.report('1.1.02', [`name=${encodeURIComponent('老员工')}`, 'pageSize=200']);
      expect(page.items.map((item) => `${item.serviceType}:${item.kind}:${item.startDate}`).sort()).toEqual(
        ['primary:hire:2025-01-10', 'primary:transfer:2026-05-01', 'part_time:part_time:2026-09-10'].sort(),
      );
      const oldHistory = page.items.filter((item) => item.serviceType === 'primary');
      // 版本链：上一条的结束日 = 下一条的开始日前一天，最后一条开放
      expect(oldHistory.map((item) => item.endDate)).toEqual(['2026-04-30', null]);
      expect(page.columns.map((column) => column.key)).not.toContain('previousDepartment'); // 不建“变更前”列
    });
  });

  describe('(d) 字段权：整列缺席、导出 = 列表列、无权字段筛选 403', () => {
    it('1.01：无手机 / 证件号码 / 个人邮箱查看权 → 行键与列都缺席，导出表头 = 列表列，且不含明文', async () => {
      const blind = w.restricted(allow, {
        hidden: { [PERSON_OBJECT]: ['mobilePhone', 'idNumber', 'backupMail', 'email'] },
      });
      const page = await w.report('1.01', [`asOf=${AS_OF}`], blind);
      for (const item of page.items) {
        for (const key of ['mobilePhone', 'idNumber', 'backupMail']) expect(item, key).not.toHaveProperty(key);
        expect(item).toHaveProperty('employeeName');
      }
      const labels = page.columns.map((column) => column.label);
      expect(labels).not.toEqual(expect.arrayContaining(['手机']));
      expect(labels).not.toContain('证件号码');
      const csv = parseCsv(stripBom(await (await w.exported('1.01', [`asOf=${AS_OF}`], blind)).text()));
      expect(csv[0]).toEqual(labels);
      expect(csv).toHaveLength(page.total + 1);
      expect((await blind(w.reportPath('1.01', 'email=anyone@example.com'))).status).toBe(403);
    });

    it('1.06：无合同编号 / 终止日期字段权 → 这两列缺席；按合同编号筛选 403；导出表头 = 列表列', async () => {
      const blind = w.restricted(allow, { hidden: { [CONTRACT_OBJECT]: ['number', 'endDate'] } });
      const page = await w.report('1.06', [`asOf=${AS_OF}`], blind);
      expect(page.total).toBe(4);
      for (const item of page.items) {
        expect(item).not.toHaveProperty('number');
        expect(item).not.toHaveProperty('endDate');
        expect(item).toHaveProperty('effectiveDate');
      }
      const csv = parseCsv(stripBom(await (await w.exported('1.06', [`asOf=${AS_OF}`], blind)).text()));
      expect(csv[0]).toEqual(page.columns.map((column) => column.label));
      expect((await blind(w.reportPath('1.06', 'number=C-001'))).status).toBe(403);
    });

    it('1.07 / 1.1.02：任职记录“生效日期”无字段权 → 日期列整列缺席，导出表头 = 列表列', async () => {
      const blind = w.restricted(allow, { hidden: { [RECORD_OBJECT]: ['effectiveDate'] } });
      for (const code of ['1.07', '1.1.02']) {
        const page = await w.report(code, [...params(code), 'pageSize=200'], blind);
        expect(page.total, code).toBeGreaterThan(0);
        for (const item of page.items) {
          expect(item, code).not.toHaveProperty('startDate');
          expect(item, code).not.toHaveProperty('endDate');
          expect(item, code).not.toHaveProperty('date');
        }
        const csv = parseCsv(stripBom(await (await w.exported(code, params(code), blind)).text()));
        expect(csv[0], code).toEqual(page.columns.map((column) => column.label));
      }
    });
  });
});
