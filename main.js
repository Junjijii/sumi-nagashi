/*
 * 墨流し — sumi-nagashi
 *
 * GPU 上で安定流体法 (Jos Stam, "Stable Fluids") を解き、
 * 紙(和紙)の上の水に墨が落ち、にじみ、渦を巻いて溶けていく様子を描く。
 *
 * 染料テクスチャには「吸収量」(Beer–Lambert 則の光学濃度) を蓄え、
 * 表示時に paper * exp(-absorption) で紙の色から減算合成する。
 * これにより本物の墨・顔料のような重なりと濃淡が出る。
 */

'use strict';

// ─────────────────────────────────────────────
// 設定
// ─────────────────────────────────────────────
const config = {
  SIM_RESOLUTION: 160,      // 速度場の解像度(片側)
  DYE_RESOLUTION: 1024,     // 墨の解像度(片側)
  DENSITY_DISSIPATION: 0.1,  // 墨の消えにくさ(小さいほど残る)
  VELOCITY_DISSIPATION: 0.68, // 水の粘り(大きいほどすぐ止まる)
  PRESSURE: 0.8,
  PRESSURE_ITERATIONS: 24,
  CURL: 8,                   // 渦の強さ
  BLEED: 0.32,               // にじみ(毎フレームの拡散率 0..1)
  SPLAT_RADIUS: 0.0022,      // ドラッグ時の筆先の太さ
  DROP_RADIUS: 0.0042,       // 一滴の大きさ
  SPLAT_FORCE: 2200,         // ドラッグで水を押す力
  INK_FLOW: 0.2,             // ドラッグ中に出る墨の濃さ
  DROP_INK: 0.44,            // 一滴の濃さ
  SOAK_INK: 0.35,            // 押さえたまま動かさない時、毎秒とけ出す墨
  AMBIENT_STIR: true,        // 水面がかすかに揺らぐ
};

// 伝統色 — name は表示用、hex が墨の色
const INKS = [
  { name: '墨',   hex: '#262626' },
  { name: '藍',   hex: '#165e83' },
  { name: '朱',   hex: '#c73e2a' },
  { name: '千歳緑', hex: '#316745' },
  { name: '山吹', hex: '#e8a000' },
  { name: '江戸紫', hex: '#745399' },
  { name: '浅葱', hex: '#0089a7' },
];

// ─────────────────────────────────────────────
// WebGL 初期化
// ─────────────────────────────────────────────
const canvas = document.getElementById('water');

function getWebGLContext(canvas) {
  const params = { alpha: false, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };
  let gl = canvas.getContext('webgl2', params);
  const isWebGL2 = !!gl;
  if (!isWebGL2) {
    gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);
  }
  if (!gl) return null;

  let halfFloat = null;
  let supportLinearFiltering = false;
  if (isWebGL2) {
    gl.getExtension('EXT_color_buffer_float');
    supportLinearFiltering = !!gl.getExtension('OES_texture_float_linear');
  } else {
    halfFloat = gl.getExtension('OES_texture_half_float');
    supportLinearFiltering = !!gl.getExtension('OES_texture_half_float_linear');
  }
  gl.clearColor(0, 0, 0, 1);

  const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : (halfFloat && halfFloat.HALF_FLOAT_OES);
  let formatRGBA, formatRG, formatR;
  if (isWebGL2) {
    formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
    formatRG   = getSupportedFormat(gl, gl.RG16F,   gl.RG,   halfFloatTexType);
    formatR    = getSupportedFormat(gl, gl.R16F,    gl.RED,  halfFloatTexType);
  } else {
    formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
    formatRG   = formatRGBA;
    formatR    = formatRGBA;
  }
  if (!formatRGBA) return null;

  return {
    gl,
    ext: { formatRGBA, formatRG, formatR, halfFloatTexType, supportLinearFiltering },
  };
}

function getSupportedFormat(gl, internalFormat, format, type) {
  if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
    if (internalFormat === gl.R16F)  return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
    if (internalFormat === gl.RG16F) return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
    return null;
  }
  return { internalFormat, format };
}

function supportRenderTextureFormat(gl, internalFormat, format, type) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(texture);
  return ok;
}

