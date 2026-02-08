import { GaussianSplatMsg } from "../msg/GaussianSplatMsg";
import { OrbitCamera } from "./camera";

// シェーダソースをインラインで保持（webpack でテキスト読み込みが面倒なため）
const VERT_SRC = `#version 300 es
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

const FRAG_SRC = `#version 300 es
precision highp float;

in vec3 v_color;
out vec4 fragColor;

void main() {
  fragColor = vec4(v_color, 1.0);
}
`;

export class SplatRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vertexCount = 0;
  private camera: OrbitCamera;
  private animationId = 0;
  private canvas: HTMLCanvasElement;
  private detachCamera: (() => void) | null = null;

  // uniform locations
  private uView: WebGLUniformLocation | null = null;
  private uProj: WebGLUniformLocation | null = null;
  private uPointSize: WebGLUniformLocation | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
    if (!gl) {
      throw new Error("WebGL2 not supported");
    }
    this.gl = gl;
    this.camera = new OrbitCamera();

    this.initShaders();
    this.detachCamera = this.camera.attach(canvas);
  }

  private initShaders(): void {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, VERT_SRC);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);

    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link error: ${gl.getProgramInfoLog(program)}`);
    }

    this.program = program;
    this.uView = gl.getUniformLocation(program, "u_view");
    this.uProj = gl.getUniformLocation(program, "u_proj");
    this.uPointSize = gl.getUniformLocation(program, "u_pointSize");
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

  public setData(msg: GaussianSplatMsg): void {
    const gl = this.gl;

    // 既存のVAOを削除
    if (this.vao) {
      gl.deleteVertexArray(this.vao);
    }

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    // position buffer (location = 0)
    const posBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, msg.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    // color buffer (location = 1)
    const colBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, msg.colors, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);

    this.vertexCount = msg.count;

    // カメラの初期位置を点群の重心に合わせる
    this.autoFitCamera(msg);
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

    // バウンディングボックスの半径を推定
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

    // canvas サイズをCSSサイズに合わせる
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
    gl.enable(gl.DEPTH_TEST);

    if (!this.program || this.vertexCount === 0) {
      return;
    }

    gl.useProgram(this.program);

    const aspect = w / h;
    gl.uniformMatrix4fv(this.uView, false, this.camera.getViewMatrix());
    gl.uniformMatrix4fv(this.uProj, false, this.camera.getProjectionMatrix(aspect));
    gl.uniform1f(this.uPointSize, 3.0);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.POINTS, 0, this.vertexCount);
    gl.bindVertexArray(null);
  }

  public dispose(): void {
    this.stopLoop();
    this.detachCamera?.();
  }
}
