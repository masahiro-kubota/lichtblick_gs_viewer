import { PanelExtensionContext } from "@foxglove/extension";
import { ReactElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { GaussianSplatMsg } from "./msg/GaussianSplatMsg";
import { parsePly } from "./parsers/plyParser";
import { SplatRenderer } from "./renderer/SplatRenderer";

function GaussianSplatPanel({
  context,
}: {
  context: PanelExtensionContext;
}): ReactElement {
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  const [status, setStatus] = useState("Drop a .ply file here");
  const [splatData, setSplatData] = useState<GaussianSplatMsg | undefined>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SplatRenderer | undefined>();

  useLayoutEffect(() => {
    context.onRender = (_renderState, done) => {
      setRenderDone(() => done);
    };
    context.watch("topics");
    context.watch("currentFrame");
  }, [context]);

  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  // splatData が変わったらレンダラにセット
  useEffect(() => {
    if (!splatData || !canvasRef.current) return;

    if (!rendererRef.current) {
      rendererRef.current = new SplatRenderer(canvasRef.current);
      rendererRef.current.startLoop();
    }
    rendererRef.current.setData(splatData);

    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = undefined;
    };
  }, [splatData]);

  const handleFile = useCallback(async (file: File) => {
    setStatus(`Loading ${file.name}...`);
    try {
      const buffer = await file.arrayBuffer();
      const msg = parsePly(buffer);
      setSplatData(msg);
      setStatus(`${msg.count.toLocaleString()} splats`);

      console.log("[GS Viewer] Parsed PLY:", {
        count: msg.count,
        positionRange: getRange(msg.positions),
        colorRange: getRange(msg.colors),
        opacityRange: getRange(msg.opacities),
        scaleRange: getRange(msg.scales),
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      setStatus(`Error: ${errMsg}`);
      console.error("[GS Viewer] Parse error:", e);
    }
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const file = e.dataTransfer.files[0];
      if (file) {
        void handleFile(file);
      }
    },
    [handleFile],
  );

  return (
    <div
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        overflow: "hidden",
        background: "#1a1a2e",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: "100%",
          display: splatData ? "block" : "none",
        }}
      />
      {!splatData && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#888",
            fontSize: "1.1rem",
          }}
        >
          {status}
        </div>
      )}
      {splatData && (
        <div
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            color: "#aaa",
            fontSize: "0.8rem",
            background: "rgba(0,0,0,0.5)",
            padding: "4px 8px",
            borderRadius: 4,
            pointerEvents: "none",
          }}
        >
          {status}
        </div>
      )}
    </div>
  );
}

function getRange(arr: Float32Array): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

export function initGaussianSplatPanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<GaussianSplatPanel context={context} />);

  return () => {
    root.unmount();
  };
}
