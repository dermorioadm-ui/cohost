# Assistência jurídica: decisões desta implementação

Registro de 19/09/2026. Versão para revisão, sem publicação ou ativação comercial.

## Correção solicitada por Paulo — apresentação vigente

Paulo rejeitou a apresentação inicial: benefício escondido depois da garantia, texto de preparação como argumento principal e ausência de imagem do advogado. A posição e a direção da correção são dele: **quarta cena fotográfica → destaque da assistência dentro dos planos → garantia específica da ferramenta**. A versão anterior abaixo permanece como histórico, não como recomendação vigente.

### Assinaturas e responsabilidade

| Trabalho | Responsável | Entrega nesta correção |
| --- | --- | --- |
| Direção comercial e escolha da posição | Paulo | Quarta imagem, benefício preventivo e reação ao dano, card junto da oferta e asterisco |
| Copy | Botini | Novo hook, benefício, chamadas e nota de contratação |
| Direção visual e código da Landing | Gabriel | Quarta cena, card dentro dos planos e apresentação responsiva |
| Geração da imagem, integração, testes e revisão | Aline | Fotografia ilustrativa, alinhamento do upsell, verificação e prévia |

Na entrega rejeitada, Botini escreveu a copy, Thiago propôs a sequência depois da garantia, Gabriel implementou o visual e Aline integrou e aprovou a entrega. Aline assume a responsabilidade pela revisão. Sophia implementou a infraestrutura anterior; ela não escreveu a copy criticada nem executou esta correção visual.

Toda entrega e correção deve identificar quem escreveu, quem executou e quem revisou, com a contribuição real. Esses créditos pertencem ao registro do trabalho e à comunicação com Paulo, não à interface comercial do cliente. Não atribuir execução ou aprovação a quem não participou.

### Benefício, oferta e imagem

A quarta cena usa “Seu prejuízo merece mais que um ‘não’.” e apresenta apoio para agir e buscar reparação quando o hóspede ou a plataforma não assumem o dano. O card dentro dos planos usa “Da proteção do imóvel à busca por reparação.” O upsell mantém o mesmo benefício após confirmação real da compra.

`public/lp/assistencia-juridica.png` é uma imagem gerada com IA nesta correção: cena ilustrativa de um advogado revisando documentos e a fotografia de um imóvel danificado. Não representa um profissional identificado, depoimento ou caso comprovado. Foi criada para esta página, não reutilizada como prova de uma parceria já operacional.

A apresentação mantém seu benefício mesmo sem oferta ativa, com status curto de prévia junto da ação. Preço e checkout continuam dependentes da configuração real. A nota próxima ao CTA informa contratação anual separada; o comprador consulta escopo e condições antes do pagamento. Não há promessa de vitória ou indenização garantida.

Aline acrescentou a chamada com asterisco junto aos botões de cada plano, usando o texto de Botini e levando ao card jurídico. Build e os 10 testes de interface passaram nesta correção; capturas da quarta cena e do card foram inspecionadas em celular e desktop.

**Fundamento efetivamente usado:** correção direta de Paulo, análise da página e revisão de Botini/Gabriel. Princípio: mostrar primeiro o problema e o benefício, conectar a prevenção ao apoio após o dano e apresentar a assistência na decisão de compra. É uma hipótese comercial coerente com a direção do fundador, sem resultado de conversão medido.

## Apresentação inicial — substituída pela correção acima

A estratégia recebida define dois percursos comerciais: conversa no WhatsApp e compra direta pela página. A proposta de mostrar o jurídico na página e fazer uma oferta opcional imediatamente após a compra veio do fundador. A equipe não atribui a si a autoria dessa ideia.

Botini, Thiago e Gabriel revisaram a estratégia registrada e o código e convergiram nesta sequência: **planos → garantia da ferramenta → assistência jurídica opcional → contato → FAQ**. A posição é semântica; não promete a mesma dobra física em telas diferentes. Separar a garantia evita estendê-la a um serviço de condições próprias.

O bloco usa a identidade existente: marca oficial, coral, branco, preto e tipografia editorial. O hook escolhido é “E quando o problema pede um advogado?”. A oferta indisponível apresenta preparação do serviço, sem preço nem cobrança. Disponível, mostra primeiro o total anual real, depois o equivalente mensal e os termos.

O upsell só aparece após confirmação do servidor, sem interromper a configuração. Pode ser dispensado. A área jurídica oferece retorno à configuração quando a ferramenta está ativa. Não há temporizador, exclusividade, desconto ou escassez sem configuração real.

## Fundamentos e limites

| Fonte efetivamente usada | Princípio aplicado | Consequência | Limite |
| --- | --- | --- | --- |
| Estratégia vigente informada pelo fundador | Complemento opcional e venda após confirmação | Página e pós-compra apresentam o jurídico | Conversão incremental ainda não medida |
| Revisões independentes de copy, funil e mídia | Clareza da oferta e continuidade da tarefa | Anual explícito; configuração permanece acessível | Não houve leitura nova de livros ou pesquisa de mercado nesta rodada |
| Código de checkout e estado da assinatura | Estado confirmado, não presumido | Timeout nunca libera acesso; checkout não autentica pelo e-mail digitado | Stripe, Supabase Auth e e-mail ainda exigem teste integrado |
| Regra de vigência independente | Cancelar um produto não cancela outro contrato | Área jurídica e histórico fora do bloqueio do SaaS | Escopo, preço final e operação dependem de configuração |

Sophia implementou migrações, pagamentos, vigência e atendimento. A integração frontend e os testes de interface foram implementados e revisados em conjunto com a coordenação. Fontes técnicas e procedimentos estão no [runbook](../backend/docs/assistencia-juridica.md).

## Escopo comercial ainda aberto

Esta entrega não reconfigura preços SaaS no banco ou na Stripe. O catálogo legado da Landing continua como estava: valores anuais e opções de vários imóveis não devem ser tratados como aprovação das condições dos dois novos funis. Removida a promessa local de dez parcelas; a diferenciação completa dos dois percursos e seus preços deve ser implementada a partir de condições finais consistentes no catálogo e no checkout.

O jurídico cobra, quando habilitado, um pagamento integral por 12 meses, sem renovação automática. Parcelamento, desconto, termos finais, cobertura por imóvel, capacidade e operação permanecem pendentes. Nenhuma partilha financeira automática foi implementada.

## Evidência de verificação

- 26 testes TypeScript passaram: incluem validação de reconciliação, autenticação e retorno seguro; serviços externos simulados.
- 5 testes executam as novas regras SQL/RPC/RLS em PostgreSQL/PGlite com identidade de teste.
- 10 testes em Chromium passaram: página mobile/desktop, consentimento, checkout, timeout, upsell, pedidos, resposta, histórico e acesso independente.
- TypeScript e build Vite passaram. As capturas desktop e mobile foram inspecionadas.

Não houve cobrança, envio de e-mail, migração ou teste de cartão em produção. A oferta fica desabilitada até configuração e verificação em ambiente integrado. Build bem-sucedido e APIs simuladas não demonstram entrega de e-mail, evento Stripe assinado ou operação real do escritório.