const context = getWebGLContext(canvas);
if (!context) {
  document.getElementById('noWebgl').style.display = 'flex';
  throw new Error('WebGL not supported');
}
const { gl, ext } = context;
if (!ext.supportLinearFiltering) {
  // 線形補間が使えない端末では解像度を落として手動補間する
  config.DYE_RESOLUTION = 512;
}

// ─────────────────────────────────────────────
// シェーダ
// ─────────────────────────────────────────────
function compileShader(type, source, keywords) {
  if (keywords) {
    let header = '';
    keywords.forEach(k => { header += `#define ${k}\n`; });
    source = header + source;
  }
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

function createProgram(vertexShader, fragmentShader) {
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.bindAttribLocation(program, 0, 'aPosition');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program));
  }
  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const name = gl.getActiveUniform(program, i).name;
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return { program, uniforms, bind() { gl.useProgram(program); } };
}

const baseVertexShader = compileShader(gl.VERTEX_SHADER, `
  precision highp float;
  attribute vec2 aPosition;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform vec2 texelSize;
  void main () {
    vUv = aPosition * 0.5 + 0.5;
    vL = vUv - vec2(texelSize.x, 0.0);
    vR = vUv + vec2(texelSize.x, 0.0);
    vT = vUv + vec2(0.0, texelSize.y);
    vB = vUv - vec2(0.0, texelSize.y);
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`);

const clearShader = compileShader(gl.FRAGMENT_SHADER, `
  precision mediump float;
  precision mediump sampler2D;
  varying highp vec2 vUv;
  uniform sampler2D uTexture;
  uniform float value;
  void main () {
    gl_FragColor = value * texture2D(uTexture, vUv);
  }
`);

const splatShader = compileShader(gl.FRAGMENT_SHADER, `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  uniform sampler2D uTarget;
  uniform float aspectRatio;
  uniform vec3 color;
  uniform vec2 point;
  uniform float radius;
  void main () {
    vec2 p = vUv - point.xy;
    p.x *= aspectRatio;
    vec3 splat = exp(-dot(p, p) / radius) * color;
    vec3 base = texture2D(uTarget, vUv).xyz;
    gl_FragColor = vec4(base + splat, 1.0);
  }
`);

const advectionShader = compileShader(gl.FRAGMENT_SHADER, `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  uniform sampler2D uVelocity;
  uniform sampler2D uSource;
  uniform vec2 texelSize;
  uniform vec2 dyeTexelSize;
  uniform float dt;
  uniform float dissipation;

  vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
    vec2 st = uv / tsize - 0.5;
    vec2 iuv = floor(st);
    vec2 fuv = fract(st);
    vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
    vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
    vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
    vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
    return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
  }

  void main () {
    #ifdef MANUAL_FILTERING
      vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
      vec4 result = bilerp(uSource, coord, dyeTexelSize);
    #else
      vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
      vec4 result = texture2D(uSource, coord);
    #endif
    float decay = 1.0 + dissipation * dt;
    gl_FragColor = result / decay;
  }
`, ext.supportLinearFiltering ? null : ['MANUAL_FILTERING']);

const divergenceShader = compileShader(gl.FRAGMENT_SHADER, `
  precision mediump float;
  precision mediump sampler2D;
  varying highp vec2 vUv;
  varying highp vec2 vL;
  varying highp vec2 vR;
  varying highp vec2 vT;
  varying highp vec2 vB;
  uniform sampler2D uVelocity;
  void main () {
    float L = texture2D(uVelocity, vL).x;
    float R = texture2D(uVelocity, vR).x;
    float T = texture2D(uVelocity, vT).y;
    float B = texture2D(uVelocity, vB).y;
    vec2 C = texture2D(uVelocity, vUv).xy;
    if (vL.x < 0.0) { L = -C.x; }
    if (vR.x > 1.0) { R = -C.x; }
    if (vT.y > 1.0) { T = -C.y; }
    if (vB.y < 0.0) { B = -C.y; }
    float div = 0.5 * (R - L + T - B);
    gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
  }
`);

