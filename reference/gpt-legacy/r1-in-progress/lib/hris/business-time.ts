/** China business dates; this pure helper is safe to share between server and client. */
export const businessDate=(at=new Date().toISOString())=>new Date(new Date(at).getTime()+8*3600_000).toISOString().slice(0,10);
