// F-132 第 1 段（FE-R1a）：组织与职务页面按原站核对后的字段排布、筛选与按钮规则。
// 原站列、详情分区、表单字段顺序见 PR 对照表；原站有而接口未返回的列（在岗人数、胜任力等）不展示，列入后端缺口清单。
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const org = () => import(resolve('apps/web/src/org/page-model.ts'));
const job = () => import(resolve('apps/web/src/job/page-model.ts'));
const ALL = [
  'code',
  'name',
  'fullName',
  'location',
  'broadType',
  'establishedOn',
  'startDate',
  'stopDate',
  'enabled',
  'remarks',
  'effectiveDate',
  'parents',
  'grade',
  'layerId',
  'scoreLow',
  'scoreHigh',
  'layerLevel',
  'level',
  'levelTypeId',
  'minGradeId',
  'maxGradeId',
  'minLevelId',
  'maxLevelId',
  'parentId',
  'source',
  'externalId',
  'displayOrder',
  'sequenceId',
  'professionalLineId',
  'orgId',
  'postId',
  'workLocation',
  'standardPositionId',
  'isKey',
  'isConfidential',
  'responsibilities',
  'requirements',
  'evaluationScore',
];
function permission(viewable: string[], editable = viewable, update = true) {
  return {
    objectCode: 'TenantBase.Position',
    dataOperations: { update },
    viewableFields: viewable,
    editableFields: editable,
    buttons: [{ buttonCode: 'update', level: 'detail' }],
  };
}

describe('AC-FE-R1a-21 职务体系各类列表列按原站', () => {
  it('六类已核对视图按原站列顺序，不再有状态、失效日期列；未截到的两类保持原列', async () => {
    const { jobListFields } = await job();
    const { pageAccess } = await org();
    const access = pageAccess(permission(ALL));
    expect(jobListFields('sequences', access)).toEqual([
      'name',
      'parentId',
      'levelTypeId',
      'displayOrder',
      'startDate',
    ]);
    expect(jobListFields('level-types', access)).toEqual(['name', 'displayOrder', 'startDate']);
    expect(jobListFields('grades', access)).toEqual(['grade', 'name', 'layerId', 'scoreHigh', 'scoreLow', 'startDate']);
    expect(jobListFields('levels', access)).toEqual(['levelTypeId', 'name', 'level', 'minGradeId', 'maxGradeId']);
    expect(jobListFields('posts', access)).toEqual([
      'code',
      'name',
      'sequenceId',
      'levelTypeId',
      'minLevelId',
      'maxLevelId',
    ]);
    expect(jobListFields('positions', access)).toEqual([
      'code',
      'name',
      'postId',
      'orgId',
      'sequenceId',
      'levelTypeId',
      'minLevelId',
      'maxLevelId',
      'displayOrder',
    ]);
    expect(jobListFields('layers', access)).toEqual(['code', 'name', 'layerLevel', 'enabled', 'startDate', 'stopDate']);
  });
  it('无查看权的字段不出列（反向）', async () => {
    const { jobListFields } = await job();
    const { pageAccess } = await org();
    expect(jobListFields('positions', pageAccess(permission(['name', 'code'])))).toEqual(['code', 'name']);
    expect(jobListFields('grades', pageAccess(undefined))).toEqual([]);
  });
  it('同一字段在不同对象下用原站叫法', async () => {
    const { jobLabel } = await job();
    expect(jobLabel('levels', 'minGradeId')).toBe('开始职等');
    expect(jobLabel('levels', 'maxGradeId')).toBe('结束职等');
    expect(jobLabel('posts', 'minGradeId')).toBe('最低职等');
    expect(jobLabel('sequences', 'parentId')).toBe('上级序列');
    expect(jobLabel('sequences', 'levelTypeId')).toBe('关联职级类别');
    expect(jobLabel('positions', 'sequenceId')).toBe('职位序列');
    expect(jobLabel('posts', 'sequenceId')).toBe('职务序列');
    expect(jobLabel('posts', 'isKey')).toBe('关键职务');
    expect(jobLabel('positions', 'isConfidential')).toBe('是否涉密职位');
  });
});

