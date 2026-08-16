# Contrato do agente — HospedePay ↔ worker do Airbnb

Documento de repasse para quem escreve o worker que conversa no chat do Airbnb.
Descreve o que o lado HospedePay oferece, o que o worker precisa fazer, e o que
ainda não existe.

Última atualização: 2026-08-16. **Esta versão substitui a de 2026-08-15**, que
descrevia o endpoint antigo (`hermes-agent`) e um formato de `log` que não é
mais o que está no ar. Se o worker foi escrito contra aquela, veja a seção
"O que mudou" no fim.

---

## 1. O desenho em uma frase

O worker roda **no computador do anfitrião**, faz só conexão de **saída**, e
puxa trabalho de uma fila. A HospedePay nunca abre conexão com a máquina dele.

Isso não é preferência de estilo. A máquina fica atrás do roteador de casa, com
IP dinâmico e provavelmente CGNAT da operadora: não existe endereço para onde
mandar um POST. E ela desliga — à noite, na queda de luz, no reboot da
atualização. Um POST nesses intervalos vira timeout e a mensagem some; na fila,
o job espera e é entregue quando a máquina volta.

Rodar de casa também é **vantagem contra bloqueio**: o login vem do mesmo IP
residencial, na mesma cidade, do mesmo dispositivo que o anfitrião já usa.
Faixas de datacenter (VPS) são o sinal de bot mais barato de detectar — não
coloque proxy no caminho.

```
   Airbnb  ◀──── navegador automatizado ────┐
                                            │
                              ┌─────────────┴──────────────┐
                              │  worker (PC do anfitrião)  │
                              └─────────────┬──────────────┘
                                            │  HTTPS de saída
                                            │  header: x-agent-key
                                            ▼
              POST /functions/v1/airbnb-agent  (Supabase Edge Function)
                                            │
                                            ▼
                    Postgres — funções SECURITY DEFINER,
                    fechadas a anon e authenticated
```

---

## 2. Autenticação

```
POST https://hukjxwpwnrsepgneopqd.supabase.co/functions/v1/airbnb-agent
Content-Type: application/json
x-agent-key: hp_<64 hex>
```

A chave sai **uma única vez**, quando o anfitrião salva a conta no painel
(tela do imóvel → *Atendimento automático 24h*). No banco fica só o hash;
perdeu, gera outra.

**A chave identifica o DONO, não o imóvel.** Uma chave vazada expõe os imóveis
daquele anfitrião e de mais ninguém — por isso ela é por conta e não uma global
do serviço. A revogação pelo painel vale no ato.

Erro de autenticação:

```json
{ "error": { "code": "forbidden", "message": "Chave de agente inválida" } }
```

Todo erro segue esse formato. Teste `error.code`, não a mensagem.

---

## 3. Ações

| Ação | Frequência | Precisa `listing_id` |
|---|---|---|
| `credentials` | 1× por sessão de login | não |
| `challenge` | quando o Airbnb pede código | não |
| `challenge-code` | laço de **3s** enquanto espera | não |
| `session-ok` | ao concluir o login | não |
| `next-jobs` | laço de **30s** | não |
| `finish-job` | após cada job | não |
| `context` | a cada mensagem | **sim** |
| `log` | após cada troca | opcional |
| `failure` | quando o login quebra | não |

### 3.1 `credentials`

```json
{ "action": "credentials" }
```

```json
{ "credentials": {
    "login": "anfitriao@email.com",
    "password": "…",
    "totp_seed": "JBSWY3DPEHPK3PXP",
    "status": "pendente",
    "listings": ["1497251231116164748"] } }
```

A credencial é **da conta**, não do imóvel — uma conta do Airbnb hospeda todos
os anúncios do anfitrião. `listings` traz os anúncios ligados; **ignore
conversas de anúncios fora dessa lista**.

