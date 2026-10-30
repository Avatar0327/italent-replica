/** F-323（DEC-706）：人员类别预置 8 条，按 17 §F-323 只读取证；presetKey 只供种子补装识别，不冒充原站编码。 */
export const EMPLOYMENT_TYPE_PRESETS = [
  { presetKey: 'yg_regular', name: 'YG正式员工', displayOrder: 1, effectiveDate: '2026-05-22' },
  { presetKey: 'back_office', name: '职能后台', displayOrder: 1, effectiveDate: '2018-01-01' },
  { presetKey: 'marketing', name: '市场运营', displayOrder: 2, effectiveDate: '2018-01-01' },
  { presetKey: 'yg_probation', name: 'YG试用员工', displayOrder: 2, effectiveDate: '2026-05-22' },
  { presetKey: 'yg_campus', name: 'YG校招生', displayOrder: 3, effectiveDate: '2026-05-22' },
  { presetKey: 'engineering', name: '技术开发', displayOrder: 3, effectiveDate: '2018-01-01' },
  { presetKey: 'yg_resigned', name: 'YG辞职员工', displayOrder: 4, effectiveDate: '2026-05-22' },
  { presetKey: 'operations', name: '运维服务', displayOrder: 4, effectiveDate: '2018-01-01' },
].map((item) => ({ ...item, expiryDate: '9999-12-31', enabled: true }));

/** 设置页三个视图：启用 / 停用 / 全部人员类别。 */
export const EMPLOYMENT_TYPE_VIEWS = ['enabled', 'disabled', 'all'] as const;
export type EmploymentTypeView = (typeof EMPLOYMENT_TYPE_VIEWS)[number];
