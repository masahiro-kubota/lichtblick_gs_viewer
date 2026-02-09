# Gaussian Splat Viewer

Foxglove / Lichtblick Suite 向けの 3D Gaussian Splatting ビューアパネル拡張です。

MCAP トピック経由または PLY ファイルのドラッグ&ドロップで 3DGS モデルをリアルタイムに可視化できます。WebGL2 による高速なソート済みスプラットレンダリングを実装しており、マウス操作によるインタラクティブなカメラ制御が可能です。

## 機能

- **トピック購読**: `gs_debug_viewer/GaussianSplatMsg` スキーマに一致するトピックをパネル内で選択・購読
- **PLY ドラッグ&ドロップ**: 3DGS 標準 PLY ファイル (binary_little_endian) をキャンバスにドロップして即座に表示
- **WebGL2 レンダリング**: front-to-back under blending による高品質な異方性楕円スプラッティング
- **Radix Sort**: Web Worker 内での 16-bit radix sort による高速な深度ソート
- **カメラ操作**: オービットカメラ（左ドラッグ: 回転、右/中ドラッグ: パン、ホイール: ズーム）
- **自動フィッティング**: データ読み込み時にカメラ位置を自動調整

## セットアップ

### ビルド

```sh
cd extension
npm install
npm run build
```

### Foxglove Studio へのインストール

```sh
npm run local-install
```

Foxglove Studio を開く（既に開いている場合は `Ctrl+R` でリロード）とパネルが利用可能になります。

### Lichtblick Suite へのインストール

Lichtblick Suite は別のディレクトリを参照するため、手動コピーが必要です。

```sh
npm run local-install
cp -r ~/.foxglove-studio/extensions/unknown.gs-debug-viewer-0.0.0 ~/.lichtblick-suite/extensions/
```

Lichtblick Suite を再起動すると反映されます。

## 使い方

### パネルの追加

1. Foxglove / Lichtblick でパネルの追加メニューを開く
2. 「Gaussian Splat Viewer」を選択してレイアウトに追加

### トピック経由での表示

1. `gs_debug_viewer/GaussianSplatMsg` スキーマで publish されたトピックを含む MCAP ファイルを開く
2. パネル上部のドロップダウンからトピックを選択
3. スプラットが自動的にレンダリングされる

### PLY ファイルの表示

1. 3DGS の学習で出力された PLY ファイル（`point_cloud.ply` など）をキャンバスにドラッグ&ドロップ
2. パーサが自動的に SH → RGB 変換、sigmoid/exp 活性化関数を適用して表示

### PLY → MCAP 変換

同梱の変換スクリプトで PLY ファイルを MCAP に変換できます。

```sh
python tools/ply_to_mcap.py input.ply output.mcap
```

## メッセージスキーマ

`gs_debug_viewer/GaussianSplatMsg` スキーマ:

| フィールド | 型 | 説明 |
|---|---|---|
| `timestamp` | number | Unix epoch (秒) |
| `frame_id` | string | 座標フレーム名 |
| `count` | number | スプラット数 N |
| `positions_b64` | string | Float32Array [N*3] の base64 エンコード |
| `scales_b64` | string | Float32Array [N*3] の base64 エンコード (exp 適用済み) |
| `rotations_b64` | string | Float32Array [N*4] の base64 エンコード (正規化済み, wxyz) |
| `opacities_b64` | string | Float32Array [N] の base64 エンコード (sigmoid 適用済み) |
| `colors_b64` | string | Float32Array [N*3] の base64 エンコード (RGB, 0-1) |

## 開発

```sh
npm run build       # ビルド
npm run lint        # ESLint チェック
npm run lint:fix    # ESLint 自動修正
npm run package     # .foxe パッケージ作成
```

## Acknowledgments

The rendering engine of this extension is based on [antimatter15/splat](https://github.com/antimatter15/splat) (MIT License). Special thanks to Kevin Kwok ([@antimatter15](https://github.com/antimatter15)) for his excellent real-time Gaussian Splatting renderer in WebGL. Core rendering algorithms — including radix sort-based depth sorting, front-to-back under blending, and 2D projection of elliptical splats — were ported and adapted from that project.

## License

The rendering code is based on [MIT License](https://github.com/antimatter15/splat/blob/main/LICENSE) (antimatter15/splat).