`totp_seed` vem `null` quando não há autenticador por app. Quando vier
preenchido, gere o TOTP padrão (RFC 6238, SHA-1, 6 dígitos, janela de 30s).

`404` quando não há credencial ou quando nenhum imóvel está ligado.

**Regras que o worker precisa respeitar:**

- **Nunca grave a senha em disco.** Busque por esta ação a cada sessão e
  mantenha só em memória.
- **Nunca escreva a senha em log**, nem em log de erro, nem em screenshot.
- Cada chamada é carimbada em `audit_log`. Se a conta for bloqueada um dia,
  essa é a linha do tempo que responde quando o agente entrou. Não chame em
  laço.

### 3.2 Código de verificação — `challenge` → `challenge-code` → `session-ok`

Quando o Airbnb pede confirmação por SMS ou e-mail, quem recebe o código é o
anfitrião. O worker não tem como ler. A saída é o painel: o dono digita, o
worker consome.

```json
{ "action": "challenge",
  "challenge_type": "sms",
  "challenge_hint": "···· 3241",
  "ttl": 600 }
```

`challenge_type`: `sms` | `email` | `app` | `outro`.
`challenge_hint`: o destino **mascarado**, como o Airbnb mostra na tela. Serve
para o dono saber em qual celular procurar — nunca mande o telefone completo.
`ttl`: segundos de validade (padrão 600, teto 900).

Depois, em laço curto:

```json
{ "action": "challenge-code" }
```

```json
{ "estado": "aguardando", "expira_em": 540 }   // ainda não digitou
{ "estado": "ok", "codigo": "123456" }          // consome e apaga
{ "estado": "expirado" }                        // desista
```

E ao entrar:

```json
{ "action": "session-ok" }
```

**Três regras aqui são obrigatórias:**

1. **Mantenha a página do navegador aberta** entre `challenge` e
   `challenge-code`. O código só vale para a sessão que o pediu; reiniciar o
   login invalida tudo e o dono terá digitado um código morto.
2. **Consulte a cada 3–5 segundos**, não a cada 30. O código do Airbnb morre em
   minutos e a sessão fica presa esperando.
3. **`expirado` significa desistir.** Abandone a sessão e comece de novo com um
   `challenge` novo. Insistir em tela de verificação transforma verificação em
   bloqueio de conta.

O código é de **uso único**: a leitura apaga. Se o login falhar depois de
consumir, peça outro `challenge` — o Airbnb invalida o código no primeiro uso
de qualquer forma.

### 3.3 `next-jobs`

```json
{ "action": "next-jobs", "limit": 10 }
```

```json
{ "jobs": [
    { "id": "65e11e44-…",
      "seq": 1,
      "event_type": "reserva_nova",
      "property_id": "1497251231116164748",
      "payload": { "reservation_id": "…", "guest_label": "Maria",
                   "checkin_date": "2026-08-20", "checkout_date": "2026-08-23" },
      "attempts": 1,
      "created_at": "2026-08-16T02:03:39Z" } ] }
```

> `property_id` aqui é o **número do anúncio** (texto), não o uuid do imóvel.

Lista vazia é o caso normal. Os jobs voltam **reservados**: se o worker sumir
sem confirmar, o job volta à fila depois de **10 minutos**. Desligar o
computador no meio de um job é o caso esperado, não a exceção.

`limit` é limitado a 50 pelo servidor. Duas instâncias na mesma conta levam
jobs diferentes (`FOR UPDATE SKIP LOCKED`) — mas **não rode duas**, veja §4.

**Tipos de evento:**

| `event_type` | O que aconteceu | O que se espera |
|---|---|---|
| `reserva_nova` | reserva entrou pelo iCal | mensagem de boas-vindas |
| `limpeza_concluida` | diarista marcou a limpeza como feita | avisar que está pronto |
| `checkout_amanha` | hóspede sai amanhã | lembrete de saída |
| `mensagem_recebida` | reservado para o worker enfileirar para si mesmo | reprocessar resposta que falhou |

