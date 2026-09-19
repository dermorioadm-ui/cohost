# Assistência jurídica — implementação e operação

Esta alteração prepara contratação anual avulsa e atendimento independente da ferramenta. Não aplica migrações, não publica funções, não cria produtos/preços e não cobra cartões. A oferta nasce bloqueada. R$1.164/ano é referência estratégica, não preço semeado no banco.

## Contrato com o app

| Recurso | Identidade e comportamento |
| --- | --- |
| `legal_offer()` | Público; devolve `{available:false,offer:null}` até configuração completa. Quando disponível, contém apenas condições publicáveis; não divulga operador nem identificadores Stripe. |
| `legal_overview()` | Usuário autenticado; `{has_access,entitlements,requests,orders}`. `has_access` calculado no banco: status active e `starts_at <= now() < ends_at`. Histórico continua disponível após vencimento. |
| `legal_create_request(_subject,_description,_request_key)` | Abre atendimento com direito vigente, idempotente por cliente/chave UUID. Assunto 5–160 e descrição 20–6000 caracteres. |
| `legal_reply_request(_id,_message,_request_key)` | Responde no pedido próprio aberto, com direito vigente; 1–6000 caracteres. Mensagens ficam no histórico do pedido. |
| `admin_legal_requests()` | Apenas admin existente. Fila com email/nome do cliente e mensagens. |
| `admin_legal_update_request(_id,_status,_public_reply)` | Apenas admin. Estados received, in_review, waiting_customer, completed. Resposta pública registrada como mensagem e atualização auditada. Pode concluir atendimento iniciado mesmo após vencimento. |
| `admin_legal_payment_reviews()` | Apenas admin. Exceções de reembolso/disputa ou criação sem associação Stripe por mais de uma hora. |
| Edge `legal-checkout` | POST autenticado owner/admin `{offer_id:'legal-annual',offer_version,accepted_terms:true,request_id:UUID}`. Retorna `{ok,url,session_id}`. |
| Edge `legal-checkout-status` | POST autenticado `{session_id}`; confere dono antes de consultar Stripe. `{ok,state:'active'|'pending'|'failed',entitlement}`. URL não concede acesso. |

`requests` inclui `messages:[{id,request_id,author_id,author_role,message,created_at}]`. O texto de pedidos e mensagens não vai para notificações, logs ou metadata Stripe. A fila administrativa é o canal operacional mínimo: o operador autorizado precisa acompanhá-la. Esta entrega não cadastra nem concede papel admin a ninguém do escritório.

Erros estáveis de checkout: `legal_offer_unavailable`, `legal_offer_changed`, `legal_already_active`, `legal_checkout_pending`. Após tentativa encerrada, gerar novo UUID de checkout. Mesmo com UUID novo, uma ordem ainda creating/pending é reaproveitada pelo servidor; um cliente não pode manter dois checkouts jurídicos pendentes pelo endpoint. Tentativa travada em creating requer conferência operacional antes de liberação.

## Antes de liberar a oferta

Ainda precisam de decisão real: preço final, serviços incluídos/excluídos, imóveis cobertos, capacidade e responsável pelo atendimento, prazos ou ausência deles, condições para demandas intensivas, cancelamento/reembolso, termos finais, base da partilha, calendário de repasses e eventual parcelamento/desconto. Nenhum SLA, quantidade de imóveis, parcelamento ou divisão automática foi inventado.

O caminho implementado cobra integralmente uma contratação de 12 meses, sem renovação automática. Não oferece parcelamento, promoção, trial ou assinatura recorrente do jurídico. Se o modelo aprovado exigir parcelas/desconto/renovação, implementar e verificar esse modelo antes de disponibilizá-lo.

Configuração administrativa em `public.legal_offers`, somente service_role:

- `annual_price_cents` e `stripe_price_id`: preço final aprovado e Price real **one_time**, ativo, moeda BRL, valor exato, billing_scheme per_unit, produto ativo. A Edge consulta a API Stripe antes de criar Checkout. Test/live deve corresponder à chave usada pela Edge.
- `scope_text`, `property_scope_text`, `service_terms`, `payment_terms`, `terms_url`: textos finais completos, coerentes com pagamento integral anual, URL HTTPS real de termos.
- `coordinator_user_id`: usuário que já tem papel admin e assume a fila; `operations_ready=true` somente quando a operação estiver pronta.
- `enabled=true` somente após revisão desses valores e da verificação em teste. Alterações na configuração incrementam automaticamente `version`; o navegador precisa reconfirmar a versão vigente.

Não há valores fictícios prontos para copiar em SQL. O cadastro fica desabilitado até que dados reais sejam fornecidos. Oferta desabilitada não impede cumprir pagamento já realizado nem ler atendimento contratado.

## Stripe e reconciliação

Checkout Session e PaymentIntent recebem metadata `product=legal_assistance`, `legal_order_id=<UUID>` e `supabase_user_id=<UUID>`, definida no servidor. Não é necessário usar metadata no Product Stripe para roteamento; o Price tem que ser dedicado à contratação jurídica aprovada. O jurídico não usa `profiles.stripe_subscription_id`, não cria assinatura recorrente e não entra no portal de cancelamento do SaaS.

Eventos adicionais preparados em `ops-stripe-webhook`: `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created` e `charge.dispute.closed`, além de `checkout.session.completed` e eventos SaaS existentes. Atualizar a assinatura do endpoint existente após autorização; não recriar segredo sem necessidade. O código jurídico roda depois da verificação HMAC e antes do marcador legado de eventos.

