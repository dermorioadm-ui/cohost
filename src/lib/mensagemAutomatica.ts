/**
 * A mensagem que o anfitrião cola no Airbnb e na Booking.
 *
 * Vive aqui porque estava escrita duas vezes — no onboarding e na tela do
 * imóvel — e texto duplicado só é descoberto desalinhado: alguém corrige uma
 * cópia, a outra continua no ar, e o anfitrião que passou pelo onboarding
 * mandou uma mensagem diferente do que a tela dele mostra hoje.
 */

/**
 * O aviso de canal é a parte que não pode sumir numa reescrita.
 *
 * Sem ele, o hóspede escreve na caixa da plataforma, ninguém lê, e o silêncio
 * é interpretado como descaso — pelo hóspede, na avaliação, e pela própria
 * plataforma, na taxa de resposta. Dizer para onde ir é o que transforma
 * "ninguém me respondeu" em "eles me disseram onde falar".
 */
export function mensagemAutomatica(chatUrl: string): string {
  return (
    `Olá! Seja muito bem-vindo(a) 😊\n\n` +
    `Antes da sua chegada, faça seu cadastro obrigatório aqui — é rápido e ` +
    `libera as instruções de acesso, Wi-Fi e tudo mais:\n\n${chatUrl}\n\n` +
    `⚠️ IMPORTANTE: não acompanhamos as mensagens por aqui. Todo o atendimento ` +
    `acontece no chat dentro do link acima, 24 horas por dia — é lá que a gente ` +
    `vê e responde. Salve o link no seu celular.`
  );
}
