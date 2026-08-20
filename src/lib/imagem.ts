/**
 * Prepara a foto do documento para envio.
 *
 * Foto de documento tirada por celular chega com 4 a 8 MB. Mandar isso num
 * corpo JSON é pedir para o cadastro falhar por timeout justamente em quem
 * está no saguão do prédio com o sinal ruim — que é exatamente quando ele
 * precisa funcionar.
 *
 * Reduzir para 1600px no lado maior mantém o documento legível (RG e
 * passaporte são legíveis bem antes disso) e derruba o arquivo para algumas
 * centenas de KB.
 */

const LADO_MAX = 1600;
const QUALIDADE = 0.82;

export interface ImagemPreparada {
  dataUrl: string;
  bytes: number;
}

export async function prepararImagem(arquivo: File): Promise<ImagemPreparada> {
  // PDF não passa por canvas. Vai como está — quem envia PDF de documento
  // normalmente já exportou um arquivo pequeno.
  if (arquivo.type === "application/pdf") {
    const dataUrl = await lerComoDataUrl(arquivo);
    return { dataUrl, bytes: arquivo.size };
  }

  const bitmap = await carregarBitmap(arquivo);

  const escala = Math.min(1, LADO_MAX / Math.max(bitmap.width, bitmap.height));
  const largura = Math.round(bitmap.width * escala);
  const altura = Math.round(bitmap.height * escala);

  const canvas = document.createElement("canvas");
  canvas.width = largura;
  canvas.height = altura;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Não consegui processar a imagem");

  // Fundo branco antes de desenhar: PNG com transparência vira preto no JPEG,
  // e um documento com fundo preto é um documento ilegível.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, largura, altura);
  ctx.drawImage(bitmap, 0, 0, largura, altura);

  const dataUrl = canvas.toDataURL("image/jpeg", QUALIDADE);
  return { dataUrl, bytes: Math.round((dataUrl.length - 23) * 0.75) };
}

function lerComoDataUrl(arquivo: File): Promise<string> {
  return new Promise((ok, erro) => {
    const fr = new FileReader();
    fr.onload = () => ok(String(fr.result));
    fr.onerror = () => erro(new Error("Não consegui ler o arquivo"));
    fr.readAsDataURL(arquivo);
  });
}

async function carregarBitmap(arquivo: File): Promise<ImageBitmap | HTMLImageElement> {
  // `createImageBitmap` respeita a orientação EXIF quando pedimos: sem isso a
  // foto tirada com o celular deitado chega girada, e a portaria recebe um
  // documento de lado.
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(arquivo, { imageOrientation: "from-image" });
    } catch {
      /* HEIC em navegador antigo cai no caminho de baixo. */
    }
  }

  const url = URL.createObjectURL(arquivo);
  try {
    return await new Promise<HTMLImageElement>((ok, erro) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => erro(new Error("Formato de imagem não suportado"));
      img.src = url;
    });
  } finally {
    // Revoga depois do onload: revogar antes deixa a imagem sem fonte.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