const curlShader = compileShader(gl.FRAGMENT_SHADER, `
  precision mediump float;
  precision mediump sampler2D;
  varying highp vec2 vUv;
  varying highp vec2 vL;
  varying highp vec2 vR;
  varying highp vec2 vT;
  varying highp vec2 vB;
  uniform sampler2D uVelocity;
  void main () {
    float L = texture2D(uVelocity, vL).y;
    float R = texture2D(uVelocity, vR).y;
    float T = texture2D(uVelocity, vT).x;
    float B = texture2D(uVelocity, vB).x;
    float vorticity = R - L - T + B;
    gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
  }
`);

const vorticityShader = compileShader(gl.FRAGMENT_SHADER, `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uVelocity;
  uniform sampler2D uCurl;
  uniform float curl;
  uniform float dt;
  void main () {
    float L = texture2D(uCurl, vL).x;
    float R = texture2D(uCurl, vR).x;
    float T = texture2D(uCurl, vT).x;
    float B = texture2D(uCurl, vB).x;
    float C = texture2D(uCurl, vUv).x;
    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    force /= length(force) + 0.0001;
    force *= curl * C;
    force.y *= -1.0;
    vec2 velocity = texture2D(uVelocity, vUv).xy;
    velocity += force * dt;
    velocity = min(max(velocity, -1000.0), 1000.0);
    gl_FragColor = vec4(velocity, 0.0, 1.0);
  }
`);

const pressureShader = compileShader(gl.FRAGMENT_SHADER, `
  precision mediump float;
  precision mediump sampler2D;
  varying highp vec2 vUv;
  varying highp vec2 vL;
  varying highp vec2 vR;
  varying highp vec2 vT;
  varying highp vec2 vB;
  uniform sampler2D uPressure;
  uniform sampler2D uDivergence;
  void main () {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    float divergence = texture2D(uDivergence, vUv).x;
    float pressure = (L + R + B + T - divergence) * 0.25;
    gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
  }
`);

const gradientSubtractShader = compileShader(gl.FRAGMENT_SHADER, `
  precision mediump float;
  precision mediump sampler2D;
  varying highp vec2 vUv;
  varying highp vec2 vL;
  varying highp vec2 vR;
  varying highp vec2 vT;
  varying highp vec2 vB;
  uniform sampler2D uPressure;
  uniform sampler2D uVelocity;
  void main () {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    vec2 velocity = texture2D(uVelocity, vUv).xy;
    velocity.xy -= vec2(R - L, T - B);
    gl_FragColor = vec4(velocity, 0.0, 1.0);
  }
`);

// にじみ:墨をわずかに周囲へ拡散させる(和紙に染みる感じ)
const bleedShader = compileShader(gl.FRAGMENT_SHADER, `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uTexture;
  uniform float strength;
  void main () {
    vec4 c = texture2D(uTexture, vUv);
    vec4 avg = 0.25 * (
      texture2D(uTexture, vL) +
      texture2D(uTexture, vR) +
      texture2D(uTexture, vT) +
      texture2D(uTexture, vB)
    );
    gl_FragColor = mix(c, avg, strength);
  }
`);

// 表示:和紙の上に Beer–Lambert 則で墨を重ねる + 着水の波紋
const displayShader = compileShader(gl.FRAGMENT_SHADER, `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform vec2 paperTexel;
  uniform float aspectRatio;
  uniform int uRippleCount;
  uniform vec4 uRipples[8]; // x, y, 現在の半径, 振幅

  float hash (vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float vnoise (vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  void main () {
    // 波紋:輪の部分で水面が屈折して墨がゆらぎ、わずかに光る
    vec2 uv = vUv;
    float shimmer = 0.0;
    for (int i = 0; i < 8; i++) {
      if (i >= uRippleCount) break;
      vec4 rp = uRipples[i];
      vec2 d = vUv - rp.xy;
      d.x *= aspectRatio;
      float dist = length(d);
      float ring = exp(-pow((dist - rp.z) / 0.018, 2.0)) * rp.w;
      vec2 dir = d / (dist + 0.0001);
      dir.x /= aspectRatio;
      uv -= dir * ring * 0.006;
      shimmer += ring;
    }

    vec3 absorption = texture2D(uTexture, uv).rgb;
    absorption = max(absorption, 0.0);

    // 和紙:繊維のような異方ノイズ + 細かい紙肌
    vec2 px = vUv / paperTexel;
    float fiber = vnoise(vUv * vec2(120.0, 14.0)) * 0.5
                + vnoise(vUv * vec2(11.0, 90.0)) * 0.5;
    float grain = hash(floor(px * 0.7));
    vec3 paper = vec3(0.957, 0.937, 0.898);
    paper *= 0.965 + 0.030 * fiber + 0.012 * grain;

    // 墨のにじみ際がわずかに粒立つ(顔料の沈着)
    float density = absorption.r + absorption.g + absorption.b;
    float granulation = 1.0 + 0.10 * (vnoise(vUv * 240.0) - 0.5) * min(density, 1.0);

    vec3 color = paper * exp(-absorption * 1.55 * granulation);
    color *= 1.0 + 0.055 * shimmer;

    // 周辺をほんのり落とす
    vec2 d = vUv - 0.5;
    float vignette = 1.0 - 0.22 * dot(d, d) * 2.0;
    color *= vignette;

    gl_FragColor = vec4(color, 1.0);
  }
`);

