import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

/**
 * Página de vendas.
 *
 * O produto que está sendo vendido não é software — é a ausência de trabalho.
 * Por isso a página não se parece com um SaaS: nada de gradiente roxo, cartão
 * flutuante e captura de tela do painel. Ela se parece com uma revista de
 * arquitetura, porque é assim que se vende sossego: mostrando o apartamento
 * impecável e vazio, e deixando o silêncio fazer o argumento.
 *
 * Três decisões que sustentam isso:
 *
 *   1. O TOM É CLARO E QUENTE, e o app é escuro. Não é inconsistência: a
 *      página vende manhã de domingo, o app é ferramenta de trabalho. Forçar
 *      o mesmo tema faria a venda parecer um painel a mais.
 *   2. O PREÇO É O TÍTULO. "R$ 97" aparece em corpo 120 no primeiro terço da
 *      tela, porque a objeção real não é "isso funciona?", é "quanto custa?" —
 *      e esconder o preço atrás de "fale com vendas" mata a conversão de um
 *      ticket deste tamanho.
 *   3. NENHUMA PESSOA NAS FOTOS. Cômodo vazio e arrumado é a promessa; gente
 *      sorrindo em foto de banco de imagem é o que todo concorrente faz.
 *
 * A cor de cada canal (Airbnb, Booking) aparece só onde significa canal —
 * mesma regra do app. Ela é dado, não decoração.
 */

/**
 * Ilustrações geradas para esta página.
 *
 * Ficam no CDN de origem por enquanto. Antes de anunciar de verdade, baixe os
 * quatro arquivos para `public/lp/` e troque as constantes: publicidade paga
 * apontando para o CDN de terceiro é uma dependência que ninguém monitora.
 */
const CDN = "https://d8j0ntlcm91z4.cloudfront.net/user_3EpjN02z3eVBpoIq5qJQUygboJL";
const IMG = {
  sala: `${CDN}/hf_20260817_034518_0936a524-bb47-4729-8ef1-9ff2a0479784.png`,
  quarto: `${CDN}/hf_20260817_034518_2a64baec-31a7-460a-a1ac-6fa0a16f9559.png`,
  insumos: `${CDN}/hf_20260817_034518_825a329b-6662-4415-83cf-f7b6d65fe53d.png`,
  cafe: `${CDN}/hf_20260817_034518_d496a9fa-8cb8-48f5-b0c1-744c8901f988.png`,
};

/** Espelha public.plans. Preço em reais inteiros porque não há centavos. */
const PLANOS = [
  {
    tier: "essencial",
    nome: "Essencial",
    imoveis: "1 imóvel",
    mensal: 97,
    anual: 970,
    linha: "Para quem tem um apartamento e quer ele rodando sozinho.",
    itens: [
      "Calendário do Airbnb e do Booking sincronizados",
      "Checkout vira limpeza na agenda da diarista",
      "Cadastro do hóspede com termo de responsabilidade",
      "Assistente responde o hóspede 24h",
      "Portaria avisada a cada reserva",
    ],
    destaque: false,
  },
  {
    tier: "pro",
    nome: "Profissional",
    imoveis: "até 3 imóveis",
    mensal: 197,
    anual: 1970,
    linha: "Quando deixa de ser um extra e vira operação.",
    itens: [
      "Tudo do Essencial, nos três imóveis",
      "Reposição de insumos por taxa fixa mensal",
      "Painel da diarista com ganhos e aprovações",
      "Cadastro direto no sistema da portaria",
      "Fechamento financeiro do mês por imóvel",
    ],
    destaque: true,
  },
  {
    tier: "ilimitado",
    nome: "Portfólio",
    imoveis: "até 5 imóveis",
    mensal: 297,
    anual: 2970,
    linha: "Para quem administra os imóveis dos outros também.",
    itens: [
      "Tudo do Profissional, nos cinco imóveis",
      "Uma diarista atendendo vários apartamentos",
      "Relatório mensal consolidado",
      "Histórico completo de hóspedes e acessos",
      "Suporte prioritário",
    ],
    destaque: false,
  },
];

