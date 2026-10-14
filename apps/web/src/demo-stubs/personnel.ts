/** DEC-456 L2：仅用于缺失筛选契约的合成样例，不混入后端员工列表或档案。 */
export const filterExamples = [
  { id: 'sample-a', name: '合成样例甲', gender: '女', department: '示例研发部', company: '示例公司甲' },
  { id: 'sample-b', name: '合成样例乙', gender: '男', department: '示例人事部', company: '示例公司甲' },
  { id: 'sample-c', name: '合成样例丙', gender: '女', department: '示例人事部', company: '示例公司乙' },
];
export type DemoFilters = Partial<Record<'gender' | 'department' | 'company', string>>;
export function previewFilters(filters: DemoFilters) {
  return filterExamples.filter((row) =>
    Object.entries(filters).every(([key, value]) => !value || row[key as keyof DemoFilters] === value),
  );
}
