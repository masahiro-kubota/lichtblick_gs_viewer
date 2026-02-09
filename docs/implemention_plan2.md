# WebGPU 移行計画: 3DGS Viewer 品質改善

## 前提

- **現状**: antimatter15/splat ベースの WebGL2 Lv3 レンダラが動作中
  - Instanced quad + front-to-back under blending
  - CPU counting sort (Web Worker)
  - SH DC のみ（f_rest 未使用）
- **環境**: Lichtblick (Electron 39 / Chromium 142)、iGPU (Intel UHD 770 想定)
- **ベースコード**: `extension/src/renderer/SplatRenderer.ts`

---

## 0. ゴール定義

| 優先度 | KPI | 説明 |
|--------|-----|------|
| 1 | にじみ/濁りの低減 | alpha 合成の破綻・順序近似の副作用を抑える |
| 2 | floaters の抑制 | 寄与の小さいガウスを描画しない |
| 3 | 視点依存の質感 | SH higher order で view-dependent color を反映 |
| 4 | 操作可能な FPS | iGPU で 30fps 安定、理想 60fps |

## 1. 非ゴール

- 数千万ガウス（都市スケール）の直接描画
- 毎フレーム全ガウス完全深度ソート
- 物理的に正確な透過（厳密な OIT）
- タイルベースラスタライザの完全実装（実装コストに対して効果が見合わない）

---

## 2. WebGPU 利用可否

### Electron 39 (Chromium 142) の WebGPU サポート

| プラットフォーム | 状態 | 必要フラグ |
|-----------------|------|-----------|
| Windows (x64) | デフォルト有効 | なし |
| macOS | デフォルト有効 | なし |
| Linux | 要フラグ | `--enable-unsafe-webgpu`, `--enable-features=Vulkan` |

**Linux の場合**: Lichtblick の起動オプションにフラグを追加するか、Electron main process で `app.commandLine.appendSwitch()` が必要。Extension 単体では制御不可のため、**WebGL フォールバックを維持する**。

### iGPU 制約 (Intel UHD 770)

| 項目 | 値 |
|------|-----|
| Execution Units | 32 |
| FP32 性能 | ~0.8 TFLOPS |
| メモリ帯域 (DDR4-3200) | ~51.2 GB/s |
| WebGPU maxStorageBufferBindingSize | 128 MiB |
| WebGPU maxComputeWorkgroupStorageSize | 16 KiB |

比較: RTX 3060 = 360 GB/s、メモリ帯域は専用 GPU の 1/7。
GPU Radix Sort ベンチマーク (参考: wgpu_sort):
- Intel HD 4600: 1M 要素 = 38.74ms
- RTX A5000: 1M 要素 = 0.317ms

---

## 3. アーキテクチャ方針

### 採用: ハイブリッドアプローチ

**Compute shader で前処理 + Instanced quad で描画**（タイルベースラスタライザは実装しない）

```
[GPU Compute]                    [GPU Render]
Splat Data → カリング → Depth計算 → Radix Sort → Instanced Quad Draw
              ↓                                    ↑
         visibility buffer                   sorted index buffer
```

根拠:
- タイルベースは原論文 CUDA 実装の WebGPU 再実装に等しく、実装コストが非常に高い
- Instanced quad + GPU sort でも十分な品質改善が得られる（cvlab-epfl, Visionary が実証）
- 現在の WebGL 版のシェーダ資産を WGSL に移植するだけで済む

### 参考実装

