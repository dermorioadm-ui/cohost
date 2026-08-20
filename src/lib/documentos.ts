/**
 * CPF: validação e formatação.
 *
 * A validação existe porque o termo assinado só identifica alguém se o
 * documento for real. Um campo que aceita qualquer coisa transforma
 * "assinado por CPF 000.000.000-00" num documento que não aponta para pessoa
 * nenhuma — e é justamente na hora de apontar que ele seria usado.
 *
 * O dígito verificador não prova que o CPF EXISTE, e menos ainda que é de
 * quem digitou. Prova que não é um número inventado na hora, que é o erro
 * comum: gente que digita 1 onze vezes para passar do campo.
 */

/** Só os dígitos, do jeito que vai para o banco. */
export const soDigitos = (v: string): string => (v ?? "").replace(/\D/g, "");

export function cpfValido(valor: string): boolean {
  const d = soDigitos(valor);
  if (d.length !== 11) return false;

  // 111.111.111-11 e companhia passam na conta dos dígitos por acidente
  // matemático. São a forma mais comum de "preencher para passar".
  if (/^(\d)\1{10}$/.test(d)) return false;

  const digito = (ate: number): number => {
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(d[i]) * (ate + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  return digito(9) === Number(d[9]) && digito(10) === Number(d[10]);
}

/** 000.000.000-00 conforme a pessoa digita. */
export function formatarCpf(valor: string): string {
  const d = soDigitos(valor).slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

/**
 * Passaporte.
 *
 * Não existe formato único no mundo — cada país emite o seu. Dá para exigir
 * comprimento razoável e caracteres plausíveis, e nada além disso sem virar
 * um campo que recusa passaporte legítimo.
 */
export function passaporteValido(valor: string): boolean {
  const v = (valor ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{5,12}$/.test(v);
}
