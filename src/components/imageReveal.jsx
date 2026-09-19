'use client';

import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';

/**
 * LiquidFluidReveal
 * ------------------
 * A real stable-fluids simulation (the same technique as the Navier–Stokes
 * "splat → divergence → pressure (Jacobi) → gradient-subtract → advect"
 * pipeline in the reference demo) driving a *reveal* instead of a
 * standalone distortion.
 *
 * At rest, `topSrc` covers the whole element. On hover, a circle centered
 * on the cursor reveals `bottomSrc` underneath. The circle's edge is not
 * a clean geometric boundary — it's pushed and rippled by the live
 * velocity/dye fields, so dragging the cursor around makes the reveal
 * boundary trail and swirl like it's cutting through liquid. On mouse
 * leave, the circle tweens back to zero (GSAP) while the fluid keeps
 * dissipating naturally on its own for a couple hundred ms.
 *
 * Two float-texture fields drive it:
 *  - velocity: vec2 field, splatted with the pointer's movement delta,
 *    made incompressible each frame via the standard divergence →
 *    16-iteration Jacobi pressure solve → gradient-subtract steps, then
 *    advected by itself (self-advection = the actual "fluid" part).
 *  - dye: a scalar field splatted at the pointer on every move and
 *    advected/decayed by the velocity field — this is what gives the
 *    liquid a trailing, decaying ripple instead of an instant snap.
 *
 * The display pass reads both fields to (a) bend the reveal circle's
 * edge outward/inward per-pixel and (b) apply a small UV warp to both
 * images right at the transition band, so the boundary itself looks wet
 * rather than just organically shaped.
 *
 * Requires OES_texture_float. Falls back to a plain CSS circular
 * clip-path reveal (still cursor-following, just without the liquid
 * warp) if that extension isn't available.
 *
 * Props:
 *  - topSrc, bottomSrc: image URLs
 *  - revealRadius: radius of the fully-revealed circle in normalized,
 *    aspect-corrected units (try 0.28–0.5)
 *  - cursorSize: splat footprint — bigger = fatter velocity/dye blobs
 *  - cursorPower: how hard movement pushes the fluid
 *  - disturbPower: how much the velocity/dye fields bend the reveal edge
 *    and warp the images near it
 *  - pressureIterations: Jacobi solver iterations (16 is a good default;
 *    lower is cheaper and slightly less incompressible/"clean")
 *  - simResolution: baseline sim texture resolution (perf vs. detail)
 */
