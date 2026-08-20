import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/lib/api";

export type AppRole = "owner" | "cleaner" | "admin";

/**
 * Quem é a pessoa, e em qual papel ela está agora.
 *
 * Antes isto devolvia UM papel: quem acumulava vários entrava no mais alto e
 * ficava preso lá. Funcionou enquanto ninguém acumulava — até o dono da
 * plataforma virar admin e, com isso, perder o acesso ao painel do próprio
 * apartamento. Um papel a mais tirava uma tela.
 *
 * Agora `roles` é a lista do que a conta pode ser e `role` é o que ela está
 * sendo. A escolha fica no navegador porque é preferência de sessão de
 * trabalho, não atributo da conta: gravar no banco faria a escolha vazar entre
 * dispositivos, e ninguém quer abrir o celular no papel em que deixou o desktop.
 */

const CHAVE = "hospedepay.papel-ativo";

/** Admin > owner > cleaner. Só decide o papel INICIAL de quem nunca escolheu. */
const preferido = (roles: AppRole[]): AppRole | null =>
  roles.includes("admin") ? "admin"
  : roles.includes("owner") ? "owner"
  : roles.includes("cleaner") ? "cleaner"
  : null;

interface AuthValue {
  session: Session | null;
  user: User | null;
  /** O papel em uso agora. */
  role: AppRole | null;
  /** Todos os papéis da conta. Tem mais de um? Cabe alternador. */
  roles: AppRole[];
  /** Troca o papel ativo. Ignora papel que a conta não tem. */
  switchRole: (r: AppRole) => void;
  loading: boolean;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthValue>({
  session: null,
  user: null,
  role: null,
  roles: [],
  switchRole: () => {},
  loading: true,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [role, setRole] = useState<AppRole | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    const carregar = async (userId: string) => {
      const { data } = await supabase.from("user_roles").select("role").eq("user_id", userId);
      const lista = (data ?? []).map((r) => r.role as AppRole);

      // A escolha guardada só vale se a conta ainda tiver aquele papel. Um
      // admin rebaixado que voltasse no papel antigo veria telas que a RLS
      // recusaria — erro de permissão em vez de tela ausente, que é pior.
      const salvo = localStorage.getItem(CHAVE) as AppRole | null;
      const ativo = salvo && lista.includes(salvo) ? salvo : preferido(lista);

      return { lista, ativo };
    };

    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (data.session?.user) {
        const { lista, ativo } = await carregar(data.session.user.id);
        setRoles(lista);
        setRole(ativo);
      }
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (_e, next) => {
      if (!active) return;
      setSession(next);
      if (next?.user) {
        const { lista, ativo } = await carregar(next.user.id);
        setRoles(lista);
        setRole(ativo);
      } else {
        setRoles([]);
        setRole(null);
      }
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
        roles,
        switchRole: (r) => {
          if (!roles.includes(r)) return;
          localStorage.setItem(CHAVE, r);
          setRole(r);
        },
        loading,
        signOut: async () => {
          await supabase.auth.signOut();
          // A preferência sai junto: no computador compartilhado, a próxima
          // pessoa não deve herdar o papel de quem saiu.
          localStorage.removeItem(CHAVE);
          setSession(null);
          setRoles([]);
          setRole(null);
        },
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
