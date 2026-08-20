import { describe, expect, it } from "vitest";
import { mensagemAutomatica } from "../mensagemAutomatica";

describe("mensagemAutomatica", () => {
  const msg = mensagemAutomatica("https://hospedepay.org/c/teste");

  it("contém o link do cadastro", () => {
    expect(msg).toContain("https://hospedepay.org/c/teste");
  });

  // O aviso de canal é a parte da mensagem que não pode sumir numa reescrita:
  // sem ele o hóspede escreve na caixa da plataforma e ninguém lê.
  it("avisa que o atendimento é no chat do link, não na plataforma", () => {
    expect(msg).toMatch(/não acompanhamos as mensagens por aqui/i);
    expect(msg).toMatch(/chat dentro do link/i);
  });
});
