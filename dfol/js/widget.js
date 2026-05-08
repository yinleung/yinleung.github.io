// Spectral Filtering Widget — vanilla JS + persistent SVG nodes.
// Reads precomputed grid emitted by widget/scripts/precompute.py.
// Distill-style smoothness: build SVG once in setup, only mutate `d` /
// transform attributes per frame. No innerHTML teardown, no DOM churn.

const SVG_NS = "http://www.w3.org/2000/svg";

const COLORS = {
  raw:        "#9ca3af",
  rawFill:    "#e5e7eb",
  momentum:   "#1d4ed8",
  momFill:    "#dbeafe",
  signal:     "#111827",
  ratio:      "#0d9488",
  ratioFill:  "rgba(13, 148, 136, 0.18)",
  guideline:  "#cbd5e1",
  axis:       "#475569",
  axisLight:  "#94a3b8",
};

const X_AXIS_MAX = 40;            // show first 40 singular values
const Y_TICK_COUNT = 5;
const X_TICKS = [1, 5, 10, 15, 20, 25, 30, 35, 40];

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function pathFromPoints(points) {
  if (!points.length) return "";
  let d = `M${points[0][0].toFixed(2)},${points[0][1].toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    d += `L${points[i][0].toFixed(2)},${points[i][1].toFixed(2)}`;
  }
  return d;
}

function areaPath(pointsTop, baselineY) {
  if (!pointsTop.length) return "";
  let d = `M${pointsTop[0][0].toFixed(2)},${baselineY.toFixed(2)}`;
  for (const [x, y] of pointsTop) d += `L${x.toFixed(2)},${y.toFixed(2)}`;
  d += `L${pointsTop[pointsTop.length-1][0].toFixed(2)},${baselineY.toFixed(2)}Z`;
  return d;
}

function makeLinearScale(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const slope = (r1 - r0) / (d1 - d0);
  return (v) => r0 + (v - d0) * slope;
}

function niceStep(rough) {
  const exp = Math.floor(Math.log10(rough));
  const f = rough / Math.pow(10, exp);
  let nice;
  if (f < 1.5) nice = 1;
  else if (f < 3) nice = 2;
  else if (f < 7) nice = 5;
  else nice = 10;
  return nice * Math.pow(10, exp);
}

function niceTicks(min, max, count) {
  const range = max - min;
  const step = niceStep(range / count);
  const ticks = [];
  let v = Math.ceil(min / step) * step;
  while (v <= max + 1e-9) {
    ticks.push(+v.toFixed(6));
    v += step;
  }
  return ticks;
}

function diamondPath(cx, cy, r) {
  return `M${cx},${cy - r}L${cx + r},${cy}L${cx},${cy + r}L${cx - r},${cy}Z`;
}


// ----------------------------------------------------------------
//                         SpectrumWidget
// ----------------------------------------------------------------
class SpectrumWidget {
  constructor(container, payload) {
    this.container = container;
    this.payload = payload;
    this.meta = payload.meta;
    this.data = payload.data;

    // Continuous (fractional) indices — sliders step in 0.01 increments.
    // We linearly interpolate between adjacent precomputed grid points so that
    // dragging the slider feels continuous, not stepped.
    this.state = {
      rank: this.meta.default_rank,
      sigmaIdx: this.meta.default_sigma_idx,
      betaIdx: this.meta.default_beta_idx,
    };

    this.specMargin = { top: 22, right: 24, bottom: 38, left: 58 };
    this.ratioMargin = { top: 30, right: 24, bottom: 38, left: 58 };

    this._yRangeCache = new Map();
    this._lastSpecKey = "";   // (rank|sigmaIdx) used to skip axis rebuild
    this._lastRatioKey = "";  // rank only
    this._dims = { specW: 0, specH: 0, ratioW: 0, ratioH: 0 };

    this.buildDOM();
    this.buildStaticSVG();
    this.attachListeners();
    this.requestRender(true);
    window.addEventListener("resize", () => this.handleResize());
  }

  // ============ DOM ============
  buildDOM() {
    this.container.classList.add("widget-root");
    this.container.classList.remove("loading");
    this.container.innerHTML = "";

    const labelDiv = document.createElement("div");
    labelDiv.className = "widget-header";
    labelDiv.innerHTML =
      `<div class="widget-eyebrow">Interactive · Spectral Filtering Widget</div>
       <div class="widget-headline">Drag <span class="kbd">β</span> to watch momentum carve a spectral gap from raw gradient noise.</div>
       <div class="widget-sub">Synthetic rank-<em>r</em> spiked-MDS gradient stream. Three curves: <span class="lg-raw">raw G<sub>K</sub></span>, <span class="lg-mom">momentum M<sub>K</sub></span>, <span class="lg-sig">planted signal</span>.</div>`;
    this.container.appendChild(labelDiv);

    const charts = document.createElement("div");
    charts.className = "widget-charts";
    this.container.appendChild(charts);

    this.specSVG = svgEl("svg", { class: "spectrum-chart", preserveAspectRatio: "none" });
    charts.appendChild(this.specSVG);
    this.ratioSVG = svgEl("svg", { class: "ratio-chart", preserveAspectRatio: "none" });
    charts.appendChild(this.ratioSVG);

    const controls = document.createElement("div");
    controls.className = "widget-controls";
    controls.innerHTML = `
      <div class="control-row hero">
        <label class="control-label">
          <span class="lab-name">β  <span class="lab-sub">momentum coefficient</span></span>
          <span class="lab-val" data-bind="beta-val">0.95</span>
        </label>
        <input type="range" id="ctl-beta" class="slider" min="0" max="${this.meta.beta_grid.length - 1}" step="0.01" value="${this.state.betaIdx}">
        <div class="slider-axis">
          <span>0</span><span>0.5</span><span>0.9</span><span>0.995</span>
        </div>
      </div>
      <div class="control-row">
        <label class="control-label">
          <span class="lab-name">σ <span class="lab-sub">noise scale  ·  λ<sub>1</sub>/σ = <span data-bind="snr-val">12</span></span></span>
          <span class="lab-val" data-bind="sigma-val">1.00</span>
        </label>
        <input type="range" id="ctl-sigma" class="slider" min="0" max="${this.meta.sigma_grid.length - 1}" step="0.01" value="${this.state.sigmaIdx}">
        <div class="slider-axis">
          <span>0.2</span><span>1.0</span><span>5.0</span>
        </div>
      </div>
      <div class="control-row inline">
        <span class="control-mini-label">rank r</span>
        <div class="rank-pills" role="radiogroup" aria-label="signal rank">
          ${this.meta.ranks.map(r => `
            <button class="pill ${r === this.state.rank ? "active" : ""}" data-rank="${r}">r=${r}</button>
          `).join("")}
        </div>
        <div class="rank-meta">
          <span class="control-mini-label info" data-bind="strength-text">strengths [12, 8, 5]</span>
          <span class="rank-note-sep">·</span>
          <span class="rank-note" data-bind="rank-note">3-spike baseline</span>
        </div>
        <div class="spacer"></div>
        <button class="reset-btn" id="ctl-reset" title="Reset to defaults">reset</button>
      </div>
    `;
    this.container.appendChild(controls);

    const readout = document.createElement("div");
    readout.className = "widget-readout";
    readout.innerHTML = `
      <div class="readout-grid">
        <div class="readout-item"><div class="r-label">Effective window</div><div class="r-value" data-bind="window-text">T = 20</div></div>
        <div class="readout-item"><div class="r-label">Top-r mean error</div><div class="r-value" data-bind="head-error">—</div></div>
        <div class="readout-item"><div class="r-label">Tail floor σ<sub>r+1</sub></div><div class="r-value" data-bind="tail-floor">—</div></div>
        <div class="readout-item"><div class="r-label">Spectral gap σ<sub>r</sub>−σ<sub>r+1</sub></div><div class="r-value" data-bind="gap-text">—</div></div>
      </div>
    `;
    this.container.appendChild(readout);

    this.bind = {};
    for (const el of this.container.querySelectorAll("[data-bind]")) {
      this.bind[el.dataset.bind] = el;
    }
    this.betaSlider = this.container.querySelector("#ctl-beta");
    this.sigmaSlider = this.container.querySelector("#ctl-sigma");
  }

  attachListeners() {
    this.betaSlider.addEventListener("input", (e) => {
      this.state.betaIdx = parseFloat(e.target.value);
      this.requestRender();
    });
    this.sigmaSlider.addEventListener("input", (e) => {
      this.state.sigmaIdx = parseFloat(e.target.value);
      this.requestRender();
    });
    for (const btn of this.container.querySelectorAll(".pill")) {
      btn.addEventListener("click", () => {
        const r = +btn.dataset.rank;
        this.state.rank = r;
        for (const b of this.container.querySelectorAll(".pill")) b.classList.toggle("active", +b.dataset.rank === r);
        this.requestRender();
      });
    }
    this.container.querySelector("#ctl-reset").addEventListener("click", () => {
      this.state = {
        rank: this.meta.default_rank,
        sigmaIdx: this.meta.default_sigma_idx,
        betaIdx: this.meta.default_beta_idx,
      };
      this.betaSlider.value = this.state.betaIdx;
      this.sigmaSlider.value = this.state.sigmaIdx;
      for (const b of this.container.querySelectorAll(".pill")) b.classList.toggle("active", +b.dataset.rank === this.state.rank);
      this.requestRender();
    });
  }

  // ============ Static SVG (built once) ============
  buildStaticSVG() {
    this.measureDims();

    // Spectrum panel: store references in this.spec.* for later mutation
    this.spec = {};
    const sp = this.spec;
    const W = this._dims.specW, H = this._dims.specH;
    this.specSVG.setAttribute("viewBox", `0 0 ${W} ${H}`);

    // Y-axis label (vertical)
    sp.yAxisLabel = svgEl("text", {
      x: 14, y: H / 2, "text-anchor": "middle", class: "axis-title",
      transform: `rotate(-90 14 ${H / 2})`,
    });
    sp.yAxisLabel.textContent = "singular value σₖ";
    this.specSVG.appendChild(sp.yAxisLabel);

    // X-axis label
    const xLab = svgEl("text", { x: W / 2, y: H - 4, "text-anchor": "middle", class: "axis-title" });
    xLab.textContent = "singular-value index k";
    this.specSVG.appendChild(xLab);

    // Group for gridlines + tick text (we rebuild these on σ/rank change)
    sp.gridGroup = svgEl("g", { class: "grid" });
    this.specSVG.appendChild(sp.gridGroup);

    // X-axis baseline
    sp.xAxisLine = svgEl("line", { stroke: COLORS.axis, "stroke-width": 1.2 });
    this.specSVG.appendChild(sp.xAxisLine);

    // Raw curve: fill below + stroked path
    sp.rawArea = svgEl("path", { fill: COLORS.rawFill, opacity: "0.35" });
    sp.rawPath = svgEl("path", { fill: "none", stroke: COLORS.raw, "stroke-width": 1.6, "stroke-dasharray": "4 3" });
    this.specSVG.appendChild(sp.rawArea);
    this.specSVG.appendChild(sp.rawPath);

    // Momentum curve
    sp.momArea = svgEl("path", { fill: COLORS.momFill, opacity: "0.5" });
    sp.momPath = svgEl("path", { fill: "none", stroke: COLORS.momentum, "stroke-width": 2.4, "stroke-linejoin": "round" });
    this.specSVG.appendChild(sp.momArea);
    this.specSVG.appendChild(sp.momPath);

    // Spectral-gap annotation (vertical bracket between σ_r and σ_{r+1})
    sp.gapGroup = svgEl("g", { class: "gap-bracket" });
    sp.gapLine = svgEl("line", { stroke: COLORS.signal, "stroke-width": 1, opacity: "0.5", "stroke-dasharray": "2 3" });
    sp.gapTopTick = svgEl("line", { stroke: COLORS.signal, "stroke-width": 1, opacity: "0.5" });
    sp.gapBotTick = svgEl("line", { stroke: COLORS.signal, "stroke-width": 1, opacity: "0.5" });
    sp.gapLabel = svgEl("text", { class: "gap-label", "text-anchor": "start" });
    sp.gapGroup.appendChild(sp.gapLine);
    sp.gapGroup.appendChild(sp.gapTopTick);
    sp.gapGroup.appendChild(sp.gapBotTick);
    sp.gapGroup.appendChild(sp.gapLabel);
    this.specSVG.appendChild(sp.gapGroup);

    // Signal connector (dashed thin line across diamonds)
    sp.signalConnector = svgEl("path", {
      fill: "none", stroke: COLORS.signal, "stroke-width": 1, opacity: "0.35", "stroke-dasharray": "2 2",
    });
    this.specSVG.appendChild(sp.signalConnector);

    // Up to MAX_DIAMONDS signal diamonds (we hide unused ones).
    // MAX_DIAMONDS must be ≥ max(meta.ranks); 20 covers r ∈ {1, 3, 5, 10, 15}
    // with headroom.
    sp.diamonds = [];
    const MAX_DIAMONDS = 20;
    for (let k = 0; k < MAX_DIAMONDS; k++) {
      const dPath = svgEl("path", { fill: "#ffffff", stroke: COLORS.signal, "stroke-width": 1.8 });
      const dot = svgEl("circle", { r: 1.6, fill: COLORS.signal });
      this.specSVG.appendChild(dPath);
      this.specSVG.appendChild(dot);
      sp.diamonds.push({ diamond: dPath, dot });
    }

    // ---- Ratio panel ----
    this.ratio = {};
    const rp = this.ratio;
    const RW = this._dims.ratioW, RH = this._dims.ratioH;
    this.ratioSVG.setAttribute("viewBox", `0 0 ${RW} ${RH}`);

    // Y-axis label
    rp.yAxisLabel = svgEl("text", {
      x: 14, y: RH / 2, "text-anchor": "middle", class: "axis-title",
      transform: `rotate(-90 14 ${RH / 2})`,
    });
    rp.yAxisLabel.textContent = "σₖ(M) / σₖ(G)";
    this.ratioSVG.appendChild(rp.yAxisLabel);

    // Title (top-left, outside chart area)
    const rtitle = svgEl("text", { x: this.ratioMargin.left + 4, y: 14, class: "ratio-title", "text-anchor": "start" });
    rtitle.textContent = "Per-step filtering ratio σₖ(M)/σₖ(G)  —  head preserved, tail attenuated";
    this.ratioSVG.appendChild(rtitle);

    rp.gridGroup = svgEl("g", { class: "grid" });
    this.ratioSVG.appendChild(rp.gridGroup);

    rp.headBand = svgEl("rect", { fill: COLORS.momFill, opacity: "0.42" });
    this.ratioSVG.appendChild(rp.headBand);
    rp.refLine = svgEl("line", { stroke: COLORS.guideline, "stroke-width": 1, "stroke-dasharray": "3 3" });
    this.ratioSVG.appendChild(rp.refLine);

    rp.area = svgEl("path", { fill: COLORS.ratio, opacity: "0.18" });
    rp.curve = svgEl("path", { fill: "none", stroke: COLORS.ratio, "stroke-width": 2.2, "stroke-linejoin": "round" });
    this.ratioSVG.appendChild(rp.area);
    this.ratioSVG.appendChild(rp.curve);

    rp.xAxisLine = svgEl("line", { stroke: COLORS.axis, "stroke-width": 1.2 });
    this.ratioSVG.appendChild(rp.xAxisLine);

    rp.bandLabel = svgEl("text", { class: "band-label", "text-anchor": "middle" });
    rp.bandLabel.textContent = "head k≤r";
    this.ratioSVG.appendChild(rp.bandLabel);

    this.layoutAxes();
  }

  measureDims() {
    const a = this.specSVG.getBoundingClientRect();
    const b = this.ratioSVG.getBoundingClientRect();
    this._dims.specW = a.width || 720;
    this._dims.specH = a.height || 320;
    this._dims.ratioW = b.width || 720;
    this._dims.ratioH = b.height || 200;
  }

  // Static positions: x-axis tick labels and lines that depend on width only.
  layoutAxes() {
    // Spectrum
    const sp = this.spec;
    const m = this.specMargin;
    const W = this._dims.specW, H = this._dims.specH;
    const innerW = W - m.left - m.right;
    const innerH = H - m.top - m.bottom;
    const x = makeLinearScale([1, X_AXIS_MAX], [m.left, m.left + innerW]);
    sp.x = x;
    sp.innerW = innerW;
    sp.innerH = innerH;
    sp.xAxisLine.setAttribute("x1", m.left);
    sp.xAxisLine.setAttribute("x2", m.left + innerW);
    sp.xAxisLine.setAttribute("y1", m.top + innerH);
    sp.xAxisLine.setAttribute("y2", m.top + innerH);

    // Ratio
    const rp = this.ratio;
    const rm = this.ratioMargin;
    const RW = this._dims.ratioW, RH = this._dims.ratioH;
    const rInnerW = RW - rm.left - rm.right;
    const rInnerH = RH - rm.top - rm.bottom;
    const rx = makeLinearScale([1, X_AXIS_MAX], [rm.left, rm.left + rInnerW]);
    const ry = makeLinearScale([0, 1.1], [rm.top + rInnerH, rm.top]);
    rp.x = rx;
    rp.y = ry;
    rp.innerW = rInnerW;
    rp.innerH = rInnerH;
    rp.xAxisLine.setAttribute("x1", rm.left);
    rp.xAxisLine.setAttribute("x2", rm.left + rInnerW);
    rp.xAxisLine.setAttribute("y1", rm.top + rInnerH);
    rp.xAxisLine.setAttribute("y2", rm.top + rInnerH);
    rp.refLine.setAttribute("x1", rm.left);
    rp.refLine.setAttribute("x2", rm.left + rInnerW);
    rp.refLine.setAttribute("y1", ry(1));
    rp.refLine.setAttribute("y2", ry(1));

    // ratio panel y-grid (always 0..1.1 — never changes)
    rp.gridGroup.innerHTML = "";
    const yTicks = [0, 0.25, 0.5, 0.75, 1.0];
    for (const t of yTicks) {
      rp.gridGroup.appendChild(svgEl("line", {
        x1: rm.left, y1: ry(t), x2: rm.left + rInnerW, y2: ry(t),
        stroke: COLORS.guideline, "stroke-width": 1, opacity: t === 0 ? "0.6" : "0.18",
      }));
      const lab = svgEl("text", { x: rm.left - 8, y: ry(t) + 4, "text-anchor": "end", class: "axis-label" });
      lab.textContent = t.toFixed(2);
      rp.gridGroup.appendChild(lab);
    }
    for (const t of X_TICKS) {
      const lab = svgEl("text", { x: rx(t), y: rm.top + rInnerH + 18, "text-anchor": "middle", class: "axis-label" });
      lab.textContent = t;
      rp.gridGroup.appendChild(lab);
    }

    this._lastRatioKey = "";
    this._lastSpecKey = "";
  }

  handleResize() {
    this.measureDims();
    // recompute viewBox; preserveAspectRatio=none stretches but width-driven layout is cleaner
    this.specSVG.setAttribute("viewBox", `0 0 ${this._dims.specW} ${this._dims.specH}`);
    this.ratioSVG.setAttribute("viewBox", `0 0 ${this._dims.ratioW} ${this._dims.ratioH}`);
    this.layoutAxes();
    this.requestRender(true);
  }

  // Lerp two adjacent grid rows (or matrices) at a fractional index.
  lerpVec(arr, idx) {
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, arr.length - 1);
    const t = Math.max(0, Math.min(1, idx - lo));
    if (t === 0) return arr[lo];
    const a = arr[lo], b = arr[hi];
    const out = new Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] + t * (b[i] - a[i]);
    return out;
  }

  // For the (sigma, beta) momentum / ratio matrices, both axes need lerping.
  lerp2D(matrix, sigmaIdx, betaIdx) {
    const sLo = Math.floor(sigmaIdx);
    const sHi = Math.min(sLo + 1, matrix.length - 1);
    const sT = Math.max(0, Math.min(1, sigmaIdx - sLo));
    const bLo = Math.floor(betaIdx);
    const bHi = Math.min(bLo + 1, matrix[0].length - 1);
    const bT = Math.max(0, Math.min(1, betaIdx - bLo));
    const a = matrix[sLo][bLo];
    const b = matrix[sLo][bHi];
    const c = matrix[sHi][bLo];
    const d = matrix[sHi][bHi];
    const out = new Array(a.length);
    for (let i = 0; i < a.length; i++) {
      const ab = a[i] + bT * (b[i] - a[i]);
      const cd = c[i] + bT * (d[i] - c[i]);
      out[i] = ab + sT * (cd - ab);
    }
    return out;
  }

  // Linear interp of a scalar over a 1-D grid array at fractional idx.
  lerpScalar(arr, idx) {
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, arr.length - 1);
    const t = Math.max(0, Math.min(1, idx - lo));
    return arr[lo] + t * (arr[hi] - arr[lo]);
  }

  // ============ Y-axis range (cached per (rank, sigmaIntIdx)) ============
  // Use the integer floor of sigmaIdx so y-range is stable while user drags β
  // *and* while user drags σ within a single grid cell.
  spectrumYRange(rank, sigmaIdx) {
    const sLo = Math.floor(sigmaIdx);
    const sHi = Math.min(sLo + 1, this.meta.sigma_grid.length - 1);
    const key = `${rank}|${sLo}|${sHi}`;
    if (this._yRangeCache.has(key)) return this._yRangeCache.get(key);
    const rankData = this.data[rank];
    let maxVal = 0;
    // Look across both adjacent sigma bins so the axis doesn't pop when
    // crossing a bin boundary.
    for (const sIdx of [sLo, sHi]) {
      for (const v of rankData.raw[sIdx]) if (v > maxVal) maxVal = v;
      for (const row of rankData.mom[sIdx]) for (const v of row) if (v > maxVal) maxVal = v;
    }
    const strengths = this.meta.strengths[String(rank)];
    const sigMax = Math.max(...strengths);
    if (sigMax > maxVal) maxVal = sigMax;
    const nice = (v) => {
      if (v <= 2) return Math.ceil(v * 4) / 4;
      if (v <= 5) return Math.ceil(v);
      if (v <= 20) return Math.ceil(v / 2) * 2;
      if (v <= 50) return Math.ceil(v / 5) * 5;
      if (v <= 200) return Math.ceil(v / 10) * 10;
      return Math.ceil(v / 50) * 50;
    };
    const out = nice(maxVal * 1.06);
    this._yRangeCache.set(key, out);
    return out;
  }

  // ============ Render loop ============
  requestRender(force = false) {
    if (this._rafQueued && !force) return;
    this._rafQueued = true;
    if (force) {
      this._rafQueued = false;
      this.render();
      return;
    }
    requestAnimationFrame(() => {
      this._rafQueued = false;
      this.render();
    });
  }

  render() {
    const rank = this.state.rank;
    const sigmaIdx = this.state.sigmaIdx;
    const betaIdx = this.state.betaIdx;
    const beta = this.lerpScalar(this.meta.beta_grid, betaIdx);
    const sigma = this.lerpScalar(this.meta.sigma_grid, sigmaIdx);
    const rankData = this.data[rank];
    const raw = this.lerpVec(rankData.raw, sigmaIdx);
    const mom = this.lerp2D(rankData.mom, sigmaIdx, betaIdx);
    const ratio = this.lerp2D(rankData.ratio, sigmaIdx, betaIdx);
    const strengths = this.meta.strengths[String(rank)];

    // -- text bindings --
    this.bind["beta-val"].textContent = beta < 0.1 ? beta.toFixed(2) : beta.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
    this.bind["sigma-val"].textContent = sigma.toFixed(2);
    const SNR = strengths[0] / sigma;
    this.bind["snr-val"].textContent = SNR.toFixed(1);
    const T = 1 / Math.max(1 - beta, 1e-4);
    this.bind["window-text"].textContent = `T = ${T < 100 ? T.toFixed(1) : Math.round(T)}`;
    // Show one decimal only when at least one strength is non-integer; collapse
    // long lists so the rank-control row never wraps.
    const allInt = strengths.every(s => Number.isInteger(s));
    const fmt = (s) => allInt ? s.toFixed(0) : s.toFixed(1);
    const strengthStr = strengths.length <= 6
      ? strengths.map(fmt).join(", ")
      : `${fmt(strengths[0])}, ${fmt(strengths[1])}, …, ${fmt(strengths[strengths.length-2])}, ${fmt(strengths[strengths.length-1])}`;
    this.bind["strength-text"].textContent = `strengths [${strengthStr}]`;
    let headErr = 0;
    for (let k = 0; k < rank; k++) headErr += Math.abs(mom[k] - strengths[k]) / strengths[k];
    headErr /= rank;
    this.bind["head-error"].textContent = `${(headErr * 100).toFixed(1)}%`;
    const tailFloor = mom[rank];
    this.bind["tail-floor"].textContent = tailFloor.toFixed(2);
    const gap = mom[rank - 1] - mom[rank];
    this.bind["gap-text"].textContent = gap.toFixed(2);

    const rankNote = {
      1:  "1-spike baseline",
      3:  "3-spike baseline",
      5:  "5-spike stress test",
      10: "10-spike stress test",
      15: "15-spike stress test",
    }[rank] || "";
    this.bind["rank-note"].textContent = rankNote;

    // -- charts --
    this.renderSpectrum(raw, mom, strengths, rank);
    this.renderRatio(ratio, rank);
  }

  renderSpectrum(raw, mom, strengths, rank) {
    const sp = this.spec;
    const m = this.specMargin;
    const yMaxVal = this.spectrumYRange(rank, this.state.sigmaIdx);
    const y = makeLinearScale([0, yMaxVal], [m.top + sp.innerH, m.top]);
    const x = sp.x;
    sp.y = y;

    const specKey = `${rank}|${yMaxVal}`;
    if (specKey !== this._lastSpecKey) {
      // Rebuild gridlines + y-tick labels + x-tick labels
      sp.gridGroup.innerHTML = "";
      const yTicks = niceTicks(0, yMaxVal, Y_TICK_COUNT);
      for (const t of yTicks) {
        sp.gridGroup.appendChild(svgEl("line", {
          x1: m.left, y1: y(t), x2: m.left + sp.innerW, y2: y(t),
          stroke: COLORS.guideline, "stroke-width": 1, opacity: t === 0 ? "0.6" : "0.3",
        }));
        const lab = svgEl("text", { x: m.left - 8, y: y(t) + 4, "text-anchor": "end", class: "axis-label" });
        lab.textContent = t;
        sp.gridGroup.appendChild(lab);
      }
      for (const t of X_TICKS) {
        const lab = svgEl("text", { x: x(t), y: m.top + sp.innerH + 18, "text-anchor": "middle", class: "axis-label" });
        lab.textContent = t;
        sp.gridGroup.appendChild(lab);
      }
      this._lastSpecKey = specKey;
    }

    // Build curve points (only k=1..40)
    const xs = [];
    for (let k = 1; k <= X_AXIS_MAX; k++) xs.push(k);
    const rawPts = xs.map((k, i) => [x(k), y(raw[i])]);
    const momPts = xs.map((k, i) => [x(k), y(mom[i])]);

    sp.rawPath.setAttribute("d", pathFromPoints(rawPts));
    sp.rawArea.setAttribute("d", areaPath(rawPts, y(0)));
    sp.momPath.setAttribute("d", pathFromPoints(momPts));
    sp.momArea.setAttribute("d", areaPath(momPts, y(0)));

    // Diamonds for planted signal. Shrink the marker as rank grows so adjacent
    // diamonds don't crowd at r=10 / r=15.
    const dRadius = strengths.length <= 5 ? 6 : strengths.length <= 10 ? 5 : 4;
    for (let k = 0; k < sp.diamonds.length; k++) {
      const item = sp.diamonds[k];
      if (k < strengths.length) {
        const cx = x(k + 1);
        const cy = y(strengths[k]);
        item.diamond.setAttribute("d", diamondPath(cx, cy, dRadius));
        item.diamond.setAttribute("opacity", "1");
        item.dot.setAttribute("cx", cx);
        item.dot.setAttribute("cy", cy);
        item.dot.setAttribute("opacity", "1");
      } else {
        item.diamond.setAttribute("opacity", "0");
        item.dot.setAttribute("opacity", "0");
      }
    }

    // Signal connector (dashed line linking diamonds)
    if (strengths.length > 1) {
      const sigPts = strengths.map((s, i) => [x(i + 1), y(s)]);
      sp.signalConnector.setAttribute("d", pathFromPoints(sigPts));
      sp.signalConnector.setAttribute("opacity", "0.4");
    } else {
      sp.signalConnector.setAttribute("opacity", "0");
    }

    // Spectral-gap bracket between σ_r and σ_{r+1}
    if (rank < mom.length) {
      const xMid = x(rank + 0.5);
      const yTop = y(mom[rank - 1]);
      const yBot = y(mom[rank]);
      // Don't draw if gap is essentially zero
      const gap = mom[rank - 1] - mom[rank];
      if (gap > 0.05 * yMaxVal) {
        sp.gapLine.setAttribute("x1", xMid);
        sp.gapLine.setAttribute("x2", xMid);
        sp.gapLine.setAttribute("y1", yTop);
        sp.gapLine.setAttribute("y2", yBot);
        sp.gapTopTick.setAttribute("x1", xMid - 4);
        sp.gapTopTick.setAttribute("x2", xMid + 4);
        sp.gapTopTick.setAttribute("y1", yTop);
        sp.gapTopTick.setAttribute("y2", yTop);
        sp.gapBotTick.setAttribute("x1", xMid - 4);
        sp.gapBotTick.setAttribute("x2", xMid + 4);
        sp.gapBotTick.setAttribute("y1", yBot);
        sp.gapBotTick.setAttribute("y2", yBot);
        sp.gapLabel.setAttribute("x", xMid + 7);
        sp.gapLabel.setAttribute("y", (yTop + yBot) / 2 + 4);
        sp.gapLabel.textContent = `gap = ${gap.toFixed(2)}`;
        sp.gapGroup.setAttribute("opacity", "1");
      } else {
        sp.gapGroup.setAttribute("opacity", "0");
      }
    }
  }

  renderRatio(ratio, rank) {
    const rp = this.ratio;
    const x = rp.x, y = rp.y;
    const rm = this.ratioMargin;

    // Head band: rebuild rect on rank change
    if (this._lastRatioKey !== `r${rank}`) {
      const bandX0 = x(0.6);
      const bandX1 = x(rank + 0.4);
      rp.headBand.setAttribute("x", bandX0);
      rp.headBand.setAttribute("y", rm.top);
      rp.headBand.setAttribute("width", Math.max(bandX1 - bandX0, 4));
      rp.headBand.setAttribute("height", rp.innerH);
      rp.bandLabel.setAttribute("x", (bandX0 + bandX1) / 2);
      rp.bandLabel.setAttribute("y", rm.top + rp.innerH - 6);
      rp.bandLabel.setAttribute("opacity", rank === 1 ? "0" : "1");
      this._lastRatioKey = `r${rank}`;
    }

    // Curve
    const xs = [];
    for (let k = 1; k <= X_AXIS_MAX; k++) xs.push(k);
    const pts = xs.map((k, i) => [x(k), y(Math.min(ratio[i], 1.08))]);
    rp.curve.setAttribute("d", pathFromPoints(pts));
    rp.area.setAttribute("d", areaPath(pts, y(0)));
  }
}


// ----------------------------------------------------------------
//                          bootstrap
// ----------------------------------------------------------------
async function bootWidget() {
  const container = document.getElementById("widget");
  if (!container) return;
  try {
    container.classList.add("loading");
    const resp = await fetch("data/grid.json");
    if (!resp.ok) throw new Error(`grid.json fetch failed: ${resp.status}`);
    const payload = await resp.json();
    new SpectrumWidget(container, payload);
  } catch (err) {
    container.classList.remove("loading");
    container.innerHTML = `<div class="widget-error">Could not load widget data (${err.message}). Serve via <code>python -m http.server</code> in <code>widget/site/</code>.</div>`;
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", bootWidget);
