import { describe, expect, it } from 'vitest';
import { OFFER_VIEWS } from '@italent/domain';
import { displayValue, listPath, readActions, filterOptions, type OfferRow } from '../../apps/web/src/offers/model.js';
import { detailSections, viewSpecs } from '../../apps/web/src/offers/messages.js';
import { settings } from '../../apps/web/src/offers/settings-messages.js';
import { offerRow } from '../../apps/web/smoke/offer-list-fixture.js';

// F-298 取代演示状态机与本地筛选；原列序、设置与只读边界继续回归。
describe('AC-FE-R2b1 真实读口接入后的展示契约', () => {
  it('十视图列序列宽保留，视图编码与服务端定义相同', () => {
    expect(viewSpecs).toHaveLength(10);
    expect(viewSpecs.map((v) => ({ key: v.key, columns: v.columns }))).toEqual(
      OFFER_VIEWS.map((v) => ({ key: v.key, columns: v.columns.map((c) => [c.label, c.width]) })),
    );
  });
  it('AC-OF-16/19 行操作采用服务端裁剪结果，缺失写动作不自行推算补回', () => {
    for (const status of ['pending', 'sent', 'accepted', 'rejected', 'onboarded', 'invalid']) {
      const row = { id: offerRow.id, status, rowActions: { primary: [], menu: ['view'] } } satisfies OfferRow;
      const actions = readActions(row);
      expect([...actions.primary, ...actions.menu]).not.toContain('transfer');
      expect([...actions.primary, ...actions.menu]).not.toContain('invalidate');
      expect([...actions.primary, ...actions.menu].includes('viewMail')).toBe(status !== 'pending');
      expect(row.rowActions).toEqual({ primary: [], menu: ['view'] });
    }
    expect(readActions({ id: offerRow.id })).toEqual({ primary: [], menu: [] });
  });
  it('F-319 六组名称与 ID 分离，null 或裁剪不能回落 UUID，部门全称不拼接', () => {
    for (const [label, id, name] of [
      ['录用部门', 'departmentId', 'departmentName'],
      ['组织全称', 'departmentId', 'departmentFullName'],
      ['录用职位', 'positionId', 'positionName'],
      ['职务', 'postId', 'postName'],
      ['Offer发送人', 'sentBy', 'sentByName'],
      ['直线经理', 'directManagerId', 'directManagerName'],
    ]) {
      const row: OfferRow = { ...offerRow, rowActions: undefined };
      expect(displayValue(row, label!)).toBe(row[name!]);
      expect(displayValue({ ...row, [name!]: null }, label!)).toBe('--');
      delete row[id!];
      expect(displayValue(row, label!)).toBe('--');
    }
  });
  it('服务器分页与 ID 筛选，不把名称当查询值；拒绝历史不出现在详情字段中', () => {
    const rows: OfferRow[] = [{ ...offerRow, rowActions: undefined }];
    const [entry] = filterOptions(rows, '部门');
    expect(entry).toEqual({ value: offerRow.departmentId, label: offerRow.departmentName });
    const url = new URL(listPath('unsubmitted', 2, { departmentId: entry! }), 'http://example.com');
    expect(url.searchParams.get('departmentId')).toBe(offerRow.departmentId);
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('pageSize')).toBe('15');
    expect(detailSections.flatMap((s) => s.fields).some((label) => /拒绝|备注/.test(label))).toBe(false);
  });
  it('设置目录顺序按截图，8项Offer加13项入职；只保留设置合成样例', () => {
    expect(settings.filter((s) => s.group === 'Offer管理').map((s) => s.id)).toEqual([
      'reasons',
      'sync',
      'edit-send',
      'headcount',
      'templates',
      'validity',
      'authorization',
      'matching',
    ]);
    expect(settings.filter((s) => s.group === '入职')).toHaveLength(13);
    expect(settings.filter((s) => s.rows).every((s) => s.rows!.length >= 2 && s.rows!.length <= 3)).toBe(true);
  });
});