Reconciliação consulta Session com `line_items` e `payment_intent.latest_charge`. Confere produto, modo payment, cliente vinculado por ID autenticado, ordem, preço, quantidade, moeda, total e pagamento efetivamente bem-sucedido. Pagamento/direito/evento são persistidos em uma transação SQL. Repetição nunca estende vigência. Evento atrasado consulta o objeto atual da Stripe; falhas antigas não rebaixam uma compra paga. Reembolso/disputa abre revisão e confirmação antiga não cria um novo direito depois dessa revisão.

A vigência é de 12 meses de calendário a partir do timestamp da cobrança bem-sucedida informado pela Stripe; a confirmação repetida preserva as mesmas datas. Um reembolso não aplica política jurídica de cancelamento ainda indefinida: se o direito já existia, não é automaticamente revogado. A operação precisa tratar essa exceção conforme os termos aprovados. Não há Stripe Connect, split, transferência nem registro de lucro; a partilha comercial não é executada automaticamente nesta versão.

## Publicação autorizada, ordem e reversão

1. Validar em projeto Supabase de teste e conta Stripe test separados. Executar migrações existentes necessárias e depois `0062_assistencia_juridica.sql`, `0063_bloqueia_operacoes_sem_software.sql`, `0064_webhook_tentativas.sql`. A migração 0062 não habilita venda. 0063 não apaga dados.
2. Publicar Edge novas e modificadas com as migrações já presentes, incluindo os endpoints operacionais que usam o novo gate e o retorno público do checkout. Preservar as variáveis existentes e apontar `APP_BASE_URL` para o ambiente correto. `legal-checkout` e `legal-checkout-status` exigem JWT e validam a identidade novamente no servidor.
3. Atualizar eventos do webhook existente. `ops-stripe-webhook` foi ajustada no código; nenhuma chamada operacional foi executada nesta tarefa. Conferir segredo HMAC existente, sem imprimir seu valor.
4. Publicar frontend compatível com `requires_login` do retorno público e as RPCs jurídicas. Confirmar compra de teste, email de recuperação, login, acesso jurídico, pedido, resposta admin/cliente e persistência após recarregar; repetir com SaaS cancelado e outro usuário.
5. Configurar condições reais e habilitar venda somente no ambiente aprovado após esses resultados. Na publicação em produção, repetir inspeção de configuração sem cartão real, salvo autorização específica posterior.

Para interromper novas vendas, desabilitar a oferta. Uma sessão Stripe já aberta pode permanecer pagável até expirar: para interromper também essas sessões, a operação deve localizar ordens pending e expirar cada Session aberta pela API/painel Stripe. Manter webhook e leitura/atendimento enquanto há pagamentos ou direitos vigentes. Reversão da UI pode retirar novas compras, mantendo uma rota para contratos existentes. Migrações são aditivas e devem permanecer; não apagar pedidos, contratos ou eventos para fazer rollback. O novo `processed_at` permite retry do webhook depois de falhas de processamento e deve ser mantido com o código correspondente.

## Correções relacionadas no SaaS

- O retorno público não emite access_token/refresh_token por possuir uma URL Checkout nem autentica pelo email do cartão. Confirmação retorna `requires_login`; nova conta nasce `email_confirm:false`. A recuperação existente envia token exclusivamente à caixa e `/nova-senha` verifica esse token antes de definir senha.
- O Supabase Auth confirma email ainda não confirmado dentro de `recoverVerify`, após validar o token; isto foi conferido na fonte oficial, não exercitado contra o projeto de produção.
- Estado atual de assinatura é consultado na Stripe, e preços de outros produtos não alteram plano SaaS. Falha de fatura precisa corresponder à assinatura SaaS registrada e continuar inadimplente na consulta atual.
- O gate da ferramenta foi acrescentado aos endpoints de gestão de imóvel, iCal, convite/link de diarista, portaria, duplicação e novas ações de credenciais. Triggers SQL impedem writes de owner inativo nas tabelas core (inclusive REST/RPC). Conta, billing, histórico e jurídico não usam esse gate; revogação de credenciais Hermes continua disponível.
- Não foi realizada auditoria total de toda função/integração legada nem bloqueio de todas as leituras históricas. Jobs iCal e atendimento de hóspede já conferiam `subscription_is_active`. A permanência em past_due continua como regra preexistente do SaaS.

## Verificação reproduzível e limites

Na raiz: `npm test -- backend/tests/legal-payments.test.ts backend/tests/software-checkout.test.ts`.

Banco local: `npm ci --prefix backend` e `npm run test:database --prefix backend`.

Os testes de banco executam as migrations/RPCs/RLS em Postgres WASM (PGlite), com fixtures de auth.uid/identidade do Supabase. Testam bloqueio da oferta, permissão service_role, reserva duplicada, pagamento transacional, divergência de sessão, repetição/evento atrasado, isolamento cliente, fila admin, respostas, expiração e independência do SaaS. Não substituem migração completa de todas as versões do banco nem Supabase Auth real.

Os testes TypeScript usam Stripe/Supabase simulados: comprovam validação/reconciliação e ausência de autenticação por checkout. Não comprovam entrega de email, transação Stripe, assinatura HMAC em rede ou jornada de pagamento em ambiente integrado. Nenhum teste usa cartões, SQL de produção ou credenciais reais.

Fontes primárias consultadas: [Stripe fulfillment](https://docs.stripe.com/checkout/fulfillment), [eventos/webhooks](https://docs.stripe.com/webhooks), [Price](https://docs.stripe.com/api/prices/object), [Checkout](https://docs.stripe.com/api/checkout/sessions/create), [Supabase generateLink](https://supabase.com/docs/reference/javascript/auth-admin-generatelink), [Supabase Auth verify.go](https://github.com/supabase/auth/blob/master/internal/api/verify.go).
