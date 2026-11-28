import {dehydrate,hydrate,type QueryClient,type DehydratedState} from '@tanstack/react-query';
import type {AuthSession} from '@/lib/domain/types';
import {getPartitionMeta,setPartitionMeta} from '@/lib/offline/idb-store';
export async function startReferenceCache(session:AuthSession,client:QueryClient):Promise<()=>Promise<void>>{
 if(session.mode!=='supabase')return async()=>{};
 const epoch=await getPartitionMeta(session.businessId,session.userId,'dataEpoch');
 const saved=await getPartitionMeta(session.businessId,session.userId,'references');
 if(saved){try{const parsed=JSON.parse(saved) as {epoch:string;cache:DehydratedState};if(parsed.epoch===epoch)hydrate(client,parsed.cache);}catch{/* Corrupt cache is not authoritative. */}}
 let stopped=false,timer:ReturnType<typeof setTimeout>|null=null,writes:Promise<void>=Promise.resolve();
 const unsubscribe=client.getQueryCache().subscribe(()=>{
  if(stopped)return;if(timer)clearTimeout(timer);
  timer=setTimeout(()=>{
   if(stopped)return;
   const cache=dehydrate(client,{shouldDehydrateQuery:q=>q.state.status==='success'&&q.queryKey.includes(session.businessId),shouldDehydrateMutation:()=>false});
   writes=writes.then(()=>setPartitionMeta(session.businessId,session.userId,'references',JSON.stringify({epoch,cache}))).catch(()=>{});
  },200);
 });
 return async()=>{stopped=true;unsubscribe();if(timer)clearTimeout(timer);await writes;};
}
