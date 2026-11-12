export interface Region {
  code: string;
  parentCode: string | null;
  level: number;
  name: string;
}
export function parseRegions(html: string): Region[];
export function verifySource(bytes: Buffer): Region[];
export function seedBlock(records: Region[], part: number, size?: number): string;
