import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Base para montar os links públicos (chat do hóspede, convite da diarista).
 * Sempre o domínio de onde o app está sendo servido — sem exceção para host de
 * preview, que era resquício do app anterior e apontava para o domínio errado.
 */
export function getAppBaseUrl() {
  return typeof window === "undefined" ? "" : window.location.origin;
}

