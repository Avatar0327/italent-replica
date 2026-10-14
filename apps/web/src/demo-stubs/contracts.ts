// DEC-456：独立合成数据，不补入服务端记录，也不声明为原站业务规则。
// 只保留后端尚未提供的能力：导出（以合成样例演示文件格式）。姓名 / 邮箱 / 工号（#316）与电子协议签署列在列表中留空。
const rows = [
  { number: 'DEMO-CT-A', name: '合成甲', email: 'demo-a@example.com', code: 'DEMO-001', effectiveDate: '2026-01-01' },
  { number: 'DEMO-CT-B', name: '合成乙', email: 'demo-b@example.com', code: 'DEMO-002', effectiveDate: '2025-01-01' },
];
export function demoCsv() {
  const keys = Object.keys(rows[0]!);
  const cell = (input: unknown) => `"${String(input ?? '').replaceAll('"', '""')}"`;
  return (
    '﻿' +
    [keys, ...rows.map((row) => keys.map((key) => row[key as keyof typeof row]))]
      .map((row) => row.map(cell).join(','))
      .join('\r\n')
  );
}
