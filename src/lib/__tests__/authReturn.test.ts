import { describe, expect, it } from "vitest";
import { authReturn } from "../authReturn";

describe("retorno após autenticação", () => {
  it("preserva a jornada jurídica e de confirmação sem redirecionar para terceiros", () => {
    expect(authReturn("/juridico?session=cs_paid")).toBe("/juridico?session=cs_paid");
    expect(authReturn("/assinatura?status=ok")).toBe("/assinatura?status=ok");
    for (const destination of ["//evil.test/juridico", "/\\evil.test/juridico", "https://evil.test", "javascript:alert(1)", "/admin", "/juridico/../admin", null]) {
      expect(authReturn(destination)).toBeNull();
    }
  });
});
