// Dev-only harness: http://localhost:1420/src/windows/whiteboard/preview.html
// Params: fixture=<name> (default canned-whiteboard, a wire response in demo/fixtures; "sample" = SAMPLE_WHITEBOARD),
//         theme=light|dark, seg=N (visible segments), empty=1 (no response), phase=speaking
import "./whiteboard.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { wireToShape } from "@shared/contracts";
import type { Phase, Shape, TutorResponse, WireResponse } from "@shared/contracts";
import { Whiteboard } from "./Whiteboard";
import { SAMPLE_WHITEBOARD } from "./sample";

// ?backdrop=incline draws the captured screenshot under an overlay-style (image-pixel) response.
const INCLINE_BACKDROP = { src: "/demo/fixtures/incline.png", w: 1440, h: 900 };

async function loadFixture(name: string): Promise<TutorResponse> {
  const res = await fetch(`/demo/fixtures/${encodeURIComponent(name)}.json`);
  if (!res.ok) throw new Error(`fixture ${name}: HTTP ${res.status}`);
  const wire = (await res.json()) as WireResponse;
  const shapes = (wire.shapes ?? []).map((w) => wireToShape(w)).filter((sh): sh is Shape => sh !== null);
  return { ...wire, shapes };
}

function Preview() {
  const params = new URLSearchParams(window.location.search);
  const fixture = params.get("fixture") ?? "canned-whiteboard";
  const [theme, setTheme] = useState<"light" | "dark">(params.get("theme") === "dark" ? "dark" : "light");
  const [loaded, setLoaded] = useState<TutorResponse | null | undefined>(
    fixture === "sample" ? SAMPLE_WHITEBOARD : undefined,
  );

  useEffect(() => {
    if (fixture === "sample") return;
    let cancelled = false;
    loadFixture(fixture).then(
      (r) => !cancelled && setLoaded(r),
      (err) => {
        console.error(err);
        if (!cancelled) setLoaded(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fixture]);

  if (loaded === undefined) return null;
  const response = params.get("empty") === "1" ? null : loaded;

  const all = response?.segments ?? [];
  const segParam = params.get("seg");
  const count = segParam === null ? all.length : Math.max(0, Math.min(all.length, Number(segParam) || 0));
  const visible = all.slice(0, count);
  const last = visible[visible.length - 1];
  const phase = (params.get("phase") ?? "speaking") as Phase;

  return (
    <Whiteboard
      response={response}
      visibleSegmentIds={visible.map((seg) => seg.id)}
      currentSegmentId={last?.id ?? null}
      pulseShapeIds={[]}
      sideNote={null}
      backdrop={params.get("backdrop") === "incline" ? INCLINE_BACKDROP : null}
      theme={theme}
      caption={last?.text ?? ""}
      phase={phase}
      sourceLabel="Source: your screen — the incline diagram"
      onToggleTheme={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
      onClose={() => window.close()}
    />
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Preview />);
