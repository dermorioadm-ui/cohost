import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, BellOff, Check, Clock, DoorOpen, Loader2 } from "lucide-react";
import { supabase } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

/**
 * Portaria.
 *
 * Duas coisas acontecem antes de o hóspede chegar no prédio, e as duas falham
 * caladas hoje: o e-mail que avisa o condomínio da reserva, e o cadastro da
 * pessoa na portaria digital, que é o que faz o elevador funcionar. Quando uma
 * delas quebra, o dono só descobre pelo hóspede parado na guarita.
 *
 * Esta tela existe para isso aparecer antes. Ela não dispara nada — quem
 * dispara são os jobs job-notify-condo e job-porter-sync. Ela mostra o que
 * eles já fizeram e o que travou, com o motivo do banco, não um "erro".
 */

interface Property {
  id: string;
  name: string;
  condo_name: string | null;
  condo_email: string | null;
  condo_notify: boolean;
}

interface Reservation {
  id: string;
  property_id: string;
  checkin_date: string;
  checkout_date: string;
  guest_label: string | null;
  condo_notified_at: string | null;
  condo_notify_error: string | null;
}

interface PorterRow {
  id: string;
  property_id: string;
  person_id: string;
  status: string;
  attempts: number;
  access_from: string;
  access_until: string;
}

interface PorterStatus {
  property_id: string;
  active: boolean;
  last_ok_at: string | null;
  has_error: boolean;
  last_error: string | null;
}

const PORTER_LABEL: Record<string, string> = {
  pending: "Na fila",
  registered: "Liberado",
  failed: "Falhou",
  no_integration: "Sem portaria digital",
  skipped: "Não se aplica",
};

const fmtDate = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
  });

