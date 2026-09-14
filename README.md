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

Confirmado em produção em 14/09/2026: `STRIPE_SECRET_KEY` é a chave live e
os seis preços de `plans` existem na Stripe (o `billing-checkout-public`
devolveu uma sessão `cs_live_`). O que ainda fica fora do repositório:

1. **Domínio.** Na Vercel, projeto `cohost` → Settings → Domains → adicionar
   `hospedepay.org` e `www.hospedepay.org`; no registrador, o A/CNAME que a
   Vercel mostrar. O certificado sai sozinho.
2. **Base dos links.** Secret `APP_BASE_URL=https://hospedepay.org` nas Edge
   Functions do Supabase. É ele que monta o retorno do checkout, o link do
   e-mail e o link do chat do hóspede. Sem ele o padrão já é hospedepay.org.
3. **Webhook da Stripe.** Endpoint
   `https://hukjxwpwnrsepgneopqd.supabase.co/functions/v1/stripe-webhook`
   com os eventos `checkout.session.completed`, `customer.subscription.*`,
   `invoice.paid`, `invoice.payment_failed`; o `whsec_...` vai no secret
   `STRIPE_WEBHOOK_SECRET`. A volta do checkout já cria a conta sem ele, mas
   é o webhook que acompanha renovação, cancelamento e cartão recusado.
4. **Formulário "me liga" da página.** `VITE_WHATSAPP` (ou
   `VITE_LEAD_ENDPOINT`) na Vercel. Sem nenhum dos dois, o botão manda criar
   a conta.
5. **Teste de ponta a ponta** com um cartão real e reembolso pelo painel da
   Stripe. Se mudar de preço, `SELECT private.call_job('billing-sync-plans')`
   recria os preços a partir de `plans` — nunca digite price id à mão.

## Rotas

| Rota | Acesso | Tela |
|---|---|---|
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
