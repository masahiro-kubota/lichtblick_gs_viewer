import { Immutable, MessageEvent, PanelExtensionContext, Topic } from "@foxglove/extension";
import { ReactElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { GaussianSplatMsg } from "./msg/GaussianSplatMsg";
import { GAUSSIAN_SPLAT_SCHEMA_NAME, GaussianSplatMsgJson } from "./msg/schema";
import { parsePly } from "./parsers/plyParser";
import { SplatRenderer } from "./renderer/SplatRenderer";
import { base64ToFloat32Array } from "./utils/base64";

type InputMode = "ply" | "topic";

/** JSON メッセージ → 内部 GaussianSplatMsg に変換 */
function decodeJsonMsg(json: GaussianSplatMsgJson): GaussianSplatMsg {
  return {
    timestamp: json.timestamp,
    frame_id: json.frame_id,
    count: json.count,
    positions: base64ToFloat32Array(json.positions_b64),
    scales: base64ToFloat32Array(json.scales_b64),
    rotations: base64ToFloat32Array(json.rotations_b64),
    opacities: base64ToFloat32Array(json.opacities_b64),
    colors: base64ToFloat32Array(json.colors_b64),
  };
}

function GaussianSplatPanel({
  context,
}: {
  context: PanelExtensionContext;
}): ReactElement {
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  const [status, setStatus] = useState("Drop .ply or subscribe to topic");
  const [splatData, setSplatData] = useState<GaussianSplatMsg | undefined>();
  const [inputMode, setInputMode] = useState<InputMode>("ply");
  const [availableTopics, setAvailableTopics] = useState<Immutable<Topic[]>>([]);
  const [selectedTopic, setSelectedTopic] = useState<string>("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SplatRenderer | undefined>();

  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);

      // トピック一覧を更新
      if (renderState.topics) {
        setAvailableTopics(renderState.topics);
      }

      // topic モードで currentFrame にメッセージがある場合
      if (renderState.currentFrame && renderState.currentFrame.length > 0) {
        const lastMsg = renderState.currentFrame[renderState.currentFrame.length - 1] as
          | MessageEvent<GaussianSplatMsgJson>
          | undefined;
        if (lastMsg?.message) {
          try {
            const decoded = decodeJsonMsg(lastMsg.message);
            setSplatData(decoded);
            setStatus(`Topic: ${decoded.count.toLocaleString()} splats`);
          } catch (e) {
            console.error("[GS Viewer] Decode error:", e);
          }
        }
      }
    };

    context.watch("topics");
    context.watch("currentFrame");
  }, [context]);

  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  // topic 選択が変わったら購読
  useEffect(() => {
    if (inputMode === "topic" && selectedTopic) {
      context.subscribe([{ topic: selectedTopic }]);
      setStatus(`Subscribed: ${selectedTopic}`);
    }
  }, [context, inputMode, selectedTopic]);

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
    setInputMode("ply");
    setStatus(`Loading ${file.name}...`);
    try {
      const buffer = await file.arrayBuffer();
      const msg = parsePly(buffer);
      setSplatData(msg);
      setStatus(`PLY: ${msg.count.toLocaleString()} splats`);
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

  // GS スキーマに一致する topic をフィルタ
  const gsTopics = availableTopics.filter(
    (t) => t.schemaName === GAUSSIAN_SPLAT_SCHEMA_NAME,
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
        background: "#000",
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
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            color: "#888",
            fontSize: "1rem",
            gap: 16,
          }}
        >
          <div>{status}</div>
          {gsTopics.length > 0 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select
                value={selectedTopic}
                onChange={(e) => {
                  setSelectedTopic(e.target.value);
                  setInputMode("topic");
                }}
                style={{
                  background: "#333",
                  color: "#fff",
                  border: "1px solid #555",
                  borderRadius: 4,
                  padding: "4px 8px",
                }}
              >
                <option value="">Select topic...</option>
                {gsTopics.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}
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
