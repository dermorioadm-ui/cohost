# HospedePay — Backend

Backend do produto, servindo o app em `src/`. Projeto Supabase
`hukjxwpwnrsepgneopqd` — o único deste repositório.

Mesma lógica de negócio do produto antigo (`page-muse-glow`), reescrita com as falhas corrigidas e
com as três peças que faltavam para o pitch ser verdadeiro: sincronização
automática, aviso à portaria por reserva, e relatório mensal.

---

## Stack

Supabase (Postgres 15 + RLS + Edge Functions em Deno) · Stripe · Anthropic
(`claude-opus-5`) ou Google Gemini · Resend/SendGrid · Meta Cloud API.

Sem framework novo. Quem conhece o backend atual reconhece este.

---

## Estrutura

```
backend/
├── .env.example                 todas as chaves, comentadas
└── supabase/
    ├── config.toml              quais functions exigem JWT
    ├── migrations/              0001 → 0016, na ordem
    └── functions/
        ├── _shared/lib/         env, http, db, ical, ai
        ├── _shared/email-templates/
        └── <uma pasta por endpoint>
```

---

## Subir do zero

```bash
# 1. Criar o projeto Supabase (novo, separado do atual)
supabase projects create hospedepay-v2

# 2. Preencher o .env
cp backend/.env.example backend/.env   # e editar

# 3. Aplicar as migrations, em ordem
supabase db push --db-url "$SUPABASE_DB_URL"

# 4. Publicar as functions
supabase functions deploy --project-ref "$SUPABASE_PROJECT_ID"

# 5. Ligar os jobs (passo manual, uma vez)
psql "$SUPABASE_DB_URL" -c "
  INSERT INTO private.job_config (id, functions_url, cron_secret)
  VALUES (1, 'https://$SUPABASE_PROJECT_ID.supabase.co/functions/v1', '$CRON_SECRET')
  ON CONFLICT (id) DO UPDATE
    SET functions_url = EXCLUDED.functions_url,
        cron_secret   = EXCLUDED.cron_secret;"

# 6. Conferir
psql "$SUPABASE_DB_URL" -c "SELECT jobname, schedule FROM cron.job;"
```

O passo 5 é o único manual — o `pg_cron` precisa saber a URL do projeto e o
segredo, e nenhum dos dois pode ficar no código.

---

## Endpoints

### Autenticados (JWT do Supabase)

| Rota | Papel | O que faz |
|---|---|---|
| `property-upsert` | owner | Cria/atualiza imóvel. Aceita preenchimento parcial — é a entrada do funil conversacional. Devolve o que ainda falta. |
| `ical-validate` | owner | Valida o link do calendário e devolve *"achei 7 reservas, próxima saída dia 14"*. Salva se `save: true`. |
| `cleaner-invite` | owner | Gera o convite da diarista e devolve um link `wa.me` com a mensagem pronta. |
| `admin-metrics` | admin | Painel: KPIs, assinantes, funil de ativação, saúde do sistema. |

### Públicos (autorização própria)

| Rota | Como autoriza |
|---|---|
| `guest-register` | Slug público do imóvel + limite por IP. Devolve token de sessão. |
| `guest-chat` | Header `x-guest-token`. Streaming SSE. |
| `cleaner-accept` | Token do convite. Devolve sessão pronta, sem senha. |
| `stripe-webhook` | Assinatura HMAC do Stripe. |

### Jobs (header `x-cron-secret`)

| Rota | Cadência | Papel |
|---|---|---|
| `job-sync-ical` | 15 min | **Sincroniza os calendários.** É isto que torna "automático" verdadeiro. |
| `job-process-outbox` | 1 min | Envia a fila de e-mail/WhatsApp com retry e backoff. |
| `job-notify-condo` | 10 min | Rede de segurança do aviso à portaria. |
| `job-subscription-sweep` | diário | Expira trial, avisa quem está acabando, alerta calendário quebrado. |
| `job-monthly-report` | dia 1 | Resumo do mês para o dono. |

---

## O que mudou em relação ao backend atual

### Falhas de segurança corrigidas

| Antes | Agora |
|---|---|
| `guest_chat_sessions` e `guest_chat_messages` com `USING (true)` para `anon` — qualquer um com a chave pública lia nome e WhatsApp de todos os hóspedes e todas as conversas (que contêm senha de fechadura e Wi-Fi) | Nenhuma policy para `anon`. O hóspede fala com uma edge function que valida um token opaco. |
| `"Anon can lookup referral codes"` em `profiles` — RLS é por linha, então entregava e-mail, WhatsApp, **chave PIX** e IDs do Stripe de todo afiliado | `profiles` fechada. A consulta de indicação virou `lookup_referral()`, que devolve só id e primeiro nome. |
| `register-porter-guest` público, aceitando `propertyId` avulso — qualquer um cadastrava morador na portaria digital, com permissão de abrir porta | O cadastro na portaria só nasce de um `guest_registration` criado com sessão válida. |
| Preço do checkout vindo do cliente | Preço sempre do banco (tabela `plans`). |
| Credenciais da portaria legíveis pelo dono | `porter_accounts` sem policy de SELECT — só `service_role` lê, na hora de chamar a API. |
| `EXECUTE` de funções `SECURITY DEFINER` herdado de `PUBLIC` | `0016` revoga de `PUBLIC` e concede explicitamente. |

