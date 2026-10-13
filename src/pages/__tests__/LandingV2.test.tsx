import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";

describe("Landing V2 preview", () => {
  it("serves the approved landing in production and retains the preview", () => {
    const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
    expect(app).toContain('<Route path="/v2" element={<LandingV2 />} />');
    expect(app).toContain('<Route path="/pagina" element={<LandingV2 production />} />');
    expect(app).toContain('if (!user) return <LandingV2 production />;');
  });
  it("renders an isolated alternate page with original content and a return link", async () => {
    const { default: LandingV2 } = await import("../LandingV2");
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={["/v2"]}><LandingV2 /></MemoryRouter>);
    expect(html).toContain('class="hp-v2"');
    expect(html).toContain('href="/pagina"');
    expect(html).toContain("Versão 2");
    for (const id of ["video", "como-funciona", "check-in", "prova", "quem-responde", "e-ainda", "comparacao", "planos", "perguntas"])
      expect(html).toContain(`id="${id}"`);
    expect(html).toContain('name="plano-hospedepay"');
    expect(html).toContain("Assinar o");
  });
});
