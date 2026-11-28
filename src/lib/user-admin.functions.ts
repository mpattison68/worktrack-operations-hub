import {createServerFn} from '@tanstack/react-start';
import {z} from 'zod';
import {attachWorktrackBearer} from '@/lib/admin-auth';
const schema=z.object({businessId:z.uuid(),email:z.email(),fullName:z.string().trim().min(1).max(200),role:z.enum(['admin','owner','supervisor']),jobs:z.array(z.uuid()).max(100),password:z.string().min(12).max(128).optional()});
export const createBusinessUser=createServerFn({method:'POST'}).middleware([attachWorktrackBearer]).inputValidator((data:unknown)=>schema.parse(data)).handler(async({data})=>{
 const {authorizedAdmin}=await import('@/lib/user-admin.server');
 const {userClient,admin}=await authorizedAdmin(data.businessId,'create_user');
 // Verify job references before making Auth changes.
 if(data.jobs.length){
  const jobs=await userClient.from('jobs').select('id').eq('business_id',data.businessId).in('id',data.jobs);
  if(jobs.error || jobs.data.length!==data.jobs.length) throw new Error('One or more jobs are not authorized.');
 }
 const created=data.password ? await admin.auth.admin.createUser({email:data.email,password:data.password,email_confirm:true,user_metadata:{full_name:data.fullName}}) : await admin.auth.admin.inviteUserByEmail(data.email,{data:{full_name:data.fullName}});
 if(created.error || !created.data.user) throw new Error('Account creation failed. If the email already exists, use its existing membership; no account was overwritten.');
 const user=created.data.user;
 const linked=await userClient.rpc('worktrack_manage_membership',{p_business:data.businessId,p_user:user.id,p_role:data.role,p_active:true,p_jobs:data.jobs,p_name:data.fullName});
 if(linked.error){
  const cleanup=await admin.auth.admin.deleteUser(user.id);
  throw new Error(cleanup.error?'Membership linking failed and new-account cleanup needs administrator attention.':'Membership linking failed; the newly created account was removed.');
 }
 return {userId:user.id,invitationSent:!data.password};
});
export const recoverBusinessPassword=createServerFn({method:'POST'}).middleware([attachWorktrackBearer]).inputValidator((data:unknown)=>z.object({businessId:z.uuid(),userId:z.uuid(),password:z.string().min(12).max(128)}).parse(data)).handler(async({data})=>{
 const {authorizedAdmin}=await import('@/lib/user-admin.server');
 const {userClient,admin}=await authorizedAdmin(data.businessId,'password_recovery');
 const member=await userClient.from('memberships').select('user_id').eq('business_id',data.businessId).eq('user_id',data.userId).single();
 if(member.error) throw new Error('User is not a member of this business.');
 const result=await admin.auth.admin.updateUserById(data.userId,{password:data.password});
 if(result.error) throw new Error('Password recovery failed.');
 // Revocation of existing sessions is separately required by GoTrue: membership
 // deactivation revokes Data API access immediately; password-reset flow uses
 // global logout on the affected user's next authenticated password change.
 return {changed:true};
});
