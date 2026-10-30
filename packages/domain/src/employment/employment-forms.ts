/** F-321，02 只读取证 d30d14d4a；编码为复刻稳定编码，不冒充原站业务编码。 */
export const EMPLOYMENT_FORM_CATEGORIES = [
  { code: 1, name: '正式员工' },
  { code: 2, name: '劳务' },
  { code: 3, name: '实习' },
  { code: 4, name: '外部' },
] as const;

export const EMPLOYMENT_FORM_PRESETS = [
  { code: 'third_party', name: '第三方员工', category: 2, displayOrder: 0, effectiveDate: '2025-01-01' },
  { code: 'regular', name: '正式员工', category: 1, displayOrder: 0, effectiveDate: '2023-11-20' },
  { code: 'temporary', name: '临时工', category: 2, displayOrder: 0, effectiveDate: '2024-08-09' },
  { code: 'intern', name: '实习生', category: 3, displayOrder: 0, effectiveDate: '2023-11-20' },
  { code: 'outsourced', name: '外包人员', category: 4, displayOrder: 0, effectiveDate: '2023-11-20' },
  { code: 'hourly', name: '小时工', category: 4, displayOrder: 0, effectiveDate: '2002-01-01' },
  { code: 'consultant', name: '顾问', category: 1, displayOrder: 0, effectiveDate: '2024-09-28' },
  { code: 'part_time', name: '兼职人员', category: 2, displayOrder: 0, effectiveDate: '2025-06-29' },
  { code: 'full_time', name: '全日制用工方式', category: null, displayOrder: 1, effectiveDate: '2018-01-01' },
  { code: 'non_full_time', name: '非全日制用工方式', category: null, displayOrder: 2, effectiveDate: '2018-01-01' },
  { code: 'dispatch', name: '劳务派遣', category: 2, displayOrder: 3, effectiveDate: '2022-02-07' },
].map((item) => ({ ...item, expiryDate: '9999-12-31', enabled: true }));
