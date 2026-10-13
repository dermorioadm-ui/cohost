import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CameraOff, Check, FileImage, FileText, Pause, PenLine, Play, RotateCcw, ScanFace, UserRound } from "lucide-react";
import { Marca } from "./Marca";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import styles from "./CheckInDemo.css?inline";

const scenes = [
  { name: "Cadastro", icon: UserRound, title: "Os dados da estadia, juntos.", description: "Datas e dados do hóspede no mesmo cadastro." },
  { name: "Documento", icon: FileImage, title: "Documento junto ao cadastro.", description: "Uma imagem acompanha os dados informados pelo hóspede." },
  { name: "Assinatura", icon: PenLine, title: "O termo antes da assinatura.", description: "O hóspede lê o termo e assina no próprio celular." },
  { name: "Selfie", icon: ScanFace, title: "Um registro para conferência.", description: "A selfie acompanha o cadastro. Não é uma validação biométrica automática." },
  { name: "Contrato", icon: FileText, title: "Tudo reunido no documento.", description: "Veja um resumo ilustrativo dos registros da estadia." },
];
const SCENE_MS = 5000; // Presentation pacing, never a promise about real check-in duration.

/** Local, read-only product preview. GuestChat performs network calls and is NOT imported.
 * Marca/Input/Label are shared pure UI. Assinatura and CapturaFacial were used as visual
 * references only: we must not capture a real signature, image, consent or camera stream.
 */
