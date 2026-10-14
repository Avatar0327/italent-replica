import type { PlanStatus, StageStatus } from '@italent/domain';

/** 接口 DTO 的前端形状；字段按服务端字段权限裁剪，任何字段都可能缺失。 */
export interface Stage {
  id: string;
  subProcessId: string;
  seq: number;
  name: string;
  status: StageStatus;
  dueDate?: string | null;
  endedOn?: string | null;
  failureReason?: string | null;
  attemptCount?: number;
}
export interface PlanSummary {
  id: string;
  revision?: number;
  name?: string;
  employeeId?: string;
  templateId?: string;
  processId?: string;
  startDate?: string;
  endDate?: string;
  tutorRole?: string;
  tutorEmployeeId?: string | null;
  status?: PlanStatus;
  currentStageName?: string | null;
  currentNodeName?: string | null;
  stages?: Stage[];
}
export interface PlanModule {
  id: string;
  moduleType: string;
  name: string;
  description?: string | null;
  displayOrder?: number;
}
export interface GoalTask {
  id: string;
  name?: string;
  startDate?: string | null;
  endDate?: string | null;
}
export interface PlanGoal {
  id: string;
  moduleId?: string;
  name?: string;
  measure?: string | null;
  suggestion?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  sourceType?: string;
  indicatorName?: string | null;
  tasks?: GoalTask[];
}
export interface KeyInfoRow {
  id: string;
  [field: string]: unknown;
}
export interface PlanDetail extends PlanSummary {
  createdAt?: string;
  updatedAt?: string;
  modules?: PlanModule[];
  goals?: PlanGoal[];
  keyInfo?: { tutorships?: KeyInfoRow[]; careers?: KeyInfoRow[]; workShifts?: KeyInfoRow[] };
}
export interface SubProcess {
  id?: string;
  seq?: number;
  name?: string;
  category?: string;
  approvalType?: string;
  approvalProcessId?: string;
  endNoticeTemplate?: string | null;
  startMode?: string;
  startTimeType?: string | null;
  fixedDate?: string | null;
  referencePoint?: string | null;
  startFrom?: string | null;
  days?: number | null;
  ruleText?: string;
}
export interface Process {
  id: string;
  revision?: number;
  name?: string;
  orgId?: string;
  publicDown?: boolean;
  enabled?: boolean;
  referenced?: boolean;
  subProcesses?: SubProcess[];
}
export interface TemplateModule extends PlanModule {
  [setting: string]: unknown;
}
export interface Template {
  id: string;
  revision?: number;
  name?: string;
  description?: string | null;
  orgId?: string;
  publicDown?: boolean;
  processId?: string;
  status?: 'draft' | 'published';
  referenced?: boolean;
  modules?: TemplateModule[];
  commonGoals?: { id: string; name?: string; measure?: string | null }[];
}
export interface ApprovalCandidate {
  id: string;
  name: string;
  approvalType?: string;
  nodes: { nodeKey: string; name: string; seq: number }[];
}
export interface Receipt {
  id: string;
  status: number;
  outcome?: string;
  code?: string;
}
