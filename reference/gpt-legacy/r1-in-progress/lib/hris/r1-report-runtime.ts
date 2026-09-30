import {env} from 'cloudflare:workers';
import {HttpError} from './http';
import type {ReportObjectStore} from './r1-report-csv';
// No scheduler/queue credentials or external endpoint is assumed. Platform capability remains an explicit dependency.
export const reportRuntimeCapability={available:false,reasonCode:'DEP-PLATFORM-01',state:'blocked_runtime'} as const;
export function reportObjectStore():ReportObjectStore{const bucket=(env as unknown as {BUCKET?:R2Bucket}).BUCKET;if(!bucket)throw new HttpError(503,'文件存储尚未配置','REPORT_STORAGE_UNAVAILABLE');return {async put(key,bytes){await bucket.put(key,bytes as unknown as ArrayBuffer,{httpMetadata:{contentType:'text/csv; charset=utf-8'}});},async get(key){const object=await bucket.get(key);return object?new Uint8Array(await object.arrayBuffer()):null;}};}
