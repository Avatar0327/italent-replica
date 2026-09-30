/** One authority generation owns all sensitive portal data and object URLs. No browser storage. */
export class PortalCache<T>{
 generation=0;authorizationRevision:number|null=null;data:T|null=null;private controllers=new Set<AbortController>();private urls=new Set<string>();
 begin(){const controller=new AbortController();this.controllers.add(controller);return {generation:this.generation,controller};}
 accept(request:{generation:number;controller:AbortController},data:T,authorizationRevision:number){this.controllers.delete(request.controller);if(request.generation!==this.generation||request.controller.signal.aborted)return false;if(this.authorizationRevision!==null&&this.authorizationRevision!==authorizationRevision){this.clear();return false;}this.authorizationRevision=authorizationRevision;this.data=data;return true;}
 addObjectUrl(url:string){this.urls.add(url);}
 clear(revoke:(url:string)=>void=url=>URL.revokeObjectURL(url)){this.generation++;for(const c of this.controllers)c.abort();this.controllers.clear();for(const url of this.urls)revoke(url);this.urls.clear();this.data=null;this.authorizationRevision=null;}
 failed(status?:number){void status;this.clear();}
}
