/**
 * Worker code shared between WebGL and WebGPU renderers.
 * Handles texture generation (3D covariance → half-float packed RGBA32UI)
 * and depth sorting (16-bit counting sort) with alpha-based culling.
 */
export function createWorkerCode(): string {
  return `
"use strict";

var _fv = new Float32Array(1);
var _iv = new Int32Array(_fv.buffer);

function floatToHalf(f) {
  _fv[0] = f;
  var v = _iv[0];
  var s = (v >> 31) & 0x0001;
  var e = (v >> 23) & 0x00ff;
  var frac = v & 0x007fffff;
  var ne;
  if (e === 0) { ne = 0; }
  else if (e < 113) { ne = 0; frac |= 0x00800000; frac = frac >> (113 - e); if (frac & 0x01000000) { ne = 1; frac = 0; } }
  else if (e < 142) { ne = e - 112; }
  else { ne = 31; frac = 0; }
  return (s << 15) | (ne << 10) | (frac >> 13);
}

function packHalf2x16(x, y) {
  return (floatToHalf(x) | (floatToHalf(y) << 16)) >>> 0;
}

// Generate RGBA32UI texture from packed buffer
// Each splat occupies 2 texels in a 2048-wide texture:
//   texel[2i+0]: position xyz (float32 as uint32) + rgba (uint8x4 in .w)
//   texel[2i+1]: 3D covariance 6 components (half-float pairs) + rgba in .w
function generateTexture(buffer, vertexCount) {
  var f_buffer = new Float32Array(buffer);
  var u_buffer = new Uint8Array(buffer);
  var texwidth = 1024 * 2;
  var texheight = Math.ceil((2 * vertexCount) / texwidth);
  var texdata = new Uint32Array(texwidth * texheight * 4);
  var texdata_c = new Uint8Array(texdata.buffer);
  var texdata_f = new Float32Array(texdata.buffer);

  for (var i = 0; i < vertexCount; i++) {
    // position (float32 -> bitcast to uint32)
    texdata_f[8 * i + 0] = f_buffer[8 * i + 0];
    texdata_f[8 * i + 1] = f_buffer[8 * i + 1];
    texdata_f[8 * i + 2] = f_buffer[8 * i + 2];

    // RGBA stored in texel[2i+1].w
    texdata_c[4 * (8 * i + 7) + 0] = u_buffer[32 * i + 24 + 0];
    texdata_c[4 * (8 * i + 7) + 1] = u_buffer[32 * i + 24 + 1];
    texdata_c[4 * (8 * i + 7) + 2] = u_buffer[32 * i + 24 + 2];
    texdata_c[4 * (8 * i + 7) + 3] = u_buffer[32 * i + 24 + 3];

    // Compute 3D covariance from scale + rotation
    var scale = [
      f_buffer[8 * i + 3],
      f_buffer[8 * i + 4],
      f_buffer[8 * i + 5],
    ];
    var rot = [
      (u_buffer[32 * i + 28 + 0] - 128) / 128,
      (u_buffer[32 * i + 28 + 1] - 128) / 128,
      (u_buffer[32 * i + 28 + 2] - 128) / 128,
      (u_buffer[32 * i + 28 + 3] - 128) / 128,
    ];

    // M = diag(scale) * R  (row-major, each row scaled)
    var M = [
      1.0 - 2.0 * (rot[2] * rot[2] + rot[3] * rot[3]),
      2.0 * (rot[1] * rot[2] + rot[0] * rot[3]),
      2.0 * (rot[1] * rot[3] - rot[0] * rot[2]),
      2.0 * (rot[1] * rot[2] - rot[0] * rot[3]),
      1.0 - 2.0 * (rot[1] * rot[1] + rot[3] * rot[3]),
      2.0 * (rot[2] * rot[3] + rot[0] * rot[1]),
      2.0 * (rot[1] * rot[3] + rot[0] * rot[2]),
      2.0 * (rot[2] * rot[3] - rot[0] * rot[1]),
      1.0 - 2.0 * (rot[1] * rot[1] + rot[2] * rot[2]),
    ];
    for (var j = 0; j < 9; j++) M[j] *= scale[Math.floor(j / 3)];

    // sigma = M^T * M (symmetric, 6 unique values)
    var sigma = [
      M[0]*M[0] + M[3]*M[3] + M[6]*M[6],
      M[0]*M[1] + M[3]*M[4] + M[6]*M[7],
      M[0]*M[2] + M[3]*M[5] + M[6]*M[8],
      M[1]*M[1] + M[4]*M[4] + M[7]*M[7],
      M[1]*M[2] + M[4]*M[5] + M[7]*M[8],
      M[2]*M[2] + M[5]*M[5] + M[8]*M[8],
    ];

    texdata[8 * i + 4] = packHalf2x16(4 * sigma[0], 4 * sigma[1]);
    texdata[8 * i + 5] = packHalf2x16(4 * sigma[2], 4 * sigma[3]);
    texdata[8 * i + 6] = packHalf2x16(4 * sigma[4], 4 * sigma[5]);
  }

  return { texdata: texdata, texwidth: texwidth, texheight: texheight };
}

// 16-bit counting sort by depth with alpha culling
function runSort(f_buffer, u_buffer, vertexCount, viewProj, alphaMin) {
  // Pre-filter: collect visible splat indices
  var visibleMap = new Uint32Array(vertexCount);
  var visibleCount = 0;
  for (var i = 0; i < vertexCount; i++) {
    if (u_buffer[32 * i + 27] >= alphaMin) {
      visibleMap[visibleCount++] = i;
    }
  }

  if (visibleCount === 0) {
    return { depthIndex: new Uint32Array(0), visibleCount: 0 };
  }

  // Compute depths for visible splats only
  var maxDepth = -Infinity;
  var minDepth = Infinity;
  var sizeList = new Int32Array(visibleCount);
  for (var vi = 0; vi < visibleCount; vi++) {
    var idx = visibleMap[vi];
    var depth = ((viewProj[2] * f_buffer[8*idx+0] + viewProj[6] * f_buffer[8*idx+1] + viewProj[10] * f_buffer[8*idx+2]) * 4096) | 0;
    sizeList[vi] = depth;
    if (depth > maxDepth) maxDepth = depth;
    if (depth < minDepth) minDepth = depth;
  }

  // Counting sort
  var depthInv = (256 * 256 - 1) / (maxDepth - minDepth);
  var counts0 = new Uint32Array(256 * 256);
  for (var vi = 0; vi < visibleCount; vi++) {
    sizeList[vi] = ((sizeList[vi] - minDepth) * depthInv) | 0;
    counts0[sizeList[vi]]++;
  }
  var starts0 = new Uint32Array(256 * 256);
  for (var i = 1; i < 256 * 256; i++) starts0[i] = starts0[i-1] + counts0[i-1];
  var depthIndex = new Uint32Array(visibleCount);
  for (var vi = 0; vi < visibleCount; vi++) {
    depthIndex[starts0[sizeList[vi]]++] = visibleMap[vi];
  }

  return { depthIndex: depthIndex, visibleCount: visibleCount };
}

// --- Worker state ---
var buffer = null;
var f_buffer = null;
var u_buffer = null;
var vertexCount = 0;
var lastProj = [];
var alphaMin = 1;

self.onmessage = function(e) {
  try {
  if (e.data.buffer) {
    buffer = e.data.buffer;
    f_buffer = new Float32Array(buffer);
    u_buffer = new Uint8Array(buffer);
    vertexCount = e.data.vertexCount;

    // Generate texture
    var tex = generateTexture(buffer, vertexCount);
    self.postMessage({ texdata: tex.texdata, texwidth: tex.texwidth, texheight: tex.texheight }, [tex.texdata.buffer]);
  }
  if (e.data.cullParams !== undefined) {
    alphaMin = e.data.cullParams.alphaMin;
    // Force re-sort with new cull params
    lastProj = [];
  }
  if (e.data.view) {
    if (!buffer || vertexCount === 0) return;
    var viewProj = e.data.view;

    // Throttle: skip if view direction barely changed
    if (lastProj.length > 0) {
      var dot = lastProj[2]*viewProj[2] + lastProj[6]*viewProj[6] + lastProj[10]*viewProj[10];
      if (Math.abs(dot - 1) < 0.01) return;
    }
    lastProj = viewProj;

    var result = runSort(f_buffer, u_buffer, vertexCount, viewProj, alphaMin);
    self.postMessage({
      depthIndex: result.depthIndex,
      vertexCount: result.visibleCount,
      totalCount: vertexCount
    }, [result.depthIndex.buffer]);
  }
  } catch(err) { console.error("[GS Worker] error:", err); }
};
`;
}

/** 4x4 matrix multiply (column-major) */
export function multiply4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[j * 4 + i] =
        a[0 * 4 + i]! * b[j * 4 + 0]! +
        a[1 * 4 + i]! * b[j * 4 + 1]! +
        a[2 * 4 + i]! * b[j * 4 + 2]! +
        a[3 * 4 + i]! * b[j * 4 + 3]!;
    }
  }
  return out;
}
