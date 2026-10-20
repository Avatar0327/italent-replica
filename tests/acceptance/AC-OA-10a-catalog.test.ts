/**
 * R2-T08 BE-10a：状态枚举与 §4.5 静态命名空间字段编码目录（纯函数，无数据库）。
 * 字段目录只是编码与类型 formFields，本批不挂到权限对象（A-14 取证后随 BE-10a2）。
 */
import {
  contractChangeFieldCode,
  ORG_ADJUSTMENT_APPROVAL_STATUS,
  ORG_ADJUSTMENT_CONTRACT_CONTAINER,
  ORG_ADJUSTMENT_EXECUTION_STATUS,
  ORG_ADJUSTMENT_FORM_FIELDS,
  ORG_ADJUSTMENT_HEADER_FIELDS,
  ORG_ADJUSTMENT_SECTION_FIELDS,
  ORG_ADJUSTMENT_STATUS_FILTERS,
  ORG_ADJUSTMENT_AUDIT_ACTIONS,
  auditFieldLabel,
  auditObjectMeta,
  auditReferenceKind,
  parseContractChangeFieldCode,
  statusFilterApprovalStatus,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';

describe('状态枚举（§2.1 / §3，DEC-526④）', () => {
  it('审批状态 0～6、执行状态 1～3，数值与规格 33 补充节一致', () => {
    expect(ORG_ADJUSTMENT_APPROVAL_STATUS).toEqual({
      staged: 0,
      reviewing: 1,
      approved: 2,
      notApproved: 3,
      effective: 4,
      voided: 5,
      rejected: 6,
    });
    expect(ORG_ADJUSTMENT_EXECUTION_STATUS).toEqual({ pending: 1, executed: 2, executing: 3 });
  });

  it('列表下拉 8 项；“草稿”“已暂存”都筛 0，“生效”筛 4', () => {
    expect(ORG_ADJUSTMENT_STATUS_FILTERS.map((f) => f.label)).toEqual([
      '草稿',
      '已暂存',
      '审批中',
      '审批通过',
      '审批未通过',
      '生效',
      '作废',
      '已驳回',
    ]);
    const byLabel = Object.fromEntries(ORG_ADJUSTMENT_STATUS_FILTERS.map((f) => [f.label, statusFilterApprovalStatus(f.code)]));
    expect(byLabel).toMatchObject({ 草稿: 0, 已暂存: 0, 审批中: 1, 审批通过: 2, 审批未通过: 3, 生效: 4, 作废: 5, 已驳回: 6 });
    expect(new Set(ORG_ADJUSTMENT_STATUS_FILTERS.map((f) => f.code)).size).toBe(8);
    expect(statusFilterApprovalStatus('no_such')).toBeNull();
  });
});

describe('静态命名空间字段编码目录（§4.5）', () => {
  it('头字段不含 scopeNote（A-9 字段关闭）；每个分区的字段都带分区前缀且互不重复', () => {
    expect(ORG_ADJUSTMENT_HEADER_FIELDS).toEqual(
      expect.arrayContaining(['subject', 'effectiveDate', 'approvalSubjectOrgId', 'content']),
    );
    expect(ORG_ADJUSTMENT_HEADER_FIELDS).not.toContain('scopeNote');
    const sections = Object.keys(ORG_ADJUSTMENT_SECTION_FIELDS);
    expect(sections).toEqual(['orgItems', 'transferItems', 'positionItems', 'establishmentItems', 'partTimeItems']);
    for (const [section, fields] of Object.entries(ORG_ADJUSTMENT_SECTION_FIELDS)) {
      expect(fields.every((code) => code.startsWith(`${section}.`)), section).toBe(true);
      expect(new Set(fields).size).toBe(fields.length);
    }
    expect(ORG_ADJUSTMENT_SECTION_FIELDS.orgItems).toEqual(
      expect.arrayContaining(['orgItems.name', 'orgItems.parentOrgId', 'orgItems.personInChargeId']),
    );
    expect(ORG_ADJUSTMENT_SECTION_FIELDS.transferItems).toEqual(
      expect.arrayContaining([
        'transferItems.departmentId',
        'transferItems.directManagerId',
        'transferItems.dutyTransfer',
        'transferItems.trial',
        'transferItems.adjustSalary',
      ]),
    );
  });

  it('类型 formFields = 头字段 + 五个分区的静态字段 + 合同变更容器；编码全局唯一', () => {
    expect(ORG_ADJUSTMENT_CONTRACT_CONTAINER).toBe('transferItems.contractChange');
    expect(ORG_ADJUSTMENT_FORM_FIELDS).toEqual([
      ...ORG_ADJUSTMENT_HEADER_FIELDS,
      ...Object.values(ORG_ADJUSTMENT_SECTION_FIELDS).flat(),
      ORG_ADJUSTMENT_CONTRACT_CONTAINER,
    ]);
    expect(new Set(ORG_ADJUSTMENT_FORM_FIELDS).size).toBe(ORG_ADJUSTMENT_FORM_FIELDS.length);
  });

  it('合同变更编码带明细身份：transferItems.<itemId>.contractChange.<field>，可往返解析', () => {
    const itemId = '7f3a0c1e-5b2d-4e8f-9a61-0d4c2b7e9f10';
    const code = contractChangeFieldCode(itemId, 'endDate');
    expect(code).toBe(`transferItems.${itemId}.contractChange.endDate`);
    expect(parseContractChangeFieldCode(code)).toEqual({ itemId, field: 'endDate' });
    expect(parseContractChangeFieldCode('transferItems.departmentId')).toBeNull();
    expect(parseContractChangeFieldCode(`transferItems.not-a-uuid.contractChange.endDate`)).toBeNull();
    expect(parseContractChangeFieldCode(`transferItems.${itemId}.contractChange.`)).toBeNull();
    expect(() => contractChangeFieldCode('not-a-uuid', 'endDate')).toThrow();
  });
});

describe('审计标签（§9.4）', () => {
  it('登记对象类型、动作与字段中文名', () => {
    expect(auditObjectMeta('org-adjustment')).toEqual({ label: '组织调整申请', app: '组织员工' });
    expect(auditObjectMeta('org-adjustment-item')).toEqual({ label: '组织调整明细', app: '组织员工' });
    expect(ORG_ADJUSTMENT_AUDIT_ACTIONS).toEqual([
      'org-adjustment.create',
      'org-adjustment.update',
      'org-adjustment.void',
      'org-adjustment.submit',
      'org-adjustment.withdraw',
      'org-adjustment.rebase',
      'org-adjustment.item.create',
      'org-adjustment.item.update',
      'org-adjustment.item.delete',
      'org-adjustment.approved',
      'org-adjustment.rejected',
      'org-adjustment.disapproved',
      'org-adjustment.execution.scheduled',
      'org-adjustment.execution.started',
      'org-adjustment.execution.group.succeeded',
      'org-adjustment.execution.group.failed',
      'org-adjustment.execution.group.retry',
      'org-adjustment.execution.takeover',
      'org-adjustment.execution.completed',
    ]);
    expect(auditFieldLabel('subject')).toBe('调整主题');
    expect(auditFieldLabel('approvalSubjectOrgId')).toBe('审批主体组织');
    expect(auditFieldLabel('executionNote')).toBe('执行备注');
    expect(auditReferenceKind('approvalSubjectOrgId')).toBe('org');
  });
});
