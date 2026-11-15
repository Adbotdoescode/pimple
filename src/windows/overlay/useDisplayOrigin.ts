import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface Origin { x: number; y: number }

/**
 * The overlay window's top-left corner in global logical points.
 * Shapes are mapped through this so they land on the same pixels as the capture.
 */
export function useDisplayOrigin(): Origin {
  const [origin, setOrigin] = useState<Origin>({ x: 0, y: 0 });

  useEffect(() => {
    let disposed = false;
    const win = getCurrentWindow();

    const read = async () => {
      try {
        const [pos, scale] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
        if (!disposed) setOrigin({ x: pos.x / scale, y: pos.y / scale });
      } catch (err) {
        console.warn("[useDisplayOrigin] could not read window position", err);
      }
    };

    void read();
    const unsubs = [win.onMoved(() => void read()), win.onResized(() => void read())];
    return () => {
      disposed = true;
      for (const p of unsubs) p.then((un) => un()).catch(() => {});
    };
  }, []);

  return origin;
}
