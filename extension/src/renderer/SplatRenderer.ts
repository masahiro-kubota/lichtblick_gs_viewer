import { GaussianSplatMsg } from "../msg/GaussianSplatMsg";
import { OrbitCamera } from "./camera";

// ---- Lv1/Lv2: Instanced billboard quad + Gaussian fragment ----

const VERT_SRC = `#version 300 es
precision highp float;

uniform mat4 u_view;
uniform mat4 u_proj;
uniform float u_splatScale;

// Per-vertex (quad corners)
layout(location = 0) in vec2 a_quadPos;

// Per-instance
layout(location = 1) in vec3 a_position;
layout(location = 2) in vec3 a_color;
layout(location = 3) in float a_opacity;
layout(location = 4) in vec3 a_scale;

out vec3 v_color;
out float v_opacity;
out vec2 v_quadPos;

void main() {
  vec4 viewPos = u_view * vec4(a_position, 1.0);
  float maxScale = max(a_scale.x, max(a_scale.y, a_scale.z));
  float radius = maxScale * u_splatScale;

  vec3 offset = vec3(a_quadPos * radius * 3.0, 0.0);
  vec4 billboardPos = viewPos + vec4(offset, 0.0);

  gl_Position = u_proj * billboardPos;
  v_color = a_color;
  v_opacity = a_opacity;
  v_quadPos = a_quadPos;
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;

in vec3 v_color;
in float v_opacity;
in vec2 v_quadPos;

out vec4 fragColor;

void main() {
  float r2 = dot(v_quadPos, v_quadPos);
  if (r2 > 1.0) discard;
  float alpha = exp(-4.5 * r2) * v_opacity;
  fragColor = vec4(v_color * alpha, alpha);
}
`;

// Lv0 (GL_POINTS)
const VERT_SRC_LV0 = `#version 300 es
precision highp float;

uniform mat4 u_view;
uniform mat4 u_proj;
uniform float u_pointSize;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_color;

out vec3 v_color;

void main() {
  vec4 viewPos = u_view * vec4(a_position, 1.0);
  gl_Position = u_proj * viewPos;
  v_color = a_color;
  float dist = length(viewPos.xyz);
  gl_PointSize = u_pointSize / max(dist, 0.1);
}
`;

const FRAG_SRC_LV0 = `#version 300 es
precision highp float;

in vec3 v_color;
out vec4 fragColor;

void main() {
  fragColor = vec4(v_color, 1.0);
}
`;

export type RenderLevel = 0 | 1 | 2;

export class SplatRenderer {
  private gl: WebGL2RenderingContext;
  private camera: OrbitCamera;
  private animationId = 0;
  private canvas: HTMLCanvasElement;
  private detachCamera: (() => void) | null = null;
  private splatCount = 0;
  private renderLevel: RenderLevel = 2;
  private splatScale = 0.2; // スプラットサイズ倍率

  // Lv0
  private progLv0: WebGLProgram | null = null;
  private vaoLv0: WebGLVertexArrayObject | null = null;

  // Lv1/Lv2
  private progLv1: WebGLProgram | null = null;
  private vaoLv1: WebGLVertexArrayObject | null = null;
  private quadIndexCount = 0;

  // Lv2 ソート用
  private splatMsg: GaussianSplatMsg | null = null;
  private sortedIndices: Uint32Array | null = null;
  private instancePosBuf: WebGLBuffer | null = null;
  private instanceColBuf: WebGLBuffer | null = null;
  private instanceOpaBuf: WebGLBuffer | null = null;
  private instanceSclBuf: WebGLBuffer | null = null;
  private lastSortEye: [number, number, number] = [0, 0, 0];
  private sortDirty = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
    if (!gl) {
      throw new Error("WebGL2 not supported");
    }
    this.gl = gl;
    this.camera = new OrbitCamera();

