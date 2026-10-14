// F-127b：合同表单纯逻辑（校验、期限联动、回执分流、按钮权限、列表参数）。
// 组件只调用这些函数，浏览器冒烟另在 apps/web/smoke/AC-FE-R2a.smoke.spec.ts。
import { describe, expect, it } from 'vitest';
import {
  availableModes,
  buttonLevel,
  commandFields,
  editableFormFields,
  initialValues,
  linkTerm,
  myPendingTask,
  parseContractReceipt,
  parseSavedReceipt,
  parseSettingsReceipt,
  validateContract,
} from '../../apps/web/src/contracts/forms.js';
import { listPath } from '../../apps/web/src/contracts/model.js';

const source = {
  id: 'source',
  employeeId: 'employee',
  number: 'DEMO-CT-001',
  companyId: 'company',
  typeId: 'type',
  termType: 'fixed',
  termMonths: 12,
  signingDate: '2026-01-01',
  effectiveDate: '2026-01-01',
  endDate: '2026-12-31',
  revision: 3,
  status: 'valid',
};

describe('AC-FE-R2a-10 新签 / 变更 / 续签 / 终止的按钮权限', () => {
  const grants =
    (...codes: string[]) =>
    (button: string, level: string) =>
      codes.includes(`${button}@${level}`);
  it('新签按列表级判断，其余按详情级判断', () => {
    expect(buttonLevel('create')).toBe('list');
    for (const op of ['change', 'renew', 'terminate'] as const) expect(buttonLevel(op)).toBe('detail');
  });
  it('直接办理与提交申请分别对应各自按钮，直接办理在前，无授权不出现', () => {
    expect(availableModes(grants('create@list', 'createApplication@list'), 'create')).toEqual([
      'direct',
      'application',
    ]);
    expect(availableModes(grants('renewApplication@detail'), 'renew')).toEqual(['application']);
    expect(availableModes(grants('change@list'), 'change')).toEqual([]);
    expect(availableModes(grants(), 'terminate')).toEqual([]);
  });
  it('可提交字段 = 本操作字段 ∩ 当前可编辑字段；续签不能改合同类型', () => {
    const editable = (field: string) => field !== 'signingDate';
    expect(editableFormFields('terminate', editable)).toEqual(['actualTerminationDate']);
    expect(editableFormFields('renew', editable)).not.toContain('typeId');
    expect(editableFormFields('change', editable)).toContain('typeId');
    expect(editableFormFields('create', editable)).not.toContain('signingDate');
  });
});

describe('AC-FE-R2a-11 初始值与期限联动', () => {
  it('新签默认固定期限，变更清空生效日期，续签沿用原合同并从原终止日次日起算', () => {
    expect(initialValues('create')).toMatchObject({ termType: 'fixed' });
    expect(initialValues('change', source)).toMatchObject({
      typeId: 'type',
      number: 'DEMO-CT-001',
      effectiveDate: null,
    });
    expect(initialValues('renew', source)).toMatchObject({
      typeId: 'type',
      companyId: 'company',
      termMonths: 12,
      effectiveDate: '2027-01-01',
      endDate: null,
      number: null,
      signingDate: null,
    });
    expect(initialValues('terminate', source)).toEqual({ actualTerminationDate: null });
  });
  it('生效日期或期限月数变化时推算终止日期；改为无固定期限时清空终止日期与月数', () => {
    expect(linkTerm('effectiveDate', { termType: 'fixed', effectiveDate: '2026-02-01', termMonths: 12 })).toEqual({
      endDate: '2027-01-31',
    });
    expect(linkTerm('termMonths', { termType: 'fixed', effectiveDate: '2026-01-31', termMonths: 1 })).toEqual({
      endDate: '2026-02-27',
    });
    expect(linkTerm('termType', { termType: 'indefinite', endDate: '2027-01-01', termMonths: 12 })).toEqual({
      endDate: null,
      termMonths: null,
    });
    expect(linkTerm('termMonths', { termType: 'fixed', termMonths: 12 })).toEqual({});
    expect(linkTerm('termMonths', { termType: 'indefinite', effectiveDate: '2026-01-01', termMonths: 12 })).toEqual({});
    expect(linkTerm('number', { termType: 'fixed', effectiveDate: '2026-01-01', termMonths: 12 })).toEqual({});
  });
});

