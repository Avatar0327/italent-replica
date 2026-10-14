export type Collection = 'projects' | 'templates' | 'matrices';
export interface ReviewRecord {
  id: string;
  revision?: number;
  name?: string;
  code?: string;
  accessLevel?: string;
  status?: string;
  ownerOrgId?: string;
  year?: number;
  period?: string;
  periodStartDate?: string;
  periodEndDate?: string;
  enabled?: boolean;
  [key: string]: unknown;
}
export const objects = {
  projects: 'TalentReview.Project',
  templates: 'TalentReview.Template',
  matrices: 'TalentReview.Matrix',
} as const;
export type ProjectAction = 'update' | 'start' | 'end' | 'restart';
