/**
 * As automatizações de um imóvel, em um lugar só.
 *
 * A lista de imóveis mostrava preço e diarista — o que não mostrava era o que
 * o app está fazendo sozinho por aquele imóvel. Sem isso, um imóvel com a
 * mensagem automática desligada parece igual a um imóvel configurado, e o dono
 * só descobre a diferença quando o hóspede chega sem cadastro.
 *
 * A regra de "ligada" mora aqui, e não na tela, porque a mesma resposta precisa
 * valer na lista e na página do imóvel — e porque cada uma tem um jeito
 * próprio de estar meio ligada, que é justamente o caso perigoso.
 */

export interface AutomationInput {
  self_clean: boolean;
  cleaner_id: string | null;
  supplies_enabled: boolean;
  auto_message_confirmed_at: string | null;
  ai_enabled: boolean;
  /** Portaria conectada e ativa para ESTE imóvel (vem da view porter_status). */
  porter_active: boolean;
}

export interface Automation {
  key: "limpeza" | "insumos" | "atendimento" | "portaria";
  label: string;
  active: boolean;
  /** Por que está desligada — o que falta fazer, na ordem em que resolve. */
  hint: string;
}

export function automationsOf(p: AutomationInput): Automation[] {
  const limpeza = p.self_clean || Boolean(p.cleaner_id);
  const insumos = Boolean(p.supplies_enabled);

  // Atendimento só conta como ligado com as duas metades no ar: a mensagem
  // leva o hóspede ao cadastro, e a assistente é quem responde depois. Com uma
  // só, metade dos hóspedes chega sem cadastro ou fica sem resposta às 2h.
  const mensagem = Boolean(p.auto_message_confirmed_at);
  const atendimento = mensagem && p.ai_enabled;

  return [
    {
      key: "limpeza",
      label: "Limpeza",
      active: limpeza,
      hint: limpeza
        ? p.self_clean
          ? "Cada saída vira tarefa na sua própria agenda."
          : "Cada saída vira tarefa na agenda da diarista."
        : "Ninguém acompanha os checkouts. Vincule uma diarista ou marque que você mesmo limpa.",
    },
    {
      key: "insumos",
      label: "Insumos",
      active: insumos,
      hint: insumos
        ? "Valor fixo combinado com a diarista para repor o que acaba."
        : "A reposição não está combinada — papel, café e sabão dependem de você.",
    },
    {
      key: "atendimento",
      label: "Atendimento",
      active: atendimento,
      hint: atendimento
        ? "Reserva confirmada manda o link de cadastro, e a assistente responde 24h."
        : !mensagem && !p.ai_enabled
          ? "Falta colar a mensagem automática no Airbnb e ligar a assistente."
          : !mensagem
            ? "A assistente responde, mas a mensagem automática não está no Airbnb — o hóspede não recebe o link."
            : "A mensagem sai, mas a assistente está desligada — ninguém responde fora do horário.",
    },
    {
      key: "portaria",
      label: "Portaria",
      active: p.porter_active,
      hint: p.porter_active
        ? "O cadastro do hóspede entra sozinho no sistema da portaria."
        : "O hóspede continua sendo cadastrado na portaria por você, no braço.",
    },
  ];
}