### 3.4 `finish-job`

```json
{ "action": "finish-job", "job_id": "65e11e44-…" }
{ "action": "finish-job", "job_id": "65e11e44-…", "status": "falhou", "error": "Airbnb fora do ar" }
```

Falha **devolve o job à fila**, não o mata. Quem desiste é o contador: após
**5 tentativas** o job vira `falhou` e sai do caminho, para um job envenenado
não trancar a fila.

`404` significa job de outro dono ou id inexistente — não reprocesse em laço.

### 3.5 `context`

```json
{ "action": "context", "listing_id": "1497251231116164748" }
```

```json
{ "property": {
    "name": "SOU MAIS ICARAÍ",
    "neighborhood": "Ingá",
    "ai_prompt": "<texto que o anfitrião cadastrou>",
    "ai_config": { "…": "…" },
    "ai_enabled": true,
    "checkin_time": "15:00:00",
    "checkout_time": "11:00:00" },
  "current_reservation": {
    "guest_label": "Maria", "checkin_date": "2026-08-20",
    "checkout_date": "2026-08-23", "status": "confirmed" } }
```

`ai_prompt` é o que deve ir no system prompt do modelo.

> **`ai_prompt` e `ai_config` contêm o código da fechadura e a senha do Wi-Fi.**
> Mesmo cuidado da senha da conta: não grave em disco, não escreva em log. Só
> entregue ao hóspede o que o próprio prompt autorizar.

`404` significa: não é imóvel deste dono, está arquivado, ou o atendimento foi
desligado. As três respostas são iguais de propósito — distinguir seria contar
sobre imóvel alheio.

### 3.6 `log`

```json
{ "action": "log",
  "listing_id": "1497251231116164748",
  "guest_message": "que horas posso entrar?",
  "agent_reply": "A partir das 15h!" }
```

Pelo menos um dos dois é obrigatório. **Uma chamada por troca**, com os dois
campos, é o caminho normal. Se o hóspede mandar três mensagens antes de
qualquer resposta, mande `guest_message` sozinho nas duas primeiras.

O backend **não tem como deduzir** a mensagem do hóspede: ela nasce no Airbnb e
nunca passa por nós. Sem isso o anfitrião entrega a conta e fica cego.

### 3.7 `failure`

```json
{ "action": "failure", "error": "senha rejeitada" }
```

Marca a credencial como `falhou` com o erro visível no painel, e registra em
`audit_log`. Chame quando o login quebrar, não a cada mensagem que der errado.

> **Não sai e-mail hoje.** O provedor de e-mail do sistema nunca foi
> configurado — todas as notificações estão com status `failed`. O sinal de
> falha é o painel do imóvel. Quando o provedor entrar, o e-mail passa a sair
> daqui, sem mudança no worker.

---

## 4. O laço recomendado

```
  ao iniciar:
      credentials
      login no Airbnb
      se pedir código:
          challenge(tipo, dica)
          repetir a cada 3s: challenge-code
              "ok"       -> digita o código, segue
              "expirado" -> abandona a sessão e recomeça
      session-ok

  a cada 30s:
      next-jobs
      para cada job:
          context(listing_id)  -> monta o system prompt
          gera a resposta, envia no chat
          log(guest_message, agent_reply)
          finish-job(ok)   ou   finish-job(status="falhou", error=…)

  a cada 3-5 min (com jitter):
      varre a inbox do Airbnb procurando mensagem nova

  ao detectar sessão caída:
      failure(motivo)  ->  para; tenta credentials de novo mais tarde
```

**Um worker por CONTA, não por imóvel.** Itera `credentials.listings`. Dois
motivos, o segundo é decisivo:

- uma conta = uma sessão de navegador; N workers = N sessões simultâneas na
  mesma conta e do mesmo IP, que é o sinal de bot mais óbvio que existe;
