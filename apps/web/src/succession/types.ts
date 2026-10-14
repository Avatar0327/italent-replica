// 继任接口的视图类型（apps/api/src/modules/succession；隐藏字段在响应里缺省，不是 null）。
export type SuccessionType = 'position' | 'org';
export interface PersonView {
  employeeId: string;
  name: string;
  email?: string;
  label?: string;
}
export interface ReadinessRef {
  id: string;
  code?: string;
  name: string;
  color: string;
}
export interface RecordView {
  id: string;
  revision: number;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  successionType: SuccessionType;
  targetOrgId?: string;
  targetPositionId?: string;
  successorEmployeeId?: string;
  readinessId?: string | null;
  backupType?: string;
  startDate?: string;
  endDate?: string | null;
  endReason?: string | null;
  status?: 'active' | 'ended';
  successor?: PersonView | null;
  successorLeft?: boolean;
  readiness?: ReadinessRef | null;
  targetOrg?: { id: string; name: string };
  targetPosition?: { id: string; name: string; orgId?: string };
  personInCharge?: PersonView | null;
  incumbents?: PersonView[];
}
export interface ListResult<T> {
  items: T[];
  total?: number;
  hasDataPermission?: boolean;
}
export interface LevelResult {
  id?: string;
  levelId?: string | null;
  levelName?: string | null;
  levelColor?: string | null;
  revision?: number;
}
export interface MapSuccessor {
  id: string;
  successor?: PersonView | null;
  readiness?: ReadinessRef | null;
}
export interface MapItem {
  id: string;
  name: string;
  parentId: string | null;
  orgId?: string;
  incumbents?: PersonView[];
  personInCharge?: PersonView | null;
  successors?: MapSuccessor[];
  successorCount?: number;
  risk?: LevelResult | null;
  health?: LevelResult | null;
  stats?: { onDutyCount?: number | null; greenRate?: number | null; capacity?: string | number | null };
}
export interface MapResult {
  asOf?: string;
  hasDataPermission?: boolean;
  items: MapItem[];
}
export interface Preferences {
  rootOrgId: string | null;
  depth: number;
  hiddenOrgIds: string[];
  showKeyPositions: boolean;
  showPositionsWithoutSuccessor: boolean;
  revision: number;
}
export interface LevelOption {
  id: string;
  name: string;
  color: string;
}
