-- Termo do hóspede 3.0 — ressarcimento pela plataforma e objetos esquecidos.
--
-- Duas cláusulas novas, e uma que só documenta o que o cadastro já coleta.
--
-- A de RESSARCIMENTO existe para ser apresentada ao Airbnb ou à Booking. Nem
-- uma nem outra dá a terceiros o poder de debitar um cartão; o que elas têm é
-- um procedimento de danos (Centro de Resoluções / AirCover no Airbnb, o
-- processo de danos da Booking) em que o anfitrião abre um pedido e a
-- plataforma decide. O que este termo acrescenta a esse pedido é o
-- consentimento EXPRESSO do titular do meio de pagamento, dado antes do fato,
-- assinado, com documento e rosto anexados — que é exatamente a peça que falta
-- na maioria dos pedidos recusados por "falta de comprovação".
--
-- Por isso o texto termina dizendo que a cobrança efetiva depende da decisão
-- da plataforma. Não é ressalva contra o anfitrião: é o contrário. Um termo
-- que prometesse débito automático seria contestável inteiro, e o parágrafo
-- seguinte preserva a dívida pelas vias comuns quando a plataforma não cobra
-- ou cobra menos que o prejuízo.
--
-- A de OBJETOS ESQUECIDOS afasta a responsabilidade sem afastar a boa-fé:
-- o anfitrião não responde pelo que ficou para trás, mas guarda por 30 dias e
-- devolve a quem pedir, com o custo do envio por conta de quem esqueceu.
--
-- A 2.0 é DESATIVADA, nunca apagada. Cada assinatura guarda uma cópia do texto
-- que foi assinado (`assinaturas.term_texto`), mas a linha de origem é o que
-- permite dizer qual versão estava publicada em cada data.
--
-- SEQUENCIAMENTO: a 3.0 nasce INATIVA. O resumo que o hóspede marca na tela
-- vive no frontend, e o frontend sobe depois do banco. Ativar a 3.0 antes do
-- deploy faria a pessoa marcar um resumo sem as cláusulas 7 e 8 e assinar um
-- PDF que as contém — "eu nunca vi isso" é exatamente o argumento que derruba
-- a cláusula no dia em que ela importa. A troca é feita depois, com o
-- `UPDATE` comentado no fim deste arquivo.

BEGIN;

