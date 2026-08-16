# hermes-agent — alias de `airbnb-agent`

Serve exatamente o mesmo código de `../airbnb-agent/index.ts`. Não edite aqui:
edite lá e faça deploy nos dois slugs.

## Por que existe

O worker no PC do anfitrião já estava apontado para `/hermes-agent`, que servia
a versão ANTIGA do contrato — `credentials` exigia `listing_id` e `log` recusava
`guest_message`/`agent_reply`. Trocar a URL no `.env` de uma máquina que já está
rodando é mais arriscado do que servir o código certo nas duas.

## Quando apagar

Assim que o worker apontar para `/airbnb-agent`. Aí este slug some do Supabase
e este diretório sai do repositório.
