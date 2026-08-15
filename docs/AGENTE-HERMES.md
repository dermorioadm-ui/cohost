# Contrato do agente — HospedePay ↔ Hermes

Documento de repasse para quem vai escrever o worker que conversa no chat do
Airbnb. Descreve o que o lado HospedePay já oferece, o que o worker precisa
fazer, e o que ainda não existe.

Última atualização: 2026-08-15.

---

## 1. O desenho em uma frase

O worker roda **no computador do anfitrião**, faz só conexão de **saída**, e
puxa trabalho de uma fila. A HospedePay nunca abre conexão com a máquina dele.

Isso não é preferência de estilo. A máquina fica atrás do roteador de casa, com
IP dinâmico e provavelmente CGNAT da operadora: não existe endereço para onde
mandar um POST. E ela desliga — à noite, na queda de luz, no reboot da
atualização. Um POST nesses intervalos vira timeout e a mensagem some; na fila,
o job espera e é entregue quando a máquina volta.

```
   Airbnb  ◀──── navegador automatizado ────┐
                                            │
                              ┌─────────────┴──────────────┐
                              │  worker (PC do anfitrião)  │
                              └─────────────┬──────────────┘
                                            │  HTTPS de saída
                                            │  header: x-agent-key
                                            ▼
              POST /functions/v1/hermes-agent  (Supabase Edge Function)
                                            │
                                            ▼
                    Postgres — funções SECURITY DEFINER,
                    fechadas a anon e authenticated
```

---

## 2. Autenticação

Endpoint único:

```
POST https://hukjxwpwnrsepgneopqd.supabase.co/functions/v1/hermes-agent
Content-Type: application/json
x-agent-key: hp_<64 hex>
```

A chave é gerada pelo anfitrião no painel (tela do imóvel → *Atendimento
automático 24h* → **Gerar chave nova**) e mostrada **uma única vez**. No banco
fica só o hash; perdeu, gera outra.

**A chave identifica o DONO, não o imóvel.** Uma chave vazada expõe os imóveis
daquele anfitrião e de mais ninguém — é por isso que ela é por conta e não uma
global do serviço. O anfitrião revoga a qualquer momento pelo painel, e a
revogação vale no ato.

Erro de autenticação:

```json
{ "error": { "code": "unauthorized", "message": "Chave de agente inválida ou revogada" } }
```

Todo erro segue esse formato. Teste `error.code`, não a mensagem — a mensagem
pode mudar, o código não.

---

## 3. Ações

| Ação | Frequência | Precisa `listing_id` |
|---|---|---|
| `credentials` | 1× por sessão de login | não |
| `next-jobs` | laço, ~30s | não |
| `finish-job` | após cada job | não |
| `context` | a cada mensagem | **sim** |
| `log` | após cada resposta | **sim** |
| `failure` | quando o login quebra | **sim** |

### 3.1 `credentials` — pegar o login

```json
{ "action": "credentials", "platform": "airbnb" }
```

```json
{ "ok": true,
  "credentials": {
    "login": "anfitriao@email.com",
    "password": "…",
    "totp_secret": "JBSWY3DPEHPK3PXP",
    "listings": ["1497251231116164748"]
  } }
```

A credencial é **da conta**, não do imóvel — uma conta do Airbnb hospeda todos
os anúncios do anfitrião. `listings` traz os anúncios que ele ligou; ignore
conversas de anúncios fora dessa lista.

`totp_secret` vem `null` quando a conta não tem verificação em duas etapas.
Quando vier preenchido, gere o código TOTP padrão (RFC 6238, SHA-1, 6 dígitos,
janela de 30s).

Responde `404 not_found` quando não há credencial ou quando nenhum imóvel está
ligado.

**Regras que o worker precisa respeitar:**

- **Nunca grave a senha em disco.** Busque por esta ação a cada sessão de login
  e mantenha só em memória. É para isso que a ação existe.
- **Nunca escreva a senha em log**, nem em log de erro, nem em screenshot de
  depuração.
