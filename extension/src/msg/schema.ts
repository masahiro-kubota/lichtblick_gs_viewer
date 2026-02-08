/** GaussianSplatMsg の JSON Schema 名（MCAP / Foxglove で使用） */
export const GAUSSIAN_SPLAT_SCHEMA_NAME = "gs_debug_viewer/GaussianSplatMsg";

/**
 * JSON Schema 定義。
 * MCAP に記録する際のスキーマとして使用。
 * バイナリデータは base64 エンコードされた文字列として格納する。
 */
export const GAUSSIAN_SPLAT_JSON_SCHEMA = {
  type: "object",
  properties: {
    timestamp: { type: "number" },
    frame_id: { type: "string" },
    count: { type: "integer" },
    // Float32Array は base64 文字列として格納
    positions_b64: { type: "string" },
    scales_b64: { type: "string" },
    rotations_b64: { type: "string" },
    opacities_b64: { type: "string" },
    colors_b64: { type: "string" },
  },
  required: ["timestamp", "frame_id", "count", "positions_b64", "scales_b64", "rotations_b64", "opacities_b64", "colors_b64"],
} as const;

/** MCAP 上の JSON メッセージ型 */
export interface GaussianSplatMsgJson {
  timestamp: number;
  frame_id: string;
  count: number;
  positions_b64: string;
  scales_b64: string;
  rotations_b64: string;
  opacities_b64: string;
  colors_b64: string;
}
