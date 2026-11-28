import { startReferenceCache } from "@/lib/offline/reference-cache";
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getPartitionMeta, setPartitionMeta, clearPartition } from "@/lib/offline/idb-store";
import { isSupabaseConfigured, supabase, setClientDataEpoch } from "@/lib/supabase";
import { listSyntheticAccounts } from "@/lib/data/repository";
import type { AuthSession } from "@/lib/domain/types";

const SYNTHETIC_SESSION_KEY = "worktrack_synthetic_session_v1";

interface AuthContextValue {
  session: AuthSession | null;
  loading: boolean;
  isOnline: boolean;
  backendMode: "supabase" | "synthetic_dev" | "unconfigured";
  connectionState: "checking" | "connected" | "offline" | "error";
  signInWithPassword: (email: string, password: string) => Promise<void>;
  signInSynthetic: (membershipId: string) => void;
  signOut: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

async function hydrateSupabaseSession(): Promise<AuthSession | null> {
  if (!supabase) return null;
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const {data} = await supabase.auth.getSession();
    const user = data.session?.user;
    if (!user) return null;
    // This snapshot enables offline capture only; every online RPC reauthorizes.
    const businessId = await getPartitionMeta('auth',user.id,'lastBusiness');
    const cached = businessId ? await getPartitionMeta(businessId,user.id,'authSnapshot') : null;
    return cached ? JSON.parse(cached) as AuthSession : null;
  }
  const {data:{user},error:authError} = await supabase.auth.getUser();
  if (authError?.name === "AuthSessionMissingError") return null;
  if (authError && authError.status !== 401 && authError.status !== 403) throw new Error('Authentication service unavailable.');
  if (!user) return null;
  const { data: membership, error } = await supabase
    .from("memberships")
    .select("business_id, role, assigned_job_ids, full_name, businesses(name,data_epoch)")
    .eq("user_id", user.id)
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("Business membership could not be loaded.");
  if (!membership) return null;
  const bizField = membership.businesses as { name?: string; data_epoch?: number } | Array<{ name?: string; data_epoch?: number }> | null;
  const businessName = Array.isArray(bizField)
    ? (bizField[0]?.name ?? "WorkTrack Business")
    : (bizField?.name ?? "WorkTrack Business");
  const epoch = Array.isArray(bizField) ? bizField[0]?.data_epoch : bizField?.data_epoch;
  setClientDataEpoch(epoch ?? null);
  if(epoch) await setPartitionMeta(membership.business_id,user.id,"dataEpoch",String(epoch));
  const result: AuthSession = {
    userId: user.id,
    email: user.email ?? "",
    fullName: membership.full_name ?? user.email ?? "Member",
    businessId: membership.business_id,
    businessName,
    role: membership.role,
    assignedJobIds: membership.assigned_job_ids ?? [],
    mode: "supabase",
  };
  await setPartitionMeta(result.businessId,result.userId,'authSnapshot',JSON.stringify(result));
  await setPartitionMeta('auth',result.userId,'lastBusiness',result.businessId);
  return result;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const stopReferenceCache=React.useRef<(()=>Promise<void>)|null>(null);
  const [session, setSession] = React.useState<AuthSession | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [isOnline, setIsOnline] = React.useState(true);
  const [connectionState,setConnectionState] = React.useState<"checking"|"connected"|"offline"|"error">("checking");

