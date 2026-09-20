# Revisão visual da página — 20 de setembro de 2026

Paulo pediu fotografias com cantos arredondados e recortes mais modernos, uma página mais enxuta e a recuperação do movimento lateral dos benefícios durante a rolagem. A hero e as quatro cenas já aprovadas deveriam ser preservadas.

## Fonte, princípio e aplicação

| Fonte observada | Princípio | Aplicação |
| --- | --- | --- |
| Captura de Paulo e sequência da página publicada | Dar mais informação em menos rolagem, mantendo leitura confortável | Rotina e tempo livre passam a ocupar uma composição única; a mensagem de tranquilidade vira um bloco compacto |
| Pedido explícito de recortes modernos | Variar as molduras dentro da identidade existente | Fotografias com raios assimétricos, margens permanentes e proporções próprias para cada uso |
| CSS da faixa de benefícios: movimento vertical desativado no celular e altura fixa de 260svh no desktop | Fazer o percurso acompanhar o conteúdo | Movimento lateral calculado pela largura real do trilho, com botões para acessar os quatro recursos |
| Botão de contato fixo e diferentes alturas de tela | Manter texto e navegação visíveis | Reserva de espaço acima do contato; arraste lateral nativo quando o conteúdo não cabe; grade estática com movimento reduzido |
| Pedido de preservar hero e quatro cenas | Manter a narrativa visual aprovada | Conteúdo, imagens, marcação e CSS dedicados à sequência permanecem iguais |

## Composição

- Resultados: proporção 3:2 e indicadores fora da foto mantidos, com novo arredondamento assimétrico.
- Rotina e tempo livre: fotografias em dupla, com alturas deslocadas e textos reunidos.
- Benefícios: fotografias mais horizontais, numeração legível fora dos cantos maiores, navegação numerada e indicação do gesto.
- Tranquilidade: fotografia menor ao lado da mensagem.
- Comparação e garantia: blocos contidos na largura de leitura, sem expansão até as bordas.
- Demonstração, apresentação do anfitrião, FAQ e fechamento: alturas e espaçamentos reduzidos.
- Pequena correção de redação: o calendário fecha datas nos outros canais, sem a contagem equivocada de “outros três”.

Não foram geradas novas fotografias. Os recortes foram feitos na apresentação das imagens existentes. Preços, checkout, disponibilidade jurídica, condições e integrações permanecem como estavam na produção. Esta revisão não publica o backend da PR #45.

## Verificação

Quatro verificações locais passaram: 390 × 844, 1365 × 900, 390 × 620 e preferência por movimento reduzido. Foram conferidos o deslocamento lateral durante a rolagem, a saída da seção fixa, o acesso ao último recurso pelos botões, a adaptação em tela baixa, as imagens carregadas, as molduras e a ausência de transbordamento horizontal e erros de execução. A navegação da faixa fica acima do botão fixo de contato. As capturas foram inspecionadas no celular e no computador.

A comparação do código confirma a preservação da hero e das quatro cenas aprovadas. Não se mediu impacto comercial: melhoria de conversão continua sendo hipótese a avaliar com tráfego real.

**Assinatura:** direção e critérios de Paulo; composição, implementação e revisão executadas por Aline, aplicando diretamente as skills de Gabriel e Sophia. Não houve execução independente desses agentes nesta revisão.