### Falhas funcionais corrigidas

- **Sincronização só rodava quando alguém abria o app.** Agora é `pg_cron` a cada 15 minutos.
- **Aviso à portaria só saía se o hóspede preenchesse o formulário.** Agora nasce da reserva.
- **Deduplicação por data de saída.** Agora pela `UID` do evento iCal, que é estável quando a data muda.
- **Reserva não existia como entidade.** Agora existe — é o que permite avisar a portaria, detectar cancelamento e ligar hóspede à estadia.
- **Taxas de reposição sem competência.** O fechamento somava taxas de todos os meses dentro do mês exibido. Agora têm `reference_month`.
- **Datas em UTC.** Depois das 21h no Brasil o app virava o dia e o botão "concluir limpeza" sumia. Tudo passa por `app_today()`.
- **Nenhum webhook do Stripe.** Nenhum pagamento era conciliado. Agora o Stripe empurra o estado.
- **Falha de calendário invisível.** Agora cada fonte guarda erro e contador, e o dono é avisado.

### Peças novas

- **Ativação rastreada** (`0012`): a view `owner_activation` diz em qual passo cada cliente parou. É a lista que a operação usa para destravar fila em vez de fazer setup um a um.
- **Outbox único** (`0010`): e-mail e WhatsApp na mesma fila, com idempotência e backoff.
- **Convite da diarista por link** (`0003`): sem e-mail, sem senha.
- **Termo versionado** (`0008`): guarda qual texto o hóspede aceitou, com data, hora e IP.
- **E-mail para o hóspede**: instruções de acesso + cópia do termo. Quem fechava a aba perdia tudo e ligava para o dono.
- **Relatório mensal**: torna visível um produto que, funcionando, é invisível.

---

## Onde ficam as chaves

Tudo em `.env.example`, comentado. Os grupos:

| Grupo | Quando é obrigatório |
|---|---|
| `SUPABASE_*` | sempre |
| `CRON_SECRET` | sempre (jobs) |
| `STRIPE_*` | para cobrar |
| `ANTHROPIC_API_KEY` ou `GOOGLE_AI_API_KEY` | para o chat do hóspede |
| `RESEND_API_KEY` / `SENDGRID_API_KEY` | para portaria e relatórios |
| `WHATSAPP_*` | opcional — com `WHATSAPP_ENABLED=false` o sistema gera links `wa.me` e nada quebra |
| Portaria (Kiper) | por imóvel, na tabela `porter_accounts` |

O provedor de IA é escolhido em `AI_PROVIDER` (`anthropic` ou `google`).
No modo Anthropic o modelo é `claude-opus-5`, com `effort: low` (chat de FAQ
prioriza latência), prompt do imóvel em cache e fallback server-side ligado.

---

## Estado atual

**Escrito:** 20 migrations, a biblioteca compartilhada e **19 edge functions**.

| Grupo | Funções |
|---|---|
| Jobs | `job-sync-ical`, `job-process-outbox`, `job-notify-condo`, `job-subscription-sweep`, `job-monthly-report`, `job-porter-sync` |
| Hóspede | `guest-register`, `guest-chat` |
| Diarista | `cleaner-invite`, `cleaner-accept` |
| Dono | `property-upsert`, `ical-validate`, `billing-checkout`, `billing-portal` |
| Admin | `admin-metrics`, `admin-users` |
| Webhooks | `stripe-webhook`, `email-webhook`, `whatsapp-webhook` |

**Fora do escopo por decisão:** `admin-impersonate`. O backend antigo tinha —
gerava um magic link para entrar como o cliente. É acesso total e permanente à
conta de um terceiro, com pouco ganho sobre o que `admin-metrics ?view=subscriber`
já mostra. Se você quiser mesmo, dá para fazer com sessão curta e auditada, mas
preferi não incluir sem você decidir.

> ### Estado em produção
>
> As migrations `0001` → `0020` **estão aplicadas** em `hukjxwpwnrsepgneopqd`,
> com dados de cliente real. Os 7 jobs do `pg_cron` estão ativos.
>
> Nem todas as edge functions estão publicadas. Confira antes de assumir que
> um endpoint existe — um job agendado chamando uma function ausente devolve
> 404 silenciosamente, e o cron continua marcando "succeeded":
>
> ```sql
> -- o que está no ar
> select slug, version from edge_functions;   -- ou: supabase functions list
>
> -- o que os jobs receberam de resposta de verdade
> select status_code, count(*)
>   from net._http_response
>  where created > now() - interval '3 hours'
>  group by status_code;
> ```

---

## Migrar os dados do sistema atual

Os nomes de tabela e coluna foram mantidos onde fazia sentido justamente para
isso. O caminho:

1. `profiles`, `user_roles` — cópia quase direta (o enum de status mudou de
   texto livre para `subscription_status`).
2. `properties` — os três campos `*_ical_url` viram linhas em
   `property_ical_sources`; o texto de `ai_prompt` vira o JSONB `ai_config`.
3. `connections` — cópia direta.
4. `cleaning_tasks` — copiar, deixando `reservation_id` nulo; a primeira
   sincronização religa as tarefas futuras às reservas.
5. `cleaner_monthly_fees` → `cleaner_fees`, preenchendo `reference_month` a
   partir de `created_at`.

Histórico de chat de hóspede eu não migraria — é justamente o dado que estava
exposto.
