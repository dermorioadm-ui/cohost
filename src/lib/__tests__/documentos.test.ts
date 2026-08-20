import { describe, expect, it } from "vitest";
import { cpfValido, formatarCpf, passaporteValido, soDigitos } from "../documentos";

/**
 * Estes testes protegem as funções por onde passa dinheiro e documento: o CPF
 * decide se o cadastro conclui, e um falso "válido" produz um termo assinado
 * apontando para ninguém.
 */

describe("cpfValido", () => {
  it("aceita CPFs com dígitos verificadores corretos", () => {
    expect(cpfValido("529.982.247-25")).toBe(true);
    expect(cpfValido("52998224725")).toBe(true);
  });

  it("recusa dígito verificador errado", () => {
    expect(cpfValido("529.982.247-26")).toBe(false);
    expect(cpfValido("12345678900")).toBe(false);
  });

  // Repetidos passam na aritmética por acidente — a regra que os recusa é
  // separada, e por isso ganha teste separado: se alguém "simplificar" a
  // função, este é o caso que denuncia.
  it("recusa os repetidos que passariam na conta", () => {
    for (const d of ["00000000000", "11111111111", "99999999999"]) {
      expect(cpfValido(d)).toBe(false);
    }
  });

  it("recusa tamanho errado e vazio", () => {
    expect(cpfValido("")).toBe(false);
    expect(cpfValido("1234567890")).toBe(false);
    expect(cpfValido("123456789012")).toBe(false);
  });
});

describe("formatarCpf", () => {
  it("formata progressivamente enquanto digita", () => {
    expect(formatarCpf("529")).toBe("529");
    expect(formatarCpf("529982")).toBe("529.982");
    expect(formatarCpf("52998224725")).toBe("529.982.247-25");
  });

  it("ignora o que não é dígito", () => {
    expect(formatarCpf("529.982.247-25")).toBe("529.982.247-25");
    expect(soDigitos("529.982.247-25")).toBe("52998224725");
  });
});

describe("passaporteValido", () => {
  it("aceita formatos comuns", () => {
    expect(passaporteValido("FD123456")).toBe(true);
    expect(passaporteValido("ab123456")).toBe(true); // maiusculiza antes
  });

  it("recusa curto demais e caracteres fora do padrão", () => {
    expect(passaporteValido("AB12")).toBe(false);
    expect(passaporteValido("AB 123456")).toBe(false);
  });
});
