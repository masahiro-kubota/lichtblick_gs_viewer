import { GaussianSplatMsg } from "../msg/GaussianSplatMsg";
import { sigmoid, shDcToRgb, expScale, normalizeQuat } from "../utils/activations";

interface PlyHeader {
  vertexCount: number;
  properties: string[];
  headerBytes: number;
}

function parseHeader(buffer: ArrayBuffer): PlyHeader {
  const decoder = new TextDecoder("ascii");
  // ヘッダは ASCII なので先頭を十分な長さで読む
  const headerText = decoder.decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 8192)));

  const lines = headerText.split("\n");
  const properties: string[] = [];
  let vertexCount = 0;
  let headerEndIndex = 0;

  for (const line of lines) {
    // +1 for the newline character
    headerEndIndex += line.length + 1;

    const trimmed = line.trim();
    if (trimmed.startsWith("element vertex")) {
      vertexCount = parseInt(trimmed.split(/\s+/)[2]!, 10);
    } else if (trimmed.startsWith("property float")) {
      // "property float x" → "x"
      properties.push(trimmed.split(/\s+/)[2]!);
    } else if (trimmed === "end_header") {
      break;
    }
  }

  // headerEndIndex はテキストのバイト位置（ASCII なので 1:1）
  return { vertexCount, properties, headerBytes: headerEndIndex };
}

/**
 * 3DGS PLY (binary_little_endian) を読み込んで GaussianSplatMsg に変換する。
 *
 * プロパティの並び順（62 × float32 = 248 bytes/vertex）:
 *   x, y, z, nx, ny, nz,
 *   f_dc_0, f_dc_1, f_dc_2,
 *   f_rest_0 ~ f_rest_44,
 *   opacity,
 *   scale_0, scale_1, scale_2,
 *   rot_0, rot_1, rot_2, rot_3
 */
export function parsePly(buffer: ArrayBuffer): GaussianSplatMsg {
  const header = parseHeader(buffer);
  const { vertexCount, properties, headerBytes } = header;

  if (vertexCount === 0) {
    throw new Error("PLY contains no vertices");
  }

  // プロパティ名からオフセット（float32 インデックス）を取得
  const propIndex = (name: string): number => {
    const idx = properties.indexOf(name);
    if (idx === -1) {
      throw new Error(`PLY property "${name}" not found`);
    }
    return idx;
  };

  const stride = properties.length; // float32 単位のストライド
  const dataView = new DataView(buffer, headerBytes);

  // 出力配列を確保
  const positions = new Float32Array(vertexCount * 3);
  const scales = new Float32Array(vertexCount * 3);
  const rotations = new Float32Array(vertexCount * 4);
  const opacities = new Float32Array(vertexCount);
  const colors = new Float32Array(vertexCount * 3);

  // プロパティオフセットをキャッシュ
  const iX = propIndex("x");
  const iY = propIndex("y");
  const iZ = propIndex("z");
  const iDc0 = propIndex("f_dc_0");
  const iDc1 = propIndex("f_dc_1");
  const iDc2 = propIndex("f_dc_2");
  const iOpacity = propIndex("opacity");
  const iScale0 = propIndex("scale_0");
  const iScale1 = propIndex("scale_1");
  const iScale2 = propIndex("scale_2");
  const iRot0 = propIndex("rot_0");
  const iRot1 = propIndex("rot_1");
  const iRot2 = propIndex("rot_2");
  const iRot3 = propIndex("rot_3");

  for (let i = 0; i < vertexCount; i++) {
    const byteOffset = i * stride * 4; // 4 bytes per float32

    // position: COLMAP/3DGS は Y-down → WebGL Y-up に変換（Y を反転）
    positions[i * 3 + 0] = dataView.getFloat32(byteOffset + iX * 4, true);
    positions[i * 3 + 1] = -dataView.getFloat32(byteOffset + iY * 4, true);
    positions[i * 3 + 2] = -dataView.getFloat32(byteOffset + iZ * 4, true);

    // color: SH DC → RGB
    colors[i * 3 + 0] = shDcToRgb(dataView.getFloat32(byteOffset + iDc0 * 4, true));
    colors[i * 3 + 1] = shDcToRgb(dataView.getFloat32(byteOffset + iDc1 * 4, true));
    colors[i * 3 + 2] = shDcToRgb(dataView.getFloat32(byteOffset + iDc2 * 4, true));

    // opacity: sigmoid
    opacities[i] = sigmoid(dataView.getFloat32(byteOffset + iOpacity * 4, true));

    // scale: exp
    scales[i * 3 + 0] = expScale(dataView.getFloat32(byteOffset + iScale0 * 4, true));
    scales[i * 3 + 1] = expScale(dataView.getFloat32(byteOffset + iScale1 * 4, true));
    scales[i * 3 + 2] = expScale(dataView.getFloat32(byteOffset + iScale2 * 4, true));

    // rotation: normalize quaternion
    const [rw, rx, ry, rz] = normalizeQuat(
      dataView.getFloat32(byteOffset + iRot0 * 4, true),
      dataView.getFloat32(byteOffset + iRot1 * 4, true),
      dataView.getFloat32(byteOffset + iRot2 * 4, true),
      dataView.getFloat32(byteOffset + iRot3 * 4, true),
    );
    rotations[i * 4 + 0] = rw;
    rotations[i * 4 + 1] = rx;
    rotations[i * 4 + 2] = ry;
    rotations[i * 4 + 3] = rz;
  }

  return {
    timestamp: 0,
    frame_id: "map",
    count: vertexCount,
    positions,
    scales,
    rotations,
    opacities,
    colors,
  };
}
