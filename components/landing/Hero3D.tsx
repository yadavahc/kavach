"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Incoming call as a waveform travelling toward the viewer: retrieval matches
 * ignite as points along it, and a shield forms before it lands.
 *
 * Deliberately cheap and late: the canvas is only created once the hero is on
 * screen and the browser is idle, three.js is code-split, the pixel ratio is
 * capped, and the loop stops when the tab is hidden. A static poster frame is
 * the first paint and the only frame under prefers-reduced-motion, so the
 * animation never sits on the critical path.
 */
export function Hero3D() {
  const host = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let cancelled = false;
    let dispose: (() => void) | undefined;
    const idle = (fn: () => void) => (typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(fn, { timeout: 1200 }) : setTimeout(fn, 400));

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      idle(() => {
        void (async () => {
          const THREE = await import("three");
          if (cancelled || !host.current) return;

          const width = () => host.current?.clientWidth ?? 1;
          const height = () => host.current?.clientHeight ?? 1;
          const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
          renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
          renderer.setSize(width(), height());
          host.current.appendChild(renderer.domElement);
          renderer.domElement.style.display = "block";

          const scene = new THREE.Scene();
          const camera = new THREE.PerspectiveCamera(42, width() / height(), 0.1, 120);
          camera.position.set(0, 1.15, 7.2);
          camera.lookAt(0, 0.1, -6);

          // Waveform: a polyline in z, redrawn each frame as the call moves toward the viewer.
          const COUNT = 260;
          const SPAN = 46;
          const positions = new Float32Array(COUNT * 3);
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
          const wave = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0x9ad7ff, transparent: true, opacity: 0.85 }));
          scene.add(wave);

          // Match points ignite where retrieval finds a scam pattern.
          const SPARKS = 34;
          const sparkPositions = new Float32Array(SPARKS * 3);
          const sparkGeometry = new THREE.BufferGeometry();
          sparkGeometry.setAttribute("position", new THREE.BufferAttribute(sparkPositions, 3));
          const sparks = new THREE.Points(sparkGeometry, new THREE.PointsMaterial({ color: 0xff4d5e, size: 0.085, transparent: true, opacity: 0.95, sizeAttenuation: true }));
          scene.add(sparks);

          // Shield: a hexagonal ring that closes in front of the viewer.
          const shield = new THREE.Group();
          const ring = new THREE.Mesh(new THREE.RingGeometry(1.62, 1.72, 6), new THREE.MeshBasicMaterial({ color: 0x9ad7ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
          const inner = new THREE.Mesh(new THREE.CircleGeometry(1.62, 6), new THREE.MeshBasicMaterial({ color: 0x7aa2ff, transparent: true, opacity: 0.06, side: THREE.DoubleSide }));
          shield.add(ring, inner);
          shield.position.set(0, 0.15, 1.2);
          shield.rotation.z = Math.PI / 6;
          scene.add(shield);

          const onResize = () => {
            renderer.setSize(width(), height());
            camera.aspect = width() / height();
            camera.updateProjectionMatrix();
          };
          window.addEventListener("resize", onResize);

          let raf = 0;
          let t = 0;
          const clock = new THREE.Clock();
          const render = () => {
            const dt = Math.min(clock.getDelta(), 0.05);
            t += dt;
            const travel = (t * 2.6) % SPAN;

            for (let i = 0; i < COUNT; i++) {
              const u = i / (COUNT - 1);
              const z = -SPAN + u * SPAN + travel;
              const env = Math.max(0, 1 - Math.abs(z + 6) / 26);
              const speech = Math.sin(u * 46 + t * 5) * 0.55 + Math.sin(u * 17 - t * 2.2) * 0.3 + Math.sin(u * 91 + t * 8) * 0.12;
              positions[i * 3] = (u - 0.5) * 0.7;
              positions[i * 3 + 1] = speech * (0.28 + env * 0.85);
              positions[i * 3 + 2] = z;
            }
            geometry.attributes.position!.needsUpdate = true;

            for (let s = 0; s < SPARKS; s++) {
              const phase = (s / SPARKS + t * 0.08) % 1;
              const z = -SPAN + phase * SPAN + travel * 0.0;
              const i = Math.min(COUNT - 1, Math.round(phase * (COUNT - 1)));
              sparkPositions[s * 3] = positions[i * 3]!;
              sparkPositions[s * 3 + 1] = positions[i * 3 + 1]! * 1.05;
              sparkPositions[s * 3 + 2] = z;
            }
            sparkGeometry.attributes.position!.needsUpdate = true;

            const pulse = 0.5 + 0.5 * Math.sin(t * 1.35);
            ring.material.opacity = 0.32 + pulse * 0.42;
            inner.material.opacity = 0.03 + pulse * 0.07;
            shield.rotation.z = Math.PI / 6 + Math.sin(t * 0.25) * 0.05;
            shield.scale.setScalar(0.97 + pulse * 0.035);

            renderer.render(scene, camera);
            raf = requestAnimationFrame(render);
          };

          const onVisibility = () => {
            cancelAnimationFrame(raf);
            if (!document.hidden) {
              clock.getDelta();
              raf = requestAnimationFrame(render);
            }
          };
          document.addEventListener("visibilitychange", onVisibility);
          raf = requestAnimationFrame(render);
          setLive(true);

          dispose = () => {
            cancelAnimationFrame(raf);
            window.removeEventListener("resize", onResize);
            document.removeEventListener("visibilitychange", onVisibility);
            renderer.domElement.remove();
            renderer.dispose();
            geometry.dispose();
            sparkGeometry.dispose();
            ring.geometry.dispose();
            inner.geometry.dispose();
            (wave.material as { dispose(): void }).dispose();
            (sparks.material as { dispose(): void }).dispose();
            ring.material.dispose();
            inner.material.dispose();
          };
        })();
      });
    }, { rootMargin: "200px" });

    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
      dispose?.();
    };
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <div ref={host} className="absolute inset-0" />
      {!live && <HeroPoster />}
      <div className="absolute inset-0 bg-gradient-to-b from-ink/10 via-ink/40 to-ink" />
    </div>
  );
}

/** First paint and the only frame when motion is reduced. */
export function HeroPoster() {
  const points = Array.from({ length: 120 }, (_, i) => {
    const u = i / 119;
    const y = (Math.sin(u * 46) * 0.55 + Math.sin(u * 17) * 0.3 + Math.sin(u * 91) * 0.12) * (0.3 + Math.max(0, 1 - Math.abs(u - 0.62) * 2.4) * 0.9);
    return `${(u * 900).toFixed(1)},${(180 - y * 110).toFixed(1)}`;
  }).join(" ");
  return (
    <svg viewBox="0 0 900 360" className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid slice">
      <polyline points={points} fill="none" stroke="#9ad7ff" strokeWidth="1.6" opacity="0.8" />
      {[0.28, 0.44, 0.58, 0.69, 0.78].map((u) => (
        <circle key={u} cx={u * 900} cy={180 - (Math.sin(u * 46) * 0.55 + Math.sin(u * 17) * 0.3) * 60} r="3.2" fill="#ff4d5e" />
      ))}
      <g transform="translate(700 180)" opacity="0.65">
        <polygon points="0,-86 74,-43 74,43 0,86 -74,43 -74,-43" fill="none" stroke="#9ad7ff" strokeWidth="2.4" />
        <polygon points="0,-86 74,-43 74,43 0,86 -74,43 -74,-43" fill="#7aa2ff" opacity="0.06" />
      </g>
    </svg>
  );
}
