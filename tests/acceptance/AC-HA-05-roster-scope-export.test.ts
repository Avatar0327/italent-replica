/**
 * BE-12a / AC-HA-05 + 导出：时点花名册的功能权、数据范围、字段权与 CSV 导出。
 * 列表与导出同一套过滤——管理单元内人员（范围外不出现、不计入总数）、字段无权的列在行里缺席、在 CSV 表头里也缺席；
 * 导出的行与列不得多于同一用户同一查询的列表。
 */
import './support/exit-gate-enforced.js';
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_OBJECT,
  parseCsv,
  stripBom,
  PERSON_OBJECT,
  RECORD_OBJECT,
  ROSTER_HEADERS,
  ROSTER_OBJECT,
  rosterWorld,
} from './AC-HA-roster-support.js';

const database = useTestDb();
const ASOF = '2025-07-01';
const SECRET = { mobilePhone: '13900000009', idNumber: '110101199001010099', email: 'secret@example.com' };

async function fixture(label: string) {
  const w = await rosterWorld(database().db, label);
  const dept = await w.org('范围部门');
  const mine = await w.hire('HE0001', '范围内甲', '2025-01-01', dept, SECRET);
  const other = await w.hire('HE0002', '范围外乙', '2025-01-01', dept, {
    mobilePhone: '13900000008',
    idNumber: '110101199001010088',
  });
  await w.contract(mine.id, { effectiveDate: '2025-01-01', endDate: '2025-12-31' });
  return { w, mine, other };
}

const allow: Authorizer = () => true;
/** 只拒绝指定对象的按钮 / 查看权（其余放行）。 */
const deny =
  (...resources: string[]): Authorizer =>
  (request) =>
    !(resources.includes(String(request.resource)) && ['object.view', 'object.button'].includes(request.action));

describe('AC-HA-05 数据范围与字段权', () => {
  it('HRBP 只见管理单元内人员：范围外不出现、不计入总数；范围为空 fail-closed', async () => {
    const { w, mine } = await fixture('ha05-scope');
    const hrbp = w.restricted(allow, { personIds: [mine.id] });
    const page = await w.rosterOk(ASOF, '', hrbp);
    expect(w.codes(page)).toEqual(['HE0001']);
    expect(page.total).toBe(1);
    expect(page.hasDataPermission).toBe(true);
    const full = await w.rosterOk(ASOF);
    expect(w.codes(full)).toEqual(['HE0001', 'HE0002']);

    const nobody = w.restricted(allow, { personIds: [] });
    expect(await w.rosterOk(ASOF, '', nobody)).toMatchObject({ items: [], total: 0 });
    // 筛选命中范围外的人也不泄露
    expect(await w.rosterOk(ASOF, 'name=' + encodeURIComponent('范围外乙'), hrbp)).toMatchObject({ total: 0 });
  });

  it('无敏感字段（手机 / 证件号码 / 个人邮箱）查看权：行里键缺席；筛选敏感字段 403；其余列照常', async () => {
    const { w } = await fixture('ha05-fields');
    const blind = w.restricted(allow, { hidden: { [PERSON_OBJECT]: ['mobilePhone', 'idNumber', 'email'] } });
    const page = await w.rosterOk(ASOF, '', blind);
    expect(page.items).toHaveLength(2);
    for (const item of page.items) {
      for (const key of ['mobilePhone', 'idNumber', 'email']) expect(item, key).not.toHaveProperty(key);
      expect(item).toHaveProperty('employeeName');
    }
    expect(JSON.stringify(page)).not.toContain(SECRET.mobilePhone);
    expect(page.columns.map((column) => column.label)).not.toEqual(expect.arrayContaining(['手机', '证件号码']));
    expect((await w.roster(ASOF, 'email=secret@example.com', blind)).status).toBe(403);
    const sighted = await w.rosterOk(ASOF);
    expect(sighted.items[0]).toMatchObject(SECRET);
  });

  it('任职 / 合同对象无查看权：对应列整体缺席（不是 null），其余列照常', async () => {
    const { w } = await fixture('ha05-objects');
    const noContract = w.restricted(deny(CONTRACT_OBJECT));
    const noRecord = w.restricted(deny(RECORD_OBJECT));
    const labels = async (request: typeof noContract) =>
      (await w.rosterOk(ASOF, '', request)).columns.map((column) => column.label);
    const noContractLabels = await labels(noContract);
    expect(noContractLabels).not.toContain('合同类型');
    expect(noContractLabels).toContain('组织全称');
    const noRecordLabels = await labels(noRecord);
    for (const label of ['职级', '直线经理', '工作地点', '组织全称', '一级组织'])
      expect(noRecordLabels, label).not.toContain(label);
    expect(noRecordLabels).toContain('合同类型');
    const row = (await w.rosterOk(ASOF, '', noRecord)).items[0]!;
    expect(row).not.toHaveProperty('orgFullName');
    expect(row).not.toHaveProperty('directManagerName');
  });

  it('没有“人事分析 - 时点名册”查看权 403；没有人员信息查看权 403', async () => {
    const { w } = await fixture('ha05-perm');
    expect((await w.roster(ASOF, '', w.restricted(deny(ROSTER_OBJECT)))).status).toBe(403);
    expect((await w.roster(ASOF, '', w.restricted(deny(PERSON_OBJECT)))).status).toBe(403);
  });
});

