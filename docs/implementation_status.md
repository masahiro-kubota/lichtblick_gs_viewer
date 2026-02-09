# 実装状況と方針

## 完了済み

### Phase 1: WebGPU MVP
- `SplatRendererGPU.ts` — WGSL シェーダで WebGL 版と同一描画
- `ISplatRenderer.ts` — WebGL/WebGPU 共通インターフェース
- `workerCode.ts` — Worker コード共有（テクスチャ生成 + CPU ソート）
- `GaussianSplatPanel.tsx` — WebGPU/WebGL 自動切替 + バックエンド表示
- Linux は WebGPU フラグ必須のため `[WebGL]` フォールバックで動作確認済み

### Phase 2-A: カリング
- Worker 側アルファカリング（`runSort` で `alphaMin` 未満を除外）
- ソート対象を実際に減らすため描画数も削減
- UI: Alpha スライダー (1-255) + 描画数/総数の統計表示
- WebGL / WebGPU 両対応

## 現在のアーキテクチャ

```
setData(GaussianSplatMsg)
  → 32-byte pack → Worker (transferable)
  → Worker: generateTexture() → texdata → GPU texture (RGBA32UI)
  → Worker: runSort(viewProj, alphaMin) → depthIndex → GPU vertex buffer
  → Draw: instanced quad (4頂点 × visibleCount インスタンス)
```

ソートは CPU Worker 上の counting sort（O(N)、65536 バケット）。
視点変化が小さい場合はスキップ（dot product 閾値 0.01）。

## Phase 2-B: GPU Radix Sort — 方針

### 目的
CPU Worker ソートを GPU Compute に置き換え、CPU-GPU 転送を排除する。

### 採用ライブラリ
**webgpu-radix-sort** (npm, MIT, kishimisu)
- 4-way parallel radix sort（2ビット/パス × 16パス = 32bit ソート）
- 各パス: radix_sort → prefix_sum (再帰) → reorder
- 全パスが 1 computePass 内で完結
- バッファ要件: ~20N bytes（74万 splats → ~14 MB）

### 統合フロー（WebGPU 専用、WebGL は現行のまま）

```
setData()
  → Worker: generateTexture() → texdata → GPU texture（変更なし）
  → Worker: ソート不要になる（テクスチャ生成のみ）

drawFrame()
  → Compute Pass:
      1. calcDepths: texture から position 読み取り → viewProj で depth 計算 → keys[] + values[]
      2. RadixSortKernel.dispatch(): keys/values をソート
  → Render Pass:
      sorted values buffer を頂点バッファとして直接使用
      drawIndirect で visibleCount を GPU 側で制御
```

### 具体的な実装タスク

1. **深度計算 compute shader** (`calcDepths.wgsl`)
   - texture_2d<u32> から position を読み取り
   - `depth = viewProj[2] * pos` → `floatFlip(bitcast<u32>(depth))` で sortable u32 に変換
   - カリング: `alpha < alphaMin` → `key = 0xFFFFFFFF`（末尾にソート）
   - atomicAdd で visibleCount → indirect draw buffer に書き込み

2. **RadixSortKernel 統合**
   - keys/values バッファを `STORAGE | VERTEX` で作成
   - `new RadixSortKernel({ device, keys, values, count, bit_count: 32 })`
   - `kernel.dispatch(computePass)` で 1 回呼ぶだけ

3. **drawIndirect 化**
   - indirect buffer: `[vertexCount=4, instanceCount, firstVertex=0, firstInstance=0]`
   - calcDepths で instanceCount を atomic に積算
   - `passEncoder.drawIndirect(indirectBuffer, 0)`

4. **Stats 表示**
   - indirect buffer の instanceCount を async readback → `onStatsUpdate`

5. **フォールバック**
   - WebGL: 現行の Worker ソートをそのまま維持
   - WebGPU で GPU sort 失敗時: Worker ソートにフォールバック

### ファイル構成

```
extension/src/renderer/
├── SplatRenderer.ts        # WebGL2（変更なし）
├── SplatRendererGPU.ts     # WebGPU（GPU sort 統合）
├── ISplatRenderer.ts       # 共通インターフェース
├── workerCode.ts           # Worker（テクスチャ生成のみに縮小）
└── gpuSort.ts              # calcDepths shader + RadixSortKernel wrapper
```

### 懸念事項

| 項目 | 対策 |
|------|------|
| iGPU で GPU sort が遅い (~30ms/1M) | 視点変化時のみソート、毎フレームは行わない |
| webgpu-radix-sort に型定義がない | `@ts-ignore` or 自前 .d.ts |
| bit_count=32 で 16 パスは多い | 16bit に量子化すれば 8 パスに削減可能 |
| WebGPU 非対応環境 | Worker ソート (Phase 2-A) がそのまま動く |