- Cada chamada desta ação é carimbada em `audit_log`. Se a conta do anfitrião
  for bloqueada um dia, essa é a linha do tempo que responde quando o agente
  entrou. Não chame em laço.

### 3.2 `next-jobs` — puxar trabalho

```json
{ "action": "next-jobs", "limit": 10 }
```

```json
{ "ok": true,
  "jobs": [
    { "id": 42,
      "event_type": "reserva_nova",
      "listing_id": "1497251231116164748",
      "property_id": "2b831abd-…",
      "payload": { "reservation_id": "…", "guest_label": "Maria",
                   "checkin_date": "2026-08-20", "checkout_date": "2026-08-23",
                   "provider": "airbnb" },
      "attempts": 1,
      "created_at": "2026-08-15T18:40:00Z" } ] }
```

Lista vazia (`[]`) é o caso normal. Chame a cada ~30 segundos.

Os jobs voltam **reservados** (`processando`). Reservado não é feito: se o
worker sumir sem confirmar, o job volta para a fila depois de **10 minutos** e
é servido de novo. Desligar o computador no meio de um job é o caso esperado
aqui, não a exceção.

`limit` é limitado a 50 pelo servidor.

Se o anfitrião abrir o worker em duas máquinas, cada uma leva jobs diferentes
(`FOR UPDATE SKIP LOCKED`) — não haverá duas respostas para o mesmo hóspede.

**Tipos de evento:**

| `event_type` | O que aconteceu | O que se espera do agente |
|---|---|---|
| `reserva_nova` | reserva entrou pelo iCal | mensagem de boas-vindas |
| `limpeza_concluida` | diarista marcou a limpeza como feita | avisar que o apartamento está pronto |
| `checkout_amanha` | hóspede sai amanhã | lembrete de horário e procedimento de saída |
| `mensagem_recebida` | reservado para o worker enfileirar para si mesmo | reprocessar resposta que falhou |

### 3.3 `finish-job` — confirmar

```json
{ "action": "finish-job", "job_id": 42, "ok": true }
```

Em falha:

```json
{ "action": "finish-job", "job_id": 42, "ok": false, "error": "Airbnb fora do ar" }
```

Falha **devolve o job à fila**, não o mata. Quem desiste é o contador: após
**5 tentativas** o job vira `falhou` e sai do caminho, para um job envenenado
não trancar a fila atrás dele.

Responde `404 not_found` se o job não for do dono daquela chave — é o sinal de
que o worker não deve reprocessar em laço.

### 3.4 `context` — o que dizer

```json
{ "action": "context", "listing_id": "1497251231116164748" }
```

```json
{ "ok": true,
  "context": {
    "property_id": "2b831abd-…",
    "name": "SOU MAIS ICARAÍ",
    "neighborhood": "Ingá",
    "checkin_time": "15:00:00",
    "checkout_time": "11:00:00",
    "prompt": "<texto que o anfitrião cadastrou>",
    "ai_config": { "…": "…" },
    "reserva_atual": { "guest_label": "Maria", "checkin_date": "2026-08-20",
                       "checkout_date": "2026-08-23", "provider": "airbnb",
                       "status": "confirmed" } } }
```

`prompt` é o texto que o anfitrião escreveu sobre o apartamento — é o que deve
ir no system prompt do modelo.

> **`prompt` e `ai_config` contêm o código da fechadura e a senha do Wi-Fi.**
> Trate com o mesmo cuidado da senha da conta: não grave em disco, não escreva
> em log. Só entregue ao hóspede o que o próprio prompt autorizar entregar.

`404 not_found` significa: não é imóvel deste dono, está arquivado, ou o
atendimento foi desligado. As três respostas são iguais de propósito —
distinguir seria contar sobre imóvel alheio.

### 3.5 `log` — registrar o que foi dito

```json
{ "action": "log",
  "listing_id": "1497251231116164748",
  "thread_ref": "<id da conversa no Airbnb>",
  "direction": "agente",
  "guest_name": "Maria",
  "content": "Oi Maria! O check-in é a partir das 15h…" }
```