  React.useEffect(() => {
    setIsOnline(navigator.onLine);
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  React.useEffect(() => {
    let mounted = true;

    if (isSupabaseConfigured && supabase) {
      hydrateSupabaseSession()
        .then((s) => {
          if (mounted) {setSession(s);setConnectionState(navigator.onLine ? "connected" : "offline");}
        })
        .catch(() => {if(mounted)setConnectionState("error");})
        .finally(() => {
          if (mounted) setLoading(false);
        });

      const { data } = supabase.auth.onAuthStateChange((event) => {
        if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
        if (event === "SIGNED_OUT") {
          setSession(null);
          return;
        }
        hydrateSupabaseSession().then((s) => {
          if (mounted) setSession(s);
          queryClient.invalidateQueries();
        });
      });
      return () => {
        mounted = false;
        data.subscription.unsubscribe();
      };
    }

    if (import.meta.env.PROD) { setLoading(false);setConnectionState("error");return; }
    // Explicit development-only synthetic mode
    try {
      const savedId = window.sessionStorage.getItem(SYNTHETIC_SESSION_KEY);
      if (savedId) {
        const account = listSyntheticAccounts().find((a) => a.id === savedId);
        if (account && mounted) {
          setSession({
            userId: account.userId,
            email: account.email,
            fullName: account.fullName,
            businessId: account.businessId,
            businessName: account.businessName,
            role: account.role,
            assignedJobIds: account.assignedJobIds,
            mode: "synthetic_dev",
          });
        }
      }
    } finally {
      if (mounted) setLoading(false);
    }

    return () => {
      mounted = false;
    };
  }, [queryClient]);

  React.useEffect(() => {
    if (!isSupabaseConfigured || !session || !isOnline) { if (!isOnline) setConnectionState('offline'); return; }
    let stopped=false;
    const verify=async()=>{
      try { const fresh=await hydrateSupabaseSession();if(stopped)return;
        setConnectionState('connected');
        if(!fresh){await clearPartition(session.businessId,session.userId);setSession(null);queryClient.clear();}
        else if(JSON.stringify(fresh)!==JSON.stringify(session)){setSession(fresh);queryClient.clear();}
      } catch {if(!stopped)setConnectionState('error');}
    };
    void verify(); const timer=setInterval(()=>void verify(),60000);
    return ()=>{stopped=true;clearInterval(timer);};
  },[session,isOnline,queryClient]);

  React.useEffect(()=>{
    if(!session)return;let cancelled=false;
    void startReferenceCache(session,queryClient).then(async stop=>{if(cancelled)await stop();else stopReferenceCache.current=stop;});
    return ()=>{cancelled=true;void stopReferenceCache.current?.();stopReferenceCache.current=null;};
  },[session,queryClient]);

  const signInWithPassword = React.useCallback(async (email: string, password: string) => {
    if (!supabase) {
      throw new Error("Backend connection is not configured. Contact your administrator.");
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    const hydrated = await hydrateSupabaseSession();
    if (!hydrated) {
      await supabase.auth.signOut();
      throw new Error(
        "No active business membership found for this account. Ask your business admin for an invitation.",
      );
    }
    setSession(hydrated);
    setConnectionState("connected");
  }, []);

  const signInSynthetic = React.useCallback(
    (membershipId: string) => {
      if (import.meta.env.PROD) throw new Error("Demonstration sign-in is disabled in production.");
      const account = listSyntheticAccounts().find((a) => a.id === membershipId);
      if (!account) throw new Error("Synthetic test account not found.");
      window.sessionStorage.setItem(SYNTHETIC_SESSION_KEY, account.id);
      queryClient.clear();
      setSession({
        userId: account.userId,
        email: account.email,
        fullName: account.fullName,
        businessId: account.businessId,
        businessName: account.businessName,
        role: account.role,
        assignedJobIds: account.assignedJobIds,
        mode: "synthetic_dev",
      });
    },
    [queryClient],
  );

  const signOut = React.useCallback(async () => {
    await stopReferenceCache.current?.();stopReferenceCache.current=null;
    await queryClient.cancelQueries();
    queryClient.clear();
    if (isSupabaseConfigured && supabase) {
      await supabase.auth.signOut();
    } else {
      window.sessionStorage.removeItem(SYNTHETIC_SESSION_KEY);
    }
    if (session) {await clearPartition(session.businessId,session.userId);await clearPartition('auth',session.userId);}
    setSession(null);
  }, [queryClient,session]);

  return (
    <AuthContext.Provider
      value={{
        session,
        loading,
        isOnline,
        backendMode: isSupabaseConfigured ? "supabase" : import.meta.env.DEV ? "synthetic_dev" : "unconfigured",
        connectionState,
        signInWithPassword,
        signInSynthetic,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useWorkTrackAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useWorkTrackAuth must be used inside AuthProvider.");
  return ctx;
}