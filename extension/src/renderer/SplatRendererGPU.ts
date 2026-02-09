/// <reference types="@webgpu/types" />
import { GaussianSplatMsg } from "../msg/GaussianSplatMsg";
import { CullParams, ISplatRenderer, RenderStats } from "./ISplatRenderer";
import { GPUSorter } from "./gpuSort";
import { OrbitCamera } from "./camera";
import { createWorkerCode, multiply4 } from "./workerCode";

// ============================================================
// WGSL Shader — ported from antimatter15/splat (GLSL → WGSL)
// ============================================================

const SPLAT_WGSL = /* wgsl */ `
struct Uniforms {
    projection: mat4x4f,
    view: mat4x4f,
    focal: vec2f,
    viewport: vec2f,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var u_texture: texture_2d<u32>;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) vColor: vec4f,
    @location(1) vPosition: vec2f,
};

@vertex
fn vs_main(
    @builtin(vertex_index) vertex_index: u32,
    @location(0) index: u32,
) -> VertexOutput {
    var out: VertexOutput;

    // Quad positions (triangle-strip order)
    var quadPos: vec2f;
    switch (vertex_index) {
        case 0u: { quadPos = vec2f(-2.0, -2.0); }
        case 1u: { quadPos = vec2f(2.0, -2.0); }
        case 2u: { quadPos = vec2f(-2.0, 2.0); }
        default: { quadPos = vec2f(2.0, 2.0); }
    }

    // Fetch position from texture
    let texCoord0 = vec2u((index & 0x3ffu) << 1u, index >> 10u);
    let cen = textureLoad(u_texture, texCoord0, 0);
    let pos = vec3f(bitcast<f32>(cen.x), bitcast<f32>(cen.y), bitcast<f32>(cen.z));

    let cam = uniforms.view * vec4f(pos, 1.0);
    let pos2d = uniforms.projection * cam;

    let clip = 1.2 * pos2d.w;
    if (pos2d.z < -clip || pos2d.x < -clip || pos2d.x > clip || pos2d.y < -clip || pos2d.y > clip) {
        out.position = vec4f(0.0, 0.0, 2.0, 1.0);
        return out;
    }

    // Fetch covariance from texture
    let texCoord1 = vec2u(((index & 0x3ffu) << 1u) | 1u, index >> 10u);
    let cov = textureLoad(u_texture, texCoord1, 0);
    let u1 = unpack2x16float(cov.x);
    let u2 = unpack2x16float(cov.y);
    let u3 = unpack2x16float(cov.z);

    // 3D covariance (symmetric)
    let Vrk = mat3x3f(
        u1.x, u1.y, u2.x,
        u1.y, u2.y, u3.x,
        u2.x, u3.x, u3.y,
    );

    // Jacobian of projection
    let focal = uniforms.focal;
    let J = mat3x3f(
        focal.x / cam.z, 0.0, -(focal.x * cam.x) / (cam.z * cam.z),
        0.0, -focal.y / cam.z, (focal.y * cam.y) / (cam.z * cam.z),
        0.0, 0.0, 0.0,
    );

    // Extract mat3 from view and compute 2D covariance
    let view3 = mat3x3f(
        uniforms.view[0].xyz,
        uniforms.view[1].xyz,
        uniforms.view[2].xyz,
    );
    let T = transpose(view3) * J;
    let cov2d = transpose(T) * Vrk * T;

    let mid = (cov2d[0][0] + cov2d[1][1]) / 2.0;
    let radius = length(vec2f((cov2d[0][0] - cov2d[1][1]) / 2.0, cov2d[0][1]));
    let lambda1 = mid + radius;
    let lambda2 = mid - radius;

    if (lambda2 < 0.0) {
        out.position = vec4f(0.0, 0.0, 2.0, 1.0);
        return out;
    }

    let diag = normalize(vec2f(cov2d[0][1], lambda1 - cov2d[0][0]));
    let majorAxis = min(sqrt(2.0 * lambda1), 1024.0) * diag;
    let minorAxis = min(sqrt(2.0 * lambda2), 1024.0) * vec2f(diag.y, -diag.x);

    // Color: RGBA from texture .w
    let r = f32(cov.w & 0xffu);
    let g = f32((cov.w >> 8u) & 0xffu);
    let b = f32((cov.w >> 16u) & 0xffu);
    let a = f32((cov.w >> 24u) & 0xffu);
    out.vColor = clamp(pos2d.z / pos2d.w + 1.0, 0.0, 1.0) * vec4f(r, g, b, a) / 255.0;
    out.vPosition = quadPos;

    let vCenter = pos2d.xy / pos2d.w;
    out.position = vec4f(
        vCenter + quadPos.x * majorAxis / uniforms.viewport + quadPos.y * minorAxis / uniforms.viewport,
        0.0, 1.0,
    );

    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let A = -dot(in.vPosition, in.vPosition);
    if (A < -4.0) {
        discard;
    }
    let B = exp(A) * in.vColor.a;
    return vec4f(B * in.vColor.rgb, B);
}
`;