- **`next-jobs` é escopado por DONO, não por anúncio.** Dois workers brigam
  pela mesma fila: o do imóvel A reserva um job do imóvel B e marca como
  processado.

**Ritmo — são dois relógios diferentes:**

| O quê | Intervalo | Por quê |
|---|---|---|
| `next-jobs` | 30s fixo | é a nossa API; risco de detecção zero |
| varredura da inbox | 3–5 min, com jitter | é o Airbnb olhando |
| atraso antes de responder | 40s a 4 min, aleatório | resposta instantânea às 4h é o que denuncia |

Anfitrião nenhum atualiza a caixa de mensagens a cada 30 segundos.

Mensagem de hóspede **não vem pela fila** — nasce no Airbnb e o worker vê
sozinho. A fila carrega só o que nasce do lado da HospedePay.

---

## 5. Antes de o worker achar que quebrou

**A fila só enche para imóveis com atendimento ligado.** Se `next-jobs` devolve
`[]` para sempre, o mais provável é que o anfitrião ainda não ativou o imóvel no
painel — não que o endpoint esteja errado. Confirme com `credentials`: se
`listings` vier vazio, não há imóvel ligado.

Isso é de propósito: fila que enche sem consumidor acumularia meses de trabalho
e, na primeira conexão, dispararia "bem-vindo" para hóspede que já foi embora.

---

## 6. O que existe e o que não existe

**No ar:**

- endpoint `airbnb-agent` com as nove ações acima
- credencial cifrada com pgcrypto, chave no Vault do Supabase (fora das
  tabelas), ilegível para qualquer papel que não seja `service_role`
- chave de máquina com hash, revogável, auditoria de toda leitura de senha
- fila com reserva de job, devolução do que travou e desistência após 5 falhas
- relé do código de verificação pelo painel
- `listing_id` extraído automaticamente do link iCal do Airbnb
- termo de responsabilidade aceito no ato da entrega da senha, com IP e
  user agent

**Não existe e é o trabalho do worker:**

- o login no Airbnb por automação de navegador
- a leitura das conversas e o envio das respostas
- o cálculo do TOTP quando houver semente

**Não tem solução:** 2FA por SMS **sem** o dono por perto. O relé do §3.2 cobre
o caso em que ele está no painel; se ninguém digitar dentro do prazo, o login
falha e pronto.

---

## 7. Riscos que o worker precisa levar em conta

O Airbnb não oferece acesso automatizado público às mensagens. O atendimento é
feito **acessando a conta como se fosse o anfitrião**, o que pode contrariar os
Termos de Serviço. O anfitrião aceitou um termo assumindo esse risco; o worker
deve reduzi-lo onde puder:

- ritmo humano (tabela do §4), nunca rajada;
- uma sessão por conta, reaproveitada — não faça login a cada job;
- uma conversa por vez, sem paralelismo;
- IP residencial do próprio anfitrião, sem proxy.

Se cair em verificação de identidade que o relé não resolve, chame `failure` e
**pare**. Insistir vira bloqueio.

---

## 8. O que mudou desde 2026-08-15

Quem escreveu worker contra a versão anterior precisa ajustar:

| Antes | Agora |
|---|---|
| endpoint `hermes-agent` | **`airbnb-agent`** (o antigo foi aposentado) |
| `credentials` exigia `listing_id` | não exige, e devolve `listings` |
| `log` com `thread_ref` + `direction` + `content` | **`guest_message` + `agent_reply`** |
| `finish-job` com `{job_id, ok: bool}` | **`{job_id, status: "falhou"}`** para falha; sucesso é omitir |
| `next-jobs` com `{ok, jobs}` | `{jobs}` |
| `context` devolvia `{ok, context:{…}}` | **`{property, current_reservation}`** |
| 30s para tudo | 30s só para a fila; inbox 3–5 min |
| `failure` mandava e-mail | não manda: provedor não configurado |
| — | **novas:** `challenge`, `challenge-code`, `session-ok` |
