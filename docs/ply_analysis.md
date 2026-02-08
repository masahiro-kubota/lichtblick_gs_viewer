# PLY 構造解析

## 対象ファイル

`data/point_cloud.ply`

- フォーマット: `binary_little_endian 1.0`
- 頂点数: **741,883**
- 1頂点あたり: 62 properties (全て float32) = **248 bytes**

## プロパティ一覧

| カテゴリ | プロパティ | 個数 | 用途 |
|---|---|---|---|
| Position | `x, y, z` | 3 | 3D座標 |
| Normal | `nx, ny, nz` | 3 | 法線（レンダには不要） |
| SH DC | `f_dc_0, f_dc_1, f_dc_2` | 3 | 0次球面調和 = RGB相当 |
| SH Rest | `f_rest_0` ~ `f_rest_44` | 45 | 高次SH（3色 × 15係数、degree 3） |
| Opacity | `opacity` | 1 | 不透明度（logit値） |
| Scale | `scale_0, scale_1, scale_2` | 3 | 3軸スケール（log値） |
| Rotation | `rot_0, rot_1, rot_2, rot_3` | 4 | 四元数 |

## Lv判定

- **Lv3（異方性楕円スプラット）: 可能** — scale 3軸 + quaternion が揃っている
- **SH degree 3 まで格納済み** — v0 では使わない

## PLY → msg v0 変換時の注意

PLY の生値はそのまま使えない。3DGS の学習パラメータ空間で格納されている：

| 項目 | PLY内の値 | 変換 | msg v0 での値 |
|---|---|---|---|
| color | `f_dc_0/1/2` | `RGB = 0.5 + C0 * f_dc` (C0 = 0.28209479) | [0, 1] の RGB |
| opacity | `opacity` | `sigmoid(opacity)` | [0, 1] の不透明度 |
| scale | `scale_0/1/2` | `exp(scale)` | 正のスケール値 |
| rotation | `rot_0/1/2/3` | `normalize(quat)` | 単位四元数 |
| position | `x, y, z` | そのまま | ワールド座標 |