describe('AC-FE-R1a-22 职位列表按所属组织筛选', () => {
  const filters = { asOf: '2026-10-14', page: 1, pageSize: 15, name: '', enabled: 'true', orgId: 'org-a' };
  it('职位查询带所属组织；其他对象不带', async () => {
    const { jobCatalogQuery } = await job();
    expect(jobCatalogQuery('positions', filters)).toBe('asOf=2026-10-14&page=1&pageSize=15&enabled=true&orgId=org-a');
    expect(jobCatalogQuery('posts', filters)).toBe('asOf=2026-10-14&page=1&pageSize=15&enabled=true');
  });
  it('清空组织不带参数；全部状态改为包含停用', async () => {
    const { jobCatalogQuery } = await job();
    expect(jobCatalogQuery('positions', { ...filters, orgId: undefined, enabled: '', name: '合成' })).toBe(
      'asOf=2026-10-14&page=1&pageSize=15&name=%E5%90%88%E6%88%90&includeDisabled=true',
    );
  });
});

describe('AC-FE-R1a-23 职务、职位表单按原站分组与排序', () => {
  it('职务：编码在前，含关键 / 涉密职务；职责说明单独成组', async () => {
    const { jobFormGroups } = await job();
    expect(jobFormGroups('posts')).toEqual([
      {
        key: 'basic',
        fields: [
          'code',
          'name',
          'establishedOn',
          'sequenceId',
          'levelTypeId',
          'minLevelId',
          'maxLevelId',
          'evaluationScore',
          'isKey',
          'isConfidential',
          'displayOrder',
          'professionalLineId',
          'minGradeId',
          'maxGradeId',
          'stopDate',
          'enabled',
        ],
      },
      { key: 'duty', fields: ['responsibilities', 'requirements'] },
    ]);
  });
  it('职位表单：上级职位、虚线上级排在基本信息里，汇报关系只在详情分区；未截到表单的对象保持原顺序', async () => {
    const { jobFormGroups, jobLabel } = await job();
    const groups = jobFormGroups('positions');
    expect(groups.map((group: { key: string }) => group.key)).toEqual(['basic']);
    expect(groups[0].fields.slice(0, 15)).toEqual([
      'code',
      'name',
      'establishedOn',
      'orgId',
      'workLocation',
      'postId',
      'sequenceId',
      'levelTypeId',
      'minLevelId',
      'maxLevelId',
      'adminParent',
      'isKey',
      'dottedParent',
      'isConfidential',
      'displayOrder',
    ]);
    expect(groups[0].fields).toEqual(
      expect.arrayContaining(['adminSequence', 'dottedSequence', 'stopDate', 'enabled']),
    );
    const formLabels = groups[0].fields.map((field: string) => jobLabel('positions', field, 'form'));
    expect(formLabels).toEqual(expect.arrayContaining(['上级职位', '虚线上级']));
    expect(formLabels).not.toContain('直线上级');
    expect(jobLabel('positions', 'adminParent')).toBe('直线上级');
    expect(jobFormGroups('grades')).toEqual([
      {
        key: 'basic',
        fields: [
          'name',
          'code',
          'grade',
          'scoreLow',
          'scoreHigh',
          'layerId',
          'displayOrder',
          'establishedOn',
          'stopDate',
          'enabled',
        ],
      },
    ]);
  });
  it('关键 / 涉密按布尔值提交，未选择不发送', async () => {
    const { jobBody } = await job();
    expect(jobBody('posts', { name: '合成职务', isKey: true, isConfidential: false }, undefined, '2026-10-14')).toEqual(
      { name: '合成职务', isKey: true, isConfidential: false },
    );
    expect(jobBody('posts', { name: '合成职务', isKey: undefined }, undefined, '2026-10-14')).toEqual({
      name: '合成职务',
    });
  });
});