export function CheckInDemo() {
  const [{ scene, elapsed, finished, revision }, setPlayback] = useState({ scene: 0, elapsed: 0, finished: false, revision: 0 });
  const [paused, setPaused] = useState(false);
  const [manual, setManual] = useState(false);
  const [inView, setInView] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const ref = useRef<HTMLElement>(null);
  const id = useId();
  const running = inView && pageVisible && !paused && !reduced && !finished;

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const change = (event: MediaQueryListEvent) => { setReduced(event.matches); setPaused(true); };
    media?.addEventListener("change", change);
    const visibility = () => setPageVisible(!document.hidden);
    visibility();
    document.addEventListener("visibilitychange", visibility);
    // Unsupported observers fall back to manual navigation, never offscreen autoplay.
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => setInView(entry.isIntersecting && entry.intersectionRatio >= 0.25), { threshold: [0, 0.25] });
    if (ref.current) observer?.observe(ref.current);
    return () => {
      observer?.disconnect();
      media?.removeEventListener("change", change);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setPlayback((current) => {
      if (current.finished) return current;
      if (current.elapsed + 100 < SCENE_MS) return { ...current, elapsed: current.elapsed + 100 };
      return current.scene === scenes.length - 1
        ? { ...current, elapsed: SCENE_MS, finished: true }
        : { ...current, scene: current.scene + 1, elapsed: 0 };
    }), 100);
    return () => window.clearInterval(timer);
  }, [running]);

  function select(index: number) {
    setPaused(true); setManual(true);
    setPlayback((current) => ({ scene: index, elapsed: 0, finished: false, revision: current.revision + 1 }));
  }
  function repeat() {
    setManual(reduced); setPaused(reduced);
    setPlayback((current) => ({ scene: 0, elapsed: 0, finished: false, revision: current.revision + 1 }));
  }
  const completeFrame = manual || reduced;
  const active = scenes[scene];
  return <section ref={ref} className="hp-checkin-demo" aria-labelledby={`${id}-title`} data-running={running} data-static={completeFrame}>
    <style>{styles}</style>
    <div className="hp-demo-story">
      <span className="hp-demo-kicker">Demonstração interativa</span>
      <h2 id={`${id}-title`}>É isso que o seu hóspede vê.</h2>
      <p className="hp-demo-intro">Do cadastro ao contrato, acompanhe o caminho no celular. Ou escolha uma cena para olhar com calma.</p>
      <nav className="hp-demo-scenes" aria-label="Cenas da demonstração">
        {scenes.map(({ name, icon: Icon }, index) => <button type="button" key={name} data-demo-scene={index} aria-current={scene === index ? "step" : undefined} aria-controls={`${id}-screen`} onClick={() => select(index)}>
          <Icon size={19} aria-hidden="true" /><span>{name}</span><ArrowRight size={16} className="hp-demo-scene-arrow" aria-hidden="true" />
        </button>)}
      </nav>
      <p className="hp-demo-disclaimer"><strong>Dados fictícios.</strong> Apenas uma simulação: nada é enviado, capturado ou contratado.</p>
    </div>
    <div className="hp-demo-player">
      <div className="hp-demo-phone">
      <div className="hp-demo-hardware" aria-hidden="true"><span /></div>
      <div className="hp-demo-browser"><Marca size={28} /><span>Prévia do hóspede</span></div>
      <div id={`${id}-screen`} className="hp-demo-stage" aria-label={`Cena: ${active.name}`}>
        <article key={`${scene}-${revision}`} className="hp-demo-scene">
          <header className="hp-demo-scene-header"><p className="hp-demo-property">Casa Horizonte · imóvel fictício</p><h3>{active.title}</h3><p>{active.description}</p></header>
          {scene === 0 && <div className="hp-demo-fields">
            <div className="hp-demo-dates"><span>Check-in <strong>12 nov. 2026</strong></span><ArrowRight size={16} aria-hidden="true" /><span>Check-out <strong>15 nov. 2026</strong></span></div>
            <div className="hp-demo-field"><Label htmlFor={`${id}-name`}>Nome completo</Label><Input id={`${id}-name`} value="Marina Exemplo" readOnly autoComplete="off" tabIndex={-1} /></div>
            <div className="hp-demo-field"><Label htmlFor={`${id}-email`}>E-mail</Label><Input id={`${id}-email`} value={completeFrame || elapsed >= 1000 ? "marina@example.com" : ""} readOnly autoComplete="off" tabIndex={-1} /></div>
            <p className="hp-demo-note"><Check size={16} aria-hidden="true" />Um hóspede nesta estadia de exemplo</p>
          </div>}
          {scene === 1 && <div className="hp-demo-document">
            <div className="hp-demo-file-picture hp-demo-prop"><strong>DOCUMENTO DE EXEMPLO</strong><div className="hp-demo-prop-body"><img src="/lp/demo-selfie.png" alt="Retrato sintético da personagem fictícia Marina" /><div><b>Marina Exemplo</b><span>Personagem fictícia</span><span>Dados demonstrativos</span></div></div><em>SEM VALIDADE</em></div>
            <div className="hp-demo-file-row"><FileImage size={20} aria-hidden="true" /><span>documento-exemplo.png<small>Arquivo ilustrativo, não enviado</small></span><Check size={18} aria-hidden="true" /></div>
            <p className="hp-demo-note">Na experiência real, o hóspede escolhe a imagem do documento.</p>
          </div>}
          {scene === 2 && <div className="hp-demo-signature">
            <p className="hp-demo-term"><Check size={18} aria-hidden="true" /><span>Leitura e aceite do termo <strong>simulados</strong></span></p>
            <p className="hp-demo-label">Assine no quadro abaixo</p>
            <div className="hp-demo-sign-pad">
              <svg viewBox="0 0 320 125" role="img" aria-label="Traço ilustrativo de assinatura"><path className="hp-demo-ink" pathLength="1" d="M30 90 C40 50 49 20 57 30 C64 44 48 97 60 88 C77 74 85 20 95 31 C106 43 83 101 105 82 C124 66 139 67 135 81 C124 104 118 62 145 68 C161 77 146 90 160 83 L183 65 C166 99 194 84 204 70 C210 83 218 87 232 71 C223 98 257 79 268 68 M67 104 Q170 89 285 97" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span>Traço fictício. Não é uma assinatura válida.</span>
            </div>
            <p className="hp-demo-note">O quadro reproduz o espaço de assinatura do cadastro.</p>
          </div>}
          {scene === 3 && <div className="hp-demo-selfie">
            <div className="hp-demo-camera"><img className="hp-demo-selfie-photo" src="/lp/demo-selfie.png" alt="Selfie gerada por IA de Marina, personagem fictícia" /><div className="hp-demo-face-guide" aria-hidden="true" /><span><CameraOff size={15} aria-hidden="true" />Selfie simulada · IA · Câmera desligada</span></div>
            <p className="hp-demo-note">Enquadramento ilustrativo, sem rosto real.<br />Sem verificação biométrica nesta demonstração.</p>
          </div>}
          {scene === 4 && <div className="hp-demo-contract">
            <div className="hp-demo-watermark" aria-hidden="true">SEM VALIDADE</div>
            <FileText size={26} aria-hidden="true" /><h4>Resumo demonstrativo</h4>
            <dl><div><dt>Hóspede fictícia</dt><dd>Marina Exemplo</dd></div><div><dt>Estadia ilustrativa</dt><dd>12 a 15 de novembro de 2026</dd></div><div><dt>Registros representados</dt><dd>Cadastro, documento, assinatura e selfie</dd></div></dl>
            <p>DEMONSTRAÇÃO SEM VALIDADE JURÍDICA</p>
          </div>}
        </article>
      </div>
      <div className="hp-demo-progress" aria-hidden="true"><span style={{ transform: `scaleX(${elapsed / SCENE_MS})` }} /></div>
      <div className="hp-demo-home" aria-hidden="true" />
      </div>
      <div className="hp-demo-controls" aria-label="Controles da demonstração">
        <button type="button" disabled={scene === 0} onClick={() => select(scene - 1)}><ArrowLeft size={16} aria-hidden="true" /><span>Anterior</span></button>
        {!reduced && !finished && <button type="button" className="hp-demo-play" onClick={() => { setManual(false); setPaused((value) => !value); }}>{paused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}<span>{paused ? "Reproduzir" : "Pausar"}</span></button>}
        <button type="button" disabled={scene === scenes.length - 1} onClick={() => select(scene + 1)}><span>Próxima</span><ArrowRight size={16} aria-hidden="true" /></button>
        <button type="button" onClick={repeat}><RotateCcw size={16} aria-hidden="true" /><span>Repetir</span></button>
      </div>
      <p className="hp-demo-status" role="status" aria-live="polite">{finished ? "Demonstração concluída" : `${active.name} · cena ${scene + 1} de ${scenes.length}`}{reduced ? " | Navegação manual" : ""}</p>
      <p className="hp-demo-timing">O ritmo da animação não representa o tempo real do check-in.</p>
    </div>
  </section>;
}
