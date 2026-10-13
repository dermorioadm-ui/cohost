// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckInDemo } from "../CheckInDemo";

let root: Root;
let host: HTMLDivElement;
let visible: (value: boolean) => void;
let reduced = false;
let motionChange: (event: { matches: boolean }) => void;
const disconnect = vi.fn();
function click(label: string) {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  expect(button, label).toBeTruthy();
  act(() => button!.click());
}
function step() { return host.querySelector("[aria-current='step']")?.textContent; }
function mount() { act(() => root.render(<CheckInDemo />)); }
beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) {
      visible = (value) => callback([{ isIntersecting: value, intersectionRatio: value ? 1 : 0 } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    observe() {}
    disconnect = disconnect;
  });
  vi.stubGlobal("matchMedia", () => ({ matches: reduced, addEventListener: (_: string, fn: typeof motionChange) => { motionChange = fn; }, removeEventListener: vi.fn() }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
describe("CheckInDemo", () => {
  it("plays only in view, can pause and resume, finishes without looping, and repeats", () => {
    mount();
    act(() => vi.advanceTimersByTime(5000));
    expect(step()).toContain("Cadastro");
    act(() => visible(true));
    act(() => vi.advanceTimersByTime(5000));
    expect(step()).toContain("Documento");
    click("Pausar");
    act(() => vi.advanceTimersByTime(15000));
    expect(step()).toContain("Documento");
    click("Reproduzir");
    act(() => vi.advanceTimersByTime(5000));
    expect(step()).toContain("Assinatura");
    act(() => visible(false));
    act(() => vi.advanceTimersByTime(5000));
    expect(step()).toContain("Assinatura");
    act(() => visible(true));
    for (let i = 0; i < 3; i++) act(() => vi.advanceTimersByTime(5000));
    expect(step()).toContain("Contrato");
    expect(host.textContent).toContain("Demonstração concluída");
    act(() => vi.advanceTimersByTime(60000));
    expect(step()).toContain("Contrato");
    click("Repetir");
    expect(step()).toContain("Cadastro");
  });
  it("supports manual next, previous and scene selection with playback paused", () => {
    mount(); act(() => visible(true));
    click("Próxima"); expect(step()).toContain("Documento");
    click("Anterior"); expect(step()).toContain("Cadastro");
    click("Selfie"); expect(step()).toContain("Selfie");
    act(() => vi.advanceTimersByTime(10000)); expect(step()).toContain("Selfie");
  });
  it("respects reduced motion initially and when the preference changes", () => {
    reduced = true; mount(); act(() => visible(true));
    act(() => vi.advanceTimersByTime(15000)); expect(step()).toContain("Cadastro");
    click("Próxima"); expect(step()).toContain("Documento");
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Reproduzir")).toBe(false);
    act(() => motionChange({ matches: false })); click("Reproduzir");
    act(() => vi.advanceTimersByTime(5000)); expect(step()).toContain("Assinatura");
    act(() => motionChange({ matches: true }));
    act(() => vi.advanceTimersByTime(15000)); expect(step()).toContain("Assinatura");
  });
  it("pauses in a background tab and preserves partial scene time", () => {
    mount(); act(() => visible(true));
    act(() => vi.advanceTimersByTime(2000));
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(10000)); expect(step()).toContain("Cadastro");
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(2900)); expect(step()).toContain("Cadastro");
    act(() => vi.advanceTimersByTime(100)); expect(step()).toContain("Documento");
  });
  it("keeps every scene accessible manually without IntersectionObserver", () => {
    vi.stubGlobal("IntersectionObserver", undefined); mount();
    act(() => vi.advanceTimersByTime(15000)); expect(step()).toContain("Cadastro");
    click("Contrato"); expect(host.textContent).toContain("SEM VALIDADE");
  });
  it("releases timers and the viewport observer on unmount", () => {
    mount(); act(() => visible(true)); expect(vi.getTimerCount()).toBeGreaterThan(0);
    act(() => root.render(null));
    expect(vi.getTimerCount()).toBe(0); expect(disconnect).toHaveBeenCalled();
  });
  it("shows all five local scenes without network, uploads, camera, storage or real contracts", () => {
    const fetch = vi.fn(); const camera = vi.fn(); const xhr = vi.spyOn(XMLHttpRequest.prototype, "open");
    const storage = vi.spyOn(Storage.prototype, "setItem");
    vi.stubGlobal("fetch", fetch);
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: camera }, configurable: true });
    mount();
    click("Documento"); expect(host.textContent).toContain("documento-exemplo.png");
    click("Assinatura"); expect(host.querySelector("svg[aria-label='Traço ilustrativo de assinatura']")).not.toBeNull();
    click("Selfie"); expect(host.textContent).toContain("Câmera desligada"); expect(host.textContent).toContain("Sem verificação biométrica");
    click("Contrato"); expect(host.textContent).toContain("SEM VALIDADE"); expect(host.textContent).toContain("Resumo demonstrativo");
    expect(host.querySelector("input[type=file], video, canvas, form, a[download]")).toBeNull();
    expect(fetch).not.toHaveBeenCalled(); expect(camera).not.toHaveBeenCalled(); expect(xhr).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
  });
  it("renders fictional registration using the real labelled inputs and five scene choices", () => {
    mount();
    expect(step()).toContain("Cadastro");
    expect(host.textContent).toContain("Dados fictícios");
    expect(host.querySelectorAll("[data-demo-scene]")).toHaveLength(5);
    expect(host.querySelector<HTMLInputElement>("input[readonly]")?.value).toBe("Marina Exemplo");
    expect(host.querySelector("label[for]")).not.toBeNull();
  });
});