INSERT INTO public.term_versions (kind, locale, version, title, body, active)
VALUES
(
  'cadastro_hospede', 'pt', '3.0',
  'Termo de Responsabilidade do Hóspede',
  E'1. IDENTIFICAÇÃO DOS HÓSPEDES\n'
  'Declaro que cadastrei todas as pessoas que irão se hospedar no imóvel, com nome e documento de cada uma, respeitando o limite de ocupação informado pelo anfitrião. Declaro que as informações prestadas neste cadastro são verdadeiras.\n\n'
  '2. RESPONSABILIDADE PELO IMÓVEL\n'
  'Assumo a responsabilidade pelo imóvel durante todo o período da hospedagem e respondo por eventuais danos causados por mim, pelos demais hóspedes que cadastrei ou por qualquer pessoa a quem eu venha a permitir a entrada.\n\n'
  '3. RESPONSABILIDADE PELOS DEMAIS HÓSPEDES\n'
  'Declaro ser o responsável pelas demais pessoas cadastradas por mim neste check-in, inclusive por menores de idade sob minha guarda, e respondo por seus atos dentro do imóvel e nas áreas comuns do condomínio.\n\n'
  '4. ENTRADA DE PESSOAS NÃO CADASTRADAS\n'
  'Comprometo-me a NÃO receber no imóvel pessoas que não constam deste check-in, sem autorização prévia e expressa do anfitrião. Estou ciente de que a entrada de pessoas não cadastradas caracteriza descumprimento deste termo e das regras do condomínio, podendo resultar no encerramento imediato da hospedagem, sem reembolso, além da responsabilidade por eventuais danos e penalidades aplicadas pelo condomínio.\n\n'
  '5. REGRAS DO CONDOMÍNIO\n'
  'Declaro estar ciente de que devo respeitar as regras internas do condomínio, inclusive horários de silêncio e uso de áreas comuns, e que respondo por multas aplicadas em razão de descumprimento por mim ou pelos meus acompanhantes.\n\n'
  '6. VISTORIA\n'
  'Estou ciente de que poderá ser realizada vistoria do imóvel ao término da estadia, e de que o seu resultado, acompanhado de registro fotográfico, poderá instruir pedido de ressarcimento na forma da cláusula 7.\n\n'
  '7. RESSARCIMENTO DE DANOS E AUTORIZAÇÃO DE COBRANÇA PELA PLATAFORMA\n'
  'Reconheço que respondo pelo custo integral do reparo ou da reposição de bens danificados, da limpeza extraordinária e das multas condominiais decorrentes da minha estadia.\n\n'
  'Autorizo expressamente o anfitrião a (a) apresentar este termo, o registro da vistoria e os orçamentos correspondentes à plataforma por meio da qual a reserva foi feita — Airbnb, Booking.com ou outra —, instaurando o procedimento de cobrança de danos previsto nas regras dessa plataforma; e (b) cobrar o valor apurado do meio de pagamento que registrei nessa plataforma, até o limite por ela admitido.\n\n'
  'Este consentimento é dado de forma livre, informada e prévia, e vale como autorização do titular do meio de pagamento para os fins do procedimento de danos da plataforma.\n\n'
  'Estou ciente de que a cobrança efetiva depende das regras e da decisão da plataforma, e de que a ausência ou a insuficiência dessa cobrança não me exonera da obrigação de ressarcir o anfitrião pelo valor integral do prejuízo pelas vias comuns.\n\n'
  '8. OBJETOS ESQUECIDOS\n'
  'Os objetos deixados no imóvel após a minha saída são de minha inteira responsabilidade. O anfitrião NÃO responde por perda, extravio ou dano de pertences esquecidos.\n\n'
  'Estou ciente de que, se algum objeto for encontrado, o anfitrião entrará em contato e o manterá guardado por até 30 (trinta) dias contados da data de saída. A devolução, quando solicitada, se dá por retirada no local ou por envio, correndo por minha conta os custos de embalagem, transporte e seguro. Decorrido o prazo sem manifestação minha, o objeto poderá ser descartado ou doado.\n\n'
  '9. CONFIRMAÇÃO DE IDENTIDADE\n'
  'Envio, junto com este termo, a imagem do meu documento de identificação e uma fotografia do meu rosto, tirada no momento da assinatura. Autorizo o uso dessas imagens exclusivamente para confirmar a autoria desta assinatura e a minha identidade perante o anfitrião, o condomínio e a plataforma de reserva, e estou ciente de que elas ficam arquivadas junto deste documento.\n\n'
  '10. ASSINATURA\n'
  'Assino este termo eletronicamente. A assinatura, a data, o horário e o endereço de rede do dispositivo utilizado ficam registrados e são enviados ao anfitrião.',
  false
),
(
  'cadastro_hospede', 'en', '3.0',
  'Guest Statement of Responsibility',
  E'1. GUEST IDENTIFICATION\n'
  'I declare that I have registered every person who will be staying at the property, with the full name and identification document of each one, respecting the occupancy limit set by the host. I declare that the information provided is true.\n\n'
  '2. RESPONSIBILITY FOR THE PROPERTY\n'
  'I take responsibility for the property throughout the entire stay and am liable for any damage caused by me, by the other guests I registered, or by any person I allow to enter.\n\n'
  '3. RESPONSIBILITY FOR THE OTHER GUESTS\n'
  'I declare that I am responsible for the other people registered by me in this check-in, including minors under my care, and I am liable for their acts inside the property and in the common areas of the building.\n\n'
  '4. ENTRY OF UNREGISTERED PEOPLE\n'
  'I undertake NOT to receive at the property any person not listed in this check-in without the host''s prior and express authorisation. I understand that allowing unregistered people in constitutes a breach of this statement and of the building rules, and may result in immediate termination of the stay without refund, in addition to liability for any damage and for penalties applied by the building.\n\n'
  '5. BUILDING RULES\n'
  'I understand that I must respect the internal rules of the building, including quiet hours and the use of common areas, and that I am liable for fines applied due to a breach by me or by my companions.\n\n'
  '6. INSPECTION\n'
  'I understand that an inspection of the property may be carried out at the end of the stay, and that its result, together with photographic records, may support a reimbursement claim under clause 7.\n\n'
  '7. DAMAGE REIMBURSEMENT AND AUTHORISATION TO CHARGE VIA THE PLATFORM\n'
  'I acknowledge that I am liable for the full cost of repairing or replacing damaged property, for extraordinary cleaning, and for building fines arising from my stay.\n\n'
  'I expressly authorise the host to (a) submit this statement, the inspection record and the corresponding quotes to the platform through which the reservation was made — Airbnb, Booking.com or another — opening the damage claim procedure provided for in that platform''s rules; and (b) charge the assessed amount to the payment method I registered with that platform, up to the limit it allows.\n\n'
  'This consent is given freely, on an informed basis and in advance, and stands as the authorisation of the cardholder for the purposes of the platform''s damage procedure.\n\n'
  'I understand that the actual charge depends on the platform''s rules and decision, and that the absence or insufficiency of such a charge does not release me from the obligation to reimburse the host for the full amount of the loss by ordinary means.\n\n'
  '8. ITEMS LEFT BEHIND\n'
  'Items left at the property after my departure are entirely my own responsibility. The host is NOT liable for the loss, misplacement or damage of forgotten belongings.\n\n'
  'I understand that if an item is found, the host will make contact and keep it for up to 30 (thirty) days from the check-out date. Return, when requested, is by collection on site or by shipping, with packaging, transport and insurance costs borne by me. Once that period has passed with no word from me, the item may be discarded or donated.\n\n'
  '9. IDENTITY CONFIRMATION\n'
  'Together with this statement I submit an image of my identification document and a photograph of my face, taken at the moment of signing. I authorise the use of these images solely to confirm the authorship of this signature and my identity before the host, the building and the booking platform, and I understand that they are stored together with this document.\n\n'
  '10. SIGNATURE\n'
  'I sign this statement electronically. The signature, the date, the time and the network address of the device used are recorded and sent to the host.',
  false
),
(
  'cadastro_hospede', 'es', '3.0',
  'Término de Responsabilidad del Huésped',
  E'1. IDENTIFICACIÓN DE LOS HUÉSPEDES\n'
  'Declaro que registré a todas las personas que se hospedarán en el inmueble, con nombre y documento de cada una, respetando el límite de ocupación informado por el anfitrión. Declaro que la información proporcionada es verdadera.\n\n'
  '2. RESPONSABILIDAD POR EL INMUEBLE\n'
  'Asumo la responsabilidad por el inmueble durante todo el período de la estancia y respondo por eventuales daños causados por mí, por los demás huéspedes que registré o por cualquier persona a quien yo permita la entrada.\n\n'
  '3. RESPONSABILIDAD POR LOS DEMÁS HUÉSPEDES\n'
  'Declaro ser el responsable de las demás personas registradas por mí en este check-in, incluidos los menores de edad bajo mi guarda, y respondo por sus actos dentro del inmueble y en las áreas comunes del edificio.\n\n'
  '4. ENTRADA DE PERSONAS NO REGISTRADAS\n'
  'Me comprometo a NO recibir en el inmueble a personas que no consten en este check-in, sin autorización previa y expresa del anfitrión. Soy consciente de que la entrada de personas no registradas constituye incumplimiento de este término y de las normas del edificio, y puede resultar en la terminación inmediata de la estancia, sin reembolso, además de la responsabilidad por eventuales daños y penalidades aplicadas por el edificio.\n\n'
  '5. NORMAS DEL EDIFICIO\n'
  'Declaro ser consciente de que debo respetar las normas internas del edificio, incluidos los horarios de silencio y el uso de áreas comunes, y de que respondo por multas aplicadas por incumplimiento mío o de mis acompañantes.\n\n'
  '6. INSPECCIÓN\n'
  'Soy consciente de que podrá realizarse una inspección del inmueble al término de la estancia, y de que su resultado, acompañado de registro fotográfico, podrá instruir una solicitud de resarcimiento conforme a la cláusula 7.\n\n'
  '7. RESARCIMIENTO DE DAÑOS Y AUTORIZACIÓN DE COBRO POR LA PLATAFORMA\n'
  'Reconozco que respondo por el costo íntegro de la reparación o reposición de bienes dañados, de la limpieza extraordinaria y de las multas del edificio derivadas de mi estancia.\n\n'
  'Autorizo expresamente al anfitrión a (a) presentar este término, el registro de la inspección y los presupuestos correspondientes a la plataforma mediante la cual se hizo la reserva — Airbnb, Booking.com u otra —, instaurando el procedimiento de cobro de daños previsto en las normas de esa plataforma; y (b) cobrar el importe determinado del medio de pago que registré en esa plataforma, hasta el límite por ella admitido.\n\n'
  'Este consentimiento se otorga de forma libre, informada y previa, y vale como autorización del titular del medio de pago para los fines del procedimiento de daños de la plataforma.\n\n'
  'Soy consciente de que el cobro efectivo depende de las normas y de la decisión de la plataforma, y de que la ausencia o insuficiencia de ese cobro no me exonera de la obligación de resarcir al anfitrión por el importe íntegro del perjuicio por las vías comunes.\n\n'
  '8. OBJETOS OLVIDADOS\n'
  'Los objetos dejados en el inmueble después de mi salida son de mi entera responsabilidad. El anfitrión NO responde por pérdida, extravío o daño de pertenencias olvidadas.\n\n'
  'Soy consciente de que, si se encuentra algún objeto, el anfitrión se pondrá en contacto y lo mantendrá guardado hasta 30 (treinta) días contados desde la fecha de salida. La devolución, cuando se solicite, se realiza por retirada en el lugar o por envío, corriendo por mi cuenta los costos de embalaje, transporte y seguro. Transcurrido el plazo sin manifestación mía, el objeto podrá ser descartado o donado.\n\n'
  '9. CONFIRMACIÓN DE IDENTIDAD\n'
  'Envío, junto con este término, la imagen de mi documento de identificación y una fotografía de mi rostro, tomada en el momento de la firma. Autorizo el uso de esas imágenes exclusivamente para confirmar la autoría de esta firma y mi identidad ante el anfitrión, el edificio y la plataforma de reserva, y soy consciente de que quedan archivadas junto a este documento.\n\n'
  '10. FIRMA\n'
  'Firmo este término electrónicamente. La firma, la fecha, la hora y la dirección de red del dispositivo utilizado quedan registradas y se envían al anfitrión.',
  false
);

COMMIT;

-- Depois que a tela com o resumo novo estiver publicada, rodar:
--
--   UPDATE public.term_versions SET active = (version = '3.0')
--    WHERE kind = 'cadastro_hospede' AND version IN ('2.0', '3.0');