describe('AC-FE-R2a-12 表单校验与后端规则一致', () => {
  it('新签必填项；自动编号开启时编号可空；固定期限必须有终止日期且晚于生效日期', () => {
    expect(Object.keys(validateContract('create', { termType: 'fixed' }, {})).sort()).toEqual(
      ['companyId', 'effectiveDate', 'endDate', 'number', 'typeId'].sort(),
    );
    const base = { companyId: 'c', typeId: 't', termType: 'fixed', effectiveDate: '2026-01-01' };
    expect(validateContract('create', { ...base, endDate: '2026-12-31' }, { autoNumber: true })).toEqual({});
    expect(validateContract('create', { ...base, endDate: '2026-01-01', number: 'N' }, {})).toHaveProperty('endDate');
    expect(validateContract('create', { ...base, termType: 'task', number: 'N' }, {})).toEqual({});
    expect(
      validateContract('create', { ...base, termType: 'fixed', number: 'N', endDate: '2027-01-01', termMonths: 0 }, {}),
    ).toHaveProperty('termMonths');
  });
  it('自动编号未知时按必填处理（保守）', () => {
    const values = { companyId: 'c', typeId: 't', termType: 'task', effectiveDate: '2026-01-01' };
    expect(validateContract('create', values, {})).toHaveProperty('number');
  });
  it('续签：原合同无终止日期时必须填生效日期；终止：实际终止日期必填且不早于原生效日期', () => {
    expect(validateContract('renew', { termType: 'fixed' }, { source })).toEqual({});
    expect(validateContract('renew', {}, { source: { ...source, endDate: null } })).toHaveProperty('effectiveDate');
    expect(validateContract('terminate', {}, { source })).toHaveProperty('actualTerminationDate');
    expect(validateContract('terminate', { actualTerminationDate: '2025-12-31' }, { source })).toHaveProperty(
      'actualTerminationDate',
    );
    expect(validateContract('terminate', { actualTerminationDate: '2026-01-01' }, { source })).toEqual({});
  });
  it('提交字段规范化：空串转 null，不可为空的字段缺值时不发送', () => {
    expect(
      commandFields({ number: '', effectiveDate: null, signingDate: '', termMonths: null, typeId: 'type' }),
    ).toEqual({
      signingDate: null,
      termMonths: null,
      typeId: 'type',
    });
  });
});

