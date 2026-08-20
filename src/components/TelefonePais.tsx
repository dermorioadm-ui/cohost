import { useMemo, useRef, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { paises, paisPorIso, type Pais } from "@/lib/paises";
import { cn } from "@/lib/utils";

/**
 * Telefone com seletor de país.
 *
 * Existe por um motivo concreto, e não por estética: a portaria digital recusa
 * número sem DDI. Um "21988978322" solto virava "+21988978322" na integração,
 * e a Kiper lia "+21" como código de país — a recusa vinha com uma mensagem
 * que não apontava nem para o Brasil nem para o formato, e mandou a
 * investigação inteira para o lado errado.
 *
 * Perguntar o país resolve isso na origem. O hóspede estrangeiro deixa de
 * depender do palpite "10 ou 11 dígitos é Brasil", que é verdade aqui e
 * mentira em quase todo lugar.
 */

export interface ValorTelefone {
  /** ISO do país escolhido. */
  iso: string;
  /** Só os dígitos locais, sem DDI. */
  numero: string;
}

/** E.164 pronto para o banco: +DDI + número. */
export function paraE164(v: ValorTelefone, locale = "pt"): string {
  const p = paisPorIso(v.iso, locale);
  const local = v.numero.replace(/\D/g, "");
  if (!p || !local) return "";
  return `+${p.ddi}${local}`;
}

/** Quantos dígitos locais fazem sentido. Brasil tem regra própria. */
export function telefoneCompleto(v: ValorTelefone): boolean {
  const local = v.numero.replace(/\D/g, "");
  if (v.iso === "BR") return local.length === 10 || local.length === 11;
  // Fora do Brasil não há regra única. O piso evita o campo em branco
  // disfarçado; o teto evita a pessoa colar o DDI junto sem perceber.
  return local.length >= 6 && local.length <= 14;
}

export function TelefonePais({
  valor,
  onChange,
  locale = "pt",
  rotuloBusca = "Buscar país",
  placeholder = "",
  id,
}: {
  valor: ValorTelefone;
  onChange: (v: ValorTelefone) => void;
  locale?: string;
  rotuloBusca?: string;
  placeholder?: string;
  id?: string;
}) {
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState("");
  const campoNumero = useRef<HTMLInputElement | null>(null);

  const lista = useMemo(() => paises(locale), [locale]);
  const atual = useMemo(
    () => lista.find((p) => p.iso === valor.iso) ?? lista.find((p) => p.iso === "BR")!,
    [lista, valor.iso],
  );

  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return lista;
    // Busca por nome E por DDI: quem sabe que é "+34" não deveria precisar
    // lembrar como o navegador escreve "Espanha".
    const sq = q.replace(/^\+/, "");
    return lista.filter(
      (p) => p.nome.toLowerCase().includes(q) || p.ddi.startsWith(sq),
    );
  }, [lista, busca]);

  const escolher = (p: Pais) => {
    onChange({ ...valor, iso: p.iso });
    setAberto(false);
    setBusca("");
    // O foco vai para o número: escolher o país é meio do caminho, e deixar o
    // cursor parado obriga a pessoa a um toque extra que ela não esperava.
    setTimeout(() => campoNumero.current?.focus(), 50);
  };

  return (
    <>
      <div className="flex items-stretch gap-2">
        <button
          type="button"
          onClick={() => setAberto(true)}
          className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg border border-input bg-background px-3 text-sm"
          aria-label={atual.nome}
        >
          <span className="text-lg leading-none">{atual.bandeira}</span>
          <span className="tabular-nums text-muted-foreground">+{atual.ddi}</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        </button>

        <Input
          id={id}
          ref={campoNumero}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          value={valor.numero}
          placeholder={placeholder}
          onChange={(e) => onChange({ ...valor, numero: e.target.value.replace(/[^\d\s()-]/g, "") })}
          className="min-h-[44px] flex-1"
        />
      </div>

      {aberto && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
          <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-t-2xl bg-background p-4 sm:rounded-2xl">
            <div className="mb-3 flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  placeholder={rotuloBusca}
                  className="min-h-[44px] pl-9"
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  setAberto(false);
                  setBusca("");
                }}
                aria-label="Fechar"
                className="rounded-lg p-2 text-muted-foreground hover:bg-accent"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <ul className="min-h-0 flex-1 overflow-y-auto">
              {filtrados.map((p) => (
                <li key={p.iso}>
                  <button
                    type="button"
                    onClick={() => escolher(p)}
                    className={cn(
                      "flex min-h-[52px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-accent",
                      p.iso === atual.iso && "bg-accent",
                    )}
                  >
                    <span className="text-xl leading-none">{p.bandeira}</span>
                    <span className="w-14 shrink-0 tabular-nums text-muted-foreground">
                      +{p.ddi}
                    </span>
                    <span className="min-w-0 truncate">{p.nome}</span>
                  </button>
                </li>
              ))}
              {filtrados.length === 0 && (
                <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                  Nada encontrado
                </li>
              )}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
