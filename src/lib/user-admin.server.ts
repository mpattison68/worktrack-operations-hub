import { createClient } from '@supabase/supabase-js';
import { getRequestHeader, setResponseHeader } from '@tanstack/react-start/server';
export async function authorizedAdmin(businessId: string, action: string) {
 setResponseHeader('Cache-Control','no-store');
 const url=process.env['SUPABASE_URL'], key=process.env['SUPABASE_PUBLISHABLE_KEY'], service=process.env['SUPABASE_SERVICE_ROLE_KEY'];
 if(!url || !key || !service) throw new Error('User administration is not configured on this server.');
 const bearer=getRequestHeader('authorization');
 if(!bearer?.startsWith('Bearer ')) throw new Error('Sign in required.');
 const userClient=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},global:{headers:{Authorization:bearer}}});
 const {data,error}=await userClient.auth.getUser(bearer.slice(7));
 if(error || !data.user) throw new Error('Session expired. Sign in again.');
 const epoch=await userClient.from('businesses').select('data_epoch').eq('id',businessId).single();
 if(epoch.error) throw new Error('Active business access required.');
 const scoped=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},global:{headers:{Authorization:bearer,'x-worktrack-epoch':String(epoch.data.data_epoch)}}});
 const authorization=await scoped.rpc('worktrack_authorize_admin_operation',{p_business:businessId,p_action:action});
 if(authorization.error) throw new Error('Admin permission required or user-change limit reached.');
 // Privileged client is constructed only after active Admin authorization.
 const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
 return {userClient:scoped,admin,userId:data.user.id};
}
