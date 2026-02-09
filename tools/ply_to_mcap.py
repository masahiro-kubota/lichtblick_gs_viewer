#!/usr/bin/env python3
"""
PLY → MCAP 変換スクリプト

3DGS の PLY ファイルを読み込み、GaussianSplatMsg として MCAP に書き出す。
PLY の生値は適切な活性化関数で変換される:
  - color: SH DC → RGB (0.5 + C0 * f_dc)
  - opacity: sigmoid
  - scale: exp
  - rotation: normalize quaternion

Usage:
    python ply_to_mcap.py input.ply output.mcap [--timestamp EPOCH_SEC]
"""

import argparse
import base64
import json
import struct
import sys
import time
from pathlib import Path

import numpy as np

try:
    from mcap.writer import Writer
except ImportError:
    print("Error: mcap package not found. Install with: pip install mcap", file=sys.stderr)
    sys.exit(1)

# Schema
SCHEMA_NAME = "gs_debug_viewer/GaussianSplatMsg"
SCHEMA_ENCODING = "jsonschema"
SCHEMA_DATA = json.dumps({
    "type": "object",
    "properties": {
        "timestamp": {"type": "number"},
        "frame_id": {"type": "string"},
        "count": {"type": "integer"},
        "positions_b64": {"type": "string"},
        "scales_b64": {"type": "string"},
        "rotations_b64": {"type": "string"},
        "opacities_b64": {"type": "string"},
        "colors_b64": {"type": "string"},
    },
    "required": [
        "timestamp", "frame_id", "count",
        "positions_b64", "scales_b64", "rotations_b64",
        "opacities_b64", "colors_b64",
    ],
}).encode()

# SH C0 coefficient
SH_C0 = 0.28209479177387814


def parse_ply_header(f) -> tuple[int, list[str], int]:
    """PLY ヘッダを解析して (vertex_count, property_names, header_size) を返す"""
    properties = []
    vertex_count = 0
    header_size = 0

    while True:
        line = f.readline()
        header_size += len(line)
        line = line.decode("ascii").strip()

        if line.startswith("element vertex"):
            vertex_count = int(line.split()[2])
        elif line.startswith("property float"):
            properties.append(line.split()[2])
        elif line == "end_header":
            break

    return vertex_count, properties, header_size


def parse_ply(ply_path: str) -> dict:
    """PLY を読み込んで変換済みデータを返す"""
    with open(ply_path, "rb") as f:
        vertex_count, properties, _ = parse_ply_header(f)

        stride = len(properties)
        raw = np.frombuffer(
            f.read(vertex_count * stride * 4),
            dtype=np.float32,
        ).reshape(vertex_count, stride)

    # プロパティインデックス
    def idx(name: str) -> int:
        return properties.index(name)

    # Position (そのまま)
    positions = raw[:, [idx("x"), idx("y"), idx("z")]].copy()

    # Color: SH DC → RGB
    f_dc = raw[:, [idx("f_dc_0"), idx("f_dc_1"), idx("f_dc_2")]]
    colors = np.clip(0.5 + SH_C0 * f_dc, 0.0, 1.0).astype(np.float32)

    # Opacity: sigmoid
    raw_opacity = raw[:, idx("opacity")]
    opacities = (1.0 / (1.0 + np.exp(-raw_opacity))).astype(np.float32)

    # Scale: exp
    scales = np.exp(raw[:, [idx("scale_0"), idx("scale_1"), idx("scale_2")]]).astype(np.float32)

    # Rotation: normalize quaternion
    quats = raw[:, [idx("rot_0"), idx("rot_1"), idx("rot_2"), idx("rot_3")]].copy()
    norms = np.linalg.norm(quats, axis=1, keepdims=True)
    norms = np.maximum(norms, 1e-10)
    rotations = (quats / norms).astype(np.float32)

    return {
        "count": vertex_count,
        "positions": positions,
        "colors": colors,
        "opacities": opacities,
        "scales": scales,
        "rotations": rotations,
    }


def float32_to_b64(arr: np.ndarray) -> str:
    """numpy float32 array → base64 string"""
    return base64.b64encode(arr.tobytes()).decode("ascii")


