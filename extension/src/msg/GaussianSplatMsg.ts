export interface GaussianSplatMsg {
  timestamp: number; // unix epoch (sec)
  frame_id: string; // 座標フレーム名
  count: number; // スプラット数 N

  // 全て Float32Array、変換済みの値を格納
  positions: Float32Array; // [N * 3] xyz
  scales: Float32Array; // [N * 3] exp済み
  rotations: Float32Array; // [N * 4] 正規化済み quaternion
  opacities: Float32Array; // [N]     sigmoid済み [0,1]
  colors: Float32Array; // [N * 3] SH→RGB済み [0,1]
}
