import {
  computeDepthStats,
  decodeRgbdeComponents,
  decodeRgbdeFile,
  findBestMeshSize,
  generatePerspectiveMesh,
} from "./geometry.js";
import { preprocessDepth } from "./depth-processing.js";

const API_BASE = window.__RGBDE_API_BASE__ ?? "";

const FIXTURES = [
  { name: "rgbde-small", url: "./test-assets/rgbde-small.png" },
  { name: "rgbde-large", url: "./test-assets/rgbde-large.png" },
];

const resultsBody = document.getElementById("results-body");
const logBox = document.getElementById("log");
const runButton = document.getElementById("run-benchmarks");

runButton.addEventListener("click", () => {
  void runBenchmarks();
});

function setLog(text) {
  logBox.textContent = text;
}

function appendRow(columns) {
  const row = document.createElement("tr");
  for (const value of columns) {
    const cell = document.createElement("td");
    cell.textContent = value;
    row.appendChild(cell);
  }
  resultsBody.appendChild(row);
}

function clearRows() {
  resultsBody.innerHTML = "";
}

function formatMs(value) {
  return value.toFixed(2);
}

async function benchmarkFixture(fixture, mode) {
  const response = await fetch(fixture.url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load ${fixture.url} (${response.status})`);
  }

  const blob = await response.blob();
  const totalStart = performance.now();
  let decoded;
  let preprocessedDepth;
  let depthStats;
  let decodeMs;
  let preprocessMs;

  if (mode === "worker") {
    decoded = await decodeRgbdeFile(blob, { useWorker: true, includeMetrics: true });
    preprocessedDepth = decoded.depth;
    depthStats = decoded.depthStats;
    decodeMs = decoded.metrics?.decodeMs ?? 0;
    preprocessMs = decoded.metrics?.preprocessMs ?? 0;
  } else {
    const decodeStart = performance.now();
    decoded = await decodeRgbdeComponents(blob);
    decodeMs = performance.now() - decodeStart;

    const preprocessStart = performance.now();
    preprocessedDepth = preprocessDepth(
      decoded.depth,
      decoded.leftPixels,
      decoded.width,
      decoded.height,
    );
    depthStats = computeDepthStats(preprocessedDepth);
    preprocessMs = performance.now() - preprocessStart;
  }

  const meshStart = performance.now();
  const { meshX, meshY } = findBestMeshSize(decoded.width, decoded.height);
  generatePerspectiveMesh({
    depth: preprocessedDepth,
    width: decoded.width,
    height: decoded.height,
    meshX,
    meshY,
    depthMin: depthStats.min,
    depthMax: depthStats.max,
  });
  const meshMs = performance.now() - meshStart;

  return {
    fixture: fixture.name,
    mode,
    decodeMs,
    preprocessMs,
    meshMs,
    totalMs: performance.now() - totalStart,
    notes: `${decoded.width}x${decoded.height}`,
  };
}

async function benchmarkBackend() {
  const response = await fetch("./test-assets/source-gradient.png", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load source fixture (${response.status})`);
  }

  const sourceBlob = await response.blob();
  const form = new FormData();
  form.append("image", sourceBlob, "source-gradient.png");

  const start = performance.now();
  const backendResponse = await fetch(`${API_BASE}/api/process`, {
    method: "POST",
    body: form,
  });

  const elapsed = performance.now() - start;
  if (!backendResponse.ok) {
    const message = await backendResponse.text();
    throw new Error(message || `Backend returned ${backendResponse.status}`);
  }

  await backendResponse.arrayBuffer();
  return elapsed;
}

async function runBenchmarks() {
  runButton.disabled = true;
  clearRows();
  setLog("Running frontend fixtures...");

  try {
    for (const fixture of FIXTURES) {
      for (const mode of ["main-thread", "worker"]) {
        const result = await benchmarkFixture(fixture, mode);
        appendRow([
          result.fixture,
          result.mode,
          formatMs(result.decodeMs),
          formatMs(result.preprocessMs),
          formatMs(result.meshMs),
          formatMs(result.totalMs),
          result.notes,
        ]);
      }
    }

    setLog("Running backend round-trip benchmark...");
    try {
      const backendMs = await benchmarkBackend();
      appendRow([
        "backend-process",
        "network",
        "n/a",
        "n/a",
        "n/a",
        formatMs(backendMs),
        "source-gradient.png via /api/process",
      ]);
      setLog("Completed frontend and backend benchmarks.");
    } catch (error) {
      appendRow([
        "backend-process",
        "network",
        "n/a",
        "n/a",
        "n/a",
        "n/a",
        `Skipped: ${error.message}`,
      ]);
      setLog(`Frontend benchmarks completed. Backend benchmark skipped: ${error.message}`);
    }
  } catch (error) {
    setLog(`Benchmark failed: ${error.message}`);
  } finally {
    runButton.disabled = false;
  }
}
