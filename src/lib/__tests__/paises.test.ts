import { describe, expect, it } from "vitest";
import { paisDoTelefone, paisPorIso } from "../paises";

describe("paisDoTelefone", () => {
  // O DDI mais longo tem que vencer: +1242 (Bahamas) não pode casar como +1.
  it("prefere o DDI mais longo", () => {
    expect(paisDoTelefone("+12425551234")?.iso).toBe("BS");
    // +1 é o NANP inteiro (EUA, Canadá e Caribe): o país exato é ambíguo por
    // natureza, então o teste exige só que o DDI resolvido seja o "1" — e não
    // um chute de desempate que quebraria numa reordenação inocente da lista.
    expect(paisDoTelefone("+15551234567")?.ddi).toBe("1");
  });

  it("resolve Brasil e Colômbia", () => {
    expect(paisDoTelefone("+5521988978322")?.iso).toBe("BR");
    expect(paisDoTelefone("+573104567890")?.iso).toBe("CO");
  });
});

describe("paisPorIso", () => {
  it("devolve o DDI do país", () => {
    expect(paisPorIso("BR", "pt")?.ddi).toBe("55");
    expect(paisPorIso("ES", "pt")?.ddi).toBe("34");
  });
});