const PILARES = [
  {
    num: "01",
    titulo: "Checkout sem preocupação",
    texto:
      "A reserva entra pelo calendário e vira limpeza sozinha. Sua diarista vê a saída no celular, com o horário e o aviso de quando tem entrada no mesmo dia. Você não avisa ninguém. Nunca mais.",
  },
  {
    num: "02",
    titulo: "Insumos por taxa fixa",
    texto:
      "Papel, café, sabão, pilha, detergente. Você combina um valor fechado por mês com a diarista e ela repõe tudo. Sem lista de compras, sem reembolso item a item, sem a mensagem de domingo à noite dizendo que acabou o papel.",
  },
  {
    num: "03",
    titulo: "Hóspede e portaria resolvidos",
    texto:
      "O hóspede se cadastra sozinho pelo link, aceita o termo de responsabilidade e já entra no sistema da portaria. Chega, entra, e você fica sabendo por e-mail — não por telefone às onze da noite.",
  },
];

export default function Landing() {
  const [anual, setAnual] = useState(false);

  // Fontes só aqui: a página é lazy e o resto do app não usa nenhuma das duas.
  useEffect(() => {
    const el = document.createElement("link");
    el.rel = "stylesheet";
    el.href =
      "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,600;9..144,700&family=Archivo:wght@400;500;600;700&display=swap";
    document.head.appendChild(el);
    return () => {
      document.head.removeChild(el);
    };
  }, []);

  const brl = (v: number) => v.toLocaleString("pt-BR");

  return (
    <div className="lp">
      <style>{CSS}</style>

      {/* Textura sobre tudo: um bone chapado parece tela, com grão parece papel. */}
      <div className="lp-grain" aria-hidden />

      {/* ------------------------------------------------------------- Nav */}
      <header className="lp-nav">
        <span className="lp-wordmark">HospedePay</span>
        <nav>
          <a href="#como">Como funciona</a>
          <a href="#planos">Planos</a>
          <Link to="/entrar" className="lp-nav-entrar">
            Entrar
          </Link>
        </nav>
      </header>

      {/* ------------------------------------------------------------ Hero */}
      <section className="lp-hero">
        <div className="lp-hero-texto">
          <p className="lp-olho lp-rise" style={{ animationDelay: "60ms" }}>
            Gestão de temporada · Niterói e Rio
          </p>

          <h1 className="lp-rise" style={{ animationDelay: "140ms" }}>
            Nós gerimos seu{" "}
            <span className="lp-canal lp-canal--airbnb">Airbnb</span> e{" "}
            <span className="lp-canal lp-canal--booking">Booking</span> por{" "}
            <span className="lp-preco-inline">
              R$&nbsp;97
              <span className="lp-preco-mes">/mês</span>
            </span>
          </h1>

          <p className="lp-sub lp-rise" style={{ animationDelay: "220ms" }}>
            Checkout sem preocupação. Insumos comprados pela equipe de limpeza por
            uma taxa fixa combinada. O apartamento trabalha; você não.
          </p>

          <div className="lp-cta-linha lp-rise" style={{ animationDelay: "300ms" }}>
            <Link to="/entrar?modo=cadastro" className="lp-botao">
              Começar agora
            </Link>
            <a href="#planos" className="lp-link-seco">
              Ver os planos
            </a>
          </div>

          <p className="lp-nota lp-rise" style={{ animationDelay: "360ms" }}>
            Sem fidelidade. Cancela quando quiser, no próprio painel.
          </p>
        </div>

        <figure className="lp-hero-foto lp-rise" style={{ animationDelay: "180ms" }}>
          <img src={IMG.sala} alt="Sala de apartamento de temporada, limpa e vazia, com luz da manhã" />
          <figcaption>
            <span className="lp-fig-num">11:04</span>
            <span>Saída do hóspede. Limpeza já está na agenda da Aline.</span>
          </figcaption>
        </figure>
      </section>

      {/* --------------------------------------------------------- A dor */}
      <section className="lp-dor">
        <div className="lp-dor-texto">
          <h2>
            Um apartamento não dá trabalho.
            <br />
            <em>Combinar</em> as pessoas dá.
          </h2>
          <p>
            A reserva cai no e-mail. Você avisa a diarista no WhatsApp. Ela pergunta
            que horas sai. Você confere o calendário. O hóspede pergunta o Wi-Fi às
            duas da manhã. A portaria liga porque ninguém avisou. No fim do mês,
            você soma na mão o que ela gastou de papel e sabão.
          </p>
          <p className="lp-dor-remate">
            Nada disso é difícil. É só <em>constante</em>. E é por isso que cansa.
          </p>
        </div>

        <ul className="lp-dor-lista">
          {[
            "Avisar a diarista a cada reserva",
            "Conferir horário de saída e entrada",
            "Responder Wi-Fi, portão e fechadura",
            "Cadastrar hóspede na portaria",
            "Somar as compras no fim do mês",
          ].map((item) => (
            <li key={item}>
              <span className="lp-risco">{item}</span>
            </li>
          ))}
          <li className="lp-dor-ok">Feito. Automático.</li>
        </ul>
      </section>

      {/* ------------------------------------------------------- Os pilares */}
      <section className="lp-pilares" id="como">
        <div className="lp-pilares-grade">
          <div className="lp-pilares-lista">
            {PILARES.map((p) => (
              <article key={p.num}>
                <span className="lp-pilar-num">{p.num}</span>
                <h3>{p.titulo}</h3>
                <p>{p.texto}</p>
              </article>
            ))}
          </div>

          <div className="lp-pilares-fotos">
            <figure className="lp-foto-a">
              <img src={IMG.quarto} alt="Quarto arrumado após a limpeza, com toalhas dobradas" />
            </figure>
            <figure className="lp-foto-b">
              <img src={IMG.insumos} alt="Insumos de reposição organizados sobre a bancada" />
            </figure>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- Como roda */}
      <section className="lp-passos">
        <h2>Três passos, uma vez só</h2>
        <ol>
          <li>
            <span className="lp-passo-num">1</span>
            <h3>Cole o link do calendário</h3>
            <p>
              Airbnb e Booking exportam um link. Você cola no app e ele lê suas
              reservas na hora — inclusive as que já estão marcadas.
            </p>
          </li>
          <li>
            <span className="lp-passo-num">2</span>
            <h3>Convide sua diarista</h3>
            <p>
              Ela recebe um link no WhatsApp e entra sem senha e sem cadastro. Passa
              a ver as saídas do mês e marca a limpeza como feita em um toque.
            </p>
          </li>
          <li>
            <span className="lp-passo-num">3</span>
            <h3>Cole a mensagem no Airbnb</h3>
            <p>
              O app gera o texto pronto com o seu link. Toda reserva confirmada leva
              o hóspede ao cadastro e ao assistente. Acabou a sua parte.
            </p>
          </li>
        </ol>
      </section>

      {/* ------------------------------------------------------------ Planos */}
      <section className="lp-planos" id="planos">
        <div className="lp-planos-topo">
          <h2>Escolha pelo número de imóveis</h2>
          <div className="lp-toggle" role="group" aria-label="Ciclo de cobrança">
            <button
              type="button"
              className={!anual ? "on" : ""}
              onClick={() => setAnual(false)}
              aria-pressed={!anual}
            >
              Mensal
            </button>
            <button
              type="button"
              className={anual ? "on" : ""}
              onClick={() => setAnual(true)}
              aria-pressed={anual}
            >
              Anual <span className="lp-toggle-selo">2 meses grátis</span>
            </button>
          </div>
        </div>

        <div className="lp-planos-grade">
          {PLANOS.map((p) => (
            <article key={p.tier} className={p.destaque ? "lp-plano lp-plano--on" : "lp-plano"}>
              {p.destaque && <span className="lp-plano-fita">Mais escolhido</span>}

              <h3>{p.nome}</h3>
              <p className="lp-plano-imoveis">{p.imoveis}</p>

              <p className="lp-plano-preco">
                <span className="lp-cifra">R$</span>
                <span className="lp-valor">{brl(anual ? p.anual : p.mensal)}</span>
                <span className="lp-ciclo">{anual ? "/ano" : "/mês"}</span>
              </p>
              <p className="lp-plano-equiv">
                {anual
                  ? `Equivale a R$ ${brl(Math.round(p.anual / 12))} por mês`
                  : `No anual sai por R$ ${brl(p.anual)} — dois meses de graça`}
              </p>

              <p className="lp-plano-linha">{p.linha}</p>

              <ul>
                {p.itens.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>

              <Link
                to={`/entrar?modo=cadastro&plano=${p.tier}`}
                className={p.destaque ? "lp-botao lp-botao--bloco" : "lp-botao lp-botao--vazado"}
              >
                Assinar o {p.nome}
              </Link>
            </article>
          ))}
        </div>

        <p className="lp-planos-rodape">
          Todos os planos incluem o assistente 24h, o cadastro do hóspede com termo
          e o aviso à portaria. A diferença é quantos imóveis rodam.
        </p>
      </section>

      {/* --------------------------------------------------------------- FAQ */}
      <section className="lp-faq">
        <h2>Antes que você pergunte</h2>
        <dl>
          {[
            [
              "Preciso trocar de plataforma?",
              "Não. Você continua anunciando no Airbnb e no Booking do mesmo jeito. O app só lê o calendário dos dois e cuida do resto — ele não toca no seu anúncio nem no seu preço.",
            ],
            [
              "Minha diarista precisa saber usar app?",
              "Ela recebe um link no WhatsApp e toca. Não cria senha, não faz cadastro, não baixa nada. A tela dela tem o horário de saída grande e um botão para marcar a limpeza como feita.",
            ],
            [
              "Como funciona a taxa fixa de insumos?",
              "Você combina um valor por mês com ela e escolhe a lista do que entra — papel, café, sabão, pilha, o que for. Ela vê a lista no painel dela, repõe, e o valor entra no seu fechamento como despesa fixa. Ela precisa aceitar o valor antes de valer.",
            ],
            [
              "E se o hóspede não se cadastrar?",
              "A mensagem automática do Airbnb leva ele ao link assim que a reserva é confirmada, e o cadastro libera as instruções de acesso — Wi-Fi, fechadura, portão. Na prática ele se cadastra porque precisa das instruções.",
            ],
            [
              "Tem fidelidade?",
              "Não. Você cancela no próprio painel, quando quiser. Seus dados continuam salvos caso volte.",
            ],
          ].map(([q, a]) => (
            <div key={q as string}>
              <dt>{q}</dt>
              <dd>{a}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* --------------------------------------------------------- Fechamento */}
      <section className="lp-fim">
        <figure>
          <img src={IMG.cafe} alt="Café e celular virado para baixo numa mesa junto à janela" />
        </figure>

        <div className="lp-fim-texto">
          <p className="lp-olho">O que você está comprando</p>
          <h2>Venda a paz.</h2>
          <p>
            Seu apartamento continua rendendo. A diarista continua sendo avisada. O
            hóspede continua sendo atendido. A portaria continua sabendo quem entra.
            <br />
            <br />
            Só que nada disso passa mais por você.
          </p>
          <Link to="/entrar?modo=cadastro" className="lp-botao lp-botao--claro">
            Começar por R$ 97/mês
          </Link>
        </div>
      </section>

      <footer className="lp-rodape">
        <span className="lp-wordmark">HospedePay</span>
        <p>
          Gestão automática de aluguel por temporada. Feito em Niterói, para quem
          aluga no Rio.
        </p>
        <nav>
          <Link to="/entrar">Entrar</Link>
          <a href="#planos">Planos</a>
        </nav>
      </footer>
    </div>
  );
}

/**
 * Estilo próprio, fora do Tailwind do app.
 *
 * O app é escuro e usa outra escala tipográfica; herdar aqueles tokens
 * significaria lutar contra eles em cada regra. Um bloco isolado, prefixado em
 * `.lp`, sai mais curto e não vaza para dentro do produto.
 */
const CSS = `
.lp {
  --bone: #f7f3ec;
  --sand: #ebe3d6;
  --areia-2: #ded3c1;
  --ink: #1a1714;
  --ink-70: #4a423b;
  --ink-45: #7d746a;
  --clay: #b84f31;
  --clay-claro: #d4694a;
  --moss: #2b4a3f;
  --airbnb: #e04a4f;
  --booking: #0a57c2;

  --serif: 'Fraunces', ui-serif, Georgia, serif;
  --sans: 'Archivo', ui-sans-serif, system-ui, sans-serif;

  background: var(--bone);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 17px;
  line-height: 1.6;
  min-height: 100vh;
  overflow-x: hidden;
  position: relative;
  -webkit-font-smoothing: antialiased;
}

.lp *, .lp *::before, .lp *::after { box-sizing: border-box; }

/* Foto que não carrega vira um bloco cor de areia, não um ícone quebrado com
   o texto alternativo derramado por cima do layout. As ilustrações vêm de um
   CDN de terceiro: a falha é uma possibilidade real, não hipótese. */
.lp img { background: var(--areia-2); color: transparent; }
.lp h1, .lp h2, .lp h3 { font-family: var(--serif); font-weight: 600; letter-spacing: -0.02em; margin: 0; }
.lp p { margin: 0; }
.lp a { color: inherit; text-decoration: none; }
.lp em { font-style: italic; font-variation-settings: 'SOFT' 40; }

/* Grão: dá superfície de papel ao fundo chapado. Fica em fixed para não
   deslizar junto com o conteúdo e denunciar que é uma textura. */
.lp-grain {
  position: fixed; inset: 0; z-index: 9; pointer-events: none; opacity: .5;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)' opacity='.28'/%3E%3C/svg%3E");
  mix-blend-mode: multiply;
}

@keyframes lp-rise { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }
.lp-rise { animation: lp-rise .8s cubic-bezier(.2,.7,.3,1) backwards; }
@media (prefers-reduced-motion: reduce) { .lp-rise { animation: none; } }

/* ------------------------------------------------------------------ nav */
.lp-nav {
  position: relative; z-index: 10;
  display: flex; align-items: center; justify-content: space-between;
  gap: 16px; padding: 26px clamp(20px, 5vw, 72px);
}
.lp-wordmark {
  font-family: var(--serif); font-weight: 600; font-size: 19px;
  letter-spacing: -0.02em; font-variation-settings: 'SOFT' 60;
}
.lp-nav nav { display: flex; align-items: center; gap: clamp(16px, 3vw, 34px); font-size: 14.5px; }
.lp-nav nav a { color: var(--ink-70); transition: color .2s; }
.lp-nav nav a:hover { color: var(--ink); }
.lp-nav-entrar {
  border: 1px solid var(--areia-2); border-radius: 999px;
  padding: 8px 18px; color: var(--ink) !important;
}
.lp-nav-entrar:hover { background: var(--sand); }
@media (max-width: 560px) { .lp-nav nav a:not(.lp-nav-entrar) { display: none; } }

/* ----------------------------------------------------------------- hero */
.lp-hero {
  position: relative; z-index: 1;
  display: grid; grid-template-columns: 1.05fr .95fr; align-items: center;
  gap: clamp(28px, 5vw, 64px);
  padding: clamp(24px, 5vw, 56px) clamp(20px, 5vw, 72px) clamp(64px, 9vw, 120px);
  max-width: 1440px; margin: 0 auto;
}
@media (max-width: 900px) { .lp-hero { grid-template-columns: 1fr; } }

.lp-olho {
  font-size: 12px; letter-spacing: .16em; text-transform: uppercase;
  color: var(--ink-45); font-weight: 600;
}
.lp-hero h1 {
  margin-top: 22px;
  font-size: clamp(40px, 6.4vw, 82px);
  /* 1.02 encostava a descendente do "g" de Booking na linha de baixo, e a
     última linha no subtítulo. Com display serif deste tamanho, 1.08 ainda
     lê como bloco compacto e devolve o ar que faltava. */
  line-height: 1.08;
  font-variation-settings: 'SOFT' 30, 'WONK' 1;
}
.lp-canal { position: relative; white-space: nowrap; }
.lp-canal::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: .1em; height: .11em;
  border-radius: 2px;
}
.lp-canal--airbnb::after { background: var(--airbnb); }
.lp-canal--booking::after { background: var(--booking); }

.lp-preco-inline { color: var(--clay); white-space: nowrap; }
.lp-preco-mes {
  font-size: .4em; font-family: var(--sans); font-weight: 600;
  letter-spacing: -0.01em; margin-left: .06em;
}

.lp-sub {
  margin-top: 40px; max-width: 46ch; font-size: clamp(16.5px, 1.5vw, 19px);
  color: var(--ink-70); line-height: 1.62;
}
.lp-cta-linha { margin-top: 34px; display: flex; align-items: center; gap: 22px; flex-wrap: wrap; }
.lp-nota { margin-top: 18px; font-size: 13.5px; color: var(--ink-45); }

.lp-botao {
  display: inline-block; background: var(--clay); color: #fff !important;
  font-weight: 600; font-size: 15.5px; padding: 15px 30px; border-radius: 999px;
  transition: transform .2s cubic-bezier(.2,.7,.3,1), background .2s, box-shadow .2s;
  box-shadow: 0 1px 0 rgba(0,0,0,.06);
}
.lp-botao:hover { background: var(--clay-claro); transform: translateY(-2px); box-shadow: 0 10px 24px -12px rgba(184,79,49,.7); }
.lp-botao--vazado {
  background: transparent; color: var(--ink) !important;
  border: 1px solid var(--areia-2); box-shadow: none;
}
.lp-botao--vazado:hover { background: var(--sand); border-color: var(--ink-45); }
.lp-botao--bloco { display: block; text-align: center; }
.lp-botao--claro { background: var(--bone); color: var(--ink) !important; }
.lp-botao--claro:hover { background: #fff; box-shadow: 0 10px 24px -12px rgba(0,0,0,.5); }

.lp-link-seco { font-size: 15px; color: var(--ink-70); border-bottom: 1px solid var(--areia-2); padding-bottom: 2px; }
.lp-link-seco:hover { color: var(--ink); border-color: var(--ink); }

.lp-hero-foto { margin: 0; position: relative; }
.lp-hero-foto img {
  width: 100%; height: clamp(300px, 46vw, 520px); object-fit: cover;
  border-radius: 3px; display: block;
  box-shadow: 0 40px 80px -50px rgba(26,23,20,.55);
}
.lp-hero-foto figcaption {
  position: absolute; left: -18px; bottom: -26px;
  background: var(--bone); border: 1px solid var(--areia-2);
  padding: 13px 18px; border-radius: 3px; max-width: 270px;
  font-size: 13px; line-height: 1.45; color: var(--ink-70);
  display: flex; gap: 12px; align-items: baseline;
  box-shadow: 0 18px 34px -26px rgba(26,23,20,.5);
}
.lp-fig-num {
  font-family: var(--serif); font-size: 19px; font-weight: 600;
  color: var(--clay); font-variant-numeric: tabular-nums; flex-shrink: 0;
}
@media (max-width: 900px) { .lp-hero-foto figcaption { left: 12px; bottom: -20px; } }

/* ------------------------------------------------------------------ dor */
.lp-dor {
  position: relative; z-index: 1;
  background: var(--sand);
  padding: clamp(60px, 8vw, 104px) clamp(20px, 5vw, 72px);
  display: grid; grid-template-columns: 1.15fr .85fr; gap: clamp(32px, 6vw, 80px);
  align-items: start;
}
@media (max-width: 860px) { .lp-dor { grid-template-columns: 1fr; } }
.lp-dor h2 { font-size: clamp(29px, 4vw, 46px); line-height: 1.12; font-variation-settings: 'SOFT' 30; }
.lp-dor-texto p { margin-top: 22px; color: var(--ink-70); max-width: 54ch; }
.lp-dor-remate { font-size: 19px; color: var(--ink) !important; }

.lp-dor-lista { list-style: none; margin: 6px 0 0; padding: 0; }
.lp-dor-lista li {
  padding: 13px 0; border-bottom: 1px solid var(--areia-2);
  font-size: 15.5px; color: var(--ink-45);
}
.lp-risco { position: relative; }
.lp-risco::after {
  content: ''; position: absolute; left: 0; top: 52%; height: 1.5px; width: 100%;
  background: var(--clay); opacity: .75;
}
.lp-dor-ok {
  color: var(--moss) !important; font-weight: 600; border-bottom: none !important;
  font-family: var(--serif); font-size: 20px !important; padding-top: 20px !important;
}

/* -------------------------------------------------------------- pilares */
.lp-pilares {
  position: relative; z-index: 1;
  padding: clamp(64px, 9vw, 116px) clamp(20px, 5vw, 72px);
  max-width: 1440px; margin: 0 auto;
}
.lp-pilares-grade { display: grid; grid-template-columns: 1fr .8fr; gap: clamp(32px, 6vw, 80px); align-items: center; }
@media (max-width: 940px) { .lp-pilares-grade { grid-template-columns: 1fr; } }

.lp-pilares-lista article { padding: 30px 0; border-top: 1px solid var(--areia-2); }
.lp-pilares-lista article:last-child { border-bottom: 1px solid var(--areia-2); }
.lp-pilar-num {
  font-family: var(--serif); font-size: 13px; font-weight: 600; color: var(--clay);
  letter-spacing: .1em; display: block; margin-bottom: 10px;
}
.lp-pilares-lista h3 { font-size: clamp(23px, 2.6vw, 31px); font-variation-settings: 'SOFT' 30; }
.lp-pilares-lista p { margin-top: 12px; color: var(--ink-70); max-width: 52ch; font-size: 16px; }

.lp-pilares-fotos { position: relative; }
.lp-pilares-fotos figure { margin: 0; }
.lp-pilares-fotos img { width: 100%; display: block; border-radius: 3px; object-fit: cover; }
.lp-foto-a img { height: clamp(320px, 40vw, 460px); box-shadow: 0 40px 80px -50px rgba(26,23,20,.55); }
.lp-foto-b {
  position: absolute; right: -22px; bottom: -46px; width: 54%;
  border: 7px solid var(--bone); border-radius: 4px;
  box-shadow: 0 26px 50px -34px rgba(26,23,20,.6);
}
.lp-foto-b img { height: clamp(130px, 17vw, 190px); }
@media (max-width: 940px) { .lp-foto-b { right: 0; bottom: -30px; width: 46%; } }

/* --------------------------------------------------------------- passos */
.lp-passos {
  position: relative; z-index: 1;
  background: var(--moss); color: var(--bone);
  padding: clamp(64px, 9vw, 108px) clamp(20px, 5vw, 72px);
  margin-top: clamp(48px, 7vw, 76px);
}
.lp-passos h2 { font-size: clamp(28px, 3.6vw, 42px); max-width: 1440px; margin: 0 auto; font-variation-settings: 'SOFT' 40; }
.lp-passos ol {
  list-style: none; padding: 0; margin: clamp(34px, 5vw, 56px) auto 0; max-width: 1440px;
  display: grid; grid-template-columns: repeat(3, 1fr); gap: clamp(24px, 4vw, 54px);
}
@media (max-width: 860px) { .lp-passos ol { grid-template-columns: 1fr; } }
.lp-passos li { border-top: 1px solid rgba(247,243,236,.22); padding-top: 22px; }
.lp-passo-num {
  font-family: var(--serif); font-size: 40px; font-weight: 300; line-height: 1;
  color: rgba(247,243,236,.42); display: block; margin-bottom: 14px;
}
.lp-passos h3 { font-size: 21px; }
.lp-passos p { margin-top: 10px; color: rgba(247,243,236,.72); font-size: 15.5px; }

/* --------------------------------------------------------------- planos */
.lp-planos {
  position: relative; z-index: 1;
  padding: clamp(64px, 9vw, 116px) clamp(20px, 5vw, 72px);
  max-width: 1440px; margin: 0 auto;
}
.lp-planos-topo {
  display: flex; align-items: end; justify-content: space-between;
  gap: 24px; flex-wrap: wrap; margin-bottom: clamp(30px, 4vw, 48px);
}
.lp-planos h2 { font-size: clamp(28px, 3.8vw, 44px); font-variation-settings: 'SOFT' 30; }

.lp-toggle {
  display: inline-flex; background: var(--sand); border-radius: 999px; padding: 4px;
}
.lp-toggle button {
  font-family: var(--sans); font-size: 14px; font-weight: 600; color: var(--ink-45);
  background: none; border: 0; cursor: pointer; padding: 9px 18px; border-radius: 999px;
  display: inline-flex; align-items: center; gap: 8px; transition: background .2s, color .2s;
}
.lp-toggle button.on { background: var(--bone); color: var(--ink); box-shadow: 0 1px 3px rgba(26,23,20,.12); }
.lp-toggle-selo {
  font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em;
  background: var(--clay); color: #fff; padding: 3px 7px; border-radius: 999px;
}

.lp-planos-grade { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; align-items: start; }
@media (max-width: 940px) {
  .lp-planos-grade { grid-template-columns: 1fr; max-width: 460px; margin-inline: auto; }
}
@media (max-width: 420px) {
  /* Em 390px o selo "2 meses grátis" empurrava o botão Anual para fora da
     pílula. Some o selo: a economia continua escrita dentro de cada plano. */
  .lp-toggle-selo { display: none; }
}

.lp-plano {
  position: relative; border: 1px solid var(--areia-2); border-radius: 5px;
  padding: 30px 26px 26px; background: rgba(255,255,255,.42);
  transition: transform .25s cubic-bezier(.2,.7,.3,1), box-shadow .25s;
}
.lp-plano:hover { transform: translateY(-3px); box-shadow: 0 26px 50px -40px rgba(26,23,20,.6); }
.lp-plano--on { border-color: var(--clay); background: #fff; box-shadow: 0 26px 54px -42px rgba(184,79,49,.85); }
.lp-plano-fita {
  position: absolute; top: -11px; left: 26px; background: var(--clay); color: #fff;
  font-size: 10.5px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase;
  padding: 4px 11px; border-radius: 999px;
}
.lp-plano h3 { font-size: 25px; font-variation-settings: 'SOFT' 40; }
.lp-plano-imoveis { font-size: 13px; color: var(--ink-45); margin-top: 3px !important; letter-spacing: .01em; }

.lp-plano-preco { display: flex; align-items: baseline; gap: 4px; margin-top: 20px !important; color: var(--ink); }
.lp-cifra { font-family: var(--sans); font-size: 16px; font-weight: 600; color: var(--ink-45); }
.lp-valor {
  font-family: var(--serif); font-size: clamp(42px, 4.6vw, 56px); font-weight: 600;
  line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -0.03em;
}
.lp-ciclo { font-size: 14px; color: var(--ink-45); font-weight: 500; }
.lp-plano-equiv { font-size: 12.5px; color: var(--clay); margin-top: 8px !important; font-weight: 500; }
.lp-plano-linha { font-size: 14.5px; color: var(--ink-70); margin-top: 18px !important; min-height: 3em; }

.lp-plano ul { list-style: none; padding: 0; margin: 20px 0 26px; border-top: 1px solid var(--areia-2); }
.lp-plano li {
  font-size: 14.5px; color: var(--ink-70); padding: 11px 0 11px 25px;
  border-bottom: 1px solid rgba(222,211,193,.5); position: relative; line-height: 1.45;
}
.lp-plano li::before {
  content: ''; position: absolute; left: 3px; top: 18px;
  width: 9px; height: 5px; border-left: 1.6px solid var(--moss); border-bottom: 1.6px solid var(--moss);
  transform: rotate(-45deg);
}
.lp-planos-rodape {
  margin-top: 28px; font-size: 14px; color: var(--ink-45); text-align: center; max-width: 62ch;
  margin-left: auto; margin-right: auto;
}

/* ------------------------------------------------------------------ faq */
.lp-faq {
  position: relative; z-index: 1; background: var(--sand);
  padding: clamp(60px, 8vw, 104px) clamp(20px, 5vw, 72px);
}
.lp-faq h2 { font-size: clamp(27px, 3.4vw, 40px); max-width: 1100px; margin: 0 auto 34px; font-variation-settings: 'SOFT' 30; }
.lp-faq dl { max-width: 1100px; margin: 0 auto; }
.lp-faq dl > div { border-top: 1px solid var(--areia-2); padding: 24px 0; display: grid; grid-template-columns: .8fr 1.2fr; gap: 28px; }
@media (max-width: 780px) { .lp-faq dl > div { grid-template-columns: 1fr; gap: 8px; } }
.lp-faq dt { font-family: var(--serif); font-size: 19px; font-weight: 600; font-variation-settings: 'SOFT' 40; }
.lp-faq dd { margin: 0; color: var(--ink-70); font-size: 15.5px; }

/* ------------------------------------------------------------------- fim */
.lp-fim {
  position: relative; z-index: 1; background: var(--ink); color: var(--bone);
  display: grid; grid-template-columns: .8fr 1.2fr; align-items: center;
  gap: clamp(28px, 5vw, 72px);
  padding: clamp(56px, 8vw, 96px) clamp(20px, 5vw, 72px);
}
@media (max-width: 860px) { .lp-fim { grid-template-columns: 1fr; } }
.lp-fim figure { margin: 0; }
.lp-fim img { width: 100%; height: clamp(280px, 38vw, 440px); object-fit: cover; border-radius: 3px; display: block; }
.lp-fim .lp-olho { color: rgba(247,243,236,.5); }
.lp-fim h2 {
  font-size: clamp(46px, 7.4vw, 96px); margin-top: 14px; line-height: .98;
  font-variation-settings: 'SOFT' 20, 'WONK' 1;
}
.lp-fim p:not(.lp-olho) { margin-top: 24px; color: rgba(247,243,236,.74); max-width: 46ch; font-size: 17px; }
.lp-fim .lp-botao { margin-top: 34px; }

/* ---------------------------------------------------------------- rodapé */
.lp-rodape {
  position: relative; z-index: 1;
  padding: 34px clamp(20px, 5vw, 72px) 46px;
  display: flex; align-items: center; justify-content: space-between;
  gap: 18px; flex-wrap: wrap; border-top: 1px solid var(--areia-2);
}
.lp-rodape p { font-size: 13px; color: var(--ink-45); max-width: 40ch; }
.lp-rodape nav { display: flex; gap: 22px; font-size: 14px; color: var(--ink-70); }
.lp-rodape nav a:hover { color: var(--ink); }
`;
