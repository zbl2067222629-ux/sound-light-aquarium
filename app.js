const canvas = document.querySelector("#visualizer");
const ctx = canvas.getContext("2d");
const startButton = document.querySelector("#startButton");
const serialButton = document.querySelector("#serialButton");
const demoButton = document.querySelector("#demoButton");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const orb = document.querySelector("#orb");

const ui = {
  volume: {
    value: document.querySelector("#volumeValue"),
    bar: document.querySelector("#volumeBar"),
  },
  bass: {
    value: document.querySelector("#bassValue"),
    bar: document.querySelector("#bassBar"),
  },
  mid: {
    value: document.querySelector("#midValue"),
    bar: document.querySelector("#midBar"),
  },
  treble: {
    value: document.querySelector("#trebleValue"),
    bar: document.querySelector("#trebleBar"),
  },
};

let audioContext;
let analyser;
let timeData;
let frequencyData;
let stream;
let serialPort;
let serialWriter;
let lastSerialWrite = 0;
let demoMode = false;
let demoStartedAt = 0;

const particles = Array.from({ length: 54 }, () => ({
  x: Math.random(),
  y: Math.random(),
  size: 0.8 + Math.random() * 2.2,
  speed: 0.1 + Math.random() * 0.35,
  phase: Math.random() * Math.PI * 2,
}));

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function setStatus(text, live = false) {
  statusText.textContent = text;
  statusDot.classList.toggle("live", live);
}

function averageRange(data, startRatio, endRatio) {
  const start = Math.floor(data.length * startRatio);
  const end = Math.max(start + 1, Math.floor(data.length * endRatio));
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += data[i];
  return sum / (end - start);
}

function getAudioLevels() {
  if (demoMode) {
    const t = (performance.now() - demoStartedAt) / 1000;
    return {
      volume: 40 + 25 * Math.sin(t * 2.1) + 14 * Math.sin(t * 5.3),
      bass: 90 + 65 * Math.sin(t * 1.7),
      mid: 80 + 55 * Math.sin(t * 2.4 + 1),
      treble: 70 + 60 * Math.sin(t * 3.1 + 2),
    };
  }

  if (!analyser) return { volume: 0, bass: 0, mid: 0, treble: 0 };

  analyser.getByteTimeDomainData(timeData);
  analyser.getByteFrequencyData(frequencyData);

  let sumSquares = 0;
  for (const sample of timeData) {
    const normalized = (sample - 128) / 128;
    sumSquares += normalized * normalized;
  }

  const rms = Math.sqrt(sumSquares / timeData.length);
  return {
    volume: Math.min(100, rms * 330),
    bass: averageRange(frequencyData, 0.005, 0.08),
    mid: averageRange(frequencyData, 0.08, 0.3),
    treble: averageRange(frequencyData, 0.3, 0.72),
  };
}

function updateUI(levels) {
  const normalized = {
    volume: Math.max(0, Math.min(100, levels.volume)),
    bass: Math.max(0, Math.min(255, levels.bass)),
    mid: Math.max(0, Math.min(255, levels.mid)),
    treble: Math.max(0, Math.min(255, levels.treble)),
  };

  for (const key of Object.keys(ui)) {
    const max = key === "volume" ? 100 : 255;
    ui[key].value.textContent = Math.round(normalized[key]);
    ui[key].bar.style.width = `${(normalized[key] / max) * 100}%`;
  }

  const brightness = Math.max(0.12, normalized.volume / 100);
  const r = Math.round(normalized.bass * brightness);
  const g = Math.round(normalized.mid * brightness);
  const b = Math.round(normalized.treble * brightness);

  orb.style.background = `rgb(${r}, ${g}, ${b})`;
  orb.style.transform = `scale(${1 + normalized.volume / 650})`;
  orb.style.boxShadow = `
    0 ${18 + normalized.volume * 0.12}px ${42 + normalized.volume * 0.45}px rgba(${r}, ${g}, ${b}, 0.28),
    0 0 ${30 + normalized.volume * 0.7}px rgba(${r}, ${g}, ${b}, 0.16),
    inset -28px -32px 60px rgba(48, 52, 70, 0.15),
    inset 15px 15px 45px rgba(255, 255, 255, 0.42)
  `;

  return { r, g, b, ...normalized };
}

