# Publicação da página aprovada — 20/09/2026

Paulo aprovou a correção visual/copy de `d76d6fb` e autorizou publicar: “Vamos publicar. Dessa vez acertou”.

Esta publicação leva para o site principal a Landing aprovada, a quarta imagem ilustrativa de advogado, o card dentro dos planos, as chamadas com asterisco e os ajustes de leitura/movimento. Mantém a apresentação de contratação jurídica indisponível, como informado antes da aprovação.

A PR 45 também contém alterações de autenticação, retorno de pagamento, migrações e atendimento que precisam ser implantadas juntas e verificadas com Supabase/Stripe. Publicar esse frontend completo sobre o backend atual quebraria a compatibilidade do retorno de checkout. Por isso a entrega pública da página parte da main atual e contém somente os componentes comerciais. O card de apresentação não depende de RPC jurídica nem aponta para uma rota de contratação ainda ausente. O CTA usa o WhatsApp configurado; sem número, abre as condições no próprio card.

O checkout e a aplicação existentes permanecem na versão de produção. A preparação operacional, o upsell e as correções do fluxo de pagamento permanecem na PR 45 para a implantação coordenada descrita no runbook. Nenhuma oferta jurídica, migração, credencial ou cobrança é ativada por esta publicação.

## Assinaturas

| Responsável | Contribuição |
| --- | --- |
| Paulo | Direção comercial, posição, aprovação e autorização de publicação |
| Botini | Copy aprovada |
| Gabriel | Visual e implementação original da Landing/card |
| Aline | Imagem, integração, compatibilidade da publicação, testes e publicação |

## Verificação e reversão

Verificar build, CI, foto e card em desktop/celular, navegação por âncoras, condições, contato e entrada da conta. Não efetuar cobranças para verificar a página.

Aline reproduziu e corrigiu uma falha dos links diretos para seções: a rota carregada sob demanda ainda não tinha o elemento quando o navegador procurava a âncora. A Landing agora posiciona o destino após montar. O teste verifica o caso com movimento normal, sem rolar manualmente para ocultar a falha. Isso não identifica a causa do travamento genérico relatado anteriormente.

Para reverter esta publicação, reverter o commit desta PR na main e aguardar o deploy, ou restaurar a implantação anterior `dpl_9JVC2jinDGgoqerR2TtrTRHjttqP`. Não há dados ou migrações para apagar.