    this.progLv0 = this.createProgram(VERT_SRC_LV0, FRAG_SRC_LV0);
    this.progLv1 = this.createProgram(VERT_SRC, FRAG_SRC);
    this.detachCamera = this.camera.attach(canvas);
  }

  private createProgram(vertSrc: string, fragSrc: string): WebGLProgram {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, vertSrc);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fragSrc);
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link error: ${gl.getProgramInfoLog(program)}`);
    }
    return program;
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

  public setRenderLevel(level: RenderLevel): void {
    this.renderLevel = level;
    this.sortDirty = true;
  }

  public setSplatScale(scale: number): void {
    this.splatScale = scale;
  }

  public setData(msg: GaussianSplatMsg): void {
    this.splatCount = msg.count;
    this.splatMsg = msg;
    this.sortedIndices = new Uint32Array(msg.count);
    for (let i = 0; i < msg.count; i++) {
      this.sortedIndices[i] = i;
    }
    this.sortDirty = true;
    this.setupLv0(msg);
    this.setupLv1(msg);
    this.autoFitCamera(msg);
  }

  private setupLv0(msg: GaussianSplatMsg): void {
    const gl = this.gl;
    if (this.vaoLv0) gl.deleteVertexArray(this.vaoLv0);

    this.vaoLv0 = gl.createVertexArray();
    gl.bindVertexArray(this.vaoLv0);

    const posBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, msg.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    const colBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, msg.colors, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
  }

  private setupLv1(msg: GaussianSplatMsg): void {
    const gl = this.gl;
    if (this.vaoLv1) gl.deleteVertexArray(this.vaoLv1);

    this.vaoLv1 = gl.createVertexArray();
    gl.bindVertexArray(this.vaoLv1);

    // Quad geometry
    // prettier-ignore
    const quadVerts = new Float32Array([
      -1, -1,  1, -1,  1, 1,  -1, 1,
    ]);
    const quadIndices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    this.quadIndexCount = quadIndices.length;

    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const idxBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIndices, gl.STATIC_DRAW);

    // Instance buffers (DYNAMIC_DRAW for Lv2 sorted re-upload)
    this.instancePosBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instancePosBuf);
    gl.bufferData(gl.ARRAY_BUFFER, msg.positions, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);

    this.instanceColBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceColBuf);
    gl.bufferData(gl.ARRAY_BUFFER, msg.colors, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(2, 1);

    this.instanceOpaBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceOpaBuf);
    gl.bufferData(gl.ARRAY_BUFFER, msg.opacities, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(3, 1);

    this.instanceSclBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceSclBuf);
    gl.bufferData(gl.ARRAY_BUFFER, msg.scales, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(4, 1);

    gl.bindVertexArray(null);
  }

  /** 視点からの距離でソート（back-to-front）してインスタンスバッファを更新 */
  private sortAndUpload(): void {
    const msg = this.splatMsg;
    if (!msg || !this.sortedIndices) return;

    const eye = this.camera.getEye();

    // 視点が大きく動いていなければスキップ
    const dx = eye[0] - this.lastSortEye[0];
    const dy = eye[1] - this.lastSortEye[1];
    const dz = eye[2] - this.lastSortEye[2];
    const moveDist = dx * dx + dy * dy + dz * dz;
    if (!this.sortDirty && moveDist < 0.001) return;

    this.lastSortEye = eye;
    this.sortDirty = false;

    const positions = msg.positions;
    const indices = this.sortedIndices;
    const count = msg.count;

    // 距離の二乗を計算
    const distances = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const px = positions[i * 3 + 0]! - eye[0];
      const py = positions[i * 3 + 1]! - eye[1];
      const pz = positions[i * 3 + 2]! - eye[2];
      distances[i] = px * px + py * py + pz * pz;
    }

    // back-to-front ソート（遠い順）
    for (let i = 0; i < count; i++) indices[i] = i;
    indices.sort((a, b) => distances[b]! - distances[a]!);

    // ソート順でインスタンスバッファを再構築
    const sortedPos = new Float32Array(count * 3);
    const sortedCol = new Float32Array(count * 3);
    const sortedOpa = new Float32Array(count);
    const sortedScl = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const idx = indices[i]!;
      sortedPos[i * 3 + 0] = msg.positions[idx * 3 + 0]!;
      sortedPos[i * 3 + 1] = msg.positions[idx * 3 + 1]!;
      sortedPos[i * 3 + 2] = msg.positions[idx * 3 + 2]!;
      sortedCol[i * 3 + 0] = msg.colors[idx * 3 + 0]!;
      sortedCol[i * 3 + 1] = msg.colors[idx * 3 + 1]!;
      sortedCol[i * 3 + 2] = msg.colors[idx * 3 + 2]!;
      sortedOpa[i] = msg.opacities[idx]!;
      sortedScl[i * 3 + 0] = msg.scales[idx * 3 + 0]!;
      sortedScl[i * 3 + 1] = msg.scales[idx * 3 + 1]!;
      sortedScl[i * 3 + 2] = msg.scales[idx * 3 + 2]!;
    }

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instancePosBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, sortedPos);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceColBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, sortedCol);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceOpaBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, sortedOpa);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceSclBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, sortedScl);
  }

  private autoFitCamera(msg: GaussianSplatMsg): void {
    let cx = 0, cy = 0, cz = 0;
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
    gl.clearColor(0.1, 0.1, 0.18, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (this.splatCount === 0) return;

    const aspect = w / h;
    const viewMat = this.camera.getViewMatrix();
    const projMat = this.camera.getProjectionMatrix(aspect);

    if (this.renderLevel === 0) {
      this.drawLv0(viewMat, projMat);
    } else if (this.renderLevel === 1) {
      this.drawLv1(viewMat, projMat);
    } else {
      this.drawLv2(viewMat, projMat);
    }
  }

  private drawLv0(viewMat: Float32Array, projMat: Float32Array): void {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    gl.useProgram(this.progLv0);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progLv0!, "u_view"), false, viewMat);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progLv0!, "u_proj"), false, projMat);
    gl.uniform1f(gl.getUniformLocation(this.progLv0!, "u_pointSize"), 3.0);

    gl.bindVertexArray(this.vaoLv0);
    gl.drawArrays(gl.POINTS, 0, this.splatCount);
    gl.bindVertexArray(null);
  }

  private drawLv1(viewMat: Float32Array, projMat: Float32Array): void {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.progLv1);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progLv1!, "u_view"), false, viewMat);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progLv1!, "u_proj"), false, projMat);
    gl.uniform1f(gl.getUniformLocation(this.progLv1!, "u_splatScale"), this.splatScale);

    gl.bindVertexArray(this.vaoLv1);
    gl.drawElementsInstanced(gl.TRIANGLES, this.quadIndexCount, gl.UNSIGNED_SHORT, 0, this.splatCount);
    gl.bindVertexArray(null);
  }

  private drawLv2(viewMat: Float32Array, projMat: Float32Array): void {
    // ソート（視点変化時のみ）
    this.sortAndUpload();

    const gl = this.gl;
    // Lv2: 深度テスト無効 + back-to-front ソート + α合成
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.progLv1);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progLv1!, "u_view"), false, viewMat);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progLv1!, "u_proj"), false, projMat);
    gl.uniform1f(gl.getUniformLocation(this.progLv1!, "u_splatScale"), this.splatScale);

    gl.bindVertexArray(this.vaoLv1);
    gl.drawElementsInstanced(gl.TRIANGLES, this.quadIndexCount, gl.UNSIGNED_SHORT, 0, this.splatCount);
    gl.bindVertexArray(null);
  }

  public dispose(): void {
    this.stopLoop();
    this.detachCamera?.();
  }
}
