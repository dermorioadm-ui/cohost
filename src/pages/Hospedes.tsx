import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, Clock, Loader2, Mail, MapPin, Phone, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

/**
 * Clientes cadastrados.
 *
 * Todo hóspede que preenche o link do imóvel vira linha em `guest_people`, mas
 * até aqui esse dado só era lido por máquina — pelo job da portaria e pelo
 * chat. O dono não tinha onde ver quem passou pelo apartamento dele.
 *
 * O filtro que importa é o de acesso negado. Quando alguém não é liberado na
 * portaria, hoje isso aparece no dia em que a pessoa chega e liga; aqui aparece
 * antes, com o motivo que a Kiper devolveu — quase sempre "telefone já
 * vinculado" ou "usuário já cadastrado", que se resolve em um minuto pelo app
 * do prédio.
 *
 * O endereço mostrado é o do IMÓVEL, não o do hóspede: o cadastro do hóspede
 * pede nome, e-mail, telefone e documento — nunca pediu endereço dele.
 */

interface Row {
  person_id: string;
  full_name: string;
  email: string | null;
  phone_e164: string | null;
  document_type: string | null;
  document_number: string | null;
  is_primary: boolean;
  registration_id: string;
  checkin_date: string;
  checkout_date: string;
  created_at: string;
  property_id: string;
  porter_status: string | null;
  porter_reason: string | null;
}

interface Property {
  id: string;
  name: string;
  address: string | null;
  street_number: string | null;
  apt_number: string | null;
  block: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
}

type Filtro = "todos" | "negados" | "liberados" | "hoje";

const FILTROS: Array<{ key: Filtro; label: string }> = [
  { key: "todos", label: "Todos" },
  { key: "negados", label: "Não conseguiram acesso" },
  { key: "liberados", label: "Liberados" },
  { key: "hoje", label: "Hospedados agora" },
];

const PORTER_LABEL: Record<string, string> = {
  pending: "Na fila",
  registered: "Liberado",
  failed: "Não conseguiu acesso",
  no_integration: "Sem portaria digital",
  skipped: "Não se aplica",
};

const fmtDate = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });

/** "+5521999998888" -> "(21) 99999-8888". Sem DDI brasileiro, devolve cru. */
function fmtPhone(e164: string | null): string | null {
  if (!e164) return null;
  const d = e164.replace(/\D/g, "");
  const local = d.startsWith("55") ? d.slice(2) : d;
  if (local.length < 10) return e164;
  return `(${local.slice(0, 2)}) ${local.slice(2, -4)}-${local.slice(-4)}`;
}

function endereco(p: Property | undefined): string | null {
  if (!p) return null;
  const rua = [p.address, p.street_number].filter(Boolean).join(", ");
  const unidade = [p.block && `Bl ${p.block}`, p.apt_number && `Apt ${p.apt_number}`]
    .filter(Boolean)
    .join(" ");
  const cidade = [p.neighborhood, p.city, p.state].filter(Boolean).join(" · ");
  const linha = [rua, unidade, cidade].filter(Boolean).join(" — ");
  return linha || null;
}

