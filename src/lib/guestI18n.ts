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
  dates: string; checkin: string; checkout: string; datePick: string;
  guests: string; add: string; guest: string; responsible: string;
  removeGuest: string;
  name: string; email: string; phone: string; phoneSearch: string;
  docTitle: string; cpf: string; foreign: string; foreignHint: string;
  nationality: string; passport: string; nationalityPick: string;
  photo: string; photoHint: string; photoSending: string;
  photoOpen: string; photoRemove: string; photoDone: string;
  face: {
    titulo: string; ajuda: string; abrir: string; disparar: string;
    refazer: string; consentimento: string; negada: string; arquivo: string;
  };
  errFace: string;
  requiredHint: string;
  stepStay: string; stepTerm: string; stepFace: string;
  stepOf: (n: number, total: number) => string;
  next: string; edit: string; reviewCount: (n: number) => string;
  nights: (n: number) => string;
  term: string; termText: string; termFull: string;
  signTitle: string; signHint: string; signMissing: string;
  submit: string; sending: string;
  placeholder: string; assistant: string; hello: string; helpYou: string;
  done: string;
  okTitle: string; okText: string;
  okDownload: string; okMore: string; okAsk: string;
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
    support: "Perguntar ao anfitrião",
    required: "Obrigatório antes da chegada — libera as instruções de acesso",
    requiredDone: "Toque para incluir mais alguém na estadia",
    supportHint: "Wi-Fi, acesso, regras da casa — 24 horas",
    back: "Voltar",
    dates: "Datas da estadia", checkin: "Entrada", checkout: "Saída",
    datePick: "Escolher",
    guests: "Hóspedes", add: "Adicionar hóspede", guest: "Hóspede",
    removeGuest: "Remover hóspede",
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
    photoHint: "Tire agora ou escolha uma foto que já esteja no celular.",
    photoSending: "Preparando…",
    photoOpen: "Enviar foto do documento",
    photoRemove: "Trocar",
    photoDone: "Documento enviado",
    face: {
      titulo: "Confirmação facial",
      ajuda: "Enquadre o rosto no oval, sem boné e sem óculos escuros. A foto entra no termo assinado, ao lado do seu documento.",
      abrir: "Abrir a câmera",
      disparar: "Tirar a foto",
      refazer: "Tirar outra",
      consentimento:
        "Sua foto é usada apenas para confirmar que foi você quem assinou este termo, e fica guardada junto do documento assinado. Ela não é usada para nenhuma outra finalidade.",
      negada:
        "Não consegui abrir a câmera. Libere o acesso nas configurações do navegador ou envie a foto pelo botão abaixo.",
      arquivo: "Enviar uma foto",
    },
    errFace: "faça a confirmação facial",
    requiredHint: "Campos com * são obrigatórios",
    stepStay: "Estadia",
    stepTerm: "Termo",
    stepFace: "Rosto",
    stepOf: (n, total) => `Passo ${n} de ${total}`,
    next: "Continuar", edit: "Editar",
    reviewCount: (n) => (n === 1 ? "1 hóspede" : `${n} hóspedes`),
    nights: (n) => (n === 1 ? "1 noite" : `${n} noites`),
    term: "Termo de responsabilidade",
    termText:
      "Declaro que cadastrei <b>todas as pessoas</b> que irão se hospedar, respeitando o limite de ocupação. " +
      "Assumo a responsabilidade pelo imóvel e <b>pelas demais pessoas que cadastrei</b> durante toda a estadia. " +
      "Comprometo-me a <b>não receber pessoas que não estão neste check-in</b> sem autorização do anfitrião. " +
      "Em caso de dano, <b>autorizo o anfitrião a pedir o ressarcimento pela plataforma da reserva</b> " +
      "(Airbnb, Booking) e a cobrança no meio de pagamento que registrei nela. " +
      "Estou ciente de que <b>o anfitrião não se responsabiliza por objetos esquecidos</b>, que ficam " +
      "guardados por 30 dias, e de que será realizada uma <b>vistoria ao término</b>. " +
      "Concordo que eventual disputa corre no <b>foro da comarca do imóvel</b>.",
    termFull: "Ler o termo completo",
    signTitle: "Assine o termo",
    signHint: "Assine com o dedo. O documento assinado é enviado ao anfitrião.",
    signMissing: "Assine o termo antes de concluir",
    submit: "Cadastrar e liberar acesso", sending: "Cadastrando…",
    placeholder: "Escreva sua dúvida…", assistant: "Assistente do imóvel",
    hello: "Olá", helpYou: "Como posso te ajudar?",
    okTitle: "Cadastro concluído",
    okText:
      "Tudo certo. As instruções de acesso e o termo que você assinou foram enviados " +
      "para o seu e-mail.",
    okDownload: "Baixar meu documento",
    okMore: "Cadastrar mais pessoas",
    okAsk: "Perguntar ao anfitrião",
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
    support: "Ask the host",
    required: "Required before arrival — unlocks your access instructions",
    requiredDone: "Tap to add someone else to the stay",
    supportHint: "Wi-Fi, access, house rules — 24 hours",
    back: "Back",
    dates: "Stay dates", checkin: "Check-in", checkout: "Check-out",
    datePick: "Select",
    guests: "Guests", add: "Add guest", guest: "Guest",
    removeGuest: "Remove guest",
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
    photoHint: "Take one now, or pick a photo already on your phone.",
    photoSending: "Preparing…",
    photoOpen: "Upload photo of your ID",
    photoRemove: "Replace",
    photoDone: "ID uploaded",
    face: {
      titulo: "Face confirmation",
      ajuda: "Fit your face in the oval, no hat and no sunglasses. The photo goes into the signed statement, next to your ID.",
      abrir: "Open the camera",
      disparar: "Take the photo",
      refazer: "Retake",
      consentimento:
        "Your photo is used only to confirm that you were the person who signed this statement, and is stored with the signed document. It is not used for anything else.",
      negada:
        "I couldn't open the camera. Allow access in your browser settings, or send the photo using the button below.",
      arquivo: "Send a photo",
    },
    errFace: "complete the face confirmation",
    requiredHint: "Fields marked * are required",
    stepStay: "Stay",
    stepTerm: "Statement",
    stepFace: "Face",
    stepOf: (n, total) => `Step ${n} of ${total}`,
    next: "Continue", edit: "Edit",
    reviewCount: (n) => (n === 1 ? "1 guest" : `${n} guests`),
    nights: (n) => (n === 1 ? "1 night" : `${n} nights`),
    term: "Statement of responsibility",
    termText:
      "I declare that I have registered <b>every person</b> who will be staying, within the occupancy limit. " +
      "I take responsibility for the property and <b>for the other people I registered</b> for the whole stay. " +
      "I undertake <b>not to let in anyone who is not on this check-in</b> without the host's authorization. " +
      "In case of damage, I <b>authorize the host to claim reimbursement through the booking platform</b> " +
      "(Airbnb, Booking) and the charge to the payment method I registered there. " +
      "I understand that the <b>host is not liable for items left behind</b>, which are kept for 30 days, " +
      "and that an <b>inspection will be carried out at the end</b>. " +
      "I agree that any dispute is heard in the <b>courts of the district where the property is</b>.",
    termFull: "Read the full statement",
    signTitle: "Sign the statement",
    signHint: "Sign with your finger. The signed document is sent to the host.",
    signMissing: "Please sign before finishing",
    submit: "Register and unlock access", sending: "Registering…",
    placeholder: "Type your question…", assistant: "Property assistant",
    hello: "Hello", helpYou: "How can I help you?",
    okTitle: "Registration complete",
    okText:
      "All set. Your access instructions and the statement you signed have been sent " +
      "to your email.",
    okDownload: "Download my document",
    okMore: "Register more people",
    okAsk: "Ask the host",
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
    support: "Preguntar al anfitrión",
    required: "Obligatorio antes de llegar — libera las instrucciones de acceso",
    requiredDone: "Toca para incluir a alguien más en la estancia",
    supportHint: "Wi-Fi, acceso, normas de la casa — 24 horas",
    back: "Volver",
    dates: "Fechas de la estancia", checkin: "Entrada", checkout: "Salida",
    datePick: "Elegir",
    guests: "Huéspedes", add: "Añadir huésped", guest: "Huésped",
    removeGuest: "Quitar huésped",
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
    photoHint: "Hazla ahora o elige una foto que ya tengas en el móvil.",
    photoSending: "Preparando…",
    photoOpen: "Enviar foto del documento",
    photoRemove: "Cambiar",
    photoDone: "Documento enviado",
    face: {
      titulo: "Confirmación facial",
      ajuda: "Encuadra tu cara en el óvalo, sin gorra y sin gafas de sol. La foto entra en el término firmado, junto a tu documento.",
      abrir: "Abrir la cámara",
      disparar: "Hacer la foto",
      refazer: "Repetir",
      consentimento:
        "Tu foto se usa solo para confirmar que fuiste tú quien firmó este término, y se guarda junto al documento firmado. No se usa para ninguna otra finalidad.",
      negada:
        "No pude abrir la cámara. Permite el acceso en los ajustes del navegador o envía la foto con el botón de abajo.",
      arquivo: "Enviar una foto",
    },
    errFace: "haz la confirmación facial",
    requiredHint: "Los campos con * son obligatorios",
    stepStay: "Estancia",
    stepTerm: "Término",
    stepFace: "Rostro",
    stepOf: (n, total) => `Paso ${n} de ${total}`,
    next: "Continuar", edit: "Editar",
    reviewCount: (n) => (n === 1 ? "1 huésped" : `${n} huéspedes`),
    nights: (n) => (n === 1 ? "1 noche" : `${n} noches`),
    term: "Término de responsabilidad",
    termText:
      "Declaro que registré a <b>todas las personas</b> que se hospedarán, respetando el límite de ocupación. " +
      "Asumo la responsabilidad por el inmueble y <b>por las demás personas que registré</b> durante toda la estancia. " +
      "Me comprometo a <b>no recibir a personas que no constan en este check-in</b> sin autorización del anfitrión. " +
      "En caso de daño, <b>autorizo al anfitrión a pedir el resarcimiento por la plataforma de la reserva</b> " +
      "(Airbnb, Booking) y el cobro en el medio de pago que registré en ella. " +
      "Soy consciente de que <b>el anfitrión no se responsabiliza por objetos olvidados</b>, que se guardan " +
      "30 días, y de que se realizará una <b>inspección al término</b>. " +
      "Acepto que cualquier disputa se resuelva en el <b>fuero de la comarca del inmueble</b>.",
    termFull: "Leer el término completo",
    signTitle: "Firma el término",
    signHint: "Firma con el dedo. El documento firmado se envía al anfitrión.",
    signMissing: "Firma antes de finalizar",
    submit: "Registrar y liberar acceso", sending: "Registrando…",
    placeholder: "Escribe tu duda…", assistant: "Asistente del inmueble",
    hello: "Hola", helpYou: "¿Cómo puedo ayudarte?",
    okTitle: "Registro completado",
    okText:
      "Todo listo. Las instrucciones de acceso y el término que firmaste fueron enviados " +
      "a tu correo.",
    okDownload: "Descargar mi documento",
    okMore: "Registrar más personas",
    okAsk: "Preguntar al anfitrión",
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
