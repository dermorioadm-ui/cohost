-- 0044 — Termo do hospede v2.0, e o termo da limpeza.
--
-- A v1 do termo do hospede falava em danos e ocupacao. Nao falava do que mais
-- gera problema na pratica: gente que nao esta no check-in entrando no imovel.
-- Festa, sublocacao de fim de semana e visita que vira hospede sao o que faz o
-- condominio proibir aluguel por temporada — e o que o dono nao tem como
-- provar depois, se ninguem assinou nada dizendo o contrario.
--
-- A v1 nao e apagada, so desativada: documento assinado sob a v1 continua
-- valendo sob a v1, e a linha precisa existir para o historico apontar.

UPDATE public.term_versions SET active = false
 WHERE kind = 'cadastro_hospede' AND version = '1.0';

INSERT INTO public.term_versions (version, locale, title, kind, active, published_at, body) VALUES ('2.0', 'pt', 'Termo de Responsabilidade do Hospede', 'cadastro_hospede', true, now(), '1. IDENTIFICACAO DOS HOSPEDES
Declaro que cadastrei todas as pessoas que irao se hospedar no imovel, com nome e documento de cada uma, respeitando o limite de ocupacao informado pelo anfitriao. Declaro que as informacoes prestadas neste cadastro sao verdadeiras.

2. RESPONSABILIDADE PELO IMOVEL
Assumo a responsabilidade pelo imovel durante todo o periodo da hospedagem e respondo por eventuais danos causados por mim, pelos demais hospedes que cadastrei ou por qualquer pessoa que eu venha a permitir a entrada.

3. RESPONSABILIDADE PELOS DEMAIS HOSPEDES
Declaro ser o responsavel pelas demais pessoas cadastradas por mim neste check-in, inclusive por menores de idade sob minha guarda, e respondo por seus atos dentro do imovel e nas areas comuns do condominio.

4. ENTRADA DE PESSOAS NAO CADASTRADAS
Comprometo-me a NAO receber no imovel pessoas que nao constam deste check-in, sem autorizacao previa e expressa do anfitriao. Estou ciente de que a entrada de pessoas nao cadastradas caracteriza descumprimento deste termo e das regras do condominio, podendo resultar no encerramento imediato da hospedagem, sem reembolso, alem da responsabilidade por eventuais danos e penalidades aplicadas pelo condominio.

5. REGRAS DO CONDOMINIO
Declaro estar ciente de que devo respeitar as regras internas do condominio, inclusive horarios de silencio e uso de areas comuns, e que respondo por multas aplicadas em razao de descumprimento por mim ou pelos meus acompanhantes.

6. VISTORIA
Estou ciente de que podera ser realizada vistoria do imovel ao termino da estadia.

7. ASSINATURA
Assino este termo eletronicamente. A assinatura, a data, o horario e o endereco de rede do dispositivo utilizado ficam registrados e sao enviados ao anfitriao.');

INSERT INTO public.term_versions (version, locale, title, kind, active, published_at, body) VALUES ('2.0', 'en', 'Guest Statement of Responsibility', 'cadastro_hospede', true, now(), '1. GUEST IDENTIFICATION
I declare that I have registered every person who will be staying at the property, with the full name and identification document of each one, respecting the occupancy limit set by the host. I declare that the information provided is true.

2. RESPONSIBILITY FOR THE PROPERTY
I take responsibility for the property throughout the entire stay and am liable for any damage caused by me, by the other guests I registered, or by any person I allow to enter.

3. RESPONSIBILITY FOR THE OTHER GUESTS
I declare that I am responsible for the other people registered by me in this check-in, including any minors under my care, and I am liable for their conduct inside the property and in the common areas of the building.

4. ENTRY OF UNREGISTERED PEOPLE
I undertake NOT to allow into the property any person not listed in this check-in without the prior and express authorization of the host. I understand that allowing unregistered people in constitutes a breach of this statement and of the building rules, and may result in immediate termination of the stay without refund, in addition to liability for damages and penalties imposed by the building.

5. BUILDING RULES
I declare that I am aware that I must respect the internal rules of the building, including quiet hours and use of common areas, and that I am liable for fines imposed due to non-compliance by me or my companions.

6. INSPECTION
I understand that an inspection of the property may be carried out at the end of the stay.

7. SIGNATURE
I sign this statement electronically. The signature, date, time and network address of the device used are recorded and sent to the host.');

INSERT INTO public.term_versions (version, locale, title, kind, active, published_at, body) VALUES ('2.0', 'es', 'Termino de Responsabilidad del Huesped', 'cadastro_hospede', true, now(), '1. IDENTIFICACION DE LOS HUESPEDES
Declaro que registre a todas las personas que se hospedaran en el inmueble, con nombre y documento de cada una, respetando el limite de ocupacion informado por el anfitrion. Declaro que la informacion proporcionada es verdadera.

2. RESPONSABILIDAD POR EL INMUEBLE
Asumo la responsabilidad por el inmueble durante todo el periodo de la estancia y respondo por eventuales danos causados por mi, por los demas huespedes que registre o por cualquier persona a la que yo permita la entrada.

3. RESPONSABILIDAD POR LOS DEMAS HUESPEDES
Declaro ser responsable por las demas personas registradas por mi en este check-in, incluidos los menores de edad bajo mi guarda, y respondo por sus actos dentro del inmueble y en las areas comunes del edificio.

4. ENTRADA DE PERSONAS NO REGISTRADAS
Me comprometo a NO recibir en el inmueble a personas que no consten en este check-in, sin autorizacion previa y expresa del anfitrion. Soy consciente de que la entrada de personas no registradas constituye incumplimiento de este termino y de las reglas del edificio, pudiendo resultar en la finalizacion inmediata de la estancia, sin reembolso, ademas de la responsabilidad por eventuales danos y penalidades aplicadas por el edificio.

5. REGLAS DEL EDIFICIO
Declaro ser consciente de que debo respetar las reglas internas del edificio, incluidos los horarios de silencio y el uso de areas comunes, y que respondo por multas aplicadas por incumplimiento mio o de mis acompanantes.

6. INSPECCION
Soy consciente de que podra realizarse una inspeccion del inmueble al termino de la estancia.

7. FIRMA
Firmo este termino electronicamente. La firma, la fecha, la hora y la direccion de red del dispositivo utilizado quedan registradas y se envian al anfitrion.');

-- A declaracao da diarista. Existe em portugues so: quem faz a limpeza no
-- Brasil assina em portugues, e um termo traduzido que ninguem le e pior que
-- um termo que a pessoa entende.
INSERT INTO public.term_versions (version, locale, title, kind, active, published_at, body) VALUES ('1.0', 'pt', 'Declaracao de Limpeza Concluida', 'limpeza_concluida', true, now(), 'Declaro que realizei a limpeza e a arrumacao do imovel identificado neste documento, na data e no horario informados por mim acima.

Declaro que:

1. O imovel foi entregue limpo e em condicoes de receber o proximo hospede.

2. Comuniquei ao anfitriao qualquer dano, avaria ou falta de item que tenha encontrado durante a limpeza.

3. As informacoes de data e horario que preenchi sao verdadeiras.

Assino esta declaracao eletronicamente. A assinatura, a data, o horario e o endereco de rede do dispositivo utilizado ficam registrados.');
