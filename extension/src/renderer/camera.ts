/** 簡易 Orbit Camera — マウスドラッグで回転、ホイールでズーム */
export class OrbitCamera {
  /** 注視点を中心とした球面座標 */
  public theta = 0; // 水平角 (rad)
  public phi = Math.PI / 4; // 仰角 (rad)
  public radius = 5; // 距離

  /** 注視点 */
  public targetX = 0;
  public targetY = 0;
  public targetZ = 0;

  /** 画角 */
  public fov = 60; // degrees
  public near = 0.01;
  public far = 1000;

  private dragging = false;
  private panning = false;
  private lastX = 0;
  private lastY = 0;

  public attach(canvas: HTMLCanvasElement): () => void {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 0) {
        this.dragging = true;
      } else if (e.button === 1 || e.button === 2) {
        this.panning = true;
      }
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    };

    const onMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;

      if (this.dragging) {
        this.theta -= dx * 0.005;
        this.phi = Math.max(0.01, Math.min(Math.PI - 0.01, this.phi - dy * 0.005));
      } else if (this.panning) {
        const panSpeed = this.radius * 0.002;
        // カメラの右方向と上方向でパン
        const sinT = Math.sin(this.theta);
        const cosT = Math.cos(this.theta);
        // 右方向
        this.targetX += -sinT * dx * panSpeed;
        this.targetZ += cosT * dx * panSpeed;
        // 上方向（簡易: Y軸方向）
        this.targetY += dy * panSpeed;
      }
    };

    const onMouseUp = () => {
      this.dragging = false;
      this.panning = false;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      this.radius *= 1 + e.deltaY * 0.001;
      this.radius = Math.max(0.1, Math.min(500, this.radius));
    };

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("mouseleave", onMouseUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContextMenu);

    return () => {
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("mouseleave", onMouseUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
    };
  }

  /** カメラのワールド座標 */
  public getEye(): [number, number, number] {
    const sinPhi = Math.sin(this.phi);
    return [
      this.targetX + this.radius * sinPhi * Math.cos(this.theta),
      this.targetY + this.radius * Math.cos(this.phi),
      this.targetZ + this.radius * sinPhi * Math.sin(this.theta),
    ];
  }

  /** View 行列（4x4, column-major） */
  public getViewMatrix(): Float32Array {
    const eye = this.getEye();
    return lookAt(eye, [this.targetX, this.targetY, this.targetZ], [0, 1, 0]);
  }

  /** Projection 行列（4x4, column-major） */
  public getProjectionMatrix(aspect: number): Float32Array {
    return perspective((this.fov * Math.PI) / 180, aspect, this.near, this.far);
  }
}

/** lookAt (column-major) */
function lookAt(
  eye: [number, number, number],
  target: [number, number, number],
  up: [number, number, number],
): Float32Array {
  let fx = target[0] - eye[0];
  let fy = target[1] - eye[1];
  let fz = target[2] - eye[2];
  let len = Math.sqrt(fx * fx + fy * fy + fz * fz);
  fx /= len; fy /= len; fz /= len;

  let sx = fy * up[2] - fz * up[1];
  let sy = fz * up[0] - fx * up[2];
  let sz = fx * up[1] - fy * up[0];
  len = Math.sqrt(sx * sx + sy * sy + sz * sz);
  sx /= len; sy /= len; sz /= len;

  const ux = sy * fz - sz * fy;
  const uy = sz * fx - sx * fz;
  const uz = sx * fy - sy * fx;

  // prettier-ignore
  return new Float32Array([
    sx, ux, -fx, 0,
    sy, uy, -fy, 0,
    sz, uz, -fz, 0,
    -(sx * eye[0] + sy * eye[1] + sz * eye[2]),
    -(ux * eye[0] + uy * eye[1] + uz * eye[2]),
    (fx * eye[0] + fy * eye[1] + fz * eye[2]),
    1,
  ]);
}

/** Perspective projection (column-major) */
function perspective(fovRad: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovRad / 2);
  const rangeInv = 1 / (near - far);

  // prettier-ignore
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (near + far) * rangeInv, -1,
    0, 0, 2 * near * far * rangeInv, 0,
  ]);
}
