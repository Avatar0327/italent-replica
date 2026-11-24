// 关闭调动自动带出且填写调入部门时，其他可继承字段的数据库编码。
const deferred = [
  'positionId',
  'postId',
  'levelId',
  'gradeId',
  'place',
  'directManagerId',
  'dottedManagerId',
  'employmentType',
  'employmentSource',
  'workYearCompanyBefore',
  'employmentForm',
  'sequenceId',
  'professionalLineId',
  'isKeyPerson',
  'dimension1',
  'dimension2',
  'dimension3',
  'dimension4',
  'dimension5',
  'jobNumber',
  'remarks',
]
  .map((name) => `preset:${name}`)
  .sort();

export function transferDeferredExcept(...fields: string[]): string[] {
  return deferred.filter((code) => !fields.includes(code));
}
