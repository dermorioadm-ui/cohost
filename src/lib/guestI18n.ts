/**
 * Textos da página do hóspede, em português, inglês e espanhol.
 *
 * Fica fora do componente porque o hóspede estrangeiro é o caso normal num
 * apartamento de temporada, não a exceção — e um dicionário no meio da tela
 * vira um lugar onde ninguém acha o que precisa traduzir.
 *
 * O idioma escolhido também viaja para o backend: é ele que decide em qual
 * língua o termo é assinado e o e-mail é enviado. Traduzir a tela e mandar o
 * documento em português seria pior que não traduzir — a pessoa assinaria
 * confiante algo que não leu.
 */

export type Idioma = "pt" | "en" | "es";

export const IDIOMAS: Array<{ id: Idioma; iso: string; nome: string }> = [
  { id: "pt", iso: "BR", nome: "Português" },
  { id: "en", iso: "GB", nome: "English" },
  { id: "es", iso: "ES", nome: "Español" },
];

interface Textos {
  welcome: string; how: string;
  register: string; registerDone: string;
  support: string; required: string; requiredDone: string; supportHint: string;
  back: string;
  dates: string; checkin: string; checkout: string;
  guests: string; add: string; guest: string; responsible: string;
  name: string; email: string; phone: string; phoneSearch: string;
  docTitle: string; cpf: string; foreign: string; foreignHint: string;
  nationality: string; passport: string; nationalityPick: string;
  photo: string; photoHint: string; photoSending: string;
  photoCamera: string; photoGallery: string; photoRemove: string;
  requiredHint: string;
  term: string; termText: string;
  signTitle: string; signHint: string; signMissing: string;
  submit: string; sending: string;
  placeholder: string; assistant: string; hello: string; helpYou: string;
  done: string;
  errDates: string; errOrder: string; errTerm: string;
  errName: string; errEmail: string; errPhone: string;
  errCpf: string; errPassport: string; errNationality: string; errPhoto: string;
  errGeneric: string;
}

