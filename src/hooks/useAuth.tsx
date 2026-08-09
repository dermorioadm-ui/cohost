import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/lib/api";

export type AppRole = "owner" | "cleaner" | "admin";

interface AuthValue {
  session: Session | null;
  user: User | null;
  role: AppRole | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthValue>({
  session: null,
  user: null,
  role: null,
  loading: true,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<AppRole | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    const loadRole = async (userId: string) => {
      const { data } = await supabase.from("user_roles").select("role").eq("user_id", userId);
      const roles = (data ?? []).map((r) => r.role as AppRole);
      // Admin > owner > cleaner: quem acumula papéis entra no mais alto.
      return roles.includes("admin")
        ? "admin"
        : roles.includes("owner")
          ? "owner"
          : roles.includes("cleaner")
            ? "cleaner"
            : null;
    };

    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (data.session?.user) setRole(await loadRole(data.session.user.id));
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (_e, next) => {
      if (!active) return;
      setSession(next);
      setRole(next?.user ? await loadRole(next.user.id) : null);
      setLoading(false);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return (
    <Ctx.Provider
      value={{
        session,
        user: session?.user ?? null,
        role,
        loading,
        signOut: async () => {
          await supabase.auth.signOut();
          setSession(null);
          setRole(null);
        },
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