// ─────────────────────────────────────────────
// 描画基盤
// ─────────────────────────────────────────────
const blit = (() => {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  const elemBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, elemBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);
  return (target) => {
    if (target == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  };
})();

function createFBO(w, h, internalFormat, format, type, filter) {
  gl.activeTexture(gl.TEXTURE0);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.viewport(0, 0, w, h);
  gl.clear(gl.COLOR_BUFFER_BIT);

  return {
    texture, fbo,
    width: w, height: h,
    texelSizeX: 1 / w, texelSizeY: 1 / h,
    attach(id) {
      gl.activeTexture(gl.TEXTURE0 + id);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      return id;
    },
  };
}

function createDoubleFBO(w, h, internalFormat, format, type, filter) {
  let fbo1 = createFBO(w, h, internalFormat, format, type, filter);
  let fbo2 = createFBO(w, h, internalFormat, format, type, filter);
  return {
    width: w, height: h,
    texelSizeX: fbo1.texelSizeX, texelSizeY: fbo1.texelSizeY,
    get read() { return fbo1; },
    set read(v) { fbo1 = v; },
    get write() { return fbo2; },
    set write(v) { fbo2 = v; },
    swap() { const t = fbo1; fbo1 = fbo2; fbo2 = t; },
  };
}

function getResolution(resolution) {
  let aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
  if (aspectRatio < 1) aspectRatio = 1 / aspectRatio;
  const min = Math.round(resolution);
  const max = Math.round(resolution * aspectRatio);
  if (gl.drawingBufferWidth > gl.drawingBufferHeight) {
    return { width: max, height: min };
  }
  return { width: min, height: max };
}

// プログラム束
const clearProgram     = createProgram(baseVertexShader, clearShader);
const splatProgram     = createProgram(baseVertexShader, splatShader);
const advectionProgram = createProgram(baseVertexShader, advectionShader);
const divergenceProgram = createProgram(baseVertexShader, divergenceShader);
const curlProgram      = createProgram(baseVertexShader, curlShader);
const vorticityProgram = createProgram(baseVertexShader, vorticityShader);
const pressureProgram  = createProgram(baseVertexShader, pressureShader);
const gradientProgram  = createProgram(baseVertexShader, gradientSubtractShader);
const bleedProgram     = createProgram(baseVertexShader, bleedShader);
const displayProgram   = createProgram(baseVertexShader, displayShader);

let dye, velocity, divergence, curl, pressure;

function initFramebuffers() {
  const simRes = getResolution(config.SIM_RESOLUTION);
  const dyeRes = getResolution(config.DYE_RESOLUTION);
  const texType = ext.halfFloatTexType;
  const rgba = ext.formatRGBA;
  const rg = ext.formatRG;
  const r = ext.formatR;
  const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
  gl.disable(gl.BLEND);

  dye = createDoubleFBO(dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);
  velocity = createDoubleFBO(simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);
  divergence = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
  curl = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
  pressure = createDoubleFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
}

