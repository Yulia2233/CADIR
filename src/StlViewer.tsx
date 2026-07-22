import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { Box, Download, Focus, LoaderCircle, ScanLine } from "lucide-react";

type StlViewerProps = {
  url: string | null;
  filename: string;
  generatedAt?: string;
  size?: number;
  isGenerating: boolean;
};

function formatBytes(value?: number) {
  if (value === undefined) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export default function StlViewer({ url, filename, generatedAt, size, isGenerating }: StlViewerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const resetRef = useRef<(() => void) | null>(null);
  const materialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    setLoading(Boolean(url));
    setError(undefined);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf4f5f2);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 10_000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x788176, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 3.4);
    key.position.set(45, 70, 35);
    key.castShadow = true;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xb7d8ff, 1.4);
    rim.position.set(-40, 20, -45);
    scene.add(rim);

    const grid = new THREE.GridHelper(140, 14, 0xb8bdb7, 0xd9dcd7);
    grid.visible = false;
    scene.add(grid);

    let model: THREE.Mesh | null = null;
    let disposed = false;
    const fitCamera = (bounds?: THREE.Box3) => {
      if (!bounds || bounds.isEmpty()) {
        camera.position.set(82, 62, 88);
        controls.target.set(0, 3, 0);
        controls.update();
        return;
      }
      const center = bounds.getCenter(new THREE.Vector3());
      const sphere = bounds.getBoundingSphere(new THREE.Sphere());
      const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov / 2);
      const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect);
      const limitingHalfFov = Math.max(Math.min(verticalHalfFov, horizontalHalfFov), 0.05);
      const distance = Math.max((sphere.radius / Math.sin(limitingHalfFov)) * 1.12, 10);
      camera.near = Math.max(distance / 1000, 0.01);
      camera.far = distance * 20;
      camera.position.copy(center).add(new THREE.Vector3(1, 0.75, 1).normalize().multiplyScalar(distance));
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
    };
    resetRef.current = () => fitCamera(model ? new THREE.Box3().setFromObject(model) : undefined);
    fitCamera();

    if (url) {
      new STLLoader().load(
        url,
        (geometry) => {
          if (disposed) {
            geometry.dispose();
            return;
          }
          geometry.computeVertexNormals();
          geometry.center();
          const material = new THREE.MeshStandardMaterial({
            color: 0xb9c1b8,
            metalness: 0.55,
            roughness: 0.42,
            wireframe,
          });
          materialRef.current = material;
          model = new THREE.Mesh(geometry, material);
          model.castShadow = true;
          model.receiveShadow = true;
          scene.add(model);
          const bounds = new THREE.Box3().setFromObject(model);
          const minimum = bounds.min.y;
          grid.position.y = minimum;
          grid.visible = true;
          fitCamera(bounds);
          setLoading(false);
        },
        undefined,
        () => {
          if (disposed) return;
          setLoading(false);
          setError("STL 文件加载失败");
        },
      );
    }

    const resize = () => {
      const { clientWidth, clientHeight } = mount;
      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / Math.max(clientHeight, 1);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();

    let frame = 0;
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      resetRef.current = null;
      controls.dispose();
      if (model) {
        model.geometry.dispose();
        (model.material as THREE.Material).dispose();
      }
      materialRef.current = null;
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [url]);

  useEffect(() => {
    if (materialRef.current) materialRef.current.wireframe = wireframe;
  }, [wireframe]);

  return (
    <section className="viewer-pane" aria-label="最新 STL 模型">
      <header className="viewer-header">
        <div><p className="eyebrow">最新验证模型</p><h2>{filename}</h2></div>
        {url ? <a className="icon-button" href={url} download={filename} aria-label="下载 STL" title="下载 STL"><Download size={17} /></a> : <button className="icon-button" type="button" disabled aria-label="暂无 STL"><Download size={17} /></button>}
      </header>

      <div className="viewer-canvas" ref={mountRef}>
        {!url && <div className="viewer-empty"><Box size={26} /><span>通过验证的 STL 将显示在这里</span></div>}
        {loading && <div className="viewer-loading"><LoaderCircle className="spin" size={18} /> 正在加载 STL</div>}
        {error && <div className="viewer-loading viewer-error">{error}</div>}
        {isGenerating && <div className="viewer-notice"><LoaderCircle className="spin" size={14} /> 正在生成新版本</div>}
      </div>

      <div className="viewer-toolbar" aria-label="模型查看工具">
        <button className="tool-button" type="button" onClick={() => resetRef.current?.()} disabled={!url}><Focus size={16} /> 重置视角</button>
        <button className={`tool-button ${wireframe ? "active" : ""}`} type="button" onClick={() => setWireframe((value) => !value)} disabled={!url}><ScanLine size={16} /> 线框</button>
      </div>

      <footer className="viewer-meta">
        <span><Box size={14} /> {url ? `STL${size ? ` · ${formatBytes(size)}` : ""}` : "暂无模型"}</span>
        <span>{generatedAt ? new Date(generatedAt).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : ""}</span>
      </footer>
    </section>
  );
}
