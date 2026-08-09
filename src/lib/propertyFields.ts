/**
 * Campos do cérebro da assistente.
 *
 * Ficam fora das telas porque são preenchidos no onboarding e reeditados
 * depois, em Imóveis — e duas listas divergindo significaria um campo que o
 * dono preenche no cadastro e nunca mais encontra para corrigir.
 *
 * A ordem espelha a de `build_ai_prompt` no banco, que monta o prompt final.
 */
export const AI_FIELDS = [
  { key: "address", icon: "📍", label: "Endereço completo", required: true, placeholder: "Rua, número, complemento, bairro" },
  { key: "access", icon: "🔑", label: "Como entrar", required: true, placeholder: "Portaria, cofre de chaves, código do portão…" },
  { key: "lock", icon: "🔐", label: "Senha da fechadura", required: true, placeholder: "Código digital ou onde está a chave" },
  { key: "wifi", icon: "📶", label: "Wi-Fi (rede e senha)", required: true, placeholder: "Rede: MinhaCasa / Senha: 12345678" },
  { key: "rules", icon: "📋", label: "Regras da casa", required: false, placeholder: "Lixo, barulho, animais, fumantes…" },
  { key: "appliances", icon: "🚿", label: "Equipamentos", required: false, placeholder: "Chuveiro, ar-condicionado, máquina de lavar…" },
  { key: "parking", icon: "🚗", label: "Estacionamento", required: false, placeholder: "Vaga 12, controle no armário da cozinha" },
  { key: "emergency", icon: "📞", label: "Seu WhatsApp (urgências)", required: true, placeholder: "(21) 99999-8888" },
] as const;