| プロジェクト | アプローチ | ソート | 性能 |
|-------------|-----------|--------|------|
| [Scthe/gaussian-splatting-webgpu](https://github.com/Scthe/gaussian-splatting-webgpu) | Instanced quad + Compute | GPU Bitonic Sort | 教育目的、実装が明快 |
| [kishimisu/WebGPU-Radix-Sort](https://github.com/kishimisu/WebGPU-Radix-Sort) | ソートライブラリ | 4-way Radix Sort | JS/WGSL、組み込み容易 |
| [cvlab-epfl/gaussian-splatting-web](https://github.com/cvlab-epfl/gaussian-splatting-web) | ラスタライゼーション | CPU | SH 可変 degree 対応 |
| [mkkellogg/GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D) | Three.js instancing | WASM Counting Sort | SH degree 0-2 対応 |

---

## 4. 実装フェーズ

### Phase 1: WebGPU MVP — 同じ見た目を WebGPU で再現

**目的**: WebGPU パイプラインを安定稼働させる（性能は二の次）

実装内容:
- `SplatRendererGPU.ts` を新規作成（WebGL 版は `SplatRenderer.ts` として残す）
- WebGPU device 取得 + フォールバック判定
- WGSL 頂点/フラグメントシェーダに移植
- CPU sorting は Worker をそのまま流用
- GaussianSplatPanel で WebGPU/WebGL を自動切替

Done 条件:
- [x] WebGPU 版で同一 PLY が表示できる
- [x] WebGPU 非対応環境で WebGL にフォールバックする
- [x] カメラ操作・リサイズが安定

### Phase 2-A: GPU カリング

**目的**: floaters を GPU 側で除外して描画数を減らす

Compute shader で各ガウスに対して:
- 視錐台外 → drop
- `opacity < alpha_min` → drop
- projected radius が閾値以下 → drop
- importance (alpha x 投影面積) 下位 → drop

UI:
- alpha 閾値スライダ
- importance cutoff スライダ
- 描画数/カリング数の表示

Done 条件:
- [ ] カリング有効時に floaters が目に見えて減る
- [ ] 描画 splat 数がリアルタイム表示される

### Phase 2-B: GPU Radix Sort

**目的**: CPU Worker ソートを GPU Compute に置き換え、毎フレーム正確なソートを実現

実装方針:
- [kishimisu/WebGPU-Radix-Sort](https://github.com/kishimisu/WebGPU-Radix-Sort) を参考に 4-way Radix Sort を WGSL で実装
- depth 計算 → 整数量子化 → Radix Sort → sorted index buffer

注意点:
- WebGPU は subgroup operations 未サポート → shared memory でエミュレーション
- iGPU では 74 万 splats のソートに ~30ms 以上かかる可能性（毎フレームは断念、視点変化時のみ）
- CPU Worker sorting をフォールバックとして残す

Done 条件:
- [ ] GPU sort が CPU sort と同じ結果を返す
- [ ] カメラ高速移動時のアーティファクトが軽減される

### Phase 3: SH Higher Order（任意）

**目的**: view-dependent color で「ベタ塗り感」を解消

実装方針:
- PLY パーサを拡張して `f_rest_0` ~ `f_rest_8` (SH degree 1) を読み込み
- GaussianSplatMsg に `sh_coeffs: Float32Array` フィールド追加
- 頂点シェーダで view direction から SH 評価

メモリ見積り (74 万 splats):
- DC のみ (現状): 3 float = 12 bytes → ~8.5 MB
- +Degree 1: +9 float = 36 bytes → ~25.5 MB 追加
- +Degree 2: +15 float = 60 bytes → ~42.4 MB 追加
- +Degree 3: +21 float = 84 bytes → ~59.3 MB 追加 (合計 ~127 MB)

→ iGPU の VRAM 共有を考慮し、**degree 1 (9 追加 float) から開始**

Done 条件:
- [ ] 視点を変えるとハイライト/質感が変化する
- [ ] DC のみの表示と切り替え可能

### Phase 4: 追加最適化（任意）

- FPS / frame time 表示 UI
- LOD (距離に応じたスプラット間引き)
- マルチフレームでのソート再利用
- プログレッシブローディング

---

## 5. ファイル構成（Phase 1 完了時）

```
extension/src/renderer/
├── SplatRenderer.ts        # WebGL2 版（既存、フォールバック）
├── SplatRendererGPU.ts     # WebGPU 版（新規）
├── shaders/
│   ├── splat.wgsl          # 頂点 + フラグメント
│   └── sort.wgsl           # Radix sort compute (Phase 2-B)
├── camera.ts               # 共通（変更なし）
└── gpu-utils.ts            # WebGPU ユーティリティ
```

---

## 6. 性能目標

| 条件 | 目標 FPS | 備考 |
|------|----------|------|
| 74 万 splats, iGPU, 1280x720 | 15-30 | カリングで描画数を減らせば向上 |
| 30 万 splats, iGPU, 1280x720 | 30-60 | カリング後の現実的なターゲット |
| 74 万 splats, dGPU | 60+ | RTX 3060 以上 |
