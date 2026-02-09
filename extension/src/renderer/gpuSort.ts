/// <reference types="@webgpu/types" />
import { RadixSortKernel } from "webgpu-radix-sort";

// Compute shader: read positions from splat texture, compute depth, write keys+values
const CALC_DEPTHS_WGSL = /* wgsl */ `
struct Params {
    viewProj2: vec4f,   // row 2 of viewProj matrix (depth column)
    count: u32,
    alphaMin: u32,
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var u_texture: texture_2d<u32>;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var<storage, read_write> keys: array<u32>;
@group(0) @binding(3) var<storage, read_write> values: array<u32>;
@group(0) @binding(4) var<storage, read_write> drawIndirect: array<atomic<u32>, 4>;

fn floatFlip(f: f32) -> u32 {
    let bits = bitcast<u32>(f);
    let mask = select(0x80000000u, 0xFFFFFFFFu, (bits & 0x80000000u) != 0u);
    return bits ^ mask;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let i = gid.x;
    if (i >= params.count) { return; }

    // Read position from texture (same layout as vertex shader)
    let texCoord = vec2u((i & 0x3ffu) << 1u, i >> 10u);
    let cen = textureLoad(u_texture, texCoord, 0);
    let pos = vec3f(bitcast<f32>(cen.x), bitcast<f32>(cen.y), bitcast<f32>(cen.z));

    // Read alpha from texture (texel[2i+1].w, byte 3)
    let texCoord1 = vec2u(((i & 0x3ffu) << 1u) | 1u, i >> 10u);
    let cov = textureLoad(u_texture, texCoord1, 0);
    let alpha = (cov.w >> 24u) & 0xffu;

    // Cull by alpha
    if (alpha < params.alphaMin) {
        keys[i] = 0xFFFFFFFFu;
        values[i] = i;
        return;
    }

    // Depth = dot(viewProj row2, pos)
    let depth = params.viewProj2.x * pos.x + params.viewProj2.y * pos.y + params.viewProj2.z * pos.z + params.viewProj2.w;
    keys[i] = floatFlip(depth);
    values[i] = i;

    // Count visible splats
    atomicAdd(&drawIndirect[1], 1u);
}
`;

/**
 * GPU-side depth calculation + radix sort.
 * Replaces the CPU Worker sort for the WebGPU path.
 */
export class GPUSorter {
  private device: GPUDevice;
  private count: number;

  // Compute pipeline for depth calculation
  private depthPipeline: GPUComputePipeline;
  private depthBindGroupLayout: GPUBindGroupLayout;
  private depthBindGroup: GPUBindGroup | null = null;

  // Buffers
  private keysBuffer: GPUBuffer;
  private valuesBuffer: GPUBuffer;
  private paramsBuffer: GPUBuffer;
  private indirectBuffer: GPUBuffer;
  private readbackBuffer: GPUBuffer;

  // Radix sort kernel
  private sortKernel: RadixSortKernel;

  // Readback state — prevents race condition when mapAsync is pending
  private readbackPending = false;

