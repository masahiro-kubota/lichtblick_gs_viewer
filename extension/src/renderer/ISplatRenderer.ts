import { GaussianSplatMsg } from "../msg/GaussianSplatMsg";

export interface CullParams {
  /** Minimum opacity [0..255]. Splats below this are culled from sort & draw. */
  alphaMin: number;
}

export interface RenderStats {
  totalCount: number;
  visibleCount: number;
}

export interface ISplatRenderer {
  setData(msg: GaussianSplatMsg): void;
  setCullParams(params: CullParams): void;
  startLoop(): void;
  stopLoop(): void;
  dispose(): void;
  onStatsUpdate: ((stats: RenderStats) => void) | null;
}
