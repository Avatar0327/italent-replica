import { tr } from '../talent-review/messages.js';
// DEC-456②：独立合成样例，只用于 PR-C / PR-D 暂停区域；禁止充当真实接口失败后的回退结果。
export const reviewDemo = {
  people: [
    {
      id: 'demo-person',
      employee: tr.objectName,
      qualification: tr.missing,
      category: tr.missing,
      level: tr.missing,
      status: tr.states.in_progress,
      currentStep: tr.sampleStep,
      executor: tr.demoManager,
      calcStatus: tr.uncalculated,
      calcMessage: tr.pending,
      report: tr.missing,
    },
  ],
  indicators: [
    {
      id: 'demo-indicator',
      employee: tr.objectName,
      department: tr.orgName,
      module: tr.module,
      indicator: tr.sampleIndicator,
      weight: '100%',
      score: '4.4',
      finalScore: '4.4',
      grade: tr.missing,
      finalGrade: tr.missing,
    },
  ],
  meetings: [
    {
      id: 'demo-meeting',
      name: tr.demoMeeting,
      ownerOrgId: tr.orgName,
      project: tr.demoProject,
      owner: tr.demoManager,
      date: '2026-10-20',
      committee: tr.missing,
      status: tr.enabled,
    },
  ],
  cells: [
    { number: 6, label: tr.cellLow, tone: 'blue' },
    { number: 8, label: tr.cellHigh, tone: 'green' },
    { number: 9, label: tr.cellHigh, tone: 'green' },
    { number: 3, label: tr.cellLow, tone: 'blue' },
    { number: 5, label: tr.cellMedium, tone: 'blue' },
    { number: 7, label: tr.cellHigh, tone: 'green' },
    { number: 1, label: tr.cellLow, tone: 'blue' },
    { number: 2, label: tr.cellLow, tone: 'blue' },
    { number: 4, label: tr.cellLow, tone: 'blue' },
  ],
};