export default function Hospedes() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const [busca, setBusca] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;

    (async () => {
      const [props, regs] = await Promise.all([
        supabase
          .from("properties")
          .select(
            "id, name, address, street_number, apt_number, block, neighborhood, city, state",
          )
          .order("name"),
        supabase
          .from("guest_registrations")
          .select(
            "id, property_id, checkin_date, checkout_date, created_at, guest_people(id, full_name, email, phone_e164, document_type, document_number, is_primary)",
          )
          .order("checkin_date", { ascending: false })
          .limit(300),
      ]);

      const registrations = (regs.data ?? []) as Array<{
        id: string;
        property_id: string;
        checkin_date: string;
        checkout_date: string;
        created_at: string;
        guest_people: Array<Omit<Row, keyof Row> & Record<string, unknown>>;
      }>;

      // O estado na portaria vem numa segunda consulta: `porter_registrations`
      // tem policy própria e o embed do PostgREST esconderia essa dependência.
      const { data: porter } = await supabase
        .from("porter_registrations")
        .select("person_id, status, response_body");

      const porterByPerson = new Map(
        ((porter ?? []) as Array<{
          person_id: string;
          status: string;
          response_body: string | null;
        }>).map((p) => [p.person_id, p]),
      );

      const flat: Row[] = registrations.flatMap((r) =>
        ((r.guest_people ?? []) as unknown as Array<{
          id: string;
          full_name: string;
          email: string | null;
          phone_e164: string | null;
          document_type: string | null;
          document_number: string | null;
          is_primary: boolean;
        }>).map((p) => {
          const st = porterByPerson.get(p.id);
          return {
            person_id: p.id,
            full_name: p.full_name,
            email: p.email,
            phone_e164: p.phone_e164,
            document_type: p.document_type,
            document_number: p.document_number,
            is_primary: p.is_primary,
            registration_id: r.id,
            checkin_date: r.checkin_date,
            checkout_date: r.checkout_date,
            created_at: r.created_at,
            property_id: r.property_id,
            porter_status: st?.status ?? null,
            porter_reason: st?.response_body ?? null,
          };
        }),
      );

      setProperties((props.data ?? []) as Property[]);
      setRows(flat);
      setLoading(false);
    })();
  }, [user]);

  const propById = useMemo(
    () => new Map(properties.map((p) => [p.id, p])),
    [properties],
  );

  const negados = rows.filter((r) => r.porter_status === "failed").length;

  const visiveis = useMemo(() => {
    const hoje = new Date().toISOString().slice(0, 10);
    const termo = busca.trim().toLowerCase();

    return rows.filter((r) => {
      if (filtro === "negados" && r.porter_status !== "failed") return false;
      if (filtro === "liberados" && r.porter_status !== "registered") return false;
      if (filtro === "hoje" && !(r.checkin_date <= hoje && r.checkout_date >= hoje)) {
        return false;
      }
      if (!termo) return true;
      return (
        r.full_name.toLowerCase().includes(termo) ||
        (r.email ?? "").toLowerCase().includes(termo) ||
        (r.phone_e164 ?? "").includes(termo) ||
        (propById.get(r.property_id)?.name ?? "").toLowerCase().includes(termo)
      );
    });
  }, [rows, filtro, busca, propById]);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-bold">Clientes</h1>
        <p className="text-sm text-muted-foreground">
          Quem se cadastrou pelos seus links, e quem ficou sem acesso.
        </p>
      </header>

      {negados > 0 && filtro !== "negados" && (
        <button
          type="button"
          onClick={() => setFiltro("negados")}
          className="flex w-full gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-left"
        >
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="min-w-0 text-sm">
            <p className="font-semibold text-destructive">
              {negados === 1
                ? "1 hóspede não conseguiu acesso"
                : `${negados} hóspedes não conseguiram acesso`}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Toque para ver quem é e o motivo.
            </p>
          </div>
        </button>
      )}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar por nome, e-mail, telefone ou imóvel"
          className="pl-9"
        />
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {FILTROS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFiltro(f.key)}
            className={cn(
              "shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
              filtro === f.key
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground",
            )}
          >
            {f.label}
            {f.key === "negados" && negados > 0 && ` (${negados})`}
          </button>
        ))}
      </div>

      {visiveis.length === 0 ? (
        <p className="rounded-xl glass-card px-4 py-10 text-center text-sm text-muted-foreground">
          {rows.length === 0
            ? "Ninguém se cadastrou ainda. Mande o link do imóvel para o próximo hóspede."
            : "Nenhum cliente com esse filtro."}
        </p>
      ) : (
        <div className="space-y-2">
          {visiveis.map((r) => {
            const prop = propById.get(r.property_id);
            const negado = r.porter_status === "failed";

            return (
              <article key={r.person_id} className="rounded-xl glass-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {r.full_name}
                      {r.is_primary && (
                        <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                          responsável
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {prop?.name ?? "Imóvel"} · {fmtDate(r.checkin_date)} →{" "}
                      {fmtDate(r.checkout_date)}
                    </p>
                  </div>

                  {r.porter_status && (
                    <span
                      className={cn(
                        "flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium",
                        r.porter_status === "registered"
                          ? "bg-success/10 text-success"
                          : negado
                            ? "bg-destructive/10 text-destructive"
                            : "bg-muted text-muted-foreground",
                      )}
                    >
                      {r.porter_status === "registered" ? (
                        <Check className="h-3 w-3" />
                      ) : negado ? (
                        <AlertCircle className="h-3 w-3" />
                      ) : (
                        <Clock className="h-3 w-3" />
                      )}
                      {PORTER_LABEL[r.porter_status] ?? r.porter_status}
                    </span>
                  )}
                </div>

                <dl className="mt-3 space-y-1 text-xs">
                  {r.email && (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Mail className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{r.email}</span>
                    </div>
                  )}
                  {r.phone_e164 && (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Phone className="h-3.5 w-3.5 shrink-0" />
                      <span>{fmtPhone(r.phone_e164)}</span>
                    </div>
                  )}
                  {endereco(prop) && (
                    <div className="flex items-start gap-2 text-muted-foreground">
                      <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0">{endereco(prop)}</span>
                    </div>
                  )}
                  {r.document_number && (
                    <div className="text-muted-foreground">
                      {(r.document_type ?? "documento").toUpperCase()}: {r.document_number}
                    </div>
                  )}
                </dl>

                {/* O motivo, não só o carimbo: é ele que diz o que fazer */}
                {negado && r.porter_reason && (
                  <p className="mt-3 break-words rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    {r.porter_reason.slice(0, 300)}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
