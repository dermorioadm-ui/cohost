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

## Rotas

| Rota | Acesso | Tela |
|---|---|---|
| `/entrar` | público | login e cadastro |
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