describe('BE-12a 导出：同步 CSV（UTF-8 带 BOM），与列表同一套过滤', () => {
  it('列与行与列表一致：表头 = 姓名 / 工号 + 49 列；值与列表逐项相同；带 BOM 与附件头', async () => {
    const { w, mine } = await fixture('ha05-export');
    const response = await w.exported(ASOF);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="[^"]+\.csv"$/);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = parseCsv(new TextDecoder().decode(bytes.slice(3)));
    expect(lines[0]).toEqual(['姓名', '工号', ...ROSTER_HEADERS]);
    expect(lines).toHaveLength(3);
    const list = await w.rosterOk(ASOF);
    expect(lines.slice(1).map((line) => line[1])).toEqual(w.codes(list));
    const first = lines[1]!;
    expect(first[0]).toBe('范围内甲');
    expect(first[lines[0]!.indexOf('手机')]).toBe(SECRET.mobilePhone);
    expect(first[lines[0]!.indexOf('合同类型')]).toBe('劳动合同');
    expect(first[lines[0]!.indexOf('人员状态')]).toBe('正式');
    expect(list.items[0]!.employeeId).toBe(mine.id);
  });

  it('不导出比列表更多的行或列：范围外人员、无权字段列都不在 CSV 里；筛选与列表一致', async () => {
    const { w, mine } = await fixture('ha05-export-scope');
    const hrbp = w.restricted(allow, {
      personIds: [mine.id],
      hidden: { [PERSON_OBJECT]: ['mobilePhone', 'idNumber', 'email'] },
    });
    const response = await w.exported(ASOF, '', hrbp);
    expect(response.status, await response.clone().text()).toBe(200);
    const text = await response.text();
    const lines = parseCsv(stripBom(text));
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toContain('手机');
    expect(lines[0]).not.toContain('证件号码');
    expect(lines[0]).not.toContain('个人邮箱');
    expect(lines[1]![0]).toBe('范围内甲');
    for (const secret of [...Object.values(SECRET), '范围外乙', '13900000008']) expect(text).not.toContain(secret);
    const filtered = await w.exported(ASOF, 'name=' + encodeURIComponent('不存在'));
    expect(parseCsv(stripBom(await filtered.text()))).toHaveLength(1);
  });

  it('导出另需“导出”按钮权；没有按钮权 403，列表照常可用', async () => {
    const { w } = await fixture('ha05-export-button');
    const noExport = w.restricted(deny(`${ROSTER_OBJECT}#export@list`));
    expect((await w.exported(ASOF, '', noExport)).status).toBe(403);
    expect((await w.roster(ASOF, '', noExport)).status).toBe(200);
  });

  it('CSV 公式注入防护：单元格以 = + - @ 开头时前置单引号；含逗号 / 引号 / 换行的值按 RFC 4180 加引号', async () => {
    const w = await rosterWorld(database().db, 'ha05-csv');
    const dept = await w.org('公式部门');
    await w.hire('HF0001', '=cmd|calc', '2025-01-01', dept, { emergencyContact: '甲,"乙"\n丙' });
    const lines = parseCsv(stripBom(await (await w.exported(ASOF)).text()));
    expect(lines[1]![0]).toBe("'=cmd|calc");
    expect(lines[1]![lines[0]!.indexOf('紧急联系人')]).toBe('甲,"乙"\n丙');
  });
});
