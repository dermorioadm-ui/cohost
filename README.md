# HospedePay — App

Frontend do app novo. Independente do `src/` na raiz (que é o app atual) e
consome o backend em `../backend`.

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

## Falta

- Painel admin (o backend já serve os dados em `admin-metrics`)
- Aprovação das taxas de reposição pelo dono
- Financeiro / fechamento do mês
- Upload da foto da limpeza (o bucket e a policy já existem)
- Inglês e espanhol no fluxo do hóspede (o backend já responde nos três)
