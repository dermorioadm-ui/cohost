import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CheckInDemo } from "./CheckInDemo";

/** Hide only once the replacement has committed. Keep React's original nodes intact. */
function MountedDemo({ target }: { target: HTMLElement }) {
  useEffect(() => {
    const originals = Array.from(target.children).filter((node): node is HTMLElement => node instanceof HTMLElement && !node.classList.contains("hp-checkin-demo"));
    const snapshots = originals.map((element) => ({ element, hidden: element.hidden, aria: element.getAttribute("aria-hidden"), marker: element.getAttribute("data-hp-demo-original") }));
    const videos = originals.flatMap((element) => Array.from(element.querySelectorAll("video"))).map((video) => ({ video, playing: !video.paused }));
    snapshots.forEach(({ element }) => { element.hidden = true; element.setAttribute("aria-hidden", "true"); element.setAttribute("data-hp-demo-original", ""); });
    videos.forEach(({ video }) => video.pause());
    return () => {
      snapshots.forEach(({ element, hidden, aria, marker }) => {
        element.hidden = hidden;
        if (aria === null) element.removeAttribute("aria-hidden"); else element.setAttribute("aria-hidden", aria);
        if (marker === null) element.removeAttribute("data-hp-demo-original"); else element.setAttribute("data-hp-demo-original", marker);
      });
      videos.forEach(({ video, playing }) => { if (playing && video.isConnected) void video.play().catch(() => {}); });
    };
  }, [target]);
  return <CheckInDemo />;
}

/** A ref-scoped portal prevents accidental replacement of V1, even with duplicate anchor IDs. */
export function CheckInDemoPortal({ scope }: { scope: RefObject<HTMLElement> }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => { setTarget(scope.current?.querySelector<HTMLElement>("#check-in") ?? null); }, [scope]);
  return target ? createPortal(<MountedDemo target={target} />, target) : null;
}
