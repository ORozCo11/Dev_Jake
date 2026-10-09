import { Mesh, Program, Renderer, Triangle } from 'ogl';
import { useEffect, useRef } from 'react';
import './Beams.css';

const vertex = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const fragment = `
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uBeamColor;
uniform vec3 uLightColor;

float ribbon(vec2 p, float offset, float phase) {
  float wave = sin(p.y * 2.35 + uTime * .55 + phase) * .12;
  wave += sin(p.y * 5.1 - uTime * .28 + phase * 1.7) * .025;
  float d = abs(p.x - offset - wave);
  float body = smoothstep(.13, .018, d);
  float edge = smoothstep(.045, .0, abs(d - .105));
  float light = smoothstep(.15, .0, length(p - vec2(offset + wave, .28)));
  return body * (.48 + edge * .36 + light * 1.55);
}

void main() {
  vec2 p = (gl_FragCoord.xy * 2.0 - uResolution.xy) / min(uResolution.x, uResolution.y);
  p = mat2(.94, -.34, .34, .94) * p;
  float beams = 0.0;
  for (float i = 0.0; i < 10.0; i++) {
    float x = (i - 4.5) * .22;
    beams += ribbon(p, x, i * 1.71);
  }
  float glow = exp(-8.0 * dot(p - vec2(.0, .26), p - vec2(.0, .26)));
  vec3 color = uBeamColor * beams + uLightColor * (glow * .72 + pow(beams, 2.0) * .18);
  color += uBeamColor * (.34 + .08 * (1.0 - length(p) * .22));
  gl_FragColor = vec4(color, 1.0);
}
`;

function toRgb(hex) {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16) / 255);
}

export default function Beams({ beamColor = '#153e99', lightColor = '#2563eb' }) {
  const rootRef = useRef(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;

    const renderer = new Renderer({ alpha: false, dpr: Math.min(window.devicePixelRatio, 2) });
    const gl = renderer.gl;
    const program = new Program(gl, {
      vertex,
      fragment,
      uniforms: {
        uResolution: { value: [1, 1] },
        uTime: { value: 0 },
        uBeamColor: { value: toRgb(beamColor) },
        uLightColor: { value: toRgb(lightColor) },
      },
    });
    const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });
    root.appendChild(gl.canvas);

    const resize = () => {
      renderer.setSize(root.clientWidth, root.clientHeight);
      program.uniforms.uResolution.value = [gl.canvas.width, gl.canvas.height];
    };
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame;
    const render = (time = 0) => {
      program.uniforms.uTime.value = reduceMotion ? 0 : time * .001;
      renderer.render({ scene: mesh });
      if (!reduceMotion) frame = requestAnimationFrame(render);
    };
    window.addEventListener('resize', resize);
    resize();
    render();

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      if (root.contains(gl.canvas)) root.removeChild(gl.canvas);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [beamColor, lightColor]);

  return <div className="beams-background" ref={rootRef} aria-hidden="true" />;
}
