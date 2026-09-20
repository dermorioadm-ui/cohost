# Rolagem lateral dos benefícios — 20 de setembro de 2026

Paulo pediu a recuperação do comportamento da seção “Você entra pelo check-in. Fica pelo resto.”: a rolagem deve percorrer os quatro cards lateralmente antes de permitir que a seção saia da tela.

## Causa e responsabilidade

A adaptação introduzida por Aline na PR #50 comparava a altura do conteúdo com a área útil da tela. Quando não cabia, marcava `data-drift-livre`, removia o posicionamento sticky e convertia a faixa em um carrossel de arraste manual. O problema foi reproduzido em 390 × 654: a seção tinha 583 px e o contêiner estava `position: static`. Essa alternativa não corresponde à sequência solicitada por Paulo.

## Correção

- A faixa permanece fixa durante todo o percurso horizontal. A altura da seção resulta da altura real do bloco somada à distância de rolagem necessária para revelar o último card.
- As fotos se ajustam ao espaço disponível depois de reservar título, legendas, navegação e botão de contato. O título e os intervalos da seção foram compactados no celular; o tamanho dos textos dos cards foi mantido.
- Quando o conteúdo ampliado excede a altura da tela, a fixação considera a base do bloco. A leitura pode entrar antes do percurso, e o quarto card continua sendo alcançado antes da saída.
- O deslocamento horizontal acompanha diretamente o progresso da rolagem, eliminando o atraso de interpolação na saída. Os botões numerados usam a mesma geometria.
- A preferência por movimento reduzido continua apresentando todos os recursos em grade estática.

Fontes: relato e captura de Paulo, reprodução no navegador e inspeção do código. Princípio: a duração da cena fixa deve corresponder ao percurso do conteúdo, e a adaptação à tela deve preservar essa sequência. Não houve pesquisa externa nem mudança de copy ou oferta.

## Verificação

Foram exercitados 390 × 654, 390 × 620, 390 × 844 e 1365 × 900. Em cada tamanho foram conferidos início, 25%, 50%, 75% e fim: o bloco permaneceu fixo, o trilho se moveu e a seção seguinte só alcançou a tela após a conclusão. O último card ficou inteiro, e uma nova rolagem liberou a descida da página.

Também foram verificados os botões, a redução da janela de 844 para 620 px, a preferência por movimento reduzido e textos dos cards ampliados para 150%. Não ocorreram erros de execução nem transbordamento horizontal da página. Capturas do início e do fim foram inspecionadas no celular e no computador. A reprodução usa Chromium com dimensões móveis; não equivale a um teste em aparelho físico com Safari.

A comparação do código confirmou a preservação da hero e das quatro cenas aprovadas. Preços, contratação, condições jurídicas, imagens e a composição de tempo livre permanecem como na produção anterior.

**Assinatura:** direção e correção de Paulo; implementação e revisão executadas por Aline, aplicando diretamente as skills de Sophia e Gabriel. Não houve execução independente de subagentes nesta alteração.