function resizeCanvas() {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.floor(canvas.clientWidth * pixelRatio);
  const height = Math.floor(canvas.clientHeight * pixelRatio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────
// シミュレーション
// ─────────────────────────────────────────────
function step(dt) {
  gl.disable(gl.BLEND);

  curlProgram.bind();
  gl.uniform2f(curlProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
  blit(curl);

  vorticityProgram.bind();
  gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
  gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
  gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
  gl.uniform1f(vorticityProgram.uniforms.dt, dt);
  blit(velocity.write);
  velocity.swap();

  divergenceProgram.bind();
  gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
  blit(divergence);

  clearProgram.bind();
  gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
  gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);
  blit(pressure.write);
  pressure.swap();

  pressureProgram.bind();
  gl.uniform2f(pressureProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
  for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
    gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
    blit(pressure.write);
    pressure.swap();
  }

  gradientProgram.bind();
  gl.uniform2f(gradientProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(gradientProgram.uniforms.uPressure, pressure.read.attach(0));
  gl.uniform1i(gradientProgram.uniforms.uVelocity, velocity.read.attach(1));
  blit(velocity.write);
  velocity.swap();

  advectionProgram.bind();
  gl.uniform2f(advectionProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  if (!ext.supportLinearFiltering) {
    gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
  }
  const velocityId = velocity.read.attach(0);
  gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityId);
  gl.uniform1i(advectionProgram.uniforms.uSource, velocityId);
  gl.uniform1f(advectionProgram.uniforms.dt, dt);
  gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
  blit(velocity.write);
  velocity.swap();

  if (!ext.supportLinearFiltering) {
    gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
  }
  gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
  gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
  gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
  blit(dye.write);
  dye.swap();

  // にじみ(墨の拡散)。dt に比例させ、時間的に一定の速さでにじむ。
  bleedProgram.bind();
  gl.uniform2f(bleedProgram.uniforms.texelSize, dye.texelSizeX, dye.texelSizeY);
  gl.uniform1i(bleedProgram.uniforms.uTexture, dye.read.attach(0));
  gl.uniform1f(bleedProgram.uniforms.strength, Math.min(config.BLEED * dt * 60.0, 1.0) * 0.5);
  blit(dye.write);
  dye.swap();
}

const rippleData = new Float32Array(32); // MAX_RIPPLES * 4

function render() {
  gl.disable(gl.BLEND);
  displayProgram.bind();
  gl.uniform2f(displayProgram.uniforms.texelSize, dye.texelSizeX, dye.texelSizeY);
  gl.uniform2f(displayProgram.uniforms.paperTexel, 1 / gl.drawingBufferWidth, 1 / gl.drawingBufferHeight);
  gl.uniform1f(displayProgram.uniforms.aspectRatio, canvas.width / canvas.height);
  for (let i = 0; i < ripples.length; i++) {
    const rp = ripples[i];
    rippleData[i * 4 + 0] = rp.x;
    rippleData[i * 4 + 1] = rp.y;
    rippleData[i * 4 + 2] = 0.02 + rp.age * 0.16;            // 広がる半径
    rippleData[i * 4 + 3] = Math.exp(-rp.age * 2.0) * rp.scale; // 減衰する振幅
  }
  gl.uniform1i(displayProgram.uniforms.uRippleCount, ripples.length);
  if (ripples.length > 0) {
    gl.uniform4fv(displayProgram.uniforms['uRipples[0]'], rippleData);
  }
  gl.uniform1i(displayProgram.uniforms.uTexture, dye.read.attach(0));
  blit(null);
}

// ─────────────────────────────────────────────
// 墨を落とす・かき混ぜる
// ─────────────────────────────────────────────
function correctRadius(radius) {
  const aspectRatio = canvas.width / canvas.height;
  if (aspectRatio > 1) radius *= aspectRatio;
  return radius;
}

function splatVelocity(x, y, dx, dy, radius) {
  splatProgram.bind();
  gl.uniform2f(splatProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
  gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
  gl.uniform2f(splatProgram.uniforms.point, x, y);
  gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0);
  gl.uniform1f(splatProgram.uniforms.radius, correctRadius(radius));
  blit(velocity.write);
  velocity.swap();
}

function splatInk(x, y, color, amount, radius) {
  // color: 0..1 RGB。吸収量 = (1 - 色) × 量
  splatProgram.bind();
  gl.uniform2f(splatProgram.uniforms.texelSize, dye.texelSizeX, dye.texelSizeY);
  gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
  gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
  gl.uniform2f(splatProgram.uniforms.point, x, y);
  gl.uniform3f(
    splatProgram.uniforms.color,
    (1.0 - color.r) * amount,
    (1.0 - color.g) * amount,
    (1.0 - color.b) * amount
  );
  gl.uniform1f(splatProgram.uniforms.radius, correctRadius(radius));
  blit(dye.write);
  dye.swap();
}

// 着水の波紋(表示シェーダで屈折として描く)
const MAX_RIPPLES = 8;
const ripples = [];

function addRipple(x, y, scale = 1) {
  if (ripples.length >= MAX_RIPPLES) ripples.shift();
  ripples.push({ x, y, age: 0, scale });
}

// 一滴落とす:墨 + 波紋 + 水がふわっと巻く(渦対なので圧力投影でも消えない)
function drop(x, y, color, scale = 1) {
  splatInk(x, y, color, config.DROP_INK * scale, config.DROP_RADIUS * scale);
  addRipple(x, y, scale);
  const angle = Math.random() * Math.PI * 2;
  const off = 0.006;
  const force = (18 + Math.random() * 14) * scale;
  const ox = Math.cos(angle) * off;
  const oy = Math.sin(angle) * off;
  const r = config.DROP_RADIUS * 1.25;
  splatVelocity(x + ox, y + oy, -Math.sin(angle) * force, Math.cos(angle) * force, r);
  splatVelocity(x - ox, y - oy, Math.sin(angle) * force, -Math.cos(angle) * force, r);
}

function clearWater() {
  clearProgram.bind();
  gl.uniform1f(clearProgram.uniforms.value, 0);
  gl.uniform1i(clearProgram.uniforms.uTexture, dye.read.attach(0));
  blit(dye.write);
  dye.swap();
  gl.uniform1i(clearProgram.uniforms.uTexture, velocity.read.attach(0));
  blit(velocity.write);
  velocity.swap();
  gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
  blit(pressure.write);
  pressure.swap();
}

// ─────────────────────────────────────────────
// 入力(マウス・タッチ)
// ─────────────────────────────────────────────
let currentInk = INKS[0];

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255 };
}

class Pointer {
  constructor() {
    this.id = -1;
    this.down = false;
    this.moved = false;
    this.x = 0; this.y = 0;
    this.dx = 0; this.dy = 0;
    this.color = hexToRgb(currentInk.hex);
    this.holdTime = 0;
  }
}

const pointers = [new Pointer()];

function scaleByPixelRatio(input) {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  return Math.floor(input * pixelRatio);
}

function updatePointerDown(p, id, posX, posY) {
  p.id = id;
  p.down = true;
  p.moved = false;
  p.x = posX / canvas.width;
  p.y = 1 - posY / canvas.height;
  p.dx = 0;
  p.dy = 0;
  p.color = hexToRgb(currentInk.hex);
  p.holdTime = 0;
  drop(p.x, p.y, p.color);
  hideHint();
}

function updatePointerMove(p, posX, posY) {
  const x = posX / canvas.width;
  const y = 1 - posY / canvas.height;
  p.dx = (x - p.x) * config.SPLAT_FORCE;
  p.dy = (y - p.y) * config.SPLAT_FORCE;
  // 縦横比の補正(画面の縦横で速さの見え方が変わるのを防ぐ)
  const aspect = canvas.width / canvas.height;
  if (aspect < 1) p.dx *= aspect;
  if (aspect > 1) p.dy /= aspect;
  p.x = x;
  p.y = y;
  p.moved = Math.abs(p.dx) > 0.5 || Math.abs(p.dy) > 0.5;
}

function applyPointer(p, dt) {
  if (!p.down) return;
  if (p.moved) {
    p.moved = false;
    p.holdTime = 0;
    splatVelocity(p.x, p.y, p.dx, p.dy, config.SPLAT_RADIUS * 4.0);
    const speed = Math.min(Math.hypot(p.dx, p.dy) / 1200, 1.0);
    splatInk(p.x, p.y, p.color, config.INK_FLOW * (0.35 + 0.65 * speed), config.SPLAT_RADIUS);
  } else {
    // 押さえたまま:墨が静かにとけ出していく
    p.holdTime += dt;
    const grow = 1.0 + Math.min(p.holdTime * 0.6, 2.2);
    splatInk(p.x, p.y, p.color, config.SOAK_INK * dt, config.DROP_RADIUS * grow);
  }
}

canvas.addEventListener('mousedown', (e) => {
  updatePointerDown(pointers[0], -1, scaleByPixelRatio(e.offsetX), scaleByPixelRatio(e.offsetY));
});
window.addEventListener('mousemove', (e) => {
  const p = pointers[0];
  if (!p.down) return;
  const rect = canvas.getBoundingClientRect();
  updatePointerMove(p, scaleByPixelRatio(e.clientX - rect.left), scaleByPixelRatio(e.clientY - rect.top));
});
window.addEventListener('mouseup', () => { pointers[0].down = false; });

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  for (const touch of e.changedTouches) {
    let p = pointers.find(q => !q.down);
    if (!p) { p = new Pointer(); pointers.push(p); }
    updatePointerDown(p, touch.identifier, scaleByPixelRatio(touch.clientX - rect.left), scaleByPixelRatio(touch.clientY - rect.top));
  }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  for (const touch of e.changedTouches) {
    const p = pointers.find(q => q.down && q.id === touch.identifier);
    if (!p) continue;
    updatePointerMove(p, scaleByPixelRatio(touch.clientX - rect.left), scaleByPixelRatio(touch.clientY - rect.top));
  }
}, { passive: false });