export default function LiquidFluidReveal({
    topSrc,
    bottomSrc,
    revealRadius = 0.2,
    cursorSize = 2,
    cursorPower = 0.5,
    disturbPower = 0.4,
    pressureIterations = 16,
    simResolution = 160,
    alt = '',
    className = '',
    children,
}) {
    const wrapRef = useRef(null);
    const canvasRef = useRef(null);
    const stateRef = useRef(null); // holds all GL/session state so effect cleanup can tear it down
    const radiusRef = useRef({ value: 0 });
    const radiusTweenRef = useRef(null);
    const fallbackRef = useRef(false);

    useEffect(() => {
        const wrap = wrapRef.current;
        const canvas = canvasRef.current;
        if (!wrap || !canvas) return;

        const gl = canvas.getContext('webgl', { premultipliedAlpha: false, alpha: true })
            || canvas.getContext('experimental-webgl', { premultipliedAlpha: false, alpha: true });

        const floatExt = gl && gl.getExtension('OES_texture_float');
        if (!gl || !floatExt) {
            fallbackRef.current = true;
            return;
        }
        // Optional: smoother sampling of the sim fields if the device supports it.
        const linearFloat = gl.getExtension('OES_texture_float_linear');
        const fieldFilter = linearFloat ? gl.LINEAR : gl.NEAREST;

        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

        // ---------- shader sources ----------
        const vertSrc = `
      precision highp float;
      attribute vec2 aPosition;
      varying vec2 vUv;
      void main() {
        vUv = aPosition * 0.5 + 0.5;
        gl_Position = vec4(aPosition, 0.0, 1.0);
      }
    `;

        const splatFrag = `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D u_input_texture;
      uniform float u_ratio;
      uniform vec2 u_point;
      uniform vec3 u_point_value;
      uniform float u_point_size;
      void main() {
        vec2 p = vUv - u_point;
        p.x *= u_ratio;
        vec3 base = texture2D(u_input_texture, vUv).xyz;
        float falloff = exp(-dot(p, p) / u_point_size);
        gl_FragColor = vec4(base + u_point_value * falloff, 1.0);
      }
    `;

        const divergenceFrag = `
      precision highp float;
      varying vec2 vUv;
      uniform vec2 u_texel;
      uniform sampler2D u_velocity_texture;
      void main() {
        float L = texture2D(u_velocity_texture, vUv - vec2(u_texel.x, 0.0)).x;
        float R = texture2D(u_velocity_texture, vUv + vec2(u_texel.x, 0.0)).x;
        float B = texture2D(u_velocity_texture, vUv - vec2(0.0, u_texel.y)).y;
        float T = texture2D(u_velocity_texture, vUv + vec2(0.0, u_texel.y)).y;
        float div = 0.5 * ((R - L) + (T - B));
        gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
      }
    `;

        const pressureFrag = `
      precision highp float;
      varying vec2 vUv;
      uniform vec2 u_texel;
      uniform sampler2D u_divergence_texture;
      uniform sampler2D u_pressure_texture;
      void main() {
        float L = texture2D(u_pressure_texture, vUv - vec2(u_texel.x, 0.0)).x;
        float R = texture2D(u_pressure_texture, vUv + vec2(u_texel.x, 0.0)).x;
        float B = texture2D(u_pressure_texture, vUv - vec2(0.0, u_texel.y)).x;
        float T = texture2D(u_pressure_texture, vUv + vec2(0.0, u_texel.y)).x;
        float div = texture2D(u_divergence_texture, vUv).x;
        float p = (L + R + B + T - div) * 0.25;
        gl_FragColor = vec4(p, 0.0, 0.0, 1.0);
      }
    `;

        const gradientSubtractFrag = `
      precision highp float;
      varying vec2 vUv;
      uniform vec2 u_texel;
      uniform sampler2D u_pressure_texture;
      uniform sampler2D u_velocity_texture;
      void main() {
        float L = texture2D(u_pressure_texture, vUv - vec2(u_texel.x, 0.0)).x;
        float R = texture2D(u_pressure_texture, vUv + vec2(u_texel.x, 0.0)).x;
        float B = texture2D(u_pressure_texture, vUv - vec2(0.0, u_texel.y)).x;
        float T = texture2D(u_pressure_texture, vUv + vec2(0.0, u_texel.y)).x;
        vec2 vel = texture2D(u_velocity_texture, vUv).xy;
        vel -= 0.5 * vec2(R - L, T - B);
        gl_FragColor = vec4(vel, 0.0, 1.0);
      }
    `;

        const advectionFrag = `
      precision highp float;
      varying vec2 vUv;
      uniform vec2 u_texel;
      uniform sampler2D u_velocity_texture;
      uniform sampler2D u_input_texture;
      uniform float u_dt;
      uniform float u_dissipation;
      void main() {
        vec2 vel = texture2D(u_velocity_texture, vUv).xy;
        vec2 coord = vUv - u_dt * vel * u_texel;
        gl_FragColor = u_dissipation * texture2D(u_input_texture, coord);
      }
    `;

        const displayFrag = `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D u_velocity_texture;
      uniform sampler2D u_dye_texture;
      uniform sampler2D u_texA;
      uniform sampler2D u_texB;
      uniform vec2 u_point;
      uniform float u_ratio;
      uniform float u_reveal_radius;
      uniform float u_disturb_power;
      uniform vec4 u_coverA;
      uniform vec4 u_coverB;

      void main() {
        vec2 vel = texture2D(u_velocity_texture, vUv).xy;
        float dye = texture2D(u_dye_texture, vUv).x;

        vec2 p = vUv - u_point;
        p.x *= u_ratio;
        float dist = length(p);

        // Bend the circle's edge using the live fluid fields — this is
        // what turns a plain circle into a liquid boundary.
        float edgeWarp = (dye * 0.7 + length(vel) * 12.0) * u_disturb_power * 0.05;
        float distortedDist = dist - edgeWarp;

        float mixAmount = 1.0 - smoothstep(u_reveal_radius - 0.06, u_reveal_radius + 0.06, distortedDist);
        mixAmount = clamp(mixAmount, 0.0, 1.0);

        // Only the top image gets pixel-warped as it melts away — the
        // bottom image stays clean/undistorted. The reveal boundary itself
        // is still organic because distortedDist (above) is already bent
        // by the fluid fields, independent of this UV warp.
        vec2 warpUv = vel * u_disturb_power * 0.6;

        vec2 uvA = (vUv - 0.5) * u_coverA.xy + 0.5 + u_coverA.zw + warpUv * (1.0 - mixAmount);
        vec2 uvB = (vUv - 0.5) * u_coverB.xy + 0.5 + u_coverB.zw;

        vec4 colA = texture2D(u_texA, uvA);
        vec4 colB = texture2D(u_texB, uvB);

        gl_FragColor = mix(colA, colB, mixAmount);
      }
    `;

        // ---------- shader/program helpers ----------
        function compile(type, src) {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, src);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                console.error(gl.getShaderInfoLog(shader));
                gl.deleteShader(shader);
                return null;
            }
            return shader;
        }

        function getUniforms(program) {
            const uniforms = {};
            const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
            for (let i = 0; i < count; i++) {
                const name = gl.getActiveUniform(program, i).name;
                uniforms[name] = gl.getUniformLocation(program, name);
            }
            return uniforms;
        }

        function createProgram(fragSrc) {
            const fs = compile(gl.FRAGMENT_SHADER, fragSrc);
            const program = gl.createProgram();
            gl.attachShader(program, vs);
            gl.attachShader(program, fs);
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                console.error(gl.getProgramInfoLog(program));
                return null;
            }
            return { program, uniforms: getUniforms(program) };
        }

        const vs = compile(gl.VERTEX_SHADER, vertSrc);
        const splatProgram = createProgram(splatFrag);
        const divergenceProgram = createProgram(divergenceFrag);
        const pressureProgram = createProgram(pressureFrag);
        const gradientSubtractProgram = createProgram(gradientSubtractFrag);
        const advectionProgram = createProgram(advectionFrag);
        const displayProgram = createProgram(displayFrag);

        // fullscreen quad, shared by every pass
        const quadBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

        function bindQuad(program) {
            const loc = gl.getAttribLocation(program, 'aPosition');
            gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        }

        function blit(target) {
            if (target == null) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                gl.viewport(0, 0, canvas.width, canvas.height);
            } else {
                gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
                gl.viewport(0, 0, target.width, target.height);
            }
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }

        // ---------- FBOs ----------
        function createFBO(w, h) {
            const texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, fieldFilter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, fieldFilter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.FLOAT, null);

            const fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
            gl.viewport(0, 0, w, h);
            gl.clearColor(0, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);

            return {
                texture,
                fbo,
                width: w,
                height: h,
                attach(unit) {
                    gl.activeTexture(gl.TEXTURE0 + unit);
                    gl.bindTexture(gl.TEXTURE_2D, texture);
                    return unit;
                },
            };
        }

        function createDoubleFBO(w, h) {
            let a = createFBO(w, h);
            let b = createFBO(w, h);
            return {
                width: w,
                height: h,
                texelX: 1 / w,
                texelY: 1 / h,
                read: () => a,
                write: () => b,
                swap() {
                    const t = a;
                    a = b;
                    b = t;
                },
            };
        }

        let velocity, dye, divergenceFBO, pressure;
        let simW = 2, simH = 2;

        function initSim(rect) {
            const ratio = rect.width / rect.height || 1;
            if (ratio >= 1) {
                simW = Math.round(simResolution * ratio);
                simH = simResolution;
            } else {
                simW = simResolution;
                simH = Math.round(simResolution / ratio);
            }
            velocity = createDoubleFBO(simW, simH);
            dye = createDoubleFBO(simW, simH);
            divergenceFBO = createFBO(simW, simH);
            pressure = createDoubleFBO(simW, simH);
        }

        // ---------- image textures ----------
        function makeImageTexture() {
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            return tex;
        }

        const texA = makeImageTexture();
        const texB = makeImageTexture();
        let coverA = [1, 1, 0, 0];
        let coverB = [1, 1, 0, 0];

        function coverVec(imgW, imgH, boxW, boxH) {
            const imgAspect = imgW / imgH;
            const boxAspect = boxW / boxH;
            let sx = 1, sy = 1;
            if (boxAspect > imgAspect) sy = imgAspect / boxAspect;
            else sx = boxAspect / imgAspect;
            return [sx, sy, 0, 0];
        }

        function resolveSrc(src) {
            // Accepts a plain URL string, or a Next.js static-image import
            // object ({ src, width, height, ... }) — either works.
            if (typeof src === 'string') return src;
            if (src && typeof src.src === 'string') return src.src;
            console.error('LiquidFluidReveal: unrecognized image src', src);
            return '';
        }

        function loadImage(rawSrc, tex, onDone) {
            const src = resolveSrc(rawSrc);
            if (!src) return;
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
                onDone(img.naturalWidth, img.naturalHeight);
            };
            img.onerror = (e) => console.error('LiquidFluidReveal: failed to load', src, e);
            img.src = src;
        }

        loadImage(topSrc, texA, (w, h) => {
            const rect = wrap.getBoundingClientRect();
            coverA = coverVec(w, h, rect.width, rect.height);
        });
        loadImage(bottomSrc, texB, (w, h) => {
            const rect = wrap.getBoundingClientRect();
            coverB = coverVec(w, h, rect.width, rect.height);
        });

        // ---------- pointer state ----------
        const pointer = { x: 0.5, y: 0.5, dx: 0, dy: 0, moved: false, hovering: false };

        function updatePointer(clientX, clientY) {
            const rect = wrap.getBoundingClientRect();
            const x = (clientX - rect.left) / rect.width;
            const y = 1 - (clientY - rect.top) / rect.height;
            pointer.dx = (x - pointer.x) * 6;
            pointer.dy = (y - pointer.y) * 6;
            pointer.x = x;
            pointer.y = y;
            pointer.moved = true;
        }

        const onMouseMove = (e) => updatePointer(e.clientX, e.clientY);
        const onMouseEnter = (e) => {
            pointer.hovering = true;
            updatePointer(e.clientX, e.clientY);
            radiusTweenRef.current?.kill();
            radiusTweenRef.current = gsap.to(radiusRef.current, {
                value: revealRadius,
                duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.15 : 0.8,
                ease: 'power2.out',
                overwrite: 'auto',
            });
        };
        const onMouseLeave = () => {
            pointer.hovering = false;
            radiusTweenRef.current?.kill();
            radiusTweenRef.current = gsap.to(radiusRef.current, {
                value: 0,
                duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.15 : 0.7,
                ease: 'power2.inOut',
                overwrite: 'auto',
            });
        };

        wrap.addEventListener('mousemove', onMouseMove);
        wrap.addEventListener('mouseenter', onMouseEnter);
        wrap.addEventListener('mouseleave', onMouseLeave);

        // ---------- resize ----------
        function resize() {
            const rect = wrap.getBoundingClientRect();
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = Math.max(1, Math.round(rect.width * dpr));
            canvas.height = Math.max(1, Math.round(rect.height * dpr));
            canvas.style.width = `${rect.width}px`;
            canvas.style.height = `${rect.height}px`;
            initSim(rect);
        }

        const ro = new ResizeObserver(resize);
        ro.observe(wrap);
        resize();

        // ---------- main loop ----------
        let rafId;
        const dt = 1 / 60;

        function step() {
            const ratio = canvas.width / canvas.height || 1;

            if (pointer.moved) {
                pointer.moved = false;

                gl.useProgram(splatProgram.program);
                bindQuad(splatProgram.program);
                gl.uniform1i(splatProgram.uniforms.u_input_texture, velocity.read().attach(0));
                gl.uniform1f(splatProgram.uniforms.u_ratio, ratio);
                gl.uniform2f(splatProgram.uniforms.u_point, pointer.x, pointer.y);
                gl.uniform3f(splatProgram.uniforms.u_point_value, pointer.dx * cursorPower, pointer.dy * cursorPower, 0);
                gl.uniform1f(splatProgram.uniforms.u_point_size, cursorSize * 0.001);
                blit(velocity.write());
                velocity.swap();

                gl.uniform1i(splatProgram.uniforms.u_input_texture, dye.read().attach(0));
                gl.uniform3f(splatProgram.uniforms.u_point_value, cursorPower * 0.02, 0, 0);
                blit(dye.write());
                dye.swap();
            }

            gl.useProgram(divergenceProgram.program);
            bindQuad(divergenceProgram.program);
            gl.uniform2f(divergenceProgram.uniforms.u_texel, velocity.texelX, velocity.texelY);
            gl.uniform1i(divergenceProgram.uniforms.u_velocity_texture, velocity.read().attach(0));
            blit(divergenceFBO);

            gl.useProgram(pressureProgram.program);
            bindQuad(pressureProgram.program);
            gl.uniform2f(pressureProgram.uniforms.u_texel, velocity.texelX, velocity.texelY);
            gl.uniform1i(pressureProgram.uniforms.u_divergence_texture, divergenceFBO.attach(0));
            for (let i = 0; i < pressureIterations; i++) {
                gl.uniform1i(pressureProgram.uniforms.u_pressure_texture, pressure.read().attach(1));
                blit(pressure.write());
                pressure.swap();
            }

            gl.useProgram(gradientSubtractProgram.program);
            bindQuad(gradientSubtractProgram.program);
            gl.uniform2f(gradientSubtractProgram.uniforms.u_texel, velocity.texelX, velocity.texelY);
            gl.uniform1i(gradientSubtractProgram.uniforms.u_pressure_texture, pressure.read().attach(0));
            gl.uniform1i(gradientSubtractProgram.uniforms.u_velocity_texture, velocity.read().attach(1));
            blit(velocity.write());
            velocity.swap();

            gl.useProgram(advectionProgram.program);
            bindQuad(advectionProgram.program);
            gl.uniform2f(advectionProgram.uniforms.u_texel, velocity.texelX, velocity.texelY);
            gl.uniform1i(advectionProgram.uniforms.u_velocity_texture, velocity.read().attach(0));
            gl.uniform1i(advectionProgram.uniforms.u_input_texture, velocity.read().attach(0));
            gl.uniform1f(advectionProgram.uniforms.u_dt, dt);
            gl.uniform1f(advectionProgram.uniforms.u_dissipation, 0.97);
            blit(velocity.write());
            velocity.swap();

            gl.uniform1i(advectionProgram.uniforms.u_velocity_texture, velocity.read().attach(0));
            gl.uniform1i(advectionProgram.uniforms.u_input_texture, dye.read().attach(1));
            gl.uniform1f(advectionProgram.uniforms.u_dt, dt * 8);
            gl.uniform1f(advectionProgram.uniforms.u_dissipation, 0.97);
            blit(dye.write());
            dye.swap();

            gl.useProgram(displayProgram.program);
            bindQuad(displayProgram.program);
            gl.uniform1i(displayProgram.uniforms.u_velocity_texture, velocity.read().attach(0));
            gl.uniform1i(displayProgram.uniforms.u_dye_texture, dye.read().attach(1));
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, texA);
            gl.uniform1i(displayProgram.uniforms.u_texA, 2);
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_2D, texB);
            gl.uniform1i(displayProgram.uniforms.u_texB, 3);
            gl.uniform2f(displayProgram.uniforms.u_point, pointer.x, pointer.y);
            gl.uniform1f(displayProgram.uniforms.u_ratio, ratio);
            gl.uniform1f(displayProgram.uniforms.u_reveal_radius, radiusRef.current.value);
            gl.uniform1f(displayProgram.uniforms.u_disturb_power, disturbPower);
            gl.uniform4f(displayProgram.uniforms.u_coverA, ...coverA);
            gl.uniform4f(displayProgram.uniforms.u_coverB, ...coverB);
            blit(null);

            rafId = requestAnimationFrame(step);
        }
        rafId = requestAnimationFrame(step);

        stateRef.current = { gl };

        return () => {
            cancelAnimationFrame(rafId);
            ro.disconnect();
            wrap.removeEventListener('mousemove', onMouseMove);
            wrap.removeEventListener('mouseenter', onMouseEnter);
            wrap.removeEventListener('mouseleave', onMouseLeave);
            radiusTweenRef.current?.kill();
            stateRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [topSrc, bottomSrc, revealRadius, cursorSize, cursorPower, disturbPower, pressureIterations, simResolution]);

    return (
        <div ref={wrapRef} className={`relative overflow-hidden ${className}`}>
            {fallbackRef.current ? (
                <FallbackReveal topSrc={topSrc} bottomSrc={bottomSrc} alt={alt} radiusPx={revealRadius} />
            ) : (
                <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
            )}
            {children && <div className="pointer-events-none absolute inset-0">{children}</div>}
        </div>
    );
}

// No-WebGL / no-float-texture fallback: a plain cursor-following circular
// reveal with no liquid warp, so the component still degrades gracefully.
function FallbackReveal({ topSrc, bottomSrc, alt }) {
    const ref = useRef(null);
    const onMove = (e) => {
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        el.style.setProperty('--rx', `${x}%`);
        el.style.setProperty('--ry', `${y}%`);
        el.style.setProperty('--rr', '35%');
    };
    const onLeave = () => ref.current?.style.setProperty('--rr', '0%');

    return (
        <div
            ref={ref}
            className="absolute inset-0 h-full w-full"
            onMouseMove={onMove}
            onMouseLeave={onLeave}
            style={{ '--rx': '50%', '--ry': '50%', '--rr': '0%' }}
        >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={topSrc} alt={alt} className="absolute grayscale-100 inset-0 h-full w-full object-cover" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
                src={bottomSrc}
                alt=""
                aria-hidden="true"
                className="absolute inset-0 h-full w-full object-cover transition-[clip-path] duration-300 ease-out"
                style={{ clipPath: 'circle(var(--rr) at var(--rx) var(--ry))' }}
            />
        </div>
    );
}