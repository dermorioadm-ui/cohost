// @vitest-environment jsdom
import { act, StrictMode, useRef } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { CheckInDemoPortal } from "../CheckInDemoPortal";

function Fixture({ demo = true }: { demo?: boolean }) {
  const scope = useRef<HTMLElement>(null);
  return <main className="hp-v2" ref={scope}><section id="check-in"><div data-original="true"><h2>Original</h2><video /></div></section>{demo && <CheckInDemoPortal scope={scope} />}</main>;
}
describe("V2 check-in portal", () => {
  it("mounts into the V2 section only and restores original DOM on cleanup, including StrictMode", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const outside = document.createElement("section"); outside.id = "check-in"; outside.innerHTML = "<div>V1 unaffected</div>"; document.body.append(outside);
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    try {
      act(() => root.render(<StrictMode><Fixture /></StrictMode>));
      const original = host.querySelector<HTMLElement>("[data-original]")!;
      expect(original.hidden).toBe(true);
      expect(original.getAttribute("aria-hidden")).toBe("true");
      // jsdom's ID-selector optimization mishandles deliberately duplicated IDs.
      const demo = host.querySelector("section.hp-checkin-demo");
      expect(demo).not.toBeNull();
      expect(demo?.parentElement).toBe(original.parentElement);
      expect(demo?.parentElement?.id).toBe("check-in");
      expect(outside.innerHTML).toBe("<div>V1 unaffected</div>");
      expect(pause).toHaveBeenCalled();
      act(() => root.render(<StrictMode><Fixture demo={false} /></StrictMode>));
      expect(original.hidden).toBe(false);
      expect(original.hasAttribute("aria-hidden")).toBe(false);
      expect(original.hasAttribute("data-hp-demo-original")).toBe(false);
      expect(host.querySelector(".hp-checkin-demo")).toBeNull();
    } finally { act(() => root.unmount()); host.remove(); outside.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
  });
});
