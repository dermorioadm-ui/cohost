-- Cláusula de foro no termo do hóspede (3.0).
--
-- A 3.0 ainda não foi assinada por ninguém — nasceu inativa na 0048, esperando
-- a tela nova. Por isso o texto é EDITADO no lugar, e não versionado de novo:
-- versão nova só faz sentido para separar o que já foi assinado do que passou a
-- valer depois. Criar uma 3.1 aqui produziria uma versão morta no banco e um
-- número a mais para conferir em toda consulta.
--
-- ---------------------------------------------------------------------------
-- Por que a comarca do IMÓVEL, e não o domicílio do anfitrião
--
-- O pedido foi "o juizado de preferência do host". Escrito assim, ao pé da
-- letra, a cláusula tem grande chance de ser derrubada: o hóspede costuma ser
-- consumidor, e o art. 51, IV do CDC somado ao art. 63, §3 do CPC permite ao
-- juiz declarar ineficaz de ofício a eleição de foro que dificulte a defesa da
-- parte mais fraca. Cláusula derrubada não protege ninguém.
--
-- A eleição sobrevive quando o foro escolhido tem ligação real com os fatos. E
-- tem: a hospedagem aconteceu no imóvel, a vistoria foi feita no imóvel, o
-- prejuízo é no imóvel, e as provas e testemunhas estão lá. Na prática é o
-- mesmo lugar que o anfitrião queria — a diferença é que este resiste.
--
-- A ressalva final (o consumidor pode propor ação no próprio domicílio) não é
-- concessão: é o que impede o juiz de anular a cláusula inteira. E ela não
-- custa nada no caso que interessa ao anfitrião, em que ele é o AUTOR cobrando
-- dano — aí quem escolhe o foro é ele, e a eleição vale.

BEGIN;

UPDATE public.term_versions
   SET body = replace(
         body,
         E'10. ASSINATURA',
         E'10. LEI APLICÁVEL E FORO\n'
         || E'Este termo é regido pela lei brasileira.\n\n'
         || E'Para dirimir qualquer questão decorrente deste termo ou da hospedagem, '
         || E'fica eleito o foro da comarca onde se situa o imóvel — lugar em que a '
         || E'hospedagem ocorreu, em que é realizada a vistoria e em que se encontram '
         || E'as provas e as testemunhas dos fatos.\n\n'
         || E'A eleição acima não afasta o direito que a lei assegure ao hóspede '
         || E'consumidor de propor ação no foro do seu próprio domicílio.\n\n'
         || E'11. ASSINATURA'
       )
 WHERE kind = 'cadastro_hospede' AND version = '3.0' AND locale = 'pt';

UPDATE public.term_versions
   SET body = replace(
         body,
         E'10. SIGNATURE',
         E'10. GOVERNING LAW AND JURISDICTION\n'
         || E'This statement is governed by Brazilian law.\n\n'
         || E'Any dispute arising from this statement or from the stay shall be brought '
         || E'before the courts of the district where the property is located — the place '
         || E'where the stay took place, where the inspection is carried out and where the '
         || E'evidence and the witnesses to the facts are.\n\n'
         || E'The choice above does not remove any right the law grants a guest, as a '
         || E'consumer, to bring an action in the courts of their own domicile.\n\n'
         || E'11. SIGNATURE'
       )
 WHERE kind = 'cadastro_hospede' AND version = '3.0' AND locale = 'en';

UPDATE public.term_versions
   SET body = replace(
         body,
         E'10. FIRMA',
         E'10. LEY APLICABLE Y FUERO\n'
         || E'Este término se rige por la ley brasileña.\n\n'
         || E'Para dirimir cualquier cuestión derivada de este término o de la estancia, '
         || E'se elige el fuero de la comarca donde se sitúa el inmueble — lugar en que la '
         || E'estancia ocurrió, en que se realiza la inspección y en que se encuentran las '
         || E'pruebas y los testigos de los hechos.\n\n'
         || E'La elección anterior no excluye el derecho que la ley reconozca al huésped '
         || E'consumidor de presentar demanda en el fuero de su propio domicilio.\n\n'
         || E'11. FIRMA'
       )
 WHERE kind = 'cadastro_hospede' AND version = '3.0' AND locale = 'es';

COMMIT;

-- A 3.0 continua INATIVA aqui de propósito.
--
-- O resumo que o hóspede marca na tela vive no frontend, e o frontend sobe
-- depois do banco. Ativar antes do deploy faria a pessoa marcar um resumo sem
-- as cláusulas 7, 8 e 10 e assinar um PDF que as contém — e "eu nunca vi isso"
-- é exatamente o argumento que derruba a cláusula no dia em que ela importa.
--
-- Depois que a tela nova estiver no ar:
--
--   UPDATE public.term_versions SET active = (version = '3.0')
--    WHERE kind = 'cadastro_hospede' AND version IN ('2.0', '3.0');
