# Lv3 実装方針: antimatter15/splat ベース移植

> **リファレンス**: [antimatter15/splat](https://github.com/antimatter15/splat) (MIT, 2.9k stars)
> `splat/main.js` を本プロジェクトの Foxglove Extension に移植する。

---

## 0. 方針転換

前回の計画（2A: GPU側で全計算、既存バッファ構成を維持）を**破棄**し、
**antimatter15/splat のアーキテクチャをそのまま採用**する。

| 項目 | 旧計画 (2A) | 新計画: antimatter15 移植 |
|------|-----------|-------------------------|
| データ構造 | 属性バッファ × 6 | **RGBA32UI テクスチャ 1枚** |
| 共分散計算 | GPU (頂点シェーダー) | **CPU (Web Worker)** |
| ソート | メインスレッド Array.sort | **Web Worker + 16-bit Radix Sort** |
| ソート結果 | 全配列を再構築 + 再アップロード | **インデックスバッファのみ更新** |
| ブレンド | back-to-front (ONE, ONE_MINUS_SRC_ALPHA) | **front-to-back under blending** |
| クワッド範囲 | [-1, 1] | **[-2, 2]** |

**理由**: ブラウザで 74万スプラットが快適に動作する実績ある設計をそのまま使うのが最短。

---

## 1. antimatter15/splat アーキテクチャ概要

```
main.js L298-653: Web Worker
├── processPlyBuffer()     PLY → 32byte packed buffer
│   ├── importance sort (size × opacity, 降順)
│   ├── quaternion → uint8 (±128 にマップ)
│   └── scale → exp(log_scale) (float32)
│
├── generateTexture()      packed buffer → RGBA32UI テクスチャ
│   ├── texel[2i+0]: position(xyz float32) + rgba(uint8)
│   └── texel[2i+1]: 3D共分散 6成分 (half-float packed)
│       ├── quaternion → 回転行列 R
│       ├── M = R × diag(scale)        ... .map((k,i) => k * scale[floor(i/3)])
│       ├── Σ = M^T × M                ... sigma[6]
│       └── packHalf2x16(4 * sigma)    ... 係数 4 で拡大
│
└── runSort()              16-bit Radix Sort (counting sort)
    ├── depth = viewProj[2]*x + viewProj[6]*y + viewProj[10]*z
    ├── 量子化 [0, 65535]
    └── → depthIndex (Uint32Array)

main.js L655-732: シェーダー
├── vertex: テクスチャから position + cov3d を fetch
│   ├── J (ヤコビアン) × V^T (view回転) → 2D共分散
│   ├── 固有値分解 → majorAxis, minorAxis
│   └── quad を楕円軸に沿って配置
│
└── fragment: exp(-dot(vPos, vPos)) ... 2σ で discard

main.js L807-817: ブレンド設定
└── front-to-back under blending
    gl.blendFuncSeparate(ONE_MINUS_DST_ALPHA, ONE, ONE_MINUS_DST_ALPHA, ONE)
```

---

## 2. 移植対象の詳細マッピング

### 2-1. データパイプライン (Worker)

**元コード**: `main.js` L298-653 (`createWorker` 関数内)

| 関数 | 行 | 移植先 | 備考 |
|------|-----|--------|------|
| `processPlyBuffer()` | L474-618 | 不要（既存 `plyParser.ts` で代替） | ただし packed buffer 形式への変換は必要 |
| `generateTexture()` | L348-417 | **`sortWorker.ts`** (新規) | **核心**: 3D共分散をCPUで計算 |
| `runSort()` | L420-471 | **`sortWorker.ts`** (新規) | 16-bit radix sort |
| `floatToHalf()` / `packHalf2x16()` | L315-346 | **`sortWorker.ts`** (新規) | そのまま移植 |

#### generateTexture() の移植ポイント (`main.js` L348-417)

```
入力: packed buffer (32 bytes/splat)
  [x,y,z](f32×3) [sx,sy,sz](f32×3) [r,g,b,a](u8×4) [qi,qj,qk,ql](u8×4)

出力: texdata (Uint32Array, RGBA32UI)
  texel[2i+0].xyz = position (as uint32 bitcast from float32)
  texel[2i+0].w   = unused (padding)
  texel[2i+1].x   = packHalf2x16(4*σ00, 4*σ01)   ← 注意: × 4 !!
  texel[2i+1].y   = packHalf2x16(4*σ02, 4*σ11)
  texel[2i+1].z   = packHalf2x16(4*σ12, 4*σ22)
  texel[2i+1].w   = RGBA (packed as uint32)
```

**共分散の計算** (`main.js` L376-414):
```javascript
// quaternion: uint8 → [-1, 1]
let rot = [(u_buffer[28+0]-128)/128, (u_buffer[28+1]-128)/128, ...]
// rot[0]=w, rot[1]=x, rot[2]=y, rot[3]=z

// M = diag(scale) × R   (行ごとにスケール: .map((k,i)=>k*scale[floor(i/3)]))
const M = [
  1 - 2*(rot[2]²+rot[3]²),  2*(rot[1]*rot[2]+rot[0]*rot[3]),  2*(rot[1]*rot[3]-rot[0]*rot[2]),
  2*(rot[1]*rot[2]-rot[0]*rot[3]),  1-2*(rot[1]²+rot[3]²),     2*(rot[2]*rot[3]+rot[0]*rot[1]),
  2*(rot[1]*rot[3]+rot[0]*rot[2]),  2*(rot[2]*rot[3]-rot[0]*rot[1]),  1-2*(rot[1]²+rot[2]²)
].map((k, i) => k * scale[Math.floor(i / 3)]);

// Σ = M^T × M  (6 unique components of symmetric matrix)
const sigma = [
  M[0]*M[0]+M[3]*M[3]+M[6]*M[6],  // σ00
  M[0]*M[1]+M[3]*M[4]+M[6]*M[7],  // σ01
  M[0]*M[2]+M[3]*M[5]+M[6]*M[8],  // σ02
  M[1]*M[1]+M[4]*M[4]+M[7]*M[7],  // σ11
  M[1]*M[2]+M[4]*M[5]+M[7]*M[8],  // σ12
  M[2]*M[2]+M[5]*M[5]+M[8]*M[8],  // σ22
];
```

#### runSort() の移植ポイント (`main.js` L420-471)

```javascript
// 深度計算: viewProj行列の第3行（Z）でドット積
depth = (viewProj[2]*x + viewProj[6]*y + viewProj[10]*z) * 4096 | 0

// 16-bit counting sort
depthInv = 65535 / (maxDepth - minDepth)
counts[65536] → starts[65536] → depthIndex[N]
```

**スロットリング** (`main.js` L420-433):
```javascript
// 視線方向の dot product で変化判定
let dot = lastProj[2]*viewProj[2] + lastProj[6]*viewProj[6] + lastProj[10]*viewProj[10];
if (Math.abs(dot - 1) < 0.01) return;  // ほぼ同じ方向なら再ソートしない
```

### 2-2. 頂点シェーダー

**元コード**: `main.js` L655-714

移植時の注意点:

```glsl
// ---- テクスチャフェッチ (main.js L672-683) ----
// テクスチャ幅 2048px、各スプラットが2テクセル占有
uvec4 cen = texelFetch(u_texture, ivec2((uint(index) & 0x3ffu) << 1, uint(index) >> 10), 0);
uvec4 cov = texelFetch(u_texture, ivec2(((uint(index) & 0x3ffu) << 1) | 1u, uint(index) >> 10), 0);

// ---- 3D共分散の復元 (main.js L683-684) ----
vec2 u1 = unpackHalf2x16(cov.x);  // (σ00, σ01) × 4
vec2 u2 = unpackHalf2x16(cov.y);  // (σ02, σ11) × 4
vec2 u3 = unpackHalf2x16(cov.z);  // (σ12, σ22) × 4
mat3 Vrk = mat3(u1.x, u1.y, u2.x,
                u1.y, u2.y, u3.x,
                u2.x, u3.x, u3.y);

// ---- ヤコビアン (main.js L686-690) ----
// ⚠ focal.y の符号が負（Y軸反転のため）
// ⚠ cam.y の項の符号が正（Y反転と打ち消し合う）
mat3 J = mat3(
    focal.x / cam.z,  0.,                -(focal.x * cam.x) / (cam.z * cam.z),
    0.,                -focal.y / cam.z,   (focal.y * cam.y) / (cam.z * cam.z),
    0.,                0.,                 0.
);

// ---- 2D共分散射影 (main.js L692-693) ----
// T = transpose(mat3(view)) * J    ← view は列優先なので transpose で行優先に
mat3 T = transpose(mat3(view)) * J;
mat3 cov2d = transpose(T) * Vrk * T;

// ---- 固有値分解 (main.js L695-702) ----
float mid = (cov2d[0][0] + cov2d[1][1]) / 2.0;
float radius = length(vec2((cov2d[0][0] - cov2d[1][1]) / 2.0, cov2d[0][1]));
float lambda1 = mid + radius;
float lambda2 = mid - radius;
if (lambda2 < 0.0) return;

vec2 diagonalVector = normalize(vec2(cov2d[0][1], lambda1 - cov2d[0][0]));
vec2 majorAxis = min(sqrt(2.0 * lambda1), 1024.0) * diagonalVector;
vec2 minorAxis = min(sqrt(2.0 * lambda2), 1024.0) * vec2(diagonalVector.y, -diagonalVector.x);

// ---- クワッド配置 (main.js L704-711) ----
// color は cov.w から RGBA uint8 を抽出
// depth fog: clamp(pos2d.z / pos2d.w + 1.0, 0, 1) で奥をフェードアウト
vColor = clamp(pos2d.z/pos2d.w+1.0, 0.0, 1.0)
       * vec4((cov.w) & 0xffu, (cov.w>>8) & 0xffu, (cov.w>>16) & 0xffu, (cov.w>>24) & 0xffu) / 255.0;

vec2 vCenter = vec2(pos2d) / pos2d.w;
gl_Position = vec4(
    vCenter
    + position.x * majorAxis / viewport    // ← quad range [-2, 2]
    + position.y * minorAxis / viewport,
    0.0, 1.0);
```

### 2-3. フラグメントシェーダー

**元コード**: `main.js` L716-732 — **そのまま移植**

```glsl
#version 300 es
precision highp float;

in vec4 vColor;
in vec2 vPosition;
out vec4 fragColor;

void main () {
    float A = -dot(vPosition, vPosition);
    if (A < -4.0) discard;
    float B = exp(A) * vColor.a;
    fragColor = vec4(B * vColor.rgb, B);
}
```

### 2-4. GL 設定

**元コード**: `main.js` L807-817

```javascript
gl.disable(gl.DEPTH_TEST);

gl.enable(gl.BLEND);
gl.blendFuncSeparate(
    gl.ONE_MINUS_DST_ALPHA, gl.ONE,           // srcRGB, dstRGB
    gl.ONE_MINUS_DST_ALPHA, gl.ONE            // srcAlpha, dstAlpha
);
gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
```

**front-to-back under blending**:
- 手前から描画するため、すでに不透明な領域には書き込まない
- `src × (1 - dst_alpha) + dst × 1` = 背景に重ねていく

### 2-5. 描画コール

**元コード**: `main.js` L825, L1362

```javascript
// クワッド頂点: TRIANGLE_FAN で 4頂点
const triangleVertices = new Float32Array([-2, -2, 2, -2, 2, 2, -2, 2]);

// インデックスバッファ: ソート済みインデックス (per-instance)
// vertexAttribIPointer + divisor=1

// 描画
gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, vertexCount);
```

### 2-6. インデックスベースソート結果の適用

**元コード**: `main.js` L840-845, L912-916

```javascript
// Setup: index attribute (integer, per-instance)
const a_index = gl.getAttribLocation(program, "index");
gl.enableVertexAttribArray(a_index);
gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffer);
gl.vertexAttribIPointer(a_index, 1, gl.INT, false, 0, 0);  // ← IPointer (integer)
gl.vertexAttribDivisor(a_index, 1);

// On sort complete: インデックスバッファだけ更新
gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffer);
gl.bufferData(gl.ARRAY_BUFFER, depthIndex, gl.DYNAMIC_DRAW);
```

**重要**: データ本体（テクスチャ）は更新不要。ソート結果のインデックス配列（N×4 bytes）だけを毎回アップロード。

---

## 3. 既存コードとの接続

### 3-1. データフロー変更

```
【現在】
PLY → plyParser.ts → GaussianSplatMsg{positions,colors,...}
  → SplatRenderer.setData() → 独立バッファ × 5 → インスタンス描画

【移植後】
PLY → plyParser.ts → GaussianSplatMsg{positions,colors,scales,rotations,opacities}
  → SplatRenderer.setData()
    → packed buffer (32 bytes/splat) に変換
    → Web Worker に送信
    → Worker: generateTexture() → RGBA32UI テクスチャ
    → Worker: runSort() → depthIndex
  → GPU: テクスチャ + インデックスバッファ → インスタンス描画
```

### 3-2. GaussianSplatMsg → packed buffer 変換

Worker に送る前に `GaussianSplatMsg` → antimatter15 の 32-byte packed format に変換:

```typescript
function packSplatData(msg: GaussianSplatMsg): ArrayBuffer {
  const buffer = new ArrayBuffer(32 * msg.count);
  const f = new Float32Array(buffer);
  const u = new Uint8Array(buffer);

  for (let i = 0; i < msg.count; i++) {
    // positions: float32 × 3
    f[8*i+0] = msg.positions[3*i+0];
    f[8*i+1] = msg.positions[3*i+1];
    f[8*i+2] = msg.positions[3*i+2];
    // scales: float32 × 3 (既に exp 済み)
    f[8*i+3] = msg.scales[3*i+0];
    f[8*i+4] = msg.scales[3*i+1];
    f[8*i+5] = msg.scales[3*i+2];
    // RGBA: uint8 × 4
    u[32*i+24] = Math.round(msg.colors[3*i+0] * 255);
    u[32*i+25] = Math.round(msg.colors[3*i+1] * 255);
    u[32*i+26] = Math.round(msg.colors[3*i+2] * 255);
    u[32*i+27] = Math.round(msg.opacities[i] * 255);
    // quaternion: float → uint8 ([-1,1] → [0,255])
    u[32*i+28] = Math.round(msg.rotations[4*i+0] * 128 + 128);
    u[32*i+29] = Math.round(msg.rotations[4*i+1] * 128 + 128);
    u[32*i+30] = Math.round(msg.rotations[4*i+2] * 128 + 128);
    u[32*i+31] = Math.round(msg.rotations[4*i+3] * 128 + 128);
  }
  return buffer;
}
```

### 3-3. Lv0〜Lv2 の扱い

既存の Lv0（点群）/ Lv1（ビルボード）/ Lv2（ソート付きビルボード）は**そのまま残す**。
Lv3 は完全に別パスとして実装し、共存させる。

```typescript
export type RenderLevel = 0 | 1 | 2 | 3;

private drawFrame(): void {
  if (this.renderLevel <= 2) {
    // 既存パス（変更なし）
    this.drawLv0/1/2(...);
  } else {
    // Lv3: antimatter15 ベースの新パス
    this.drawLv3(...);
  }
}
```

---

## 4. view 行列の対応

### antimatter15 の view 行列 (`main.js` L171-186)

```javascript
// COLMAP 形式: R は world→camera、t は camera 座標系
// 返す行列は R^T を列優先で格納 → GLSL では R^T として読まれる
function getViewMatrix(camera) {
    const R = camera.rotation.flat();  // row-major
    const t = camera.position;
    const camToWorld = [
        [R[0], R[1], R[2], 0],     // ← R の行が列になる → 結果は R^T
        [R[3], R[4], R[5], 0],
        [R[6], R[7], R[8], 0],
        [-t[0]*R[0]-t[1]*R[3]-t[2]*R[6], ...],
    ].flat();
    return camToWorld;
}
```

### 本プロジェクトの view 行列 (`camera.ts`)

`OrbitCamera.getViewMatrix()` は標準的な `lookAt` 行列を返す。
GLSL で `mat3(view)` を取ると、**world→camera の回転部分**が得られる。

### ヤコビアンの `transpose(mat3(view))` について

antimatter15 のシェーダー:
```glsl
mat3 T = transpose(mat3(view)) * J;
```

antimatter15 の `mat3(view)` は R^T（上記参照）なので、`transpose(R^T)` = R。
→ **T = R × J** (R = world→camera 回転)

本プロジェクトの場合、`mat3(u_view)` は既に R（world→camera）なので:
```glsl
// 本プロジェクトでは transpose 不要
mat3 T = mat3(u_view) * J;
```

**⚠ ここが最大の罠**: view 行列の格納方式が異なるため、`transpose` の有無が変わる。

---

## 5. projection と focal の対応

### antimatter15 の projection (`main.js` L160-168)

```javascript
// COLMAP の intrinsic (fx, fy) をそのまま使用
function getProjectionMatrix(fx, fy, width, height) {
    return [
        [(2*fx)/width, 0, 0, 0],
        [0, -(2*fy)/height, 0, 0],   // ← Y 反転
        [0, 0, zfar/(zfar-znear), 1],
        [0, 0, -(zfar*znear)/(zfar-znear), 0],
    ].flat();
}
// focal uniform にはそのまま fx, fy を渡す
gl.uniform2fv(u_focal, [camera.fx, camera.fy]);
```

### 本プロジェクトの projection (`camera.ts`)

```typescript
// 標準的な perspective projection (fov ベース)
// proj[0] = 1/(aspect*tan(fov/2)), proj[5] = 1/tan(fov/2)
```

focal length への逆算:
```typescript
// proj[0] = 2*fx / width → fx = proj[0] * width / 2
// proj[5] = -(2*fy) / height or 2*fy/height (符号は projection による)
const fx = projMat[0] * canvasWidth / 2;
const fy = Math.abs(projMat[5]) * canvasHeight / 2;
```

**⚠ ヤコビアンの `-focal.y` (`main.js` L688)** は Y 反転 projection に対応。
本プロジェクトの projection が Y を反転しているかどうかで符号を合わせる必要あり。

---

## 6. 変更ファイル一覧

| ファイル | 種別 | 変更内容 |
|---------|------|---------|
| `renderer/SplatRenderer.ts` | 変更 | Lv3 描画パス追加: テクスチャ/インデックスバッファ管理、新シェーダー、Worker通信 |
| `renderer/sortWorker.ts` | **新規** | `main.js` L298-653 を移植: `generateTexture()` + `runSort()` + `packHalf2x16()` |
| `GaussianSplatPanel.tsx` | 変更 | RenderLevel に 3 を追加、UI更新 |
| `renderer/camera.ts` | 確認 | projection/view 行列の符号確認（変更不要の可能性大） |
| `parsers/plyParser.ts` | 変更なし | 既存の出力をそのまま使い、packed buffer への変換は Renderer 側で行う |

---

## 7. 実装順序

```
Phase A: Worker + テクスチャ基盤
├── A-1. sortWorker.ts 作成
│   ├── floatToHalf() / packHalf2x16()    ← main.js L315-346 そのまま
│   ├── generateTexture()                  ← main.js L348-417 移植
│   └── runSort()                          ← main.js L420-471 移植
├── A-2. SplatRenderer にテクスチャ/インデックスバッファ管理を追加
│   ├── RGBA32UI テクスチャ作成             ← main.js L884-911
│   └── index attribute (IPointer+divisor) ← main.js L840-845
└── A-3. Worker 通信 (postMessage/onmessage)
    ├── setData() → packed buffer → Worker
    ├── Worker → texdata → gl.texImage2D
    └── Worker → depthIndex → indexBuffer

Phase B: Lv3 シェーダー + 描画
├── B-1. Lv3 頂点シェーダー               ← main.js L655-714 移植
│   ├── テクスチャフェッチ
│   ├── 3D共分散復元 (unpackHalf2x16)
│   ├── ヤコビアン (符号に注意!)
│   ├── 2D共分散射影
│   ├── 固有値分解 → majorAxis/minorAxis
│   └── クワッド配置
├── B-2. Lv3 フラグメントシェーダー        ← main.js L716-732 そのまま
├── B-3. drawLv3() 実装
│   ├── ブレンド設定 (front-to-back under)
│   ├── TRIANGLE_FAN, 4頂点
│   └── drawArraysInstanced
└── B-4. uniform 追加 (focal, viewport)

Phase C: 統合 + デバッグ
├── C-1. UI に Lv3 ボタン追加
├── C-2. view 行列の transpose 確認・調整
├── C-3. focal length の符号確認・調整
└── C-4. 目視確認: antimatter15/splat と同じ PLY で比較

Phase D: 品質・パフォーマンス
├── D-1. importance sort (初回ロード時)     ← main.js L526-543
├── D-2. ソートスロットリング調整
└── D-3. iGPU パフォーマンス計測
```

---

## 8. 特に注意すべきポイント

### 8-1. 共分散の × 4 係数

`main.js` L412: `packHalf2x16(4 * sigma[0], 4 * sigma[1])`

共分散値を **4倍** してテクスチャに格納している。
eigenvalue 計算時に `sqrt(2.0 * lambda)` と掛け合わせて `sqrt(2*4*σ²) = 2√2 * σ` 。
quad 範囲 [-2, 2] と組み合わせて**最大 4√2 σ** までカバーする設計。

### 8-2. quaternion の uint8 精度

`main.js` L578-581:
```javascript
rot[0] = (attrs.rot_0 / qlen) * 128 + 128;  // float → uint8 (8-bit 精度)
```

正規化済み quaternion を [-1, 1] → [0, 255] にマッピング。
精度は 1/128 ≈ 0.0078 だが、視覚的には十分。

### 8-3. importance sort (初回のみ)

`main.js` L526-543: `size × opacity` の降順でスプラットを並べ替え。
これにより重要なスプラットが先にテクスチャに格納され、
プログレッシブ描画やカリングに有利。

### 8-4. view 行列の `transpose` の罠

| 実装 | `mat3(view)` の意味 | シェーダーで必要な操作 |
|------|---------------------|---------------------|
| antimatter15 | R^T（行列の行と列が入れ替わっている） | `transpose(mat3(view))` = R |
| 本プロジェクト | R（標準 lookAt 行列） | `mat3(u_view)` をそのまま使用 |

間違えると楕円の向きが全て壊れるため、最初にデバッグすべき箇所。
