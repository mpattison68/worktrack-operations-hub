import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { listSyntheticAccounts } from "@/lib/data/repository";
import type { AuthSession } from "@/lib/domain/types";

const SYNTHETIC_SESSION_KEY = "worktrack_synthetic_session_v1";

interface AuthContextValue {
  session: AuthSession | null;
  loading: boolean;
  isOnline: boolean;
  backendMode: "supabase" | "synthetic_dev";
  signInWithPassword: (email: string, password: string) => Promise<void>;
  signInSynthetic: (membershipId: string) => void;
  signOut: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

async function hydrateSupabaseSession(): Promise<AuthSession | null> {
  if (!supabase) return null;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: membership, error } = await supabase
    .from("memberships")
    .select("business_id, role, assigned_job_ids, full_name, businesses(name)")
    .eq("user_id", user.id)
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  if (error || !membership) return null;
  const bizField = membership.businesses as { name?: string } | Array<{ name?: string }> | null;
  const businessName = Array.isArray(bizField)
    ? (bizField[0]?.name ?? "WorkTrack Business")
    : (bizField?.name ?? "WorkTrack Business");
  return {
    userId: user.id,
    email: user.email ?? "",
    fullName: membership.full_name ?? user.email ?? "Member",
    businessId: membership.business_id,
    businessName,
    role: membership.role,
    assignedJobIds: membership.assigned_job_ids ?? [],
    mode: "supabase",
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = React.useState<AuthSession | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [isOnline, setIsOnline] = React.useState(true);

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
          if (mounted) setSession(s);
        })
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

    // Local Synthetic Dev Mode (when no Supabase env vars are configured)
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

  const signInWithPassword = React.useCallback(async (email: string, password: string) => {
    if (!supabase) {
      throw new Error("Supabase backend is not configured. Use Synthetic Dev Sign-In below.");
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
  }, []);

  const signInSynthetic = React.useCallback(
    (membershipId: string) => {
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
    await queryClient.cancelQueries();
    queryClient.clear();
    if (isSupabaseConfigured && supabase) {
      await supabase.auth.signOut();
    } else {
      window.sessionStorage.removeItem(SYNTHETIC_SESSION_KEY);
    }
    setSession(null);
  }, [queryClient]);

  return (
    <AuthContext.Provider
      value={{
        session,
        loading,
        isOnline,
        backendMode: isSupabaseConfigured ? "supabase" : "synthetic_dev",
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