describe('AC-FE-R2a-13 回执按实际返回分流，无效回执进入结果未知', () => {
  const expectation = { employeeId: 'employee', operation: 'renew' as const, sourceId: 'source' };
  it('返回申请时识别为申请，不按提交方式推断', () => {
    const request = {
      id: 'request',
      employeeId: 'employee',
      operation: 'renew',
      mode: 'direct',
      targetId: 'source',
      status: 'approved',
      revision: 1,
    };
    expect(parseContractReceipt(request, expectation)).toMatchObject({ kind: 'request', id: 'request' });
    expect(() => parseContractReceipt({ ...request, operation: 'change' }, expectation)).toThrow();
    expect(() => parseContractReceipt({ ...request, targetId: 'other' }, expectation)).toThrow();
    expect(() => parseContractReceipt({ ...request, status: 'effective' }, expectation)).toThrow();
  });
  it('返回已生效合同时识别为合同；续签 / 变更结果必须是新合同，终止结果必须是原合同', () => {
    const contract = { id: 'next', employeeId: 'employee', status: 'valid', approvalStatus: 'effective', revision: 1 };
    expect(parseContractReceipt(contract, expectation)).toMatchObject({ kind: 'contract', id: 'next' });
    expect(() => parseContractReceipt({ ...contract, id: 'source' }, expectation)).toThrow();
    const terminated = { ...contract, id: 'source', status: 'terminated', revision: 4 };
    expect(parseContractReceipt(terminated, { ...expectation, operation: 'terminate' })).toMatchObject({
      kind: 'contract',
      id: 'source',
    });
    expect(() => parseContractReceipt(contract, { ...expectation, operation: 'terminate' })).toThrow();
  });
  it('员工、ID、revision 缺失或不符一律视为无效回执', () => {
    const contract = { id: 'next', employeeId: 'employee', status: 'valid', approvalStatus: 'effective', revision: 1 };
    for (const broken of [
      { ...contract, employeeId: 'other' },
      { ...contract, id: '' },
      { ...contract, revision: undefined },
      { ...contract, revision: 0 },
      null,
      'ok',
    ])
      expect(() => parseContractReceipt(broken, expectation)).toThrow();
    expect(parseContractReceipt(contract, { employeeId: 'employee', operation: 'create' })).toMatchObject({
      kind: 'contract',
    });
  });
  it('配置保存回执 revision 必须是提交值 + 1，ID 必须对应；设置按租户单例核对', () => {
    expect(parseSavedReceipt({ id: 'rule', revision: 4 }, { id: 'rule', revision: 3 })).toEqual({ id: 'rule' });
    expect(parseSavedReceipt({ id: 'new', revision: 1 }, { revision: 0 })).toEqual({ id: 'new' });
    expect(() => parseSavedReceipt({ id: 'rule', revision: 3 }, { id: 'rule', revision: 3 })).toThrow();
    expect(() => parseSavedReceipt({ id: 'other', revision: 4 }, { id: 'rule', revision: 3 })).toThrow();
    expect(() => parseSavedReceipt({ revision: 1 }, { revision: 0 })).toThrow();
    expect(() =>
      parseSavedReceipt({ id: 'rule', deleted: false, revision: 4 }, { id: 'rule', revision: 3, deleted: true }),
    ).toThrow();
    expect(parseSavedReceipt({ id: 'rule', deleted: true }, { id: 'rule', revision: 3, deleted: true })).toEqual({
      id: 'rule',
    });
    expect(parseSettingsReceipt({ tenantId: 't', revision: 2 }, { tenantId: 't', revision: 1 })).toEqual({ id: 't' });
    expect(() => parseSettingsReceipt({ revision: 2 }, { tenantId: 't', revision: 1 })).toThrow();
    expect(() => parseSettingsReceipt({ tenantId: 't', revision: 1 }, { tenantId: 't', revision: 1 })).toThrow();
  });
});

describe('AC-FE-R2a-14 列表真接口参数与行内审批操作', () => {
  it('筛选、排序参数原样传给接口，空值不发送', () => {
    const url = new URL(
      listPath('valid', 1, 30, {
        keyword: '甲',
        typeId: 'type',
        status: '',
        effectiveFrom: '2026-01-01',
        sort: 'endDate',
        order: 'desc',
      }),
      'https://example.com',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      view: 'valid',
      page: '1',
      pageSize: '15',
      keyword: '甲',
      typeId: 'type',
      effectiveFrom: '2026-01-01',
      sort: 'endDate',
      order: 'desc',
    });
    expect(new URL(listPath('all', 1, 30, {}, 1), 'https://example.com').searchParams.get('pageSize')).toBe('1');
  });
  it('转交只取本人待处理任务', () => {
    const detail = {
      tasks: [
        { id: 'done', status: 'approved', assigneeUserId: 'me' },
        { id: 'other', status: 'pending', assigneeUserId: 'someone' },
        { id: 'mine', status: 'pending', assigneeUserId: 'me' },
      ],
    };
    expect(myPendingTask(detail, 'me')).toBe('mine');
    expect(myPendingTask(detail, undefined)).toBeUndefined();
    expect(myPendingTask({ tasks: [] }, 'me')).toBeUndefined();
  });
});