const endTouch = (e) => {
  for (const touch of e.changedTouches) {
    const p = pointers.find(q => q.id === touch.identifier);
    if (p) p.down = false;
  }
};
canvas.addEventListener('touchend', endTouch);
canvas.addEventListener('touchcancel', endTouch);

// ─────────────────────────────────────────────
// UI
// ─────────────────────────────────────────────
const tray = document.getElementById('tray');
INKS.forEach((ink, i) => {
  const btn = document.createElement('button');
  btn.className = 'color-btn' + (i === 0 ? ' active' : '');
  btn.type = 'button';
  btn.setAttribute('aria-label', ink.name);
  btn.innerHTML = `<span class="dot" style="background:${ink.hex}"></span><span class="name">${ink.name}</span>`;
  btn.addEventListener('click', () => {
    currentInk = ink;
    tray.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
  tray.appendChild(btn);
});

document.getElementById('reset').addEventListener('click', clearWater);

let hintHidden = false;
function hideHint() {
  if (hintHidden) return;
  hintHidden = true;
  document.getElementById('hint').classList.add('hidden');
}

// ─────────────────────────────────────────────
// メインループ
// ─────────────────────────────────────────────
resizeCanvas();
initFramebuffers();

// 最初の演出:墨と藍が一滴ずつ、静かに落ちる
setTimeout(() => drop(0.38, 0.62, hexToRgb(INKS[0].hex), 0.9), 500);
setTimeout(() => drop(0.62, 0.45, hexToRgb(INKS[1].hex), 0.8), 1700);
setTimeout(() => drop(0.5, 0.3, hexToRgb(INKS[2].hex), 0.55), 3100);

let lastTime = performance.now();
let ambientTimer = 0;

function update(now) {
  let dt = (now - lastTime) / 1000;
  dt = Math.min(Math.max(dt, 0), 1 / 20);
  lastTime = now;

  if (resizeCanvas()) initFramebuffers();

  // 波紋の時間を進め、消えたものを取り除く
  for (const rp of ripples) rp.age += dt;
  while (ripples.length > 0 && ripples[0].age > 2.2) ripples.shift();

  for (const p of pointers) applyPointer(p, dt);

  // ときどき水面がかすかに揺らぐ
  if (config.AMBIENT_STIR) {
    ambientTimer += dt;
    if (ambientTimer > 5 + Math.random() * 5) {
      ambientTimer = 0;
      const angle = Math.random() * Math.PI * 2;
      splatVelocity(
        0.15 + Math.random() * 0.7,
        0.15 + Math.random() * 0.7,
        Math.cos(angle) * 25,
        Math.sin(angle) * 25,
        0.012
      );
    }
  }

  step(dt);
  render();
  requestAnimationFrame(update);
}

requestAnimationFrame(update);