describe('AC-FE-R1a-24 职务、职位详情按原站分区', () => {
  const position = Object.fromEntries(ALL.map((field) => [field, 'x']));
  const values = { ...position, adminParent: 'p', adminSequence: 1, dottedParent: null, dottedSequence: null };
  it('职位详情：基本信息按原站顺序，汇报关系单独分区', async () => {
    const { jobDetailSections } = await job();
    const { pageAccess } = await org();
    const sections = jobDetailSections('positions', pageAccess(permission(ALL)), values);
    expect(sections.map((section: { key: string }) => section.key)).toEqual(['basic', 'reporting']);
    expect(sections[0].fields.slice(0, 15)).toEqual([
      'code',
      'name',
      'establishedOn',
      'orgId',
      'workLocation',
      'postId',
      'sequenceId',
      'levelTypeId',
      'minLevelId',
      'maxLevelId',
      'isKey',
      'isConfidential',
      'displayOrder',
      'enabled',
      'startDate',
    ]);
    expect(sections[1].fields).toEqual(['adminParent', 'adminSequence', 'dottedParent', 'dottedSequence']);
  });
  it('无上级查看权时不出汇报关系分区；接口未返回的字段不展示（反向）', async () => {
    const { jobDetailSections } = await job();
    const { pageAccess } = await org();
    const hidden = ALL.filter((field) => field !== 'parents');
    const sections = jobDetailSections('positions', pageAccess(permission(hidden)), { name: '合成职位' });
    expect(sections).toEqual([{ key: 'basic', fields: ['name'] }]);
  });
  it('职务详情的职责描述与任职要求放在「职位说明」分区（原站叫法）', async () => {
    const { pageText } = await import(resolve('apps/web/src/job/messages.ts'));
    expect(pageText.duty).toBe('职位说明');
    const { jobDetailSections } = await job();
    const { pageAccess } = await org();
    const sections = jobDetailSections('posts', pageAccess(permission(ALL)), position);
    expect(sections[1]).toEqual({ key: 'duty', fields: ['responsibilities', 'requirements'] });
  });
});

describe('AC-FE-R1a-25 组织列表与详情字段按原站', () => {
  it('列表按原站列序，不再有状态列；详情组织全称放最后', async () => {
    const { orgListFields, orgDetailFields, pageAccess } = await org();
    const access = pageAccess(permission(ALL));
    expect(orgListFields(access)).toEqual([
      'code',
      'name',
      'fullName',
      'location',
      'broadType',
      'establishedOn',
      'startDate',
      'stopDate',
    ]);
    expect(orgDetailFields(pageAccess(permission([...ALL, 'personInChargeId'])))).toEqual([
      'code',
      'name',
      'location',
      'broadType',
      'establishedOn',
      'startDate',
      'stopDate',
      'enabled',
      'personInChargeId',
      'fullName',
      'remarks',
    ]);
    expect(orgListFields(pageAccess(permission(['name'])))).toEqual(['name']);
  });
  it('列表与详情各用原站叫法', async () => {
    const { orgLabel } = await org();
    expect(orgLabel('code', 'list')).toBe('机构ID');
    expect(orgLabel('code', 'detail')).toBe('机构ID');
    expect(orgLabel('establishedOn', 'list')).toBe('建立日期');
    expect(orgLabel('establishedOn', 'detail')).toBe('设立日期');
    expect(orgLabel('stopDate', 'list')).toBe('禁用日期');
    expect(orgLabel('stopDate', 'detail')).toBe('失效日期');
    expect(orgLabel('location', 'list')).toBe('所在城市');
    expect(orgLabel('location', 'detail')).toBe('所在地点');
    expect(orgLabel('fullName', 'detail')).toBe('组织全称');
    expect(orgLabel('enabled', 'detail')).toBe('状态');
    expect(orgLabel('personInChargeId', 'detail')).toBe('负责人');
  });
});

describe('AC-FE-R1a-26 组织行操作与详情按钮共用权限判定', () => {
  const row = { id: 'org', revision: 1, enabled: true };
  it('有更新权且字段可编辑：编辑、变更、停用', async () => {
    const { orgActions, pageAccess } = await org();
    expect(orgActions(pageAccess(permission(ALL)), row)).toEqual(['edit', 'change', 'disable']);
    expect(orgActions(pageAccess(permission(ALL)), { ...row, enabled: false })).toEqual(['edit', 'change']);
  });
  it('无更新权一律不出按钮；缺字段编辑权去掉对应按钮（反向）', async () => {
    const { orgActions, pageAccess } = await org();
    expect(orgActions(pageAccess(permission(ALL, ALL, false)), row)).toEqual([]);
    expect(orgActions(pageAccess(undefined), row)).toEqual([]);
    const noEffective = ALL.filter((field) => field !== 'effectiveDate');
    expect(orgActions(pageAccess(permission(ALL, noEffective)), row)).toEqual(['edit']);
    const noEstablished = ALL.filter((field) => field !== 'establishedOn');
    expect(orgActions(pageAccess(permission(ALL, noEstablished)), row)).toEqual(['change', 'disable']);
  });
});