function drawBackground(levels, now) {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  const intensity = levels.volume / 100;

  for (const particle of particles) {
    const wave = Math.sin(now * 0.0006 + particle.phase);
    particle.y -= particle.speed * (0.22 + intensity * 1.3) * 0.0018;
    if (particle.y < -0.03) {
      particle.y = 1.03;
      particle.x = Math.random();
    }

    const x = particle.x * innerWidth + wave * 18 * intensity;
    const y = particle.y * innerHeight;
    const alpha = 0.08 + intensity * 0.28;
    ctx.beginPath();
    ctx.fillStyle = `rgba(${90 + levels.bass / 2}, ${100 + levels.mid / 2}, ${150 + levels.treble / 2}, ${alpha})`;
    ctx.arc(x, y, particle.size * (1 + intensity), 0, Math.PI * 2);
    ctx.fill();
  }

  const baseline = innerHeight * 0.82;
  ctx.beginPath();
  ctx.moveTo(0, baseline);
  const segments = 90;
  for (let i = 0; i <= segments; i += 1) {
    const x = (i / segments) * innerWidth;
    const envelope = Math.sin((i / segments) * Math.PI);
    const y =
      baseline +
      Math.sin(i * 0.42 + now * 0.003) * 18 * intensity * envelope +
      Math.sin(i * 0.13 - now * 0.0014) * 9 * intensity;
    ctx.lineTo(x, y);
  }
  ctx.strokeStyle = `rgba(130, 117, 255, ${0.12 + intensity * 0.5})`;
  ctx.lineWidth = 1.4;
  ctx.stroke();
}

async function sendToArduino({ r, g, b }) {
  if (!serialWriter || performance.now() - lastSerialWrite < 50) return;
  lastSerialWrite = performance.now();
  const message = `${r},${g},${b}\n`;
  try {
    await serialWriter.write(new TextEncoder().encode(message));
  } catch (error) {
    setStatus("Arduino 连接中断");
    await disconnectSerial();
  }
}

function render(now) {
  const rawLevels = getAudioLevels();
  const levels = updateUI(rawLevels);
  drawBackground(levels, now);
  sendToArduino(levels);
  requestAnimationFrame(render);
}

async function startMicrophone() {
  try {
    demoMode = false;
    demoButton.textContent = "演示模式";
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    audioContext = new AudioContext();
    await audioContext.resume();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.78;
    source.connect(analyser);
    timeData = new Uint8Array(analyser.fftSize);
    frequencyData = new Uint8Array(analyser.frequencyBinCount);

    startButton.textContent = "麦克风已启用";
    startButton.disabled = true;
    serialButton.disabled = !("serial" in navigator);
    setStatus("正在聆听", true);
  } catch (error) {
    setStatus(error.name === "NotAllowedError" ? "麦克风权限未开启" : "无法启动麦克风");
  }
}

async function connectSerial() {
  if (!("serial" in navigator)) {
    setStatus("当前浏览器不支持串口");
    return;
  }

  if (serialPort) {
    await disconnectSerial();
    return;
  }

  try {
    serialPort = await navigator.serial.requestPort();
    await serialPort.open({ baudRate: 115200 });
    serialWriter = serialPort.writable.getWriter();
    serialButton.textContent = "断开 Arduino";
    setStatus("麦克风 + Arduino 已连接", true);
  } catch (error) {
    if (error.name !== "NotFoundError") setStatus("Arduino 连接失败");
    serialPort = null;
  }
}

async function disconnectSerial() {
  if (serialWriter) {
    serialWriter.releaseLock();
    serialWriter = null;
  }
  if (serialPort) {
    await serialPort.close().catch(() => {});
    serialPort = null;
  }
  serialButton.textContent = "连接 Arduino";
  setStatus(analyser ? "正在聆听" : "等待启动", Boolean(analyser));
}

function toggleDemo() {
  demoMode = !demoMode;
  demoStartedAt = performance.now();
  demoButton.textContent = demoMode ? "停止演示" : "演示模式";
  serialButton.disabled = !demoMode && !analyser;
  setStatus(demoMode ? "演示模式运行中" : analyser ? "正在聆听" : "等待启动", demoMode || Boolean(analyser));
}

window.addEventListener("resize", resizeCanvas);
startButton.addEventListener("click", startMicrophone);
serialButton.addEventListener("click", connectSerial);
demoButton.addEventListener("click", toggleDemo);

resizeCanvas();
requestAnimationFrame(render);