export const T: Record<Idioma, Textos> = {
  pt: {
    welcome: "Bem-vindo!", how: "Como podemos ajudar?",
    register: "Cadastro de acesso ao apartamento",
    registerDone: "Cadastro de acesso concluído",
    support: "Chat de Atendimento",
    required: "Obrigatório antes da chegada — libera as instruções de acesso",
    requiredDone: "Toque para incluir mais alguém na estadia",
    supportHint: "Wi-Fi, acesso, regras da casa — 24 horas",
    back: "Voltar",
    dates: "Datas da estadia", checkin: "Entrada", checkout: "Saída",
    guests: "Hóspedes", add: "Adicionar hóspede", guest: "Hóspede",
    responsible: "responsável",
    name: "Nome completo", email: "E-mail", phone: "Telefone",
    phoneSearch: "Buscar país",
    docTitle: "Documento",
    cpf: "CPF",
    foreign: "Sou estrangeiro",
    foreignHint: "Sem CPF? Informe nacionalidade e passaporte.",
    nationality: "Nacionalidade", passport: "Número do passaporte",
    nationalityPick: "Escolher país",
    photo: "Foto do documento",
    photoHint: "Ajuda a portaria a liberar sua entrada. Aceita foto ou PDF.",
    photoSending: "Preparando…",
    photoCamera: "Tirar foto",
    photoGallery: "Galeria / arquivo",
    photoRemove: "Remover",
    requiredHint: "Campos com * são obrigatórios",
    term: "Termo de responsabilidade",
    termText:
      "Declaro que cadastrei <b>todas as pessoas</b> que irão se hospedar, respeitando o limite de ocupação. " +
      "Assumo a responsabilidade pelo imóvel e <b>pelas demais pessoas que cadastrei</b> durante toda a estadia. " +
      "Comprometo-me a <b>não receber pessoas que não estão neste check-in</b> sem autorização do anfitrião. " +
      "Estou ciente de que será realizada uma <b>vistoria ao término</b>.",
    signTitle: "Assine o termo",
    signHint: "Assine com o dedo. O documento assinado é enviado ao anfitrião.",
    signMissing: "Assine o termo antes de concluir",
    submit: "Cadastrar e liberar acesso", sending: "Cadastrando…",
    placeholder: "Escreva sua dúvida…", assistant: "Assistente do imóvel",
    hello: "Olá", helpYou: "Como posso te ajudar?",
    done: "Cadastro concluído! As instruções de acesso foram enviadas para o seu e-mail.",
    errDates: "Informe as datas da estadia",
    errOrder: "A saída precisa ser depois da entrada",
    errTerm: "É necessário aceitar o termo de responsabilidade",
    errName: "informe o nome completo",
    errEmail: "e-mail inválido",
    errPhone: "telefone inválido",
    errCpf: "CPF inválido",
    errPassport: "número de passaporte inválido",
    errNationality: "escolha a nacionalidade",
    errPhoto: "não consegui ler essa imagem",
    errGeneric: "Não consegui concluir o cadastro",
  },

  en: {
    welcome: "Welcome!", how: "How can we help?",
    register: "Apartment access registration",
    registerDone: "Access registration complete",
    support: "Support chat",
    required: "Required before arrival — unlocks your access instructions",
    requiredDone: "Tap to add someone else to the stay",
    supportHint: "Wi-Fi, access, house rules — 24 hours",
    back: "Back",
    dates: "Stay dates", checkin: "Check-in", checkout: "Check-out",
    guests: "Guests", add: "Add guest", guest: "Guest",
    responsible: "responsible",
    name: "Full name", email: "Email", phone: "Phone",
    phoneSearch: "Search country",
    docTitle: "ID document",
    cpf: "CPF (Brazilian tax ID)",
    foreign: "I'm not Brazilian",
    foreignHint: "No CPF? Give your nationality and passport number.",
    nationality: "Nationality", passport: "Passport number",
    nationalityPick: "Choose country",
    photo: "Photo of your ID",
    photoHint: "Helps the front desk let you in. Photo or PDF.",
    photoSending: "Preparing…",
    photoCamera: "Take photo",
    photoGallery: "Gallery / file",
    photoRemove: "Remove",
    requiredHint: "Fields marked * are required",
    term: "Statement of responsibility",
    termText:
      "I declare that I have registered <b>every person</b> who will be staying, within the occupancy limit. " +
      "I take responsibility for the property and <b>for the other people I registered</b> for the whole stay. " +
      "I undertake <b>not to let in anyone who is not on this check-in</b> without the host's authorization. " +
      "I understand that an <b>inspection will be carried out at the end</b>.",
    signTitle: "Sign the statement",
    signHint: "Sign with your finger. The signed document is sent to the host.",
    signMissing: "Please sign before finishing",
    submit: "Register and unlock access", sending: "Registering…",
    placeholder: "Type your question…", assistant: "Property assistant",
    hello: "Hello", helpYou: "How can I help you?",
    done: "All set! Your access instructions were sent to your email.",
    errDates: "Enter the stay dates",
    errOrder: "Check-out must be after check-in",
    errTerm: "You must accept the statement of responsibility",
    errName: "enter the full name",
    errEmail: "invalid email",
    errPhone: "invalid phone number",
    errCpf: "invalid CPF",
    errPassport: "invalid passport number",
    errNationality: "choose the nationality",
    errPhoto: "couldn't read that image",
    errGeneric: "Couldn't complete the registration",
  },

  es: {
    welcome: "¡Bienvenido!", how: "¿Cómo podemos ayudar?",
    register: "Registro de acceso al apartamento",
    registerDone: "Registro de acceso completado",
    support: "Chat de atención",
    required: "Obligatorio antes de llegar — libera las instrucciones de acceso",
    requiredDone: "Toca para incluir a alguien más en la estancia",
    supportHint: "Wi-Fi, acceso, normas de la casa — 24 horas",
    back: "Volver",
    dates: "Fechas de la estancia", checkin: "Entrada", checkout: "Salida",
    guests: "Huéspedes", add: "Añadir huésped", guest: "Huésped",
    responsible: "responsable",
    name: "Nombre completo", email: "Correo electrónico", phone: "Teléfono",
    phoneSearch: "Buscar país",
    docTitle: "Documento",
    cpf: "CPF (documento brasileño)",
    foreign: "No soy brasileño",
    foreignHint: "¿Sin CPF? Indica nacionalidad y número de pasaporte.",
    nationality: "Nacionalidad", passport: "Número de pasaporte",
    nationalityPick: "Elegir país",
    photo: "Foto del documento",
    photoHint: "Ayuda a la portería a dejarte entrar. Foto o PDF.",
    photoSending: "Preparando…",
    photoCamera: "Hacer foto",
    photoGallery: "Galería / archivo",
    photoRemove: "Quitar",
    requiredHint: "Los campos con * son obligatorios",
    term: "Término de responsabilidad",
    termText:
      "Declaro que registré a <b>todas las personas</b> que se hospedarán, respetando el límite de ocupación. " +
      "Asumo la responsabilidad por el inmueble y <b>por las demás personas que registré</b> durante toda la estancia. " +
      "Me comprometo a <b>no recibir a personas que no constan en este check-in</b> sin autorización del anfitrión. " +
      "Soy consciente de que se realizará una <b>inspección al término</b>.",
    signTitle: "Firma el término",
    signHint: "Firma con el dedo. El documento firmado se envía al anfitrión.",
    signMissing: "Firma antes de finalizar",
    submit: "Registrar y liberar acceso", sending: "Registrando…",
    placeholder: "Escribe tu duda…", assistant: "Asistente del inmueble",
    hello: "Hola", helpYou: "¿Cómo puedo ayudarte?",
    done: "¡Registro completado! Las instrucciones de acceso se enviaron a tu correo.",
    errDates: "Indica las fechas de la estancia",
    errOrder: "La salida debe ser después de la entrada",
    errTerm: "Es necesario aceptar el término de responsabilidad",
    errName: "indica el nombre completo",
    errEmail: "correo inválido",
    errPhone: "teléfono inválido",
    errCpf: "CPF inválido",
    errPassport: "número de pasaporte inválido",
    errNationality: "elige la nacionalidad",
    errPhoto: "no pude leer esa imagen",
    errGeneric: "No pude completar el registro",
  },
};

/** Idioma inicial: o que a pessoa escolheu antes, ou o do navegador. */
export function idiomaInicial(): Idioma {
  try {
    const salvo = localStorage.getItem("hospedepay.idioma-hospede");
    if (salvo === "pt" || salvo === "en" || salvo === "es") return salvo;
  } catch {
    /* Safari privado bloqueia localStorage. Cai no idioma do navegador. */
  }
  const nav = (navigator.language || "pt").slice(0, 2).toLowerCase();
  return nav === "en" || nav === "es" ? nav : "pt";
}

export function salvarIdioma(id: Idioma): void {
  try {
    localStorage.setItem("hospedepay.idioma-hospede", id);
  } catch {
    /* Sem persistir, a escolha vale para esta visita. */
  }
}
