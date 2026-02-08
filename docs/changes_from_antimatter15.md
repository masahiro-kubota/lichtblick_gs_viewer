# antimatter15/splat からの変更点

本プロジェクトの Lv3 レンダラ (`SplatRenderer.ts`) は [antimatter15/splat](https://github.com/antimatter15/splat) (MIT License) をベースに実装している。以下に主要な変更点をまとめる。

---

## 1. アーキテクチャ

| 項目 | antimatter15/splat | 本プロジェクト |
|---|---|---|
| エントリ | 単体 `main.js` (~800行) | `SplatRenderer.ts` クラス + inline Worker |
| データ入力 | `.splat` ファイル (fetch) | `GaussianSplatMsg` (PLY パーサ or topic 経由) |
| フレームワーク | Vanilla JS | React + Foxglove Extension API |
| Worker 読み込み | 別ファイル (`worker.js` 想定) | Blob URL でインライン化 (`createWorkerCode()`) |

## 2. データフロー

```
antimatter15:  .splat file → fetch → ArrayBuffer → Worker → texture + sort
本プロジェクト: GaussianSplatMsg → 32-byte pack → Worker → RGBA32UI texture + depthIndex
```

- `setData()` で `GaussianSplatMsg` の各フィールド (positions, scales, rotations, opacities, colors) を 32 bytes/splat にパッキング
- antimatter15 は `.splat` ファイルがそのまま 32-byte フォーマット

## 3. 座標系・射影行列

### 3.1 View 行列

antimatter15 の `getViewMatrix()` (main.js L171-185) はカメラの回転行列を転置して格納する独自形式。本プロジェクトでは標準的な `lookAt` 関数を使用し、**Y 行と Z 行を反転**して antimatter15/COLMAP 座標系に合わせている。

```typescript
// lookAt の出力: rows = (right, up, -forward)  [OpenGL 標準]
// 反転後:         rows = (right, -up, forward)  [COLMAP 系]
const viewMat = this.camera.getViewMatrix();
// Flip Y row
viewMat[1]  = -viewMat[1];   viewMat[5]  = -viewMat[5];
viewMat[9]  = -viewMat[9];   viewMat[13] = -viewMat[13];
// Flip Z row
viewMat[2]  = -viewMat[2];   viewMat[6]  = -viewMat[6];
viewMat[10] = -viewMat[10];  viewMat[14] = -viewMat[14];
```

### 3.2 Projection 行列

| 成分 | antimatter15 | 本プロジェクト | 理由 |
|---|---|---|---|
| X | `+(2*fx)/w` | `-(2*fx)/w` | View の Y+Z flip による左右反転を補正 |
| Y | `-(2*fy)/h` | `+(2*fy)/h` | View の Y flip による上下反転を補正 |
| Z clip | `zfar/(zfar-znear)` | 同じ | 正 Z クリップ空間 |

antimatter15 では View 行列が既に COLMAP 座標系なので projection にそのまま正の X、負の Y を使う。本プロジェクトでは lookAt → Y+Z flip で変換するため、projection の符号が逆転する。

## 4. WebGL コンテキスト

| 項目 | antimatter15 | 本プロジェクト |
|---|---|---|
| alpha チャネル | 指定なし (デフォルト `true`) | 明示的に `alpha: true` 相当（`alpha: false` を削除） |
| clearColor | 指定なし (デフォルト 0,0,0,0) | `gl.clearColor(0, 0, 0, 0)` |

**重要**: `alpha: false` だとフレームバッファの dst_alpha が常に 1.0 になり、front-to-back under blending (`ONE_MINUS_DST_ALPHA`) で全フラグメントが消える。

## 5. ブレンディング

両者とも同一の front-to-back under blending:

```
blendFuncSeparate(ONE_MINUS_DST_ALPHA, ONE, ONE_MINUS_DST_ALPHA, ONE)
```

深度テスト無効、ソート済みインデックスで前→後の順に描画。

## 6. シェーダ

頂点シェーダ・フラグメントシェーダは antimatter15/splat main.js L655-732 をほぼそのまま移植。変更点:

- **Jacobian の `focal.y`**: antimatter15 は `focal.y / cam.z` (正)。本プロジェクトも同じ（`-focal.y` は不要、View の Y flip で既に符号が合っている）
- **`transpose(mat3(view))`**: antimatter15 の view 行列は R^T 格納のため transpose で R に戻す。本プロジェクトは lookAt + Y/Z flip で同等の mat3 になるので、同じ transpose を維持

## 7. Worker (ソート + テクスチャ生成)

Worker のロジックは antimatter15 をほぼそのまま移植:

- `generateTexture()`: 32-byte packed buffer → RGBA32UI テクスチャ (2048幅)
- `runSort()`: 16-bit counting sort (depth ベース)
- **スロットリング**: 視点方向の変化が小さい場合ソートをスキップ (`dot > 0.99`)
- antimatter15 にはない `try/catch` でエラーハンドリングを追加

## 8. PLY パーサ (antimatter15 にはない機能)

antimatter15 は `.splat` 専用フォーマットのみ対応。本プロジェクトでは:

- `plyParser.ts`: 3DGS 標準の PLY (binary_little_endian, 62 properties) を直接パース
- SH DC → RGB、sigmoid、exp scale、quaternion 正規化をパース時に実行
- COLMAP 座標系をそのまま使用（Y/Z 反転はレンダラ側の View 行列で処理）

## 9. カメラ

| 項目 | antimatter15 | 本プロジェクト |
|---|---|---|
| 実装 | カスタム (main.js L110-200) | `OrbitCamera` クラス |
| 操作 | マウスドラッグ + ホイール | 同左 + 右クリック/中クリックパン |
| 座標系 | 独自 (R^T 格納) | 標準 lookAt (column-major) |
| auto-fit | なし | 点群の重心+最大距離から自動設定 |
