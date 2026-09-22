import Landing from "@/pages/Landing";

/**
 * Segundo funil público da HospedePay.
 *
 * A apresentação visual continua sendo a Landing existente; a variante muda
 * somente a ação comercial: uma oferta mensal para um imóvel, checkout direto
 * e configuração feita pelo próprio cliente.
 */
export default function CompraDireta() {
  return <Landing modo="compra-direta" />;
}