describe('AC-FE-R1a-31 组织详情展示负责人，按字段查看权裁剪', () => {
  it('无负责人查看权时详情不出该字段（反向）', async () => {
    const { orgDetailFields, pageAccess } = await org();
    const hidden = ALL.filter((field) => field !== 'personInChargeId');
    expect(orgDetailFields(pageAccess(permission([...ALL, 'personInChargeId'])))).toContain('personInChargeId');
    expect(orgDetailFields(pageAccess(permission(hidden)))).not.toContain('personInChargeId');
  });
});

describe('AC-FE-R1a-30 组织新建、新建下级按权限出入口，请求体带行政维度上级', () => {
  const fields = [...ALL, 'shortName', 'personInChargeId', 'hrbpId'];
  function access(editable = fields, create = true, buttons = [{ buttonCode: 'create', level: 'list' }]) {
    return {
      objectCode: 'TenantBase.Organization',
      dataOperations: { create },
      viewableFields: fields,
      editableFields: editable,
      buttons,
    };
  }
  it('有新建权、列表新建按钮且名称与上级可编辑时才出新建 / 新建下级', async () => {
    const { orgCreatable, pageAccess } = await org();
    expect(orgCreatable(pageAccess(access()))).toBe(true);
    expect(orgCreatable(pageAccess(access(fields, false)))).toBe(false);
    expect(orgCreatable(pageAccess(access(fields, true, [])))).toBe(false);
    expect(orgCreatable(pageAccess(access(fields.filter((field) => field !== 'parents'))))).toBe(false);
    expect(orgCreatable(pageAccess(access(fields.filter((field) => field !== 'name'))))).toBe(false);
    expect(orgCreatable(pageAccess(undefined))).toBe(false);
  });
  it('请求体按接口字段组装：名称去空格、ID 小写、空值不发、上级放进 parents.admin', async () => {
    const { orgCreateBody } = await org();
    const parent = 'AAAAAAAA-0000-4000-8000-000000000001';
    expect(
      orgCreateBody({
        name: ' 合成新组织 ',
        shortName: '合成',
        code: '',
        establishedOn: '2026-10-12',
        adminParent: parent,
        personInChargeId: 'BBBBBBBB-0000-4000-8000-000000000002',
        hrbpId: undefined,
        location: null,
      }),
    ).toEqual({
      name: '合成新组织',
      shortName: '合成',
      establishedOn: '2026-10-12',
      personInChargeId: 'bbbbbbbb-0000-4000-8000-000000000002',
      parents: { admin: { parentId: parent.toLowerCase() } },
    });
  });
});

describe('AC-FE-R1a-33 无名称查看权时不按名称筛选', () => {
  it('职务体系查询不带 name', async () => {
    const { jobCatalogQuery } = await job();
    const filters = { asOf: '2026-10-14', page: 1, pageSize: 15, name: '合成', enabled: 'true' };
    expect(jobCatalogQuery('posts', filters, false)).toBe('asOf=2026-10-14&page=1&pageSize=15&enabled=true');
    expect(jobCatalogQuery('posts', filters)).toContain('name=');
  });
  it('组织查询不带 name', async () => {
    const { orgCatalogQuery } = await org();
    const filters = {
      asOf: '2026-10-14',
      dimension: 'admin',
      page: 1,
      pageSize: 15,
      includeDisabled: false,
      name: '合成',
    };
    expect(orgCatalogQuery(filters, false)).toBe(
      'asOf=2026-10-14&dimension=admin&page=1&pageSize=15&includeDisabled=false',
    );
    expect(orgCatalogQuery(filters, true)).toBe(
      'asOf=2026-10-14&dimension=admin&page=1&pageSize=15&includeDisabled=false&name=%E5%90%88%E6%88%90',
    );
  });
});
