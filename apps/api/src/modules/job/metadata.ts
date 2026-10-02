import { AppError } from '../../errors.js';

export const JOB_KINDS = [
  'layers',
  'grades',
  'level-types',
  'levels',
  'sequences',
  'professional-lines',
  'posts',
  'positions',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const SEQUENCE_ANCESTORS = [
  'firstSequenceId',
  'secondSequenceId',
  'thirdSequenceId',
  'fourthSequenceId',
  'fifthSequenceId',
  'sixthSequenceId',
  'seventhSequenceId',
  'eighthSequenceId',
  'ninthSequenceId',
  'tenthSequenceId',
] as const;

const common = ['code', 'name', 'startDate', 'stopDate', 'enabled', 'establishedOn', 'displayOrder', 'qualificationId'];
const ranges = ['levelTypeId', 'minLevelId', 'maxLevelId', 'minGradeId', 'maxGradeId'];
const assignment = [
  'sequenceId',
  'professionalLineId',
  ...ranges,
  'isKey',
  'isConfidential',
  'syncSequenceToAssignments',
];

interface JobTables {
  readonly objectTable: string;
  readonly versionTable: string;
  readonly importTarget: string;
  readonly fields: readonly string[];
}

function tables(stem: string, importTarget: string, fields: readonly string[]): JobTables {
  return {
    objectTable: `job_${stem}_objects`,
    versionTable: `job_${stem}_versions`,
    importTarget,
    fields: [...common, ...fields],
  };
}

const catalog: Record<JobKind, JobTables> = {
  layers: tables('layer', 'layerId', ['layerLevel']),
  grades: tables('grade', 'gradeId', ['grade', 'scoreLow', 'scoreHigh', 'layerId']),
  'level-types': tables('level_type', 'levelTypeId', []),
  levels: tables('level', 'levelId', ['level', 'levelTypeId', 'minGradeId', 'maxGradeId']),
  sequences: tables('sequence', 'sequenceId', [
    'parentId',
    'level',
    ...SEQUENCE_ANCESTORS,
    'levelTypeId',
    'source',
    'externalId',
  ]),
  'professional-lines': tables('professional_line', 'professionalLineId', ['parentId', 'level']),
  posts: tables('post', 'postId', [
    ...assignment,
    'competencyModelId',
    'responsibilities',
    'requirements',
    'evaluationScore',
  ]),
  positions: tables('position', 'positionId', [
    ...assignment,
    'orgId',
    'postId',
    'directParentId',
    'dottedParentId',
    'directSequence',
    'dottedSequence',
    'standardPositionId',
    'workLocation',
  ]),
};

/** 动态 SQL 只能从这份静态白名单取得表和列，不能接受客户端表名。 */
export function jobTables(kind: JobKind): JobTables {
  if (!Object.hasOwn(catalog, kind)) throw new AppError('VALIDATION_FAILED', '职务对象类型不合法');
  return catalog[kind];
}

export function columnName(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