def write_mcap(data: dict, output_path: str, timestamp: float, frame_id: str):
    """MCAP ファイルに書き出す"""
    with open(output_path, "wb") as f:
        writer = Writer(f)
        writer.start()

        # --- TF static schema (tf2_msgs/TFMessage) ---
        tf_schema_data = json.dumps({
            "type": "object",
            "properties": {
                "transforms": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "header": {
                                "type": "object",
                                "properties": {
                                    "stamp": {"type": "object", "properties": {"sec": {"type": "integer"}, "nsec": {"type": "integer"}}},
                                    "frame_id": {"type": "string"},
                                },
                            },
                            "child_frame_id": {"type": "string"},
                            "transform": {
                                "type": "object",
                                "properties": {
                                    "translation": {"type": "object", "properties": {"x": {"type": "number"}, "y": {"type": "number"}, "z": {"type": "number"}}},
                                    "rotation": {"type": "object", "properties": {"x": {"type": "number"}, "y": {"type": "number"}, "z": {"type": "number"}, "w": {"type": "number"}}},
                                },
                            },
                        },
                    },
                },
            },
        }).encode()

        tf_schema_id = writer.register_schema(
            name="tf2_msgs/TFMessage",
            encoding="jsonschema",
            data=tf_schema_data,
        )

        tf_channel_id = writer.register_channel(
            topic="/tf_static",
            message_encoding="json",
            schema_id=tf_schema_id,
        )

        # --- Gaussian Splat schema ---
        schema_id = writer.register_schema(
            name=SCHEMA_NAME,
            encoding=SCHEMA_ENCODING,
            data=SCHEMA_DATA,
        )

        channel_id = writer.register_channel(
            topic="/gaussian_splats",
            message_encoding="json",
            schema_id=schema_id,
        )

        timestamp_ns = int(timestamp * 1e9)
        stamp_sec = int(timestamp)
        stamp_nsec = int((timestamp - stamp_sec) * 1e9)

        # Write TF static: world → frame_id (identity transform)
        tf_msg = {
            "transforms": [{
                "header": {
                    "stamp": {"sec": stamp_sec, "nsec": stamp_nsec},
                    "frame_id": "world",
                },
                "child_frame_id": frame_id,
                "transform": {
                    "translation": {"x": 0.0, "y": 0.0, "z": 0.0},
                    "rotation": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
                },
            }],
        }
        tf_bytes = json.dumps(tf_msg).encode()
        writer.add_message(
            channel_id=tf_channel_id,
            log_time=timestamp_ns,
            data=tf_bytes,
            publish_time=timestamp_ns,
        )

        # Write Gaussian Splat message
        msg = {
            "timestamp": timestamp,
            "frame_id": frame_id,
            "count": data["count"],
            "positions_b64": float32_to_b64(data["positions"]),
            "scales_b64": float32_to_b64(data["scales"]),
            "rotations_b64": float32_to_b64(data["rotations"]),
            "opacities_b64": float32_to_b64(data["opacities"]),
            "colors_b64": float32_to_b64(data["colors"]),
        }

        msg_bytes = json.dumps(msg).encode()

        writer.add_message(
            channel_id=channel_id,
            log_time=timestamp_ns,
            data=msg_bytes,
            publish_time=timestamp_ns,
        )

        writer.finish()

    # ファイルサイズ表示
    size_mb = Path(output_path).stat().st_size / (1024 * 1024)
    print(f"Written: {output_path} ({size_mb:.1f} MB)")


def main():
    parser = argparse.ArgumentParser(description="Convert 3DGS PLY to MCAP")
    parser.add_argument("input", help="Input PLY file path")
    parser.add_argument("output", help="Output MCAP file path")
    parser.add_argument("--timestamp", type=float, default=None,
                        help="Unix timestamp (default: current time)")
    parser.add_argument("--frame-id", type=str, default="map",
                        help="Coordinate frame ID (default: map)")
    args = parser.parse_args()

    if not Path(args.input).exists():
        print(f"Error: {args.input} not found", file=sys.stderr)
        sys.exit(1)

    timestamp = args.timestamp if args.timestamp is not None else time.time()

    print(f"Parsing PLY: {args.input}")
    data = parse_ply(args.input)
    print(f"  Vertices: {data['count']:,}")
    print(f"  Position range: [{data['positions'].min():.3f}, {data['positions'].max():.3f}]")
    print(f"  Color range: [{data['colors'].min():.3f}, {data['colors'].max():.3f}]")
    print(f"  Opacity range: [{data['opacities'].min():.3f}, {data['opacities'].max():.3f}]")
    print(f"  Scale range: [{data['scales'].min():.6f}, {data['scales'].max():.6f}]")

    print(f"Writing MCAP: {args.output}")
    write_mcap(data, args.output, timestamp, args.frame_id)
    print("Done!")


if __name__ == "__main__":
    main()