// ============================================================
// SplatRendererGPU — WebGPU implementation with GPU radix sort
// ============================================================

export class SplatRendererGPU implements ISplatRenderer {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private camera: OrbitCamera;
  private canvas: HTMLCanvasElement;
  private animationId = 0;
  private detachCamera: (() => void) | null = null;

  // Worker (texture generation only)
  private worker: Worker | null = null;

  // GPU resources
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private splatTexture: GPUTexture | null = null;
  private bindGroup: GPUBindGroup | null = null;

  // GPU sorter
  private gpuSorter: GPUSorter | null = null;
  private splatCount = 0;
  private alphaMin = 1;

  // Camera focal
  private focalX = 0;
  private focalY = 0;

  // Stats callback
  public onStatsUpdate: ((stats: RenderStats) => void) | null = null;

  /** Factory: returns null if WebGPU is not available */
  static async create(canvas: HTMLCanvasElement): Promise<SplatRendererGPU | null> {
    if (!navigator.gpu) {
      return null;
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return null;
    }
    const device = await adapter.requestDevice();
    return new SplatRendererGPU(canvas, device);
  }

  private constructor(canvas: HTMLCanvasElement, device: GPUDevice) {
    this.canvas = canvas;
    this.device = device;
    this.camera = new OrbitCamera();
    this.detachCamera = this.camera.attach(canvas);

    const ctx = canvas.getContext("webgpu");
    if (!ctx) {
      throw new Error("Failed to get WebGPU canvas context");
    }
    this.context = ctx;

    const format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device,
      format,
      alphaMode: "premultiplied",
    });

    this.initPipeline(format);
    this.initWorker();
  }

  private initPipeline(format: GPUTextureFormat): void {
    const device = this.device;

    const shaderModule = device.createShaderModule({ code: SPLAT_WGSL });

    // Uniform buffer: projection(64) + view(64) + focal(8) + viewport(8) = 144 bytes
    this.uniformBuffer = device.createBuffer({
      size: 144,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create a 1x1 placeholder texture (will be replaced when data arrives)
    this.splatTexture = device.createTexture({
      size: [1, 1],
      format: "rgba32uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          texture: { sampleType: "uint" },
        },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });

    this.pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [
          {
            // Per-instance sorted index
            arrayStride: 4,
            stepMode: "instance",
            attributes: [{ shaderLocation: 0, offset: 0, format: "uint32" }],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format,
            blend: {
              color: {
                srcFactor: "one-minus-dst-alpha",
                dstFactor: "one",
                operation: "add",
              },
              alpha: {
                srcFactor: "one-minus-dst-alpha",
                dstFactor: "one",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: {
        topology: "triangle-strip",
        stripIndexFormat: undefined,
      },
    });

    this.rebuildBindGroup();
  }

  private rebuildBindGroup(): void {
    if (!this.pipeline || !this.uniformBuffer || !this.splatTexture) return;

    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.splatTexture.createView() },
      ],
    });
  }

  private initWorker(): void {
    const blob = new Blob([createWorkerCode()], { type: "application/javascript" });
    this.worker = new Worker(URL.createObjectURL(blob));

    this.worker.onerror = (e) => {
      console.error("[GS-GPU] Worker error:", e.message, e);
    };

    this.worker.onmessage = (e: MessageEvent) => {
      if (e.data.texdata) {
        const { texdata, texwidth, texheight } = e.data as {
          texdata: Uint32Array;
          texwidth: number;
          texheight: number;
        };
        this.uploadTexture(texdata, texwidth, texheight);

        // Create GPU sorter now that texture is ready
        if (this.splatTexture && this.splatCount > 0) {
          this.gpuSorter?.dispose();
          this.gpuSorter = new GPUSorter(this.device, this.splatCount, this.splatTexture);
        }
      }
      // depthIndex messages from Worker are ignored — GPU sort handles it
    };
  }

  private uploadTexture(texdata: Uint32Array, texwidth: number, texheight: number): void {
    const device = this.device;

    this.splatTexture?.destroy();
    this.splatTexture = device.createTexture({
      size: [texwidth, texheight],
      format: "rgba32uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    device.queue.writeTexture(
      { texture: this.splatTexture },
      texdata.buffer,
      { bytesPerRow: texwidth * 16, rowsPerImage: texheight },
      { width: texwidth, height: texheight },
    );

    this.rebuildBindGroup();
  }

  public setCullParams(params: CullParams): void {
    this.alphaMin = params.alphaMin;
  }

  public setData(msg: GaussianSplatMsg): void {
    const count = msg.count;
    this.splatCount = count;

    // Pack into 32-byte format (same as WebGL version)
    const buffer = new ArrayBuffer(32 * count);
    const f = new Float32Array(buffer);
    const u = new Uint8Array(buffer);

    for (let i = 0; i < count; i++) {
      f[8 * i + 0] = msg.positions[i * 3 + 0]!;
      f[8 * i + 1] = msg.positions[i * 3 + 1]!;
      f[8 * i + 2] = msg.positions[i * 3 + 2]!;
      f[8 * i + 3] = msg.scales[i * 3 + 0]!;
      f[8 * i + 4] = msg.scales[i * 3 + 1]!;
      f[8 * i + 5] = msg.scales[i * 3 + 2]!;
      u[32 * i + 24] = Math.round(Math.min(1, Math.max(0, msg.colors[i * 3 + 0]!)) * 255);
      u[32 * i + 25] = Math.round(Math.min(1, Math.max(0, msg.colors[i * 3 + 1]!)) * 255);
      u[32 * i + 26] = Math.round(Math.min(1, Math.max(0, msg.colors[i * 3 + 2]!)) * 255);
      u[32 * i + 27] = Math.round(Math.min(1, Math.max(0, msg.opacities[i]!)) * 255);
      u[32 * i + 28] = Math.round(Math.min(1, Math.max(-1, msg.rotations[i * 4 + 0]!)) * 128 + 128);
      u[32 * i + 29] = Math.round(Math.min(1, Math.max(-1, msg.rotations[i * 4 + 1]!)) * 128 + 128);
      u[32 * i + 30] = Math.round(Math.min(1, Math.max(-1, msg.rotations[i * 4 + 2]!)) * 128 + 128);
      u[32 * i + 31] = Math.round(Math.min(1, Math.max(-1, msg.rotations[i * 4 + 3]!)) * 128 + 128);
    }

    // Worker handles texture generation only (buffer is transferred)
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
    const canvas = this.canvas;
    const device = this.device;

    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      this.context.configure({
        device,
        format: navigator.gpu.getPreferredCanvasFormat(),
        alphaMode: "premultiplied",
      });
    }

    // --- Focal length from camera FOV ---
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const f = 1 / Math.tan(fovRad / 2);
    this.focalX = (f * h) / 2;
    this.focalY = (f * h) / 2;

    // --- Projection ---
    const znear = this.camera.near;
    const zfar = this.camera.far;
    // prettier-ignore
    const projMat = new Float32Array([
      -(2 * this.focalX) / w, 0, 0, 0,
      0, (2 * this.focalY) / h, 0, 0,
      0, 0, zfar / (zfar - znear), 1,
      0, 0, -(zfar * znear) / (zfar - znear), 0,
    ]);

    // --- View: flip Y+Z rows to match COLMAP convention ---
    const viewMat = this.camera.getViewMatrix();
    viewMat[1] = -viewMat[1]!;
    viewMat[5] = -viewMat[5]!;
    viewMat[9] = -viewMat[9]!;
    viewMat[13] = -viewMat[13]!;
    viewMat[2] = -viewMat[2]!;
    viewMat[6] = -viewMat[6]!;
    viewMat[10] = -viewMat[10]!;
    viewMat[14] = -viewMat[14]!;

    const viewProj = multiply4(projMat, viewMat);

    // --- Update uniform buffer ---
    const uniformData = new Float32Array(36);
    uniformData.set(projMat, 0);
    uniformData.set(viewMat, 16);
    uniformData[32] = this.focalX;
    uniformData[33] = this.focalY;
    uniformData[34] = w;
    uniformData[35] = h;
    device.queue.writeBuffer(this.uniformBuffer!, 0, uniformData);

    // --- Command encoder ---
    const commandEncoder = device.createCommandEncoder();

    // --- GPU sort (compute pass) ---
    if (this.gpuSorter) {
      this.gpuSorter.sort(commandEncoder, viewProj, this.alphaMin);
      this.gpuSorter.readbackVisibleCount(commandEncoder, (visibleCount) => {
        this.onStatsUpdate?.({ totalCount: this.splatCount, visibleCount });
      });
    }

    // --- Render pass ---
    const textureView = this.context.getCurrentTexture().createView();
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    if (this.gpuSorter && this.pipeline && this.bindGroup) {
      passEncoder.setPipeline(this.pipeline);
      passEncoder.setBindGroup(0, this.bindGroup);
      passEncoder.setVertexBuffer(0, this.gpuSorter.sortedValuesBuffer);
      passEncoder.drawIndirect(this.gpuSorter.indirectDrawBuffer, 0);
    }

    passEncoder.end();
    device.queue.submit([commandEncoder.finish()]);
  }

  public dispose(): void {
    this.stopLoop();
    this.detachCamera?.();
    this.worker?.terminate();
    this.worker = null;
    this.gpuSorter?.dispose();
    this.gpuSorter = null;
    this.uniformBuffer?.destroy();
    this.splatTexture?.destroy();
    this.device.destroy();
  }
}
