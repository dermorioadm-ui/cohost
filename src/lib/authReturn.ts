/** Retornos permitidos após login. Não aceita destinos externos nem protocolos. */
export function authReturn(raw: string | null): string | null {
  if (!raw?.startsWith("/") || raw.startsWith("//")) return null;
  try {
    const url = new URL(raw, "https://hospedepay.org");
    if (url.origin !== "https://hospedepay.org" || !["/juridico", "/assinatura"].includes(url.pathname)) return null;
    return url.pathname + url.search;
  } catch { return null; }
}

const RETURN_KEY = "hospedepay.auth-return";
/** O link de e-mail pode abrir outra aba. Guarda só o destino, sem token de pagamento. */
export function rememberAuthReturn(raw: string | null) {
  const safe = authReturn(raw);
  if (!safe) return;
  try {
    const destination = safe.startsWith("/assinatura") ? "/assinatura?status=ok" : "/juridico";
    localStorage.setItem(RETURN_KEY, JSON.stringify({ destination, expires: Date.now() + 60 * 60 * 1000 }));
  } catch { /* Navegação continua funcionando se o armazenamento estiver bloqueado. */ }
}
export function takeAuthReturn(): string | null {
  try {
    const value = localStorage.getItem(RETURN_KEY);
    localStorage.removeItem(RETURN_KEY);
    if (!value) return null;
    const saved = JSON.parse(value);
    return saved.expires > Date.now() ? authReturn(saved.destination) : null;
  } catch { return null; }
}