export default function Portaria() {
  const { user } = useAuth();
  const [properties, setProperties] = useState<Property[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [porter, setPorter] = useState<PorterRow[]>([]);
  const [porterStatus, setPorterStatus] = useState<PorterStatus[]>([]);
  const [people, setPeople] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;

    (async () => {
      // Ontem, não hoje: quem entrou ontem e não foi liberado ainda é problema.
      const since = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

      const [props, res, status, reg] = await Promise.all([
        supabase
          .from("properties")
          .select("id, name, condo_name, condo_email, condo_notify")
          .is("archived_at", null)
          .order("name"),
        supabase
          .from("reservations")
          .select(
            "id, property_id, checkin_date, checkout_date, guest_label, condo_notified_at, condo_notify_error",
          )
          .eq("status", "confirmed")
          .gte("checkin_date", since)
          .order("checkin_date")
          .limit(60),
        supabase
          .from("porter_status")
          .select("property_id, active, last_ok_at, has_error, last_error"),
        supabase
          .from("porter_registrations")
          .select("id, property_id, person_id, status, attempts, access_from, access_until")
          .gte("access_until", new Date().toISOString())
          .order("access_from")
          .limit(60),
      ]);

      const rows = (reg.data ?? []) as PorterRow[];
      setProperties((props.data ?? []) as Property[]);
      setReservations((res.data ?? []) as Reservation[]);
      setPorterStatus((status.data ?? []) as PorterStatus[]);
      setPorter(rows);

      // Nomes num segundo passo: guest_people só é legível pelo dono via a
      // policy que passa por guest_registrations, e o embed do PostgREST aqui
      // esconderia essa dependência.
      if (rows.length > 0) {
        const { data } = await supabase
          .from("guest_people")
          .select("id, full_name")
          .in("id", rows.map((r) => r.person_id));

        setPeople(
          Object.fromEntries(
            ((data ?? []) as Array<{ id: string; full_name: string }>).map((p) => [
              p.id,
              p.full_name,
            ]),
          ),
        );
      }

      setLoading(false);
    })();
  }, [user]);

  const propById = useMemo(
    () => Object.fromEntries(properties.map((p) => [p.id, p])),
    [properties],
  );
  const statusById = useMemo(
    () => Object.fromEntries(porterStatus.map((s) => [s.property_id, s])),
    [porterStatus],
  );

  const failing = reservations.filter((r) => r.condo_notify_error !== null);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-bold">Portaria</h1>
        <p className="text-sm text-muted-foreground">
          Aviso ao condomínio e liberação de acesso das próximas entradas.
        </p>
      </header>

      {failing.length > 0 && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
          <div className="flex gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div className="min-w-0 text-sm">
              <p className="font-semibold text-destructive">
                {failing.length === 1
                  ? "Um aviso não saiu"
                  : `${failing.length} avisos não saíram`}
              </p>
              <p className="mt-1 leading-relaxed text-muted-foreground">
                O condomínio não foi avisado destas entradas. Costuma ser e-mail
                errado no cadastro do imóvel.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Configuração por imóvel — sem isso, nada abaixo tem como funcionar */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">Imóveis</h2>

        {properties.length === 0 && (
          <p className="rounded-xl glass-card px-4 py-6 text-center text-sm text-muted-foreground">
            Nenhum imóvel cadastrado ainda.
          </p>
        )}

        {properties.map((p) => {
          const st = statusById[p.id];
          const avisa = p.condo_notify && !!p.condo_email;

          return (
            <article key={p.id} className="rounded-xl glass-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{p.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {p.condo_name ?? "Condomínio não informado"}
                  </p>
                </div>
                <DoorOpen className="h-5 w-5 shrink-0 text-muted-foreground" />
              </div>

              <dl className="mt-3 space-y-1.5 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <dt className="text-muted-foreground">Aviso por e-mail</dt>
                  <dd className={cn("text-right", avisa ? "text-foreground" : "text-muted-foreground")}>
                    {avisa ? p.condo_email : p.condo_notify ? "Falta o e-mail" : "Desligado"}
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <dt className="text-muted-foreground">Portaria digital</dt>
                  <dd className="text-right">
                    {!st ? (
                      <span className="text-muted-foreground">Não configurada</span>
                    ) : st.has_error ? (
                      <span className="text-destructive">Com erro na última tentativa</span>
                    ) : st.active ? (
                      <span className="text-success">Conectada</span>
                    ) : (
                      <span className="text-muted-foreground">Pausada</span>
                    )}
                  </dd>
                </div>
              </dl>

              {/* O motivo, não só o fato: o erro quase sempre é token vencido,
                  e quem lê "com erro" abre chamado em vez de reconectar. */}
              {st?.last_error && (
                <p className="mt-3 break-words rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {st.last_error}
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
                {!avisa && (
                  <Link
                    to="/comecar"
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    Configurar o condomínio
                  </Link>
                )}
                <Link
                  to={`/imoveis/${p.id}`}
                  className="text-xs font-medium text-primary hover:underline"
                >
                  {!st
                    ? "Conectar a portaria digital"
                    : st.has_error
                      ? "Refazer a conexão da portaria"
                      : "Ver a conexão da portaria"}
                </Link>
              </div>
            </article>
          );
        })}
      </section>

      {/* Entradas: uma linha por reserva, com o estado do aviso */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">Próximas entradas</h2>

        {reservations.length === 0 ? (
          <p className="rounded-xl glass-card px-4 py-6 text-center text-sm text-muted-foreground">
            Nenhuma entrada pela frente.
          </p>
        ) : (
          reservations.map((r) => {
            const prop = propById[r.property_id];
            const desligado = prop && (!prop.condo_notify || !prop.condo_email);

            return (
              <article key={r.id} className="rounded-xl glass-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{prop?.name ?? "Imóvel"}</p>
                    <p className="text-sm text-muted-foreground">
                      {fmtDate(r.checkin_date)} → {fmtDate(r.checkout_date)}
                    </p>
                    {r.guest_label && (
                      <p className="mt-1 truncate text-xs text-muted-foreground">{r.guest_label}</p>
                    )}
                  </div>

                  <span
                    className={cn(
                      "flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium",
                      r.condo_notify_error
                        ? "bg-destructive/10 text-destructive"
                        : r.condo_notified_at
                          ? "bg-success/10 text-success"
                          : "bg-muted text-muted-foreground",
                    )}
                  >
                    {r.condo_notify_error ? (
                      <><AlertCircle className="h-3 w-3" /> Falhou</>
                    ) : r.condo_notified_at ? (
                      <><Check className="h-3 w-3" /> Avisado</>
                    ) : desligado ? (
                      <><BellOff className="h-3 w-3" /> Sem aviso</>
                    ) : (
                      <><Clock className="h-3 w-3" /> Na fila</>
                    )}
                  </span>
                </div>

                {r.condo_notify_error && (
                  <p className="mt-3 break-words rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    {r.condo_notify_error}
                  </p>
                )}
              </article>
            );
          })
        )}
      </section>

      {/* Acessos: só existe quando o imóvel tem portaria digital integrada */}
      {porter.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">Acessos liberados</h2>

          {porter.map((row) => (
            <article
              key={row.id}
              className="flex items-start justify-between gap-3 rounded-xl glass-card p-4"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{people[row.person_id] ?? "Hóspede"}</p>
                <p className="text-xs text-muted-foreground">
                  {propById[row.property_id]?.name ?? "Imóvel"} · {fmtDate(row.access_from)} →{" "}
                  {fmtDate(row.access_until)}
                </p>
              </div>

              <span
                className={cn(
                  "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium",
                  row.status === "registered"
                    ? "bg-success/10 text-success"
                    : row.status === "failed"
                      ? "bg-destructive/10 text-destructive"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {PORTER_LABEL[row.status] ?? row.status}
                {row.status === "failed" && row.attempts > 1 && ` · ${row.attempts} tentativas`}
              </span>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
