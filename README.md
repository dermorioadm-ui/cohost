# HospedePay — App

Frontend do produto, em `src/`. Consome o backend em `backend/`.

Este repositório tem **um app e um backend, só**. Se você veio do
`page-muse-glow`, esqueça aquela árvore: lá conviviam dois apps e dois projetos
Supabase, e foi isso que fez o deploy servir o build errado. Aqui:

| O quê | Onde | Destino |
|---|---|---|
| App | `src/` | Vercel, projeto `cohost` → `cohost-ten.vercel.app` |
| Backend | `backend/` | Supabase `hukjxwpwnrsepgneopqd` |

Não existe segundo app nem segundo banco. Se aparecer um, é engano.

## Rodar

```bash
npm install
cp .env.example .env    # apontar para o projeto Supabase NOVO
npm run dev
```

## Publicar na Vercel

```bash
vercel --prod
```

`vercel.json` já traz o rewrite de SPA e os headers de segurança. As duas
variáveis do `.env.example` precisam estar configuradas no painel da Vercel.

### Checklist para o hospedepay.org vender de verdade

O código já faz o caminho inteiro, e o mais curto possível: botão do plano
na página → checkout da Stripe (nome, e-mail e telefone pedidos lá) →
conta criada com o pagamento confirmado → senha (opcional) → onboarding.
Nenhuma tela nossa antes do cartão.

Confirmado em produção em 14/09/2026:

- `STRIPE_SECRET_KEY` é a chave live e os seis preços de `plans` existem na
  Stripe (o `billing-checkout-public` devolveu uma sessão `cs_live_`).
- O webhook da Stripe está instalado e validado: endpoint
  `https://hukjxwpwnrsepgneopqd.supabase.co/functions/v1/stripe-webhook`
  com `checkout.session.completed`, `customer.subscription.*`,
  `invoice.paid` e `invoice.payment_failed`, assinatura em
  `STRIPE_WEBHOOK_SECRET`. A sonda da `ops-stripe-webhook` (cria e apaga um
  cliente de teste e espera o evento assinado chegar) passou.
- `hospedepay.org` já aponta para o projeto `cohost` na Vercel; produção é o
  que está na `main`. A base dos links (`APP_BASE_URL`) tem esse domínio
  como padrão.
- O WhatsApp do formulário "me liga" da página vem de
  `app_settings.landing_whatsapp` (lido pela RPC pública `landing_config`);
  `VITE_WHATSAPP` na Vercel, se existir, tem prioridade. Para trocar o
  número: `UPDATE app_settings SET value = '55...' WHERE key = 'landing_whatsapp'`.

Operação do webhook, sem passar pelo dashboard da Stripe nem pelo painel do
Supabase — tudo pelo SQL Editor, com o segredo de cron:

```sql
SELECT private.call_job('ops-stripe-webhook', '{"acao":"inspecionar"}'); -- lista
SELECT private.call_job('ops-stripe-webhook', '{"acao":"testar"}');      -- sonda ao vivo
SELECT private.call_job('ops-stripe-webhook', '{"acao":"instalar"}');    -- cria se faltar
-- {"acao":"instalar","forcar":true} recria o endpoint e guarda a assinatura
-- nova em private.secrets; a stripe-webhook tenta o secret do ambiente e o
-- do banco, então nada precisa ser colado à mão.
SELECT status_code, content FROM net._http_response ORDER BY id DESC LIMIT 1;
```

O que ainda fica fora do repositório:

1. **Teste de ponta a ponta** com um cartão real e reembolso pelo painel da
   Stripe: assinar pela página, cair em `/assinatura` já com a conta criada
   pedindo senha, e ver `profiles.subscription_status = 'active'`.
2. Se mudar de preço, `SELECT private.call_job('billing-sync-plans')`
   recria os preços a partir de `plans` — nunca digite price id à mão.

## Rotas

| Rota | Acesso | Tela |
|---|---|---|
| `/pagina` | público | a página de vendas, mesmo logado (a raiz manda o dono para o painel) |
| `/entrar` | público | login e cadastro |
| `/assinatura` | público/dono | retorno do checkout da página (cria a conta), ou escolha e checkout para quem já tem conta |
| `/comecar` | dono | onboarding guiado em 5 passos |
| `/painel` | dono | saídas do mês, o que está travado, alertas |
| `/agenda` | diarista | limpezas do mês, concluir em um toque |
| `/c/:slug` | público | cadastro do hóspede + assistente 24h |
| `/d/:token` | público | diarista aceitando o convite, sem senha |

## Decisões que valem saber

**A ordem do onboarding não é arbitrária.** O iCal vem antes da diarista e do
"cérebro" da assistente porque é o passo que entrega o *aha* — o cliente cola
o link e lê "achei 7 reservas, próxima saída dia 14". Motivação cai a cada
etapa; a melhor parte dela é gasta vendo as reservas aparecerem.

**O painel abre com problema, não com métrica.** Calendário fora do ar e
onboarding incompleto ficam acima dos números. Um cliente cujo feed quebrou
precisa ver isso antes da diarista reclamar que a agenda está vazia.

**A tela da diarista tem um botão só.** É usada em pé, no corredor do prédio.
Horário grande, "entrada no mesmo dia" em destaque — é o que decide se ela tem
quatro horas ou quarenta minutos.

**O token do hóspede fica no localStorage.** A estadia dura dias; a aba não.

**As credenciais da portaria entram, mas não saem.** A tela do imóvel conecta o
prédio à Kiper e, a partir daí, quem preenche o cadastro em `/c/:slug` já
aparece liberado na portaria — é o passo que o dono fazia à mão, hóspede por
hóspede. O formulário sempre abre vazio: `porter_accounts` não tem policy de
SELECT, nem para o dono, então não existe o que carregar de volta. Trocar uma
credencial é recolar as seis, e isso acontece quando o token do prédio vence —
não toda semana.

## Falta

- Painel admin (o backend já serve os dados em `admin-metrics`)
- Aprovação das taxas de reposição pelo dono
- Financeiro / fechamento do mês
- Upload da foto da limpeza (o bucket e a policy já existem)
- Inglês e espanhol no fluxo do hóspede (o backend já responde nos três)