  constructor(device: GPUDevice, count: number, texture: GPUTexture) {
    this.device = device;
    this.count = count;

    // Keys buffer (depth as sortable u32)
    this.keysBuffer = device.createBuffer({
      label: "sort-keys",
      size: count * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    // Values buffer (splat indices) — also used as vertex buffer for drawing
    this.valuesBuffer = device.createBuffer({
      label: "sort-values",
      size: count * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | GPUBufferUsage.VERTEX,
    });

    // Uniform params for depth compute
    this.paramsBuffer = device.createBuffer({
      label: "sort-params",
      size: 32, // vec4f(16) + u32 count(4) + u32 alphaMin(4) + padding(8)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Indirect draw buffer: [vertexCount=4, instanceCount, firstVertex=0, firstInstance=0]
    this.indirectBuffer = device.createBuffer({
      label: "sort-indirect",
      size: 16,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    // Readback buffer for stats
    this.readbackBuffer = device.createBuffer({
      label: "sort-readback",
      size: 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    // Depth compute pipeline
    const shaderModule = device.createShaderModule({ code: CALC_DEPTHS_WGSL });

    this.depthBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });

    this.depthPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.depthBindGroupLayout] }),
      compute: { module: shaderModule, entryPoint: "main" },
    });

    this.rebuildDepthBindGroup(texture);

    // Radix sort kernel
    this.sortKernel = new RadixSortKernel({
      device,
      keys: this.keysBuffer,
      values: this.valuesBuffer,
      count,
      bit_count: 32,
      workgroup_size: { x: 16, y: 16 },
    });
  }

  /** Rebuild bind group when texture changes (e.g. new data loaded) */
  rebuildDepthBindGroup(texture: GPUTexture): void {
    this.depthBindGroup = this.device.createBindGroup({
      layout: this.depthBindGroupLayout,
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: { buffer: this.paramsBuffer } },
        { binding: 2, resource: { buffer: this.keysBuffer } },
        { binding: 3, resource: { buffer: this.valuesBuffer } },
        { binding: 4, resource: { buffer: this.indirectBuffer } },
      ],
    });
  }

  /** Run depth calculation + radix sort. Call once per frame (or when view changes). */
  sort(encoder: GPUCommandEncoder, viewProj: Float32Array, alphaMin: number): void {
    // Update params: viewProj row 2 (elements [2,6,10,14] in column-major)
    const params = new ArrayBuffer(32);
    const f32 = new Float32Array(params);
    const u32 = new Uint32Array(params);
    f32[0] = viewProj[2]!;
    f32[1] = viewProj[6]!;
    f32[2] = viewProj[10]!;
    f32[3] = viewProj[14]!;
    u32[4] = this.count;
    u32[5] = alphaMin;
    this.device.queue.writeBuffer(this.paramsBuffer, 0, params);

    // Reset indirect buffer: vertexCount=4, instanceCount=0, firstVertex=0, firstInstance=0
    this.device.queue.writeBuffer(this.indirectBuffer, 0, new Uint32Array([4, 0, 0, 0]));

    // Compute pass: depth calc + radix sort
    const pass = encoder.beginComputePass();

    // 1. Calculate depths
    pass.setPipeline(this.depthPipeline);
    pass.setBindGroup(0, this.depthBindGroup!);
    pass.dispatchWorkgroups(Math.ceil(this.count / 256));

    // 2. Radix sort
    this.sortKernel.dispatch(pass);

    pass.end();
  }

  /** Async readback of visible count for stats display */
  readbackVisibleCount(encoder: GPUCommandEncoder, callback: (visibleCount: number) => void): void {
    // Skip if previous readback hasn't completed — buffer may be in "mapping pending" state,
    // which would cause a validation error on copyBufferToBuffer and fail the entire submit.
    if (this.readbackPending) return;
    this.readbackPending = true;

    encoder.copyBufferToBuffer(this.indirectBuffer, 4, this.readbackBuffer, 0, 4);
    // Schedule readback after submit
    this.device.queue.onSubmittedWorkDone().then(() => {
      this.readbackBuffer.mapAsync(GPUMapMode.READ).then(() => {
        const data = new Uint32Array(this.readbackBuffer.getMappedRange());
        const count = data[0]!;
        this.readbackBuffer.unmap();
        this.readbackPending = false;
        callback(count);
      }).catch(() => { this.readbackPending = false; });
    }).catch(() => { this.readbackPending = false; });
  }

  get sortedValuesBuffer(): GPUBuffer {
    return this.valuesBuffer;
  }

  get indirectDrawBuffer(): GPUBuffer {
    return this.indirectBuffer;
  }

  get totalCount(): number {
    return this.count;
  }

  dispose(): void {
    this.keysBuffer.destroy();
    this.valuesBuffer.destroy();
    this.paramsBuffer.destroy();
    this.indirectBuffer.destroy();
    this.readbackBuffer.destroy();
  }
}
