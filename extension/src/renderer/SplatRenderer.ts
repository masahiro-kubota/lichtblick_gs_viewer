import { GaussianSplatMsg } from "../msg/GaussianSplatMsg";
import { OrbitCamera } from "./camera";

// ============================================================
// Worker code (inlined as string, antimatter15/splat style)
// ============================================================

function createWorkerCode(): string {
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
//   texel[2i+0]: position xyz (float32 as uint32) + rgba (uint8×4 in .w)
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
    // position (float32 → bitcast to uint32)
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

// 16-bit counting sort by depth
function runSort(f_buffer, vertexCount, viewProj) {
  var maxDepth = -Infinity;
  var minDepth = Infinity;
  var sizeList = new Int32Array(vertexCount);
  for (var i = 0; i < vertexCount; i++) {
    var depth = ((viewProj[2] * f_buffer[8*i+0] + viewProj[6] * f_buffer[8*i+1] + viewProj[10] * f_buffer[8*i+2]) * 4096) | 0;
    sizeList[i] = depth;
    if (depth > maxDepth) maxDepth = depth;
    if (depth < minDepth) minDepth = depth;
  }
  var depthInv = (256 * 256 - 1) / (maxDepth - minDepth);
  var counts0 = new Uint32Array(256 * 256);
  for (var i = 0; i < vertexCount; i++) {
    sizeList[i] = ((sizeList[i] - minDepth) * depthInv) | 0;
    counts0[sizeList[i]]++;
  }
  var starts0 = new Uint32Array(256 * 256);
  for (var i = 1; i < 256 * 256; i++) starts0[i] = starts0[i-1] + counts0[i-1];
  var depthIndex = new Uint32Array(vertexCount);
  for (var i = 0; i < vertexCount; i++) depthIndex[starts0[sizeList[i]]++] = i;
  return depthIndex;
}

// --- Worker state ---
var buffer = null;
var f_buffer = null;
var vertexCount = 0;
var lastProj = [];

self.onmessage = function(e) {
  try {
  if (e.data.buffer) {
    buffer = e.data.buffer;
    f_buffer = new Float32Array(buffer);
    vertexCount = e.data.vertexCount;
    console.log("[GS Worker] buffer received, vertexCount:", vertexCount, "byteLength:", buffer.byteLength);

    // Generate texture
    var tex = generateTexture(buffer, vertexCount);
    console.log("[GS Worker] texture generated:", tex.texwidth, "x", tex.texheight);
    self.postMessage({ texdata: tex.texdata, texwidth: tex.texwidth, texheight: tex.texheight }, [tex.texdata.buffer]);
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

    var depthIndex = runSort(f_buffer, vertexCount, viewProj);
    console.log("[GS Worker] sort done, posting depthIndex len:", depthIndex.length);
    self.postMessage({ depthIndex: depthIndex, vertexCount: vertexCount }, [depthIndex.buffer]);
  }
  } catch(err) { console.error("[GS Worker] error:", err); }
};
`;
}

// ============================================================
// Shaders — ported from antimatter15/splat main.js L655-732
// ============================================================

const VERT_SRC_LV3 = `#version 300 es
precision highp float;
precision highp int;

uniform highp usampler2D u_texture;
uniform mat4 projection, view;
uniform vec2 focal;
uniform vec2 viewport;

in vec2 position;
in int index;

out vec4 vColor;
out vec2 vPosition;

void main () {
    uvec4 cen = texelFetch(u_texture, ivec2((uint(index) & 0x3ffu) << 1, uint(index) >> 10), 0);
    vec4 cam = view * vec4(uintBitsToFloat(cen.xyz), 1);
    vec4 pos2d = projection * cam;

    float clip = 1.2 * pos2d.w;
    if (pos2d.z < -clip || pos2d.x < -clip || pos2d.x > clip || pos2d.y < -clip || pos2d.y > clip) {
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        return;
    }

    uvec4 cov = texelFetch(u_texture, ivec2(((uint(index) & 0x3ffu) << 1) | 1u, uint(index) >> 10), 0);
    vec2 u1 = unpackHalf2x16(cov.x), u2 = unpackHalf2x16(cov.y), u3 = unpackHalf2x16(cov.z);
    mat3 Vrk = mat3(u1.x, u1.y, u2.x, u1.y, u2.y, u3.x, u2.x, u3.x, u3.y);

    mat3 J = mat3(
        focal.x / cam.z, 0., -(focal.x * cam.x) / (cam.z * cam.z),
        0., -focal.y / cam.z, (focal.y * cam.y) / (cam.z * cam.z),
        0., 0., 0.
    );

    mat3 T = transpose(mat3(view)) * J;
    mat3 cov2d = transpose(T) * Vrk * T;

    float mid = (cov2d[0][0] + cov2d[1][1]) / 2.0;
    float radius = length(vec2((cov2d[0][0] - cov2d[1][1]) / 2.0, cov2d[0][1]));
    float lambda1 = mid + radius, lambda2 = mid - radius;

    if(lambda2 < 0.0) return;
    vec2 diagonalVector = normalize(vec2(cov2d[0][1], lambda1 - cov2d[0][0]));
    vec2 majorAxis = min(sqrt(2.0 * lambda1), 1024.0) * diagonalVector;
    vec2 minorAxis = min(sqrt(2.0 * lambda2), 1024.0) * vec2(diagonalVector.y, -diagonalVector.x);

    vColor = clamp(pos2d.z/pos2d.w+1.0, 0.0, 1.0) * vec4((cov.w) & 0xffu, (cov.w >> 8) & 0xffu, (cov.w >> 16) & 0xffu, (cov.w >> 24) & 0xffu) / 255.0;
    vPosition = position;

    vec2 vCenter = vec2(pos2d) / pos2d.w;
    gl_Position = vec4(
        vCenter
        + position.x * majorAxis / viewport
        + position.y * minorAxis / viewport, 0.0, 1.0);
}
`;

const FRAG_SRC_LV3 = `#version 300 es
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
`;

// ============================================================
// SplatRenderer — antimatter15/splat architecture
// ============================================================

export class SplatRenderer {
  private gl: WebGL2RenderingContext;
  private camera: OrbitCamera;
  private canvas: HTMLCanvasElement;
  private animationId = 0;
  private detachCamera: (() => void) | null = null;

  // Worker
  private worker: Worker | null = null;

  // GL resources
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private indexBuffer: WebGLBuffer | null = null;
  private vertexCount = 0;

  // Uniform locations
  private u_projection: WebGLUniformLocation | null = null;
  private u_view: WebGLUniformLocation | null = null;
  private u_focal: WebGLUniformLocation | null = null;
  private u_viewport: WebGLUniformLocation | null = null;

  // Camera focal (derived from projection)
  private focalX = 0;
  private focalY = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { antialias: false });
    if (!gl) {
      throw new Error("WebGL2 not supported");
    }
    this.gl = gl;
    this.camera = new OrbitCamera();
    this.detachCamera = this.camera.attach(canvas);

    this.initGL();
    this.initWorker();
  }

  private initGL(): void {
    const gl = this.gl;

    // Compile shaders
    const vs = this.compileShader(gl.VERTEX_SHADER, VERT_SRC_LV3);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, FRAG_SRC_LV3);
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error(`Program link error: ${gl.getProgramInfoLog(this.program)}`);
    }
    gl.useProgram(this.program);

    // Blending: front-to-back under blending (antimatter15 L807-817)
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.ONE_MINUS_DST_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_DST_ALPHA,
      gl.ONE,
    );
    gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);

    // Uniform locations
    this.u_projection = gl.getUniformLocation(this.program, "projection");
    this.u_view = gl.getUniformLocation(this.program, "view");
    this.u_focal = gl.getUniformLocation(this.program, "focal");
    this.u_viewport = gl.getUniformLocation(this.program, "viewport");

    // Quad vertices: [-2,-2], [2,-2], [2,2], [-2,2] (TRIANGLE_FAN)
    const quadVerts = new Float32Array([-2, -2, 2, -2, 2, 2, -2, 2]);
    const vertexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
    const a_position = gl.getAttribLocation(this.program, "position");
    gl.enableVertexAttribArray(a_position);
    gl.vertexAttribPointer(a_position, 2, gl.FLOAT, false, 0, 0);

    // Texture for splat data
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    const u_textureLocation = gl.getUniformLocation(this.program, "u_texture");
    gl.uniform1i(u_textureLocation, 0);

    // Index buffer (per-instance sorted indices)
    this.indexBuffer = gl.createBuffer()!;
    const a_index = gl.getAttribLocation(this.program, "index");
    gl.enableVertexAttribArray(a_index);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuffer);
    gl.vertexAttribIPointer(a_index, 1, gl.INT, 0, 0);
    gl.vertexAttribDivisor(a_index, 1);
  }

  private initWorker(): void {
    const blob = new Blob([createWorkerCode()], { type: "application/javascript" });
    this.worker = new Worker(URL.createObjectURL(blob));

    this.worker.onerror = (e) => {
      console.error("[GS] Worker error:", e.message, e);
    };

    this.worker.onmessage = (e: MessageEvent) => {
      const gl = this.gl;
      if (e.data.texdata) {
        // Texture data from generateTexture()
        const { texdata, texwidth, texheight } = e.data as {
          texdata: Uint32Array;
          texwidth: number;
          texheight: number;
        };
        console.log("[GS] Worker → texdata received:", texwidth, "x", texheight, "len:", texdata.length);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA32UI,
          texwidth,
          texheight,
          0,
          gl.RGBA_INTEGER,
          gl.UNSIGNED_INT,
          texdata,
        );
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
      } else if (e.data.depthIndex) {
        // Sorted index buffer from runSort()
        const { depthIndex, vertexCount: vc } = e.data as {
          depthIndex: Uint32Array;
          vertexCount: number;
        };
        console.log("[GS] Worker → depthIndex received, vertexCount:", vc, "first indices:", depthIndex[0], depthIndex[1], depthIndex[2]);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, depthIndex, gl.DYNAMIC_DRAW);
        this.vertexCount = vc;
      }
    };
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`Shader compile error: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  }

  /** GaussianSplatMsg → 32-byte packed buffer → Worker */
  public setData(msg: GaussianSplatMsg): void {
    const count = msg.count;

    // Pack into antimatter15 format: 32 bytes per splat
    const buffer = new ArrayBuffer(32 * count);
    const f = new Float32Array(buffer);
    const u = new Uint8Array(buffer);

    for (let i = 0; i < count; i++) {
      // positions: float32 × 3 (bytes 0-11)
      f[8 * i + 0] = msg.positions[i * 3 + 0]!;
      f[8 * i + 1] = msg.positions[i * 3 + 1]!;
      f[8 * i + 2] = msg.positions[i * 3 + 2]!;
      // scales: float32 × 3 (bytes 12-23) — already exp'd
      f[8 * i + 3] = msg.scales[i * 3 + 0]!;
      f[8 * i + 4] = msg.scales[i * 3 + 1]!;
      f[8 * i + 5] = msg.scales[i * 3 + 2]!;
      // RGBA: uint8 × 4 (bytes 24-27)
      u[32 * i + 24] = Math.round(Math.min(1, Math.max(0, msg.colors[i * 3 + 0]!)) * 255);
      u[32 * i + 25] = Math.round(Math.min(1, Math.max(0, msg.colors[i * 3 + 1]!)) * 255);
      u[32 * i + 26] = Math.round(Math.min(1, Math.max(0, msg.colors[i * 3 + 2]!)) * 255);
      u[32 * i + 27] = Math.round(Math.min(1, Math.max(0, msg.opacities[i]!)) * 255);
      // quaternion: uint8 × 4 (bytes 28-31) — [-1,1] → [0,255]
      u[32 * i + 28] = Math.round(Math.min(1, Math.max(-1, msg.rotations[i * 4 + 0]!)) * 128 + 128);
      u[32 * i + 29] = Math.round(Math.min(1, Math.max(-1, msg.rotations[i * 4 + 1]!)) * 128 + 128);
      u[32 * i + 30] = Math.round(Math.min(1, Math.max(-1, msg.rotations[i * 4 + 2]!)) * 128 + 128);
      u[32 * i + 31] = Math.round(Math.min(1, Math.max(-1, msg.rotations[i * 4 + 3]!)) * 128 + 128);
    }

    console.log("[GS] setData: packing", count, "splats, buffer size:", buffer.byteLength);
    console.log("[GS] sample pos:", f[0], f[1], f[2], "scale:", f[3], f[4], f[5]);
    console.log("[GS] sample rgba:", u[24], u[25], u[26], u[27], "quat:", u[28], u[29], u[30], u[31]);

    // Send to worker (transfer ownership)
    this.worker?.postMessage({ buffer, vertexCount: count }, [buffer]);

    this.autoFitCamera(msg);
  }

  private autoFitCamera(msg: GaussianSplatMsg): void {
    let cx = 0,
      cy = 0,
      cz = 0;
    for (let i = 0; i < msg.count; i++) {
      cx += msg.positions[i * 3 + 0]!;
      cy += msg.positions[i * 3 + 1]!;
      cz += msg.positions[i * 3 + 2]!;
    }
    cx /= msg.count;
    cy /= msg.count;
    cz /= msg.count;

    let maxDist = 0;
    for (let i = 0; i < Math.min(msg.count, 10000); i++) {
      const dx = msg.positions[i * 3 + 0]! - cx;
      const dy = msg.positions[i * 3 + 1]! - cy;
      const dz = msg.positions[i * 3 + 2]! - cz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > maxDist) maxDist = d;
    }

    this.camera.targetX = cx;
    this.camera.targetY = cy;
    this.camera.targetZ = cz;
    this.camera.radius = Math.sqrt(maxDist) * 1.5;
  }

  public startLoop(): void {
    const render = () => {
      this.animationId = requestAnimationFrame(render);
      this.drawFrame();
    };
    render();
  }

  public stopLoop(): void {
    cancelAnimationFrame(this.animationId);
  }

  private drawFrame(): void {
    const gl = this.gl;
    const canvas = this.canvas;

    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);

    // --- Focal length from camera FOV ---
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const f = 1 / Math.tan(fovRad / 2);
    this.focalX = (f * h) / 2;
    this.focalY = (f * h) / 2;

    // --- Projection: antimatter15 style (Y-flip, positive-Z clip) ---
    const znear = this.camera.near;
    const zfar = this.camera.far;
    // prettier-ignore
    const projMat = new Float32Array([
      (2 * this.focalX) / w, 0, 0, 0,
      0, -(2 * this.focalY) / h, 0, 0,
      0, 0, zfar / (zfar - znear), 1,
      0, 0, -(zfar * znear) / (zfar - znear), 0,
    ]);

    // --- View: flip Z row so visible objects have positive cam.z ---
    // Our lookAt uses OpenGL convention (camera looks along -Z).
    // antimatter15/splat shader expects positive Z for visible objects.
    const viewMat = this.camera.getViewMatrix();
    viewMat[2] = -viewMat[2]!;
    viewMat[6] = -viewMat[6]!;
    viewMat[10] = -viewMat[10]!;
    viewMat[14] = -viewMat[14]!;

    // Send viewProj to worker for sorting
    const viewProj = multiply4(projMat, viewMat);
    this.worker?.postMessage({ view: Array.from(viewProj) });

    // Set uniforms
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.u_projection, false, projMat);
    gl.uniformMatrix4fv(this.u_view, false, viewMat);
    gl.uniform2f(this.u_focal, this.focalX, this.focalY);
    gl.uniform2f(this.u_viewport, w, h);

    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (this.vertexCount > 0) {
      gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, this.vertexCount);
    }
  }

  public dispose(): void {
    this.stopLoop();
    this.detachCamera?.();
    this.worker?.terminate();
    this.worker = null;
  }
}

// 4x4 matrix multiply (column-major)
function multiply4(a: Float32Array, b: Float32Array): Float32Array {
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
