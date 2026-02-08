# 実装計画: 3DGS Debug Viewer

## ディレクトリ構造

```
gs_debug_viewer/
├── data/
│   └── point_cloud.ply              # サンプル 3DGS PLY
│
├── docs/
│   ├── plan.md                      # プロジェクト計画（背景・目的・全体像）
│   ├── ply_analysis.md              # PLY 構造解析
│   └── implementation_plan.md       # 本ファイル
│
├── extension/                       # Foxglove カスタムパネル Extension
│   ├── package.json
│   ├── tsconfig.json
│   ├── webpack.config.ts
│   └── src/
│       ├── index.ts                 # Extension エントリポイント（registerPanel）
│       ├── GaussianSplatPanel.tsx    # パネル本体（React）
│       ├── renderer/
│       │   ├── SplatRenderer.ts     # WebGL レンダラ（Lv0→Lv3 段階実装）
│       │   ├── shaders/
│       │   │   ├── splat.vert       # 頂点シェーダ
│       │   │   └── splat.frag       # フラグメントシェーダ
│       │   └── camera.ts            # 視点操作（orbit controls）
│       ├── parsers/
│       │   └── plyParser.ts         # PLY バイナリパーサ
│       ├── msg/
│       │   └── GaussianSplatMsg.ts  # msg v0 型定義
│       └── utils/
│           └── activations.ts       # sigmoid, exp, SH→RGB 変換
│
├── tools/                           # オフラインツール
│   ├── ply_to_mcap.py               # PLY → MCAP 変換スクリプト
│   └── requirements.txt
│
└── README.md
```

## 技術スタック

| レイヤー | 技術 | 理由 |
|---|---|---|
| パネルUI | React + TypeScript | Foxglove Extension 標準 |
| レンダリング | WebGL2 (raw) | スプラット描画にカスタムシェーダが必須 |
| PLYパース | 自前 (TypeScript) | binary_little_endian の sequential read |
| msg 定義 | flatbuffers or JSON schema | MCAP 互換 |
| MCAP 変換 | Python (mcap ライブラリ) | 既存エコシステム活用 |
| パッケージ管理 | npm | Foxglove Extension 標準 |

## msg v0 定義

```typescript
interface GaussianSplatMsg {
  timestamp: number;          // unix epoch (sec)
  frame_id: string;           // 座標フレーム名
  count: number;              // スプラット数 N

  // 全て Float32Array、変換済みの値を格納
  positions: Float32Array;    // [N * 3] xyz
  scales: Float32Array;       // [N * 3] exp済み
  rotations: Float32Array;    // [N * 4] 正規化済み quaternion
  opacities: Float32Array;    // [N]     sigmoid済み [0,1]
  colors: Float32Array;       // [N * 3] SH→RGB済み [0,1]
}
```

## 実装ステップ

### Step 1: プロジェクトセットアップ

- [ ] `npm init foxglove-extension@latest` で Extension 雛形作成
- [ ] ディレクトリ構造を整備
- [ ] ビルド → Foxglove で空パネルが表示されることを確認

**到達条件**: Foxglove に "Gaussian Splat Viewer" パネルが出る

---

### Step 2: PLY パーサ実装

- [ ] `plyParser.ts` — ヘッダ解析 + binary_little_endian 読み込み
- [ ] `activations.ts` — sigmoid / exp / SH DC→RGB 変換
- [ ] パース結果をコンソールに出力して検証（頂点数、値域の確認）

**到達条件**: PLY を読み込んで `GaussianSplatMsg` 相当のデータが取れる

---

### Step 3: Lv0 レンダラ — 色付き点群

- [ ] WebGL2 コンテキスト取得 + canvas セットアップ
- [ ] orbit camera 実装（マウスドラッグで回転・ズーム）
- [ ] GL_POINTS で position + color を描画
- [ ] パネル上でファイルドロップ or 埋め込みパスで PLY を読み込み

**到達条件**: Foxglove パネル内で色付き点群が表示され、視点を回せる

---

### Step 4: Lv1 レンダラ — Billboard + ガウス円

- [ ] 点を billboard quad に変更（ジオメトリシェーダ or instancing）
- [ ] フラグメントシェーダでガウス関数（円形）を描画
- [ ] scale の最大値を使って billboard サイズを決定

**到達条件**: 各スプラットが「ぼけた円」として見える

---

### Step 5: Lv2 レンダラ — Opacity + ソート + 合成

- [ ] opacity を反映（アルファブレンディング）
- [ ] 視点からの距離でソート（back-to-front）
- [ ] ブレンディング: `src_alpha, one_minus_src_alpha`

**到達条件**: 半透明の重ね合わせで「面」が見え始める

---

### Step 6: topic 購読レンダ

- [ ] `context.subscribe` で msg v0 topic を購読
- [ ] 受信データで同じレンダパイプラインを駆動
- [ ] PLY 直読みモードと切り替え可能にする

**到達条件**: PLY 直読みと topic 購読で描画結果が一致

---

### Step 7: MCAP 記録・再生

- [ ] `ply_to_mcap.py` — PLY を msg v0 に変換して MCAP に書き出し
- [ ] Foxglove で MCAP を開いてスプラットが再生されることを確認
- [ ] タイムスタンプに沿った再生

**到達条件**: MCAP 再生でセンサログと一緒に GS が表示される

---

### Step 8 (Optional): Lv3 レンダラ — 異方性楕円スプラット

> **実装しない可能性あり。** Lv2 でデバッグ用途に十分かを先に評価する。

- [ ] scale 3軸 + rotation quaternion → 3D共分散行列
- [ ] 3D共分散 → 2D共分散（カメラ射影）
- [ ] 2D共分散から楕円の軸・角度を算出
- [ ] billboard を楕円に変形

**到達条件**: Foxglove パネルで「面っぽく」見える。フローターや破綻が直感的に分かる

---

## レンダリングレベル対応表

| Lv | 描画方式 | 使うデータ | 見え方 |
|---|---|---|---|
| 0 | GL_POINTS | position, color | 色付き点群 |
| 1 | Billboard quad + ガウス | + scale (max) | ぼけた円 |
| 2 | + alpha blending + sort | + opacity | 半透明の面 |
| 3 | 楕円スプラット | + scale 3軸, rotation | 異方性ガウシアン |

## iGPU 制約メモ

- 74万スプラットは iGPU にとって重い
- Lv2 以降のソートが最大のボトルネック
- 対策案:
  - ソートは毎フレームではなく視点変化時のみ
  - opacity が低いスプラットをカリング
  - LOD（距離に応じてスプラット間引き）
  - 必要に応じてスプラット数を制限（上位 N 件のみ）
