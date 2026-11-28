import { createMiddleware } from '@tanstack/react-start';
import { supabase } from '@/lib/supabase';
export const attachWorktrackBearer = createMiddleware({type:'function'}).client(async ({next}) => {
 if (typeof window === 'undefined' || !supabase) return next();
 const {data} = await supabase.auth.getSession();
 return next({headers:data.session?{Authorization:`Bearer ${data.session.access_token}`}:{}});
});
