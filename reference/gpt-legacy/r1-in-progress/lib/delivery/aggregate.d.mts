export type Criterion={id:string;text:string;accepted:boolean;acceptedBy?:string;acceptedAt?:string;evidence?:string};
export type Task={id:string;phase:string;moduleId:string;title:string;queueRef?:string;criteria:Criterion[];source:string;dimensions?:{requirements:string;development:string;testing:string;production:string}};
export type QueueItem={id:string;status:string;next:string;acceptance?:string;recoveryCondition?:string;dependencies?:string[]};
export type Row=Task&{execution:QueueItem|undefined;status:string;accepted:boolean};
export const statuses:string[];
export function aggregate(scope:{acceptanceTasks:Task[]},queue:{controllerQueue:QueueItem[]}):{tasks:Row[];total:number;accepted:number;percent:number|null;counts:Record<string,number>;phases:{id:string;total:number;accepted:number;percent:number|null;counts:Record<string,number>}[];blockers:QueueItem[]};