`direction` é `"hospede"` ou `"agente"` — **uma linha por mensagem**. Registre
as duas pontas: a mensagem do hóspede quando ela chega, e a resposta quando ela
sai. Não junte pergunta e resposta numa chamada só; o hóspede manda três
mensagens seguidas antes de qualquer resposta, e o agente às vezes fala
primeiro.

Sem isso o anfitrião entrega a conta e fica cego — o atendimento acontece no
Airbnb, fora do app. Estas linhas são o que a tela Conversas mostra.

A primeira chamada bem-sucedida marca a credencial como `ativo`. É melhor sinal
que um "testar conexão", que só diz que funcionava naquele segundo.

### 3.6 `failure` — avisar que o login quebrou

```json
{ "action": "failure",
  "listing_id": "1497251231116164748",
  "error": "senha rejeitada" }
```

Marca a credencial como `falhou`, mostra o erro no painel e manda e-mail ao
anfitrião (no máximo um por dia por imóvel). Chame quando o login falhar, não a
cada mensagem que der errado.

---

## 4. O laço recomendado

```
  ao iniciar:
      credentials  ──▶ login no Airbnb (com TOTP se houver)

  a cada 30s:
      next-jobs
      para cada job:
          context(listing_id)      ──▶ monta o system prompt
          gera a resposta
          envia no chat do Airbnb
          log(direction="agente")
          finish-job(ok=true)      ──▶ ou ok=false com o erro

  ao detectar sessão caída:
      failure  ──▶ tenta credentials de novo (senha pode ter sido atualizada)
```

Mensagem de hóspede **não vem pela fila** — ela nasce no Airbnb e o worker vê
sozinho pelo navegador. A fila carrega só o que nasce do lado da HospedePay
(reserva nova, limpeza concluída, check-out amanhã).

---

## 5. O que já está no ar e o que não está

**Funcionando em produção agora:**

- endpoint `hermes-agent` com `context`, `credentials`, `log`, `failure`
- credencial guardada no Vault do Supabase, ilegível para qualquer papel que
  não seja `service_role` — inclusive para o navegador do próprio anfitrião
- chave de máquina com hash, revogável, e auditoria de toda leitura de senha
- `listing_id` extraído automaticamente do link iCal do Airbnb
- termo de responsabilidade aceito no ato da entrega da senha, com IP e
  user agent

**Escrito, aguardando aprovação do anfitrião (migrations `0028` e `0029`):**

- `next-jobs` e `finish-job` — **a fila ainda não existe no banco**
- `credentials` sem `listing_id` e devolvendo `listings`
- credencial por conta em vez de por imóvel

Enquanto `0028`/`0029` não forem aplicadas, o endpoint no ar ainda exige
`listing_id` no `credentials` e não conhece as ações de fila. **Escreva o worker
contra o contrato deste documento**, que é o alvo, e combine a data de virada.

**Não existe e é o trabalho principal do worker:**

- o login no Airbnb em si, por automação de navegador
- a leitura das conversas e o envio das respostas
- 2FA por SMS: o campo TOTP cobre aplicativo autenticador; SMS não tem solução
  automática

---

## 6. Riscos que o worker precisa levar em conta

O Airbnb não oferece acesso automatizado público às mensagens. O atendimento é
feito **acessando a conta como se fosse o anfitrião**, o que pode contrariar os
Termos de Serviço da plataforma. O anfitrião aceitou um termo assumindo esse
risco, mas o worker deve reduzi-lo onde puder:

- **Ritmo humano.** Não responda em 200ms nem envie rajadas. Atraso variável de
  alguns segundos a alguns minutos.
- **Uma sessão por conta.** Reaproveite a sessão logada; não faça login a cada
  job.
- **Sem paralelismo agressivo.** Uma conversa por vez.
- **Rodar da casa do anfitrião é vantagem** — mesmo IP residencial, mesma
  cidade, mesmo dispositivo de sempre. Não faça proxy para datacenter: faixas
  de VPS são o sinal mais barato de detectar.

Se a conta cair em verificação de identidade, chame `failure` com o motivo e
**pare** — insistir transforma verificação em bloqueio.
