export interface Region {
  code: string;
  parentCode: string | null;
  level: number;
  name: string;
}
export interface SlicePlan {
  total: number;
  levels: number[];
  slices: { count: number; sha256: string }[];
}
export function parseRegions(html: string): Region[];
export function verifySource(bytes: Buffer): Region[];
export function seedBlock(records: Region[], part: number, size?: number): string;
export function verifySlices(blocks: string[], plan?: SlicePlan): { total: number; levels: number[]; parts: number };
