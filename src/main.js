import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// ── SUPABASE LEADERBOARD ────────────────────────────────────
const SUPABASE_URL = 'https://ptclkghlduibzvnsedyj.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0Y2xrZ2hsZHVpYnp2bnNlZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxNzM4NzgsImV4cCI6MjA5ODc0OTg3OH0.m5JG63oKd4T66Y0AT9JMsG30nueNRbDzCZqxLZHmNA'

async function submitScore(name, timeSeconds) {
  // Client-side validation
  const cleanName = sanitizeName(name)
  if (!/^[A-Z0-9 ]{1,12}$/.test(cleanName)) return false
  const clampedTime = Math.min(Math.max(0, timeSeconds), 7200)
  // Rate limit: reject if < 5 seconds since last submit
  const now = Date.now()
  if (now - lastSubmitTimestamp < 5000) return false
  lastSubmitTimestamp = now
  const res = await fetch(`${SUPABASE_URL}/rest/v1/scores`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ name: cleanName, time_seconds: clampedTime })
  })
  return res.ok
}

async function getLeaderboard(limit = 10) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/scores?select=name,time_seconds&order=time_seconds.desc&limit=${limit}`,
      { headers: { 'apikey': SUPABASE_KEY } }
    )
    return res.ok ? await res.json() : []
  } catch { return [] }
}

function formatTime(s) {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
}

function sanitizeName(raw) {
  // Uppercase A-Z, digits, spaces only, 1-12 chars
  const cleaned = String(raw || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim().slice(0, 12)
  return cleaned || 'ANON'
}

async function renderLeaderboard() {
  const list = document.getElementById('lb-list')
  const empty = document.getElementById('lb-empty')
  const scores = await getLeaderboard()
  if (scores.length === 0) { empty.style.display = 'block'; list.innerHTML = ''; return }
  empty.style.display = 'none'
  list.innerHTML = ''
  for (let i = 0; i < scores.length; i++) {
    const row = document.createElement('div')
    row.className = 'lb-row'
    const rank = document.createElement('span')
    rank.className = 'lb-rank'
    rank.textContent = `${i+1}.`
    const name = document.createElement('span')
    name.className = 'lb-name'
    name.textContent = sanitizeName(scores[i].name)
    const time = document.createElement('span')
    time.className = 'lb-time'
    time.textContent = formatTime(scores[i].time_seconds)
    row.append(rank, name, time)
    list.appendChild(row)
  }
}

// Load leaderboard on page load
renderLeaderboard()

// Lock to landscape on mobile (requires user gesture / fullscreen on some browsers)
if (screen.orientation?.lock) {
  screen.orientation.lock('landscape').catch(() => {})
}

const enemyTex = new THREE.TextureLoader().load('/ENEMY.jpg')
const spriteMat = new THREE.SpriteMaterial({ map: enemyTex, depthWrite: true })

// Preload face image for wall texture tiling
const faceImg = new Image()
faceImg.src = '/ENEMY.jpg'

const music = new Audio('/music.mp3')
music.loop = true
music.preload = 'auto'
music.volume = 0.08
let musicPlayPending = false  // retry on next touch if browser blocked autoplay

// ── SETTINGS (persisted to localStorage) ──────────────────
let masterVolume = parseFloat(localStorage.getItem('yerooms_volume') ?? '1')
let _savedSens = localStorage.getItem('yerooms_sensitivity')
let invertY = localStorage.getItem('yerooms_invertY') === 'true'
// postEffectsEnabled is set later after isTouch detection, then overridden from localStorage if saved
let _savedPostFx = localStorage.getItem('yerooms_postEffects')

// ── LEADERBOARD RATE LIMIT ───────────────────────────────
let lastSubmitTimestamp = 0

// ── WEB AUDIO — positional entity audio ──────────────────
let audioCtx = null
let audioPanner = null       // PannerNode for entity position
let footstepTimer = 0        // countdown to next footstep thud
let huntNoiseSource = null   // currently playing hunt drone source
let huntNoiseGain = null     // gain for hunt drone
let spawnBangPlayed = false  // prevent re-playing spawn bang

let masterGainNode = null  // master gain for all Web Audio

function initAudioContext() {
  if (audioCtx) return
  audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  // Master gain node — all audio routes through this
  masterGainNode = audioCtx.createGain()
  masterGainNode.gain.value = masterVolume
  masterGainNode.connect(audioCtx.destination)
  // PannerNode for spatial entity audio
  audioPanner = audioCtx.createPanner()
  audioPanner.panningModel = 'HRTF'
  audioPanner.distanceModel = 'inverse'
  audioPanner.refDistance = 1
  audioPanner.maxDistance = 50
  audioPanner.rolloffFactor = 1.5
  audioPanner.connect(masterGainNode)
}

// Play a low-frequency thud (footstep) at entity position
function playFootstep(volume) {
  if (!audioCtx || audioCtx.state !== 'running') return
  const osc = audioCtx.createOscillator()
  const gain = audioCtx.createGain()
  osc.type = 'sine'
  osc.frequency.value = 60 + Math.random() * 20  // 60-80 Hz
  gain.gain.setValueAtTime(volume * 0.5, audioCtx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.05)
  osc.connect(gain)
  gain.connect(audioPanner)
  osc.start(audioCtx.currentTime)
  osc.stop(audioCtx.currentTime + 0.05)
}

// Start the hunt drone (filtered noise)
function startHuntDrone() {
  if (!audioCtx || huntNoiseSource) return
  // Create white noise buffer
  const bufSize = audioCtx.sampleRate * 2
  const buf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1
  huntNoiseSource = audioCtx.createBufferSource()
  huntNoiseSource.buffer = buf
  huntNoiseSource.loop = true
  const filter = audioCtx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 200
  filter.Q.value = 3
  huntNoiseGain = audioCtx.createGain()
  huntNoiseGain.gain.value = 0
  huntNoiseSource.connect(filter)
  filter.connect(huntNoiseGain)
  huntNoiseGain.connect(audioPanner)
  huntNoiseSource.start()
}

function stopHuntDrone() {
  if (huntNoiseSource) {
    try { huntNoiseSource.stop() } catch {}
    huntNoiseSource = null
    huntNoiseGain = null
  }
}

// Metallic bang for spawn telegraph
function playSpawnBang() {
  if (!audioCtx || audioCtx.state !== 'running') return
  const bufSize = audioCtx.sampleRate * 0.15
  const buf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1
  const src = audioCtx.createBufferSource()
  src.buffer = buf
  const bp = audioCtx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 800
  bp.Q.value = 8
  const gain = audioCtx.createGain()
  gain.gain.setValueAtTime(0.7, audioCtx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15)
  src.connect(bp)
  bp.connect(gain)
  gain.connect(audioPanner)
  src.start()
  src.stop(audioCtx.currentTime + 0.15)
}

// Jumpscare audio sting — noise burst + detuned low tones
function playJumpscareSting() {
  if (!audioCtx) return
  if (audioCtx.state === 'suspended') audioCtx.resume()
  const now = audioCtx.currentTime
  // Noise burst (~100ms)
  const bufSize = audioCtx.sampleRate * 0.1
  const buf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1
  const noiseSrc = audioCtx.createBufferSource()
  noiseSrc.buffer = buf
  const noiseGain = audioCtx.createGain()
  noiseGain.gain.setValueAtTime(0.8, now)
  noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.1)
  noiseSrc.connect(noiseGain)
  noiseGain.connect(masterGainNode || audioCtx.destination)
  noiseSrc.start(now)
  noiseSrc.stop(now + 0.1)
  // Detuned low tones
  for (const freq of [80, 95]) {
    const osc = audioCtx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.value = freq
    const g = audioCtx.createGain()
    g.gain.setValueAtTime(0.6, now)
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.3)
    osc.connect(g)
    g.connect(masterGainNode || audioCtx.destination)
    osc.start(now)
    osc.stop(now + 0.3)
  }
}

// Update AudioListener position from camera
function updateAudioListener() {
  if (!audioCtx || !audioCtx.listener) return
  const listener = audioCtx.listener
  if (listener.positionX) {
    listener.positionX.value = camera.position.x
    listener.positionY.value = camera.position.y
    listener.positionZ.value = camera.position.z
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
    listener.forwardX.value = fwd.x
    listener.forwardY.value = fwd.y
    listener.forwardZ.value = fwd.z
    listener.upX.value = up.x
    listener.upY.value = up.y
    listener.upZ.value = up.z
  } else {
    listener.setPosition(camera.position.x, camera.position.y, camera.position.z)
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
    listener.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z)
  }
}

// Update PannerNode position from entity
function updatePannerPosition(ex, ey, ez) {
  if (!audioPanner) return
  if (audioPanner.positionX) {
    audioPanner.positionX.value = ex
    audioPanner.positionY.value = ey
    audioPanner.positionZ.value = ez
  } else {
    audioPanner.setPosition(ex, ey, ez)
  }
}

// ── 5b. PLAYER FOOTSTEP SOUNDS (per-floor synthesis) ─────
function playPlayerFootstep(floorIdx) {
  if (!audioCtx || audioCtx.state !== 'running') return
  const now = audioCtx.currentTime

  if (floorIdx === 0) {
    // Carpet thud: low freq, muffled
    const osc = audioCtx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = 90 + Math.random() * 20
    const lp = audioCtx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 200
    const g = audioCtx.createGain()
    g.gain.setValueAtTime(0.12, now)
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.06)
    osc.connect(lp)
    lp.connect(g)
    g.connect(masterGainNode || audioCtx.destination)
    osc.start(now)
    osc.stop(now + 0.06)
  } else if (floorIdx === 1) {
    // Hard tile click: higher freq, sharp
    const osc = audioCtx.createOscillator()
    osc.type = 'square'
    osc.frequency.value = 280 + Math.random() * 40
    const g = audioCtx.createGain()
    g.gain.setValueAtTime(0.08, now)
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.04)
    osc.connect(g)
    g.connect(masterGainNode || audioCtx.destination)
    osc.start(now)
    osc.stop(now + 0.04)
  } else {
    // Wet tile slap: noise burst through bandpass
    const bufSize = Math.floor(audioCtx.sampleRate * 0.06)
    const buf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1
    const src = audioCtx.createBufferSource()
    src.buffer = buf
    const bp = audioCtx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 200
    bp.Q.value = 2
    const g = audioCtx.createGain()
    g.gain.setValueAtTime(0.1, now)
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.06)
    src.connect(bp)
    bp.connect(g)
    g.connect(masterGainNode || audioCtx.destination)
    src.start(now)
    src.stop(now + 0.06)
  }
}

// 5e. Score juice sting (ascending synth)
function playScoreJuiceSting() {
  if (!audioCtx || audioCtx.state !== 'running') return
  const now = audioCtx.currentTime
  const osc = audioCtx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(400, now)
  osc.frequency.linearRampToValueAtTime(600, now + 0.15)
  const g = audioCtx.createGain()
  g.gain.setValueAtTime(0.1, now)
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.25)
  osc.connect(g)
  g.connect(masterGainNode || audioCtx.destination)
  osc.start(now)
  osc.stop(now + 0.25)
}

// ── SPRINT / STAMINA ──────────────────────────────────────
let stamina = 3.0           // current stamina (seconds)
const STAMINA_MAX = 3.0
const STAMINA_DRAIN = 1.0   // drain 1s of stamina per 1s of sprinting
const STAMINA_REGEN = 0.5   // recover 0.5s per 1s (= 6s full recharge)
const SPRINT_MULT = 1.35
let isSprinting = false
let breathingOsc = null
let breathingGain = null
let breathingFilter = null

// ── AMBIENCE ─────────────────────────────────────────────
let ambienceHumSource = null
let ambienceHumGain = null
let ambienceStarted = false
let ambienceEventTimer = 0
let ambienceEventsScheduled = false

// ── ESCAPE HOLES (crusher rooms) ─────────────────────────
let escapeHole0Mesh = null
let escapeHole1Mesh = null
let escapeHole2Mesh = null
let escapeHole0Open = false
let escapeHole1Open = false
let escapeHole2Open = false

// ── TRAP TELEGRAPH PANELS ────────────────────────────────
let trapPanel0 = null
let trapPanel1 = null
let trapPanel2 = null

// ── CONSTANTS ─────────────────────────────────────────────
const MAX_HEALTH   = 1
const CELL         = 4
const WALL_H       = 3.0
const EYE_H        = 1.65
const MOVE_SPEED   = 5
const TURN_SPEED   = 2.2
const LOOK_TOUCH   = 0.005
let   MOUSE_SENS   = _savedSens !== null ? parseFloat(_savedSens) : 0.0022  // radians per pixel
const FOV          = 75
const HIT_COOLDOWN = 1.5

// ── MAP ───────────────────────────────────────────────────
// 48×48 procedurally carved grid. 13 rooms of varied shapes:
//   NW room, N long hall (thin), NE big room, NE corner pocket,
//   W tube (tall narrow), NW antechamber, CENTER hub (large),
//   NE gallery (tall narrow), E tube, S pocket,
//   SW main, S long hall (thin), SE main (enemy spawn).
// Every room has ≥2 exits. No dead-ends. Multiple loops.
const MAP = (() => {
  const R = 48, C = 48
  const m = Array.from({ length: R }, () => new Array(C).fill(1))
  const open = (r1, r2, c1, c2) => {
    for (let r = r1; r <= r2; r++)
      for (let c = c1; c <= c2; c++)
        m[r][c] = 0
  }

  // ── Rooms ──────────────────────────────────────────────
  open(1,  8,  1,  9)   // NW room
  open(1,  4, 12, 22)   // N hall — long thin east-west
  open(1, 10, 25, 37)   // NE big room
  open(1,  7, 40, 46)   // NE corner pocket
  open(12, 24,  1,  5)  // W tube — tall narrow
  open(12, 18,  8, 15)  // NW antechamber
  open(11, 32, 18, 36)  // CENTER hub — large open
  open(13, 22, 40, 46)  // NE gallery — tall narrow
  open(26, 32, 40, 46)  // E tube — narrow
  open(35, 42, 22, 30)  // S pocket
  open(37, 46,  1, 12)  // SW main
  open(43, 46, 15, 32)  // S hall — long thin
  open(37, 46, 35, 46)  // SE main (enemy spawn)

  // ── Corridors — every room gets ≥2 connections ─────────
  open(2,  4, 10, 11)   // NW ↔ N hall
  open(3,  4, 23, 24)   // N hall ↔ NE big
  open(5,  7, 38, 39)   // NE big ↔ NE corner
  open(9, 11,  3,  4)   // NW → W tube (south drop)
  open(5, 10, 19, 20)   // N hall → CENTER (drops south through gap)
  open(16, 17,  6,  7)  // W tube → NW antechamber
  open(14, 15, 16, 17)  // NW antechamber → CENTER
  open(22, 23,  5, 18)  // W tube → CENTER (wide direct connector)
  open(8, 12, 42, 43)   // NE corner → NE gallery
  open(15, 16, 37, 39)  // NE gallery → CENTER
  open(23, 25, 42, 43)  // NE gallery → E tube
  open(28, 29, 37, 39)  // E tube → CENTER
  open(33, 34, 24, 25)  // CENTER → S pocket
  open(33, 38, 35, 36)  // CENTER → SE (south exit)
  open(41, 42, 12, 21)  // S pocket → SW
  open(41, 42, 30, 35)  // S pocket ↔ SE
  open(43, 44, 13, 14)  // SW ↔ S hall
  open(43, 44, 33, 34)  // S hall ↔ SE

  // ── Trap room — secret west pocket reachable via long narrow hallway ──
  open(28, 34,  2,  6)  // trap room — west dead zone, no way out
  open(31, 31,  7, 17)  // trap hallway — single corridor connecting trap room to CENTER

  return m
})()
const ROWS = MAP.length
const COLS = MAP[0].length

const openCells = []
for (let r = 0; r < ROWS; r++)
  for (let c = 0; c < COLS; c++)
    if (MAP[r][c] === 0) openCells.push([r, c])

// ── TEXTURES ──────────────────────────────────────────────

function makeWallTex(img) {
  const S = 512
  const cv = document.createElement('canvas')
  cv.width = cv.height = S
  const ctx = cv.getContext('2d')

  // Cream base
  ctx.fillStyle = '#DDD8B8'
  ctx.fillRect(0, 0, S, S)

  // Tile the face at very low opacity — wallpaper pattern
  if (img && img.naturalWidth > 0) {
    const tileW = 128, tileH = 148
    ctx.save()
    ctx.globalAlpha = 0.07
    for (let y = 0; y < S; y += tileH) {
      for (let x = 0; x < S; x += tileW) {
        ctx.drawImage(img, x, y, tileW, tileH)
      }
    }
    ctx.restore()
  }

  // Subtle vertical dividing lines — give walls a panelled feel
  ctx.strokeStyle = 'rgba(160,140,80,0.18)'
  ctx.lineWidth = 1
  for (let x = 64; x < S; x += 64) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, S); ctx.stroke()
  }

  // Noise
  for (let i = 0; i < 12000; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.04})`
    ctx.fillRect(Math.random()*S, Math.random()*S, 1, 1)
  }

  const t = new THREE.CanvasTexture(cv)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(2, 1)
  return t
}

function makeFloorTex() {
  const S = 512
  const cv = document.createElement('canvas')
  cv.width = cv.height = S
  const ctx = cv.getContext('2d')

  // Warm golden-tan carpet base
  ctx.fillStyle = '#C8BC88'
  ctx.fillRect(0, 0, S, S)

  // Isometric diamond grid — creates a 3D cube optical illusion in perspective
  // Each cell has a light top face and a dark bottom-right shadow, making it read
  // as either a raised cube or a recessed hole depending on how your eye locks it.
  const dw = 24   // diamond full width
  const dh = 14   // diamond full height

  for (let row = -2; row < S / dh + 4; row++) {
    for (let col = -2; col < S / dw + 4; col++) {
      const ox = (row % 2 === 0) ? 0 : dw / 2
      const bx = col * dw + ox
      const by = row * dh

      // Top face — light (reads as raised surface)
      ctx.fillStyle = 'rgba(255,248,200,0.28)'
      ctx.beginPath()
      ctx.moveTo(bx + dw / 2, by)
      ctx.lineTo(bx + dw,     by + dh / 2)
      ctx.lineTo(bx + dw / 2, by + dh)
      ctx.lineTo(bx,          by + dh / 2)
      ctx.closePath()
      ctx.fill()

      // Bottom-right shadow triangle — creates the cube illusion flip
      ctx.fillStyle = 'rgba(50,35,5,0.18)'
      ctx.beginPath()
      ctx.moveTo(bx + dw / 2, by + dh)
      ctx.lineTo(bx + dw,     by + dh / 2)
      ctx.lineTo(bx + dw,     by + dh)
      ctx.closePath()
      ctx.fill()

      // Bottom-left shadow triangle — completes the cube underside
      ctx.fillStyle = 'rgba(50,35,5,0.10)'
      ctx.beginPath()
      ctx.moveTo(bx + dw / 2, by + dh)
      ctx.lineTo(bx,          by + dh / 2)
      ctx.lineTo(bx,          by + dh)
      ctx.closePath()
      ctx.fill()
    }
  }

  // Diagonal cross-hatch — subtle second layer that fights the eye at angle
  ctx.strokeStyle = 'rgba(100,80,20,0.06)'
  ctx.lineWidth = 0.8
  for (let i = -S; i < S * 2; i += 20) {
    ctx.beginPath(); ctx.moveTo(i, 0);   ctx.lineTo(i + S, S); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(i, S);   ctx.lineTo(i + S, 0); ctx.stroke()
  }

  // Carpet pile noise — short horizontal strokes in pile direction
  for (let i = 0; i < 32000; i++) {
    const a = Math.random() * 0.13
    ctx.fillStyle = Math.random() > 0.55
      ? `rgba(255,248,205,${a})`
      : `rgba(90,70,20,${a})`
    ctx.fillRect(Math.random() * S, Math.random() * S, Math.random() * 4 + 1, 1)
  }

  const t = new THREE.CanvasTexture(cv)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(10, 10)
  return t
}

function makeCeilTex() {
  const S = 256
  const cv = document.createElement('canvas')
  cv.width = cv.height = S
  const ctx = cv.getContext('2d')

  // Medium warm gray — darker than walls, lighter than dark (creates clear contrast with panels)
  ctx.fillStyle = '#A89C78'
  ctx.fillRect(0, 0, S, S)

  // Drop ceiling grid — large tiles (128px = 2 tiles per texture)
  ctx.strokeStyle = '#4A4228'
  ctx.lineWidth = 3.5
  for (let i = 0; i <= S; i += 128) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, S); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(S, i); ctx.stroke()
  }
  // Inner subdivision lines — thinner
  ctx.strokeStyle = '#605840'
  ctx.lineWidth = 1
  for (let i = 64; i < S; i += 128) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, S); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(S, i); ctx.stroke()
  }

  // Tile surface noise
  for (let i = 0; i < 6000; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`
    ctx.fillRect(Math.random()*S, Math.random()*S, 1, 1)
  }

  const t = new THREE.CanvasTexture(cv)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(1, 1)
  return t
}

function makeTrapWallTex(img) {
  const S = 512
  const cv = document.createElement('canvas')
  cv.width = cv.height = S
  const ctx = cv.getContext('2d')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, S, S)
  if (img && img.naturalWidth > 0) {
    const half = S / 2
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++)
        ctx.drawImage(img, x * half, y * half, half, half)
  }
  const t = new THREE.CanvasTexture(cv)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(1, 1)
  return t
}

// ── RENDERER / SCENE / CAMERA ─────────────────────────────

const renderer = new THREE.WebGLRenderer({ antialias: false })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
renderer.setSize(window.innerWidth, window.innerHeight)
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0xC8A828)
scene.fog = new THREE.Fog(0xC8A828, 15, 80)

const levelGroups = [new THREE.Group(), new THREE.Group(), new THREE.Group()]
levelGroups.forEach(g => scene.add(g))

const FLOOR_FOG = [
  { color: 0xC8A828 },  // warm yellow backrooms
  { color: 0xE8E4DC },  // sterile white mall
  { color: 0xD4E8F0 },  // cyan poolrooms
]

function setFloorFog(floorIdx) {
  const c = FLOOR_FOG[floorIdx].color
  scene.fog.color.setHex(c)
  scene.background.setHex(c)
}

const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth/window.innerHeight, 0.05, 80)
camera.rotation.order = 'YXZ'

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight)
  camera.aspect = window.innerWidth/window.innerHeight
  camera.updateProjectionMatrix()
  // Resize post-processing render target
  if (postRT) postRT.setSize(window.innerWidth, window.innerHeight)
})

// ── 5c. POST-PROCESSING SETUP ────────────────────────────
const postRT = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight)
const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
const postScene = new THREE.Scene()
const postMaterial = new THREE.ShaderMaterial({
  uniforms: {
    tDiffuse: { value: postRT.texture },
    uTime: { value: 0 },
    uFlicker: { value: 1.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uFlicker;
    varying vec2 vUv;

    float rand(vec2 co) {
      return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);

      // Film grain
      float grain = (rand(vUv * uTime) - 0.5) * 0.08;
      color.rgb += grain;

      // Vignette
      vec2 center = vUv - 0.5;
      float dist = length(center);
      float vig = 1.0 - smoothstep(0.4, 0.85, dist);
      color.rgb *= vig;

      // Luminance flicker
      color.rgb *= uFlicker;

      gl_FragColor = color;
    }
  `,
  depthTest: false,
  depthWrite: false,
})
const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial)
postScene.add(postQuad)

// ── BUILD MAZE ────────────────────────────────────────────

const wallMat     = new THREE.MeshLambertMaterial({ map: makeWallTex(faceImg) })
const trapWallMat = new THREE.MeshLambertMaterial({ map: makeTrapWallTex(faceImg), side: THREE.DoubleSide })
// Regenerate textures once face image is confirmed loaded
faceImg.onload = () => {
  wallMat.map.dispose()
  wallMat.map = makeWallTex(faceImg)
  wallMat.needsUpdate = true
  trapWallMat.map.dispose()
  trapWallMat.map = makeTrapWallTex(faceImg)
  trapWallMat.needsUpdate = true
}
const floorMat  = new THREE.MeshLambertMaterial({ map: makeFloorTex() })
const ceilMat   = new THREE.MeshLambertMaterial({ map: makeCeilTex()  })
const panelMat  = new THREE.MeshBasicMaterial({ color: 0xfffef0, side: THREE.FrontSide })

const f0WallGeos = [], f0FloorGeos = [], f0CeilGeos = [], f0PanelGeos = []

for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) {
    const wx = col*CELL + CELL/2
    const wz = row*CELL + CELL/2

    if (MAP[row][col] === 1) {
      const g = new THREE.BoxGeometry(CELL, WALL_H, CELL)
      g.translate(wx, WALL_H/2, wz)
      f0WallGeos.push(g)
    } else {
      const fg = new THREE.PlaneGeometry(CELL, CELL)
      fg.rotateX(-Math.PI/2)
      fg.translate(wx, 0, wz)
      f0FloorGeos.push(fg)

      const cg = new THREE.PlaneGeometry(CELL, CELL)
      cg.rotateX(Math.PI/2)
      cg.translate(wx, WALL_H, wz)
      f0CeilGeos.push(cg)

      if ((row + col) % 2 === 0) {
        const pg = new THREE.PlaneGeometry(2.2, 1.0)
        pg.rotateX(Math.PI/2)
        pg.translate(wx, WALL_H - 0.015, wz)
        f0PanelGeos.push(pg)
      }
    }
  }
}

levelGroups[0].add(
  new THREE.Mesh(mergeGeometries(f0WallGeos), wallMat),
  new THREE.Mesh(mergeGeometries(f0FloorGeos), floorMat),
  new THREE.Mesh(mergeGeometries(f0CeilGeos), ceilMat),
  new THREE.Mesh(mergeGeometries(f0PanelGeos), panelMat),
  new THREE.AmbientLight(0xD4B020, 2.2)
)

// ── PROPS — furniture embedded in walls/floors/ceilings ───
const propColliders = []  // { x, z, radius, floor }
;(function placeProps() {
  // Seeded RNG for consistent placement
  let seed = 42069
  const rng = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646 }

  const metalMat = new THREE.MeshLambertMaterial({ color: 0x888888 })
  const darkMetalMat = new THREE.MeshLambertMaterial({ color: 0x444444 })
  const woodMat = new THREE.MeshLambertMaterial({ color: 0x8B6914 })
  const redMat = new THREE.MeshLambertMaterial({ color: 0xCC2020 })
  const fabricMat = new THREE.MeshLambertMaterial({ color: 0x4A4A5A })
  const whiteMat = new THREE.MeshLambertMaterial({ color: 0xE8E8E8 })

  function makeTable() {
    const g = new THREE.Group()
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.05, 0.7), woodMat)
    top.position.y = 0.75
    g.add(top)
    for (const [x, z] of [[-0.5,-0.28],[0.5,-0.28],[-0.5,0.28],[0.5,0.28]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.75, 6), darkMetalMat)
      leg.position.set(x, 0.375, z)
      g.add(leg)
    }
    return g
  }

  function makeChair() {
    const g = new THREE.Group()
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.05, 0.45), fabricMat)
    seat.position.y = 0.45
    g.add(seat)
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.5, 0.04), fabricMat)
    back.position.set(0, 0.72, -0.2)
    g.add(back)
    for (const [x, z] of [[-0.18,-0.18],[0.18,-0.18],[-0.18,0.18],[0.18,0.18]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.45, 6), darkMetalMat)
      leg.position.set(x, 0.225, z)
      g.add(leg)
    }
    return g
  }

  function makeFireHydrant() {
    const g = new THREE.Group()
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.6, 8), redMat)
    body.position.y = 0.3
    g.add(body)
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.12, 8), redMat)
    cap.position.y = 0.66
    g.add(cap)
    for (const side of [-1, 1]) {
      const noz = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.15, 6), redMat)
      noz.rotation.z = Math.PI / 2
      noz.position.set(side * 0.18, 0.4, 0)
      g.add(noz)
    }
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.08, 8), redMat)
    base.position.y = 0.04
    g.add(base)
    return g
  }

  function makeStopSign() {
    const g = new THREE.Group()
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.2, 6), metalMat)
    pole.position.y = 1.1
    g.add(pole)
    const shape = new THREE.Shape()
    const size = 0.35
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI / 8) + (i * Math.PI / 4)
      const x = Math.cos(a) * size, y = Math.sin(a) * size
      if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y)
    }
    shape.closePath()
    const sign = new THREE.Mesh(new THREE.ShapeGeometry(shape), redMat)
    sign.position.y = 2.0
    g.add(sign)
    return g
  }

  function makeFilingCabinet() {
    const g = new THREE.Group()
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.45, 1.3, 0.55), metalMat)
    body.position.y = 0.65
    g.add(body)
    for (let i = 0; i < 4; i++) {
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.02, 0.02), darkMetalMat)
      handle.position.set(0, 0.25 + i * 0.3, 0.29)
      g.add(handle)
    }
    return g
  }

  function makeShoppingCart() {
    const g = new THREE.Group()
    const wireMat = new THREE.MeshLambertMaterial({ color: 0xAAAAAA, wireframe: true })
    const basket = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.9), wireMat)
    basket.position.set(0, 0.55, 0)
    g.add(basket)
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.65, 6), metalMat)
    handle.rotation.z = Math.PI / 2
    handle.position.set(0, 0.85, -0.45)
    g.add(handle)
    for (const [x, z] of [[-0.25,-0.35],[0.25,-0.35],[-0.25,0.35],[0.25,0.35]]) {
      const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.03, 8), darkMetalMat)
      wh.rotation.z = Math.PI / 2
      wh.position.set(x, 0.06, z)
      g.add(wh)
    }
    return g
  }

  function makeVendingMachine() {
    const g = new THREE.Group()
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.8, 0.7), new THREE.MeshLambertMaterial({ color: 0x2266AA }))
    body.position.y = 0.9
    g.add(body)
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 1.2), new THREE.MeshLambertMaterial({ color: 0x112233, transparent: true, opacity: 0.7 }))
    glass.position.set(0, 1.0, 0.351)
    g.add(glass)
    const light = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.15, 0.01), whiteMat)
    light.position.set(0, 1.7, 0.351)
    g.add(light)
    return g
  }

  const factories = [makeTable, makeChair, makeFireHydrant, makeStopSign, makeFilingCabinet, makeShoppingCart, makeVendingMachine]

  // Place ~1 prop per 20 open cells
  const count = Math.floor(openCells.length / 20)

  for (let i = 0; i < count; i++) {
    const cellIdx = Math.floor(rng() * openCells.length)
    const [r, c] = openCells[cellIdx]
    const factory = factories[Math.floor(rng() * factories.length)]
    const prop = factory()

    const wx = c * CELL + CELL / 2
    const wz = r * CELL + CELL / 2
    const mode = rng()
    const rotY = rng() * Math.PI * 2

    let collides = false
    if (mode < 0.4) {
      // Sunk into floor
      const sink = 0.2 + rng() * 0.5
      const px = wx + (rng()-0.5)*1.2
      const pz = wz + (rng()-0.5)*1.2
      prop.position.set(px, -sink, pz)
      prop.rotation.y = rotY
      prop.rotation.x = (rng() - 0.5) * 0.3
      collides = true
    } else if (mode < 0.75) {
      // Embedded in adjacent wall
      const wallDirs = []
      if (r > 0 && MAP[r-1][c] === 1) wallDirs.push('n')
      if (r < ROWS-1 && MAP[r+1][c] === 1) wallDirs.push('s')
      if (c > 0 && MAP[r][c-1] === 1) wallDirs.push('w')
      if (c < COLS-1 && MAP[r][c+1] === 1) wallDirs.push('e')
      if (wallDirs.length > 0) {
        const dir = wallDirs[Math.floor(rng() * wallDirs.length)]
        const embed = 0.5 + rng() * 0.8
        let px = wx, pz = wz
        if (dir === 'n') pz -= CELL/2 + embed * 0.5
        else if (dir === 's') pz += CELL/2 + embed * 0.5
        else if (dir === 'w') px -= CELL/2 + embed * 0.5
        else if (dir === 'e') px += CELL/2 + embed * 0.5
        const py = rng() * WALL_H * 0.4
        prop.position.set(px, py, pz)
        prop.rotation.y = rotY
        prop.rotation.z = (rng() - 0.5) * 0.5
        if (py < EYE_H) collides = true  // only block if at player height
      } else {
        prop.position.set(wx, 0, wz)
        prop.rotation.y = rotY
        collides = true
      }
    } else {
      // Hanging from ceiling
      const hang = 0.2 + rng() * 0.6
      prop.position.set(wx + (rng()-0.5)*1.2, WALL_H + hang, wz + (rng()-0.5)*1.2)
      prop.rotation.y = rotY
      prop.rotation.x = Math.PI + (rng() - 0.5) * 0.4
      // No collision — above player
    }

    if (collides) {
      propColliders.push({ x: prop.position.x, z: prop.position.z, radius: 0.6, floor: 0 })
    }
    levelGroups[0].add(prop)
  }
})()

// ── FLOOR SYSTEM ─────────────────────────────────────────
// Floor 0 = existing backrooms (Y=0)
// Floor 1 = below (Y = -WALL_H - 1)
// Floor 2 = below that (Y = -2*(WALL_H + 1))
// Holes in floor 2 loop back to floor 0

const FLOOR_COUNT = 3
const FLOOR_SPACING = WALL_H + 1  // gap between floors
const floorYOffsets = [0, -FLOOR_SPACING, -2 * FLOOR_SPACING]

let currentFloor = 0
let isFalling = false
let fallTimer = 0
let fallStartY = 0
let fallTargetY = 0
let fallSourceFloor = 0
const FALL_DURATION = 0.7

// ── Floor 1 Map — Mall/Tile ─────────────────────────────
const F1_ROWS = 64, F1_COLS = 64
const MAP1 = (() => {
  const m = Array.from({ length: F1_ROWS }, () => new Array(F1_COLS).fill(1))
  const open = (r1, r2, c1, c2) => {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) m[r][c] = 0
  }
  // ── Main concourse (east-west with bends/jogs) ──
  open(28, 35, 1, 24)     // west segment
  open(26, 33, 22, 44)    // center segment (offset north by 2)
  open(28, 35, 42, 62)    // east segment
  open(26, 35, 22, 24)    // west jog connector
  open(26, 35, 42, 44)    // east jog connector

  // ── North-south corridors (5 of them) ──
  open(1, 62, 10, 12)     // NS corridor 1 (west)
  open(1, 62, 24, 26)     // NS corridor 2 (west-center)
  open(1, 62, 38, 40)     // NS corridor 3 (center)
  open(1, 62, 52, 54)     // NS corridor 4 (east-center)
  open(3, 60, 62, 62)     // NS corridor 5 (far east, narrow)

  // ── Secondary east-west corridors ──
  open(10, 11, 1, 62)     // EW upper corridor
  open(46, 47, 1, 62)     // EW lower corridor
  open(19, 19, 1, 62)     // service corridor upper
  open(55, 55, 1, 62)     // service corridor lower

  // ── Food court (large open NW area) ──
  open(2, 9, 2, 20)       // food court main
  open(2, 9, 14, 22)      // food court extension east

  // ── Anchor stores (large open rooms) ──
  open(2, 9, 28, 36)      // anchor store NE-ish
  open(2, 9, 56, 62)      // anchor store far NE
  open(56, 62, 2, 12)     // anchor store SW
  open(56, 62, 28, 38)    // anchor store S-center

  // ── North wing stores (varied sizes) ──
  open(2, 7, 42, 48)      // medium store
  open(2, 5, 49, 53)      // small store
  open(12, 18, 2, 7)      // store NW-1
  open(12, 18, 8, 14)     // store NW-2
  open(12, 18, 15, 20)    // store NW-3
  open(12, 18, 27, 32)    // store N-center-1
  open(12, 18, 33, 37)    // store N-center-2
  open(12, 18, 41, 46)    // store NE-1
  open(12, 18, 47, 51)    // store NE-2
  open(12, 18, 55, 61)    // store NE-3 (large)
  open(21, 25, 2, 8)      // store upper-W-1
  open(21, 25, 14, 20)    // store upper-W-2
  open(21, 25, 28, 36)    // store upper-C (large)
  open(21, 25, 42, 48)    // store upper-E-1
  open(21, 25, 56, 62)    // store upper-E-2

  // ── South wing stores ──
  open(36, 42, 2, 8)      // store lower-W-1
  open(36, 42, 14, 20)    // store lower-W-2
  open(36, 42, 28, 34)    // store lower-C-1
  open(36, 42, 42, 48)    // store lower-E-1
  open(36, 42, 56, 62)    // store lower-E-2 (large)
  open(48, 54, 2, 7)      // store S-1
  open(48, 54, 8, 14)     // store S-2
  open(48, 54, 15, 22)    // store S-3
  open(48, 54, 27, 32)    // store S-4
  open(48, 54, 33, 37)    // store S-5
  open(48, 54, 41, 48)    // store S-6 (large)
  open(48, 54, 55, 61)    // store S-7

  // ── Cross corridors (N-S connecting stores to concourse) ──
  open(7, 27, 6, 6)       // connector W-1
  open(7, 27, 16, 16)     // connector W-2
  open(7, 27, 30, 30)     // connector C-1
  open(7, 27, 34, 34)     // connector C-2
  open(7, 27, 44, 44)     // connector E-1
  open(7, 27, 58, 58)     // connector E-2
  open(36, 55, 6, 6)      // connector S-W-1
  open(36, 55, 16, 16)    // connector S-W-2
  open(36, 55, 30, 30)    // connector S-C-1
  open(36, 55, 34, 34)    // connector S-C-2
  open(36, 55, 44, 44)    // connector S-E-1
  open(36, 55, 58, 58)    // connector S-E-2

  // ── Service corridors (1-wide, behind stores) ──
  open(9, 9, 2, 22)       // behind N-wing stores upper
  open(9, 9, 28, 62)      // behind N-wing stores upper E
  open(20, 20, 2, 62)     // behind N-wing stores lower
  open(43, 43, 2, 62)     // behind S-wing stores upper
  open(54, 54, 2, 62)     // behind S-wing stores lower

  // ── Connecting passages between adjacent rooms (2+ exits per room) ──
  open(4, 4, 20, 22)      // food court → N corridor
  open(4, 4, 36, 38)      // anchor → N corridor
  open(15, 15, 7, 8)      // between NW stores
  open(15, 15, 14, 15)    // between NW stores
  open(15, 15, 32, 33)    // between N-center stores
  open(15, 15, 46, 47)    // between NE stores
  open(15, 15, 51, 52)    // NE store → corridor
  open(23, 23, 8, 10)     // upper-W-1 exit E
  open(23, 23, 20, 24)    // upper-W-2 exit E to corridor
  open(23, 23, 36, 38)    // upper-C exit E
  open(23, 23, 48, 52)    // upper-E-1 exit E
  open(39, 39, 8, 10)     // lower-W-1 exit E
  open(39, 39, 20, 24)    // lower-W-2 exit E
  open(39, 39, 34, 38)    // lower-C-1 exit E
  open(39, 39, 48, 52)    // lower-E-1 exit E
  open(50, 50, 7, 8)      // between S stores
  open(50, 50, 14, 15)    // between S stores
  open(50, 50, 32, 33)    // between S stores
  open(50, 50, 48, 49)    // between S stores

  // ── Winding corridors (sightline breaks) ──
  open(13, 17, 22, 22)    // jog into store area
  open(36, 38, 35, 36)    // south jog
  open(48, 50, 23, 23)    // south vertical jog
  open(5, 8, 53, 53)      // NE narrow passage
  open(56, 60, 13, 13)    // SW narrow passage
  open(44, 45, 14, 20)    // crossover passage

  // ── Escalator bays ──
  open(28, 35, 14, 16)    // west escalator bay
  open(28, 35, 46, 48)    // east escalator bay

  // ── Trap room — DEEP interior, rows 30-36, cols 50-56 ──
  // Only accessible via a single winding service corridor from col 49
  open(30, 36, 50, 56)    // the trap room itself
  // Service corridor leading to trap (winding approach)
  open(29, 29, 48, 49)    // approach from corridor, turns south
  open(29, 36, 49, 49)    // single-cell-wide passage running south along west wall
  // Seal cell: row 29, col 49 is the choke point

  // ── Dead-end spots for portals ──
  open(1, 2, 1, 2)        // NW corner nook
  open(1, 2, 60, 62)      // NE corner nook
  open(61, 62, 1, 2)      // SW corner nook
  open(61, 62, 60, 62)    // SE corner nook
  open(44, 45, 60, 61)    // mid-east alcove
  open(13, 14, 1, 2)      // mid-west alcove

  return m
})()

// ── Floor 2 Map — Poolrooms (labyrinthine with pool chambers) ──
const F2_ROWS = 64, F2_COLS = 64
const MAP2 = (() => {
  const m = Array.from({ length: F2_ROWS }, () => new Array(F2_COLS).fill(1))
  const open = (r1, r2, c1, c2) => {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) m[r][c] = 0
  }
  // ── Main spine corridors (2-wide grid) ──
  open(1, 62, 15, 16)    // N-S spine 1
  open(1, 62, 31, 32)    // N-S spine 2 (center)
  open(1, 62, 47, 48)    // N-S spine 3
  open(1, 62, 60, 61)    // N-S spine 4 (east)
  open(15, 16, 1, 62)    // E-W spine 1
  open(31, 32, 1, 62)    // E-W spine 2 (center)
  open(47, 48, 1, 62)    // E-W spine 3
  open(60, 61, 1, 62)    // E-W spine 4 (south)

  // ── Pool chambers (20+ rooms, varied sizes 5x5 to 10x10) ──
  // Row 1: top band
  open(2, 8, 2, 8)       // pool A (7x7) NW
  open(2, 8, 18, 24)     // pool B (7x7)
  open(2, 9, 34, 40)     // pool C (8x7)
  open(2, 7, 50, 55)     // pool D (6x6)
  // Row 2: upper-mid band
  open(18, 24, 2, 8)     // pool E (7x7)
  open(18, 24, 18, 24)   // pool F (7x7)
  open(18, 26, 34, 42)   // pool G (9x9) large
  open(18, 23, 50, 55)   // pool H (6x6)
  // Row 3: center band
  open(34, 40, 2, 8)     // pool I (7x7)
  open(34, 39, 18, 24)   // pool J (6x7)
  open(34, 40, 34, 40)   // pool K (7x7)
  open(34, 39, 50, 58)   // pool L (6x9) wide
  // Row 4: lower-mid band
  open(50, 56, 2, 8)     // pool M (7x7)
  open(49, 55, 18, 26)   // pool N (7x9) wide
  open(50, 56, 34, 40)   // pool O (7x7)
  open(50, 55, 50, 55)   // pool P (6x6)
  // Row 5: bottom band
  open(50, 58, 9, 14)    // pool Q (9x6) tall
  open(34, 40, 9, 13)    // pool R (7x5) small
  open(18, 23, 9, 13)    // pool S (6x5) small
  open(2, 7, 9, 13)      // pool T (6x5) small
  // Extra pools in odd spots
  open(25, 29, 2, 6)     // pool U (5x5)
  open(57, 62, 18, 23)   // pool V (6x6)
  open(57, 62, 50, 56)   // pool W (6x7)

  // ── Wide connecting passages between rooms (2-3 cells wide) ──
  open(9, 10, 3, 5)      // A south exit
  open(9, 10, 19, 21)    // B south exit
  open(10, 14, 36, 38)   // C south passage
  open(8, 10, 51, 53)    // D south exit
  open(25, 26, 4, 6)     // E south → U
  open(25, 26, 19, 21)   // F south exit
  open(27, 30, 36, 38)   // G south passage to K
  open(24, 26, 51, 53)   // H south exit
  open(41, 43, 3, 5)     // I south exit
  open(40, 43, 19, 21)   // J south exit
  open(41, 43, 36, 38)   // K south exit
  open(40, 43, 52, 54)   // L south exit
  open(57, 58, 3, 5)     // M south exit
  open(56, 58, 20, 22)   // N south exit
  open(57, 58, 36, 38)   // O south exit
  open(56, 58, 52, 54)   // P south exit

  // ── Side passages (winding, sightline breaks) ──
  open(5, 5, 8, 9)       // A east to T
  open(5, 5, 13, 15)     // T east to spine
  open(20, 20, 8, 9)     // E east to S
  open(20, 20, 13, 15)   // S east to spine
  open(36, 36, 8, 9)     // I east to R
  open(36, 36, 13, 15)   // R east to spine
  open(52, 52, 8, 9)     // Q connects
  open(6, 6, 24, 26)     // B east connect
  open(6, 6, 40, 42)     // gap C to spine
  open(20, 20, 24, 26)   // F east to spine
  open(20, 20, 42, 44)   // gap G corridor
  open(36, 36, 24, 26)   // J east
  open(36, 36, 40, 42)   // gap between K corridors
  open(52, 52, 26, 28)   // N east connects
  open(52, 52, 40, 42)   // gap O
  open(52, 52, 55, 58)   // P east connect

  // ── More connecting passages (every room gets 2+ exits) ──
  open(4, 6, 55, 56)     // D east exit
  open(20, 22, 55, 56)   // H east exit
  open(36, 38, 58, 60)   // L east exit to spine
  open(52, 54, 55, 56)   // P east exit
  open(29, 30, 6, 8)     // U east/south exit
  open(30, 31, 2, 3)     // U south to spine
  open(59, 60, 23, 26)   // V east exit
  open(59, 60, 56, 58)   // W connects

  // ── Trap room — rows 40-47, cols 40-47 (deep interior) ──
  // Accessible only via single narrow passage from west (col 39)
  open(40, 47, 40, 47)   // trap room
  open(43, 43, 39, 39)   // single-cell entrance (seal cell at 43,39)
  open(43, 43, 37, 38)   // short corridor leading to seal from spine

  // ── Dead-end alcoves for portals ──
  open(1, 2, 1, 1)       // NW corner nook
  open(1, 2, 62, 62)     // NE corner nook
  open(62, 62, 1, 2)     // SW corner nook
  open(62, 62, 61, 62)   // SE corner nook
  open(30, 30, 62, 62)   // mid-east alcove
  open(14, 14, 1, 1)     // mid-west alcove

  return m
})()

const FLOOR_MAPS = [MAP, MAP1, MAP2]
const FLOOR_ROWS = [ROWS, F1_ROWS, F2_ROWS]
const FLOOR_COLS = [COLS, F1_COLS, F2_COLS]

// ── Build Floor 1 Geometry ──────────────────────────────
const f1WallMat = new THREE.MeshLambertMaterial({ color: 0xE8E4DC })
const f1FloorMat = (() => {
  const S = 512, cv = document.createElement('canvas')
  cv.width = cv.height = S
  const ctx = cv.getContext('2d')
  ctx.fillStyle = '#E0DCD4'
  ctx.fillRect(0, 0, S, S)
  // Tile grid lines
  ctx.strokeStyle = 'rgba(140,130,110,0.7)'
  ctx.lineWidth = 2
  for (let i = 0; i <= S; i += 64) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, S); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(S, i); ctx.stroke()
  }
  // Subtle grout darkening along grid
  ctx.strokeStyle = 'rgba(100,90,75,0.15)'
  ctx.lineWidth = 4
  for (let i = 0; i <= S; i += 64) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, S); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(S, i); ctx.stroke()
  }
  // Scuff marks
  for (let i = 0; i < 5000; i++) {
    ctx.fillStyle = `rgba(80,70,60,${Math.random()*0.04})`
    ctx.fillRect(Math.random()*S, Math.random()*S, Math.random()*4+1, 1)
  }
  const t = new THREE.CanvasTexture(cv)
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(8, 8)
  return new THREE.MeshLambertMaterial({ map: t })
})()
const f1CeilMat = new THREE.MeshLambertMaterial({ color: 0xF4F0E8 })

const f1Y = floorYOffsets[1]
const f1PanelMat = new THREE.MeshBasicMaterial({ color: 0xF8F4FF, side: THREE.FrontSide })
const f1WallGeos = [], f1FloorGeos = [], f1CeilGeos = [], f1PanelGeos = []

for (let row = 0; row < F1_ROWS; row++) {
  for (let col = 0; col < F1_COLS; col++) {
    const wx = col*CELL + CELL/2, wz = row*CELL + CELL/2
    if (MAP1[row][col] === 1) {
      const g = new THREE.BoxGeometry(CELL, WALL_H, CELL)
      g.translate(wx, f1Y + WALL_H/2, wz)
      f1WallGeos.push(g)
    } else {
      const fg = new THREE.PlaneGeometry(CELL, CELL)
      fg.rotateX(-Math.PI/2); fg.translate(wx, f1Y, wz)
      f1FloorGeos.push(fg)
      const cg = new THREE.PlaneGeometry(CELL, CELL)
      cg.rotateX(Math.PI/2); cg.translate(wx, f1Y + WALL_H, wz)
      f1CeilGeos.push(cg)
      if (row % 5 === 2 && col % 5 === 2) {
        const pg = new THREE.PlaneGeometry(2.2, 1.0)
        pg.rotateX(Math.PI/2); pg.translate(wx, f1Y + WALL_H - 0.015, wz)
        f1PanelGeos.push(pg)
      }
    }
  }
}

levelGroups[1].add(
  new THREE.Mesh(mergeGeometries(f1WallGeos), f1WallMat),
  new THREE.Mesh(mergeGeometries(f1FloorGeos), f1FloorMat),
  new THREE.Mesh(mergeGeometries(f1CeilGeos), f1CeilMat),
  new THREE.AmbientLight(0xF0ECFF, 2.0)
)
if (f1PanelGeos.length) levelGroups[1].add(new THREE.Mesh(mergeGeometries(f1PanelGeos), f1PanelMat))

// ── Floor 1 Mall Props ──────────────────────────────────
;(function placeMallProps() {
  const chromeMat = new THREE.MeshLambertMaterial({ color: 0xBBBBCC })
  const darkChromeMat = new THREE.MeshLambertMaterial({ color: 0x555566 })
  const rubberMat = new THREE.MeshLambertMaterial({ color: 0x222222 })
  const waterMat = new THREE.MeshLambertMaterial({ color: 0x4488AA, transparent: true, opacity: 0.6 })
  const concreteMat = new THREE.MeshLambertMaterial({ color: 0xA0A0A0 })
  const greenMat = new THREE.MeshLambertMaterial({ color: 0x2D6B2D })
  const woodBenchMat = new THREE.MeshLambertMaterial({ color: 0x8B5E3C })
  const signMat = new THREE.MeshLambertMaterial({ color: 0x1A1A2A })

  // ── Escalators (going into ceiling) ───────────────────
  function makeEscalator(wx, wz) {
    const g = new THREE.Group()
    // Side rails
    for (const side of [-0.6, 0.6]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, WALL_H * 1.1, 3.5), chromeMat)
      rail.position.set(side, WALL_H * 0.55, 0)
      g.add(rail)
      // Handrail
      const handrail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 3.5), rubberMat)
      handrail.position.set(side, WALL_H * 0.45, 0)
      g.add(handrail)
    }
    // Steps (angled into ceiling)
    const stepCount = 14
    for (let i = 0; i < stepCount; i++) {
      const t = i / stepCount
      const step = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 0.22), darkChromeMat)
      step.position.set(0, t * WALL_H * 0.9 + 0.2, -1.5 + t * 3.0)
      g.add(step)
    }
    // Base plate
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.15, 3.8), chromeMat)
    base.position.y = 0.07
    g.add(base)
    // Top disappears into ceiling slab
    const ceilSlab = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.3, 1.2), concreteMat)
    ceilSlab.position.set(0, WALL_H - 0.15, 1.4)
    g.add(ceilSlab)
    g.position.set(wx, f1Y, wz)
    return g
  }

  // West escalator bay (cols 14-16, rows 30-33)
  const esc1 = makeEscalator(15 * CELL + CELL/2, 30 * CELL + CELL/2)
  levelGroups[1].add(esc1)
  propColliders.push({ x: 15*CELL+CELL/2, z: 30*CELL+CELL/2, radius: 1.2, floor: 1 })

  const esc2 = makeEscalator(15 * CELL + CELL/2, 33 * CELL + CELL/2)
  esc2.rotation.y = Math.PI  // facing opposite direction
  levelGroups[1].add(esc2)
  propColliders.push({ x: 15*CELL+CELL/2, z: 33*CELL+CELL/2, radius: 1.2, floor: 1 })

  // East escalator bay (cols 46-48, rows 30-33)
  const esc3 = makeEscalator(47 * CELL + CELL/2, 30 * CELL + CELL/2)
  levelGroups[1].add(esc3)
  propColliders.push({ x: 47*CELL+CELL/2, z: 30*CELL+CELL/2, radius: 1.2, floor: 1 })

  const esc4 = makeEscalator(47 * CELL + CELL/2, 33 * CELL + CELL/2)
  esc4.rotation.y = Math.PI
  levelGroups[1].add(esc4)
  propColliders.push({ x: 47*CELL+CELL/2, z: 33*CELL+CELL/2, radius: 1.2, floor: 1 })

  // ── Fountains ─────────────────────────────────────────
  function makeFountain(wx, wz) {
    const g = new THREE.Group()
    // Outer basin
    const basin = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 2.0, 0.6, 16), concreteMat)
    basin.position.y = 0.3
    g.add(basin)
    // Water surface
    const water = new THREE.Mesh(new THREE.CircleGeometry(1.6, 16), waterMat)
    water.rotation.x = -Math.PI/2
    water.position.y = 0.55
    g.add(water)
    // Center column
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 1.4, 8), concreteMat)
    col.position.y = 0.9
    g.add(col)
    // Top bowl
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.3, 0.3, 10), concreteMat)
    bowl.position.y = 1.6
    g.add(bowl)
    // Top water
    const topWater = new THREE.Mesh(new THREE.CircleGeometry(0.5, 10), waterMat)
    topWater.rotation.x = -Math.PI/2
    topWater.position.y = 1.72
    g.add(topWater)
    g.position.set(wx, f1Y, wz)
    return g
  }

  // Center concourse fountain (at corridor intersection)
  const fountain1 = makeFountain(25 * CELL + CELL/2, 30 * CELL + CELL/2)
  levelGroups[1].add(fountain1)
  propColliders.push({ x: 25*CELL+CELL/2, z: 30*CELL+CELL/2, radius: 2.2, floor: 1 })

  // Food court fountain (smaller)
  const fountain2 = makeFountain(12 * CELL + CELL/2, 5 * CELL + CELL/2)
  levelGroups[1].add(fountain2)
  propColliders.push({ x: 12*CELL+CELL/2, z: 5*CELL+CELL/2, radius: 2.2, floor: 1 })

  // ── Benches (along concourse) ─────────────────────────
  function makeBench(wx, wz, rotY) {
    const g = new THREE.Group()
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.08, 0.5), woodBenchMat)
    seat.position.y = 0.45
    g.add(seat)
    const back = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.5, 0.06), woodBenchMat)
    back.position.set(0, 0.7, -0.22)
    g.add(back)
    for (const x of [-0.7, 0, 0.7]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.45, 0.4), darkChromeMat)
      leg.position.set(x, 0.225, 0)
      g.add(leg)
    }
    g.position.set(wx, f1Y, wz)
    g.rotation.y = rotY || 0
    return g
  }

  // Benches along main concourse
  const benchPositions = [
    [4, 28], [8, 28], [16, 28], [20, 28], [30, 26], [36, 26], [46, 28], [50, 28], [56, 28], [60, 28],
    [4, 35], [8, 35], [16, 35], [20, 35], [30, 33], [36, 33], [46, 35], [50, 35], [56, 35], [60, 35],
  ]
  for (const [c, r] of benchPositions) {
    const bench = makeBench(c*CELL+CELL/2, r*CELL+CELL/2, r <= 28 ? 0 : Math.PI)
    levelGroups[1].add(bench)
    propColliders.push({ x: c*CELL+CELL/2, z: r*CELL+CELL/2, radius: 0.5, floor: 1 })
  }

  // ── Planters (large potted plants) ────────────────────
  function makePlanter(wx, wz) {
    const g = new THREE.Group()
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.4, 0.7, 8), concreteMat)
    pot.position.y = 0.35
    g.add(pot)
    // Foliage (rough sphere)
    const foliage = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 6), greenMat)
    foliage.position.y = 1.2
    foliage.scale.y = 1.3
    g.add(foliage)
    g.position.set(wx, f1Y, wz)
    return g
  }

  const planterPositions = [
    [3, 28], [3, 35], [18, 28], [18, 35], [42, 26], [42, 33], [55, 28], [55, 35],
    [11, 3], [11, 60], [25, 3], [25, 60], [39, 3], [53, 3],
  ]
  for (const [c, r] of planterPositions) {
    levelGroups[1].add(makePlanter(c*CELL+CELL/2, r*CELL+CELL/2))
    propColliders.push({ x: c*CELL+CELL/2, z: r*CELL+CELL/2, radius: 0.6, floor: 1 })
  }

  // ── Directory signs (tall kiosk) ──────────────────────
  function makeDirectory(wx, wz, rotY) {
    const g = new THREE.Group()
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.2, 0.12), chromeMat)
    post.position.y = 1.1
    g.add(post)
    const board = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.6, 0.08), signMat)
    board.position.y = 1.8
    g.add(board)
    // "YOU ARE HERE" dot (red)
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.06, 8), new THREE.MeshBasicMaterial({ color: 0xFF0000 }))
    dot.position.set(0.1, 1.5, 0.045)
    g.add(dot)
    // Frame
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.7, 0.03), chromeMat)
    frame.position.set(0, 1.8, -0.03)
    g.add(frame)
    g.position.set(wx, f1Y, wz)
    g.rotation.y = rotY || 0
    return g
  }

  // Directory signs at intersections
  levelGroups[1].add(makeDirectory(25*CELL+CELL/2, 28*CELL+CELL/2, 0))
  propColliders.push({ x: 25*CELL+CELL/2, z: 28*CELL+CELL/2, radius: 0.4, floor: 1 })
  levelGroups[1].add(makeDirectory(39*CELL+CELL/2, 35*CELL+CELL/2, Math.PI))
  propColliders.push({ x: 39*CELL+CELL/2, z: 35*CELL+CELL/2, radius: 0.4, floor: 1 })

  // ── Trash cans ────────────────────────────────────────
  function makeTrashCan(wx, wz) {
    const g = new THREE.Group()
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.22, 0.9, 8), darkChromeMat)
    body.position.y = 0.45
    g.add(body)
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.05, 8), chromeMat)
    lid.position.y = 0.92
    g.add(lid)
    const tray = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.02, 8), chromeMat)
    tray.position.y = 0.95
    g.add(tray)
    g.position.set(wx, f1Y, wz)
    return g
  }

  const trashPositions = [[6,28],[14,28],[22,28],[32,26],[44,28],[52,28],[60,28],
                          [6,35],[14,35],[22,35],[32,33],[44,35],[52,35],[60,35]]
  for (const [c,r] of trashPositions) {
    levelGroups[1].add(makeTrashCan(c*CELL+CELL/2, r*CELL+CELL/2))
    propColliders.push({ x: c*CELL+CELL/2, z: r*CELL+CELL/2, radius: 0.35, floor: 1 })
  }

  // ── Food court tables (round with chairs) ─────────────
  function makeFoodCourtTable(wx, wz) {
    const g = new THREE.Group()
    const tabletop = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.04, 12), new THREE.MeshLambertMaterial({ color: 0xF0E8D8 }))
    tabletop.position.y = 0.75
    g.add(tabletop)
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.72, 8), chromeMat)
    pedestal.position.y = 0.38
    g.add(pedestal)
    const baseDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.04, 10), chromeMat)
    baseDisc.position.y = 0.02
    g.add(baseDisc)
    // Attached chairs
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2
      const cx = Math.cos(a) * 0.85, cz = Math.sin(a) * 0.85
      const chair = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.04, 8), chromeMat)
      chair.position.set(cx, 0.45, cz)
      g.add(chair)
    }
    g.position.set(wx, f1Y, wz)
    return g
  }

  // Food court area tables
  for (let r = 3; r <= 7; r += 2) {
    for (let c = 3; c <= 18; c += 3) {
      levelGroups[1].add(makeFoodCourtTable(c*CELL+CELL/2, r*CELL+CELL/2))
      propColliders.push({ x: c*CELL+CELL/2, z: r*CELL+CELL/2, radius: 0.9, floor: 1 })
    }
  }

  // ── Ceiling skylights (glass panels in ceiling) ───────
  const skylightMat = new THREE.MeshBasicMaterial({ color: 0xCCDDFF, transparent: true, opacity: 0.3 })
  const skylightPositions = [[12,30],[20,30],[32,28],[44,30],[52,30],[60,30]]
  for (const [c,r] of skylightPositions) {
    const skylight = new THREE.Mesh(new THREE.PlaneGeometry(CELL*2.5, CELL*2.5), skylightMat)
    skylight.rotation.x = Math.PI/2
    skylight.position.set(c*CELL+CELL/2, f1Y + WALL_H - 0.02, r*CELL+CELL/2)
    levelGroups[1].add(skylight)
  }

  // ── Upside-down elements (mall) ───────────────────────
  // Benches on ceiling
  const ceilBenchPositions = [[6,30],[18,30],[44,30],[56,30]]
  for (const [c,r] of ceilBenchPositions) {
    const g = new THREE.Group()
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.08, 0.5), woodBenchMat)
    seat.position.y = 0.45
    g.add(seat)
    const back = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.5, 0.06), woodBenchMat)
    back.position.set(0, 0.7, -0.22)
    g.add(back)
    for (const x of [-0.7, 0, 0.7]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.45, 0.4), darkChromeMat)
      leg.position.set(x, 0.225, 0)
      g.add(leg)
    }
    g.position.set(c*CELL+CELL/2, f1Y + WALL_H, r*CELL+CELL/2)
    g.rotation.x = Math.PI  // flipped upside down
    g.rotation.y = Math.random() * Math.PI
    levelGroups[1].add(g)
  }

  // Upside-down food court tables on ceiling
  const ceilTablePositions = [[5,4],[9,6],[14,4],[18,7]]
  for (const [c,r] of ceilTablePositions) {
    const g = new THREE.Group()
    const tabletop = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.04, 12), new THREE.MeshLambertMaterial({ color: 0xF0E8D8 }))
    tabletop.position.y = 0.75
    g.add(tabletop)
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.72, 8), chromeMat)
    pedestal.position.y = 0.38
    g.add(pedestal)
    const baseDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.04, 10), chromeMat)
    baseDisc.position.y = 0.02
    g.add(baseDisc)
    g.position.set(c*CELL+CELL/2, f1Y + WALL_H + 0.8, r*CELL+CELL/2)
    g.rotation.x = Math.PI
    levelGroups[1].add(g)
  }

  // Upside-down escalator (going into the floor)
  const escDown = makeEscalator(25*CELL+CELL/2, 11*CELL+CELL/2)
  escDown.rotation.x = Math.PI
  escDown.position.y = f1Y + WALL_H + 1
  levelGroups[1].add(escDown)

  // Inverted planter hanging from ceiling
  const ceilPlanterPositions = [[11,15],[25,47],[53,11],[39,55]]
  for (const [c,r] of ceilPlanterPositions) {
    const g = new THREE.Group()
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.4, 0.7, 8), concreteMat)
    pot.position.y = 0.35
    g.add(pot)
    const foliage = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 6), greenMat)
    foliage.position.y = 1.2
    foliage.scale.y = 1.3
    g.add(foliage)
    g.position.set(c*CELL+CELL/2, f1Y + WALL_H + 1.3, r*CELL+CELL/2)
    g.rotation.x = Math.PI
    levelGroups[1].add(g)
  }
})()

// ── Build Floor 2 Geometry ───────────���──────────────────
const f2WallMat = new THREE.MeshLambertMaterial({ color: 0xE8F4FA })
const f2FloorMat = (() => {
  const S = 256, cv = document.createElement('canvas')
  cv.width = cv.height = S
  const ctx = cv.getContext('2d')
  ctx.fillStyle = '#C8DDE8'
  ctx.fillRect(0, 0, S, S)
  // Tile grid — visible grout lines
  ctx.strokeStyle = 'rgba(80,130,160,0.5)'
  ctx.lineWidth = 2
  for (let i = 0; i <= S; i += 64) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, S); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(S, i); ctx.stroke()
  }
  // Alternating tile shade for depth
  for (let ty = 0; ty < S; ty += 64) {
    for (let tx = 0; tx < S; tx += 64) {
      if ((tx + ty) / 64 % 2 < 1) {
        ctx.fillStyle = 'rgba(90,140,170,0.08)'
        ctx.fillRect(tx + 2, ty + 2, 60, 60)
      }
    }
  }
  // Wet sheen spots
  for (let i = 0; i < 20; i++) {
    ctx.fillStyle = `rgba(180,210,230,${0.08 + Math.random()*0.06})`
    const sx = Math.random()*S, sy = Math.random()*S
    ctx.beginPath(); ctx.ellipse(sx, sy, 8+Math.random()*12, 4+Math.random()*6, Math.random()*Math.PI, 0, Math.PI*2); ctx.fill()
  }
  const t = new THREE.CanvasTexture(cv)
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(6, 6)
  return new THREE.MeshLambertMaterial({ map: t })
})()
const f2CeilMat = new THREE.MeshLambertMaterial({ color: 0xF0F8FF })
const f2ColMat = new THREE.MeshLambertMaterial({ color: 0xC8D8E4 })

const f2Y = floorYOffsets[2]
const f2WallGeos = [], f2FloorGeos = [], f2CeilGeos = []
for (let row = 0; row < F2_ROWS; row++) {
  for (let col = 0; col < F2_COLS; col++) {
    const wx = col*CELL + CELL/2, wz = row*CELL + CELL/2
    if (MAP2[row][col] === 1) {
      const g = new THREE.BoxGeometry(CELL, WALL_H, CELL)
      g.translate(wx, f2Y + WALL_H/2, wz)
      f2WallGeos.push(g)
    } else {
      const fg = new THREE.PlaneGeometry(CELL, CELL)
      fg.rotateX(-Math.PI/2); fg.translate(wx, f2Y, wz)
      f2FloorGeos.push(fg)
      const cg = new THREE.PlaneGeometry(CELL, CELL)
      cg.rotateX(Math.PI/2); cg.translate(wx, f2Y + WALL_H, wz)
      f2CeilGeos.push(cg)
      // Pillars in corridors
      if ((row === 15 || row === 16 || row === 31 || row === 32 || row === 47 || row === 48 || row === 60 || row === 61) && col % 4 === 2) {
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, WALL_H, 8), f2ColMat)
        pillar.position.set(wx, f2Y + WALL_H/2, wz)
        levelGroups[2].add(pillar)
        propColliders.push({ x: wx, z: wz, radius: 0.3, floor: 2 })
      }
    }
  }
}
levelGroups[2].add(
  new THREE.Mesh(mergeGeometries(f2WallGeos), f2WallMat),
  new THREE.Mesh(mergeGeometries(f2FloorGeos), f2FloorMat),
  new THREE.Mesh(mergeGeometries(f2CeilGeos), f2CeilMat),
  new THREE.AmbientLight(0x88CCEE, 1.8)
)

// ── Floor 2 Pool Props ──────────────────────────────────
;(function placePoolProps() {
  const tileMat = new THREE.MeshLambertMaterial({ color: 0xB0D8E8 })
  const poolWaterMat = new THREE.MeshLambertMaterial({ color: 0x2288AA, transparent: true, opacity: 0.7 })
  const ceilPoolMat = new THREE.MeshLambertMaterial({ color: 0x3399BB, transparent: true, opacity: 0.5 })
  const stairMat = new THREE.MeshLambertMaterial({ color: 0xCCDDE8 })
  const railMat = new THREE.MeshLambertMaterial({ color: 0x99AABB })
  const ladderMat = new THREE.MeshLambertMaterial({ color: 0xAAAACC })

  // Pool chambers — each gets a sunken pool in the center
  const poolRooms = [
    // Row 1: top band
    { r1: 2, r2: 8, c1: 2, c2: 8 },       // pool A
    { r1: 2, r2: 8, c1: 18, c2: 24 },      // pool B
    { r1: 2, r2: 9, c1: 34, c2: 40 },      // pool C
    { r1: 2, r2: 7, c1: 50, c2: 55 },      // pool D
    { r1: 2, r2: 7, c1: 9, c2: 13 },       // pool T
    // Row 2: upper-mid band
    { r1: 18, r2: 24, c1: 2, c2: 8 },      // pool E
    { r1: 18, r2: 24, c1: 18, c2: 24 },    // pool F
    { r1: 18, r2: 26, c1: 34, c2: 42 },    // pool G (large)
    { r1: 18, r2: 23, c1: 50, c2: 55 },    // pool H
    { r1: 18, r2: 23, c1: 9, c2: 13 },     // pool S
    // Row 3: center band
    { r1: 34, r2: 40, c1: 2, c2: 8 },      // pool I
    { r1: 34, r2: 39, c1: 18, c2: 24 },    // pool J
    { r1: 34, r2: 40, c1: 34, c2: 40 },    // pool K
    { r1: 34, r2: 39, c1: 50, c2: 58 },    // pool L (wide)
    { r1: 34, r2: 40, c1: 9, c2: 13 },     // pool R
    // Row 4: lower-mid band
    { r1: 50, r2: 56, c1: 2, c2: 8 },      // pool M
    { r1: 49, r2: 55, c1: 18, c2: 26 },    // pool N (wide)
    { r1: 50, r2: 56, c1: 34, c2: 40 },    // pool O
    { r1: 50, r2: 55, c1: 50, c2: 55 },    // pool P
    { r1: 50, r2: 58, c1: 9, c2: 14 },     // pool Q (tall)
    // Row 5: bottom band extras
    { r1: 25, r2: 29, c1: 2, c2: 6 },      // pool U (small)
    { r1: 57, r2: 62, c1: 18, c2: 23 },    // pool V
    { r1: 57, r2: 62, c1: 50, c2: 56 },    // pool W
  ]

  // Seeded RNG for pool variation
  let pseed = 77777
  const prng = () => { pseed = (pseed * 16807) % 2147483647; return (pseed - 1) / 2147483646 }

  for (let pi = 0; pi < poolRooms.length; pi++) {
    const pr = poolRooms[pi]
    const roomW = (pr.c2 - pr.c1 - 1) * CELL
    const roomD = (pr.r2 - pr.r1 - 1) * CELL
    const cx = (pr.c1 + 1) * CELL + roomW / 2
    const cz = (pr.r1 + 1) * CELL + roomD / 2
    const poolW = roomW * (0.5 + prng() * 0.25)
    const poolD = roomD * (0.5 + prng() * 0.25)

    // Sunken pool basin (dark rectangle below floor level)
    const poolDepth = 0.6 + prng() * 0.4
    const basin = new THREE.Mesh(new THREE.BoxGeometry(poolW, poolDepth, poolD), tileMat)
    basin.position.set(cx, f2Y - poolDepth/2, cz)
    levelGroups[2].add(basin)

    // Water surface
    const water = new THREE.Mesh(new THREE.PlaneGeometry(poolW - 0.1, poolD - 0.1), poolWaterMat)
    water.rotation.x = -Math.PI/2
    water.position.set(cx, f2Y - 0.05, cz)
    levelGroups[2].add(water)

    // Pool edge rim
    const rimW = 0.15
    for (const [rx, rz, rw, rd] of [
      [cx, cz - poolD/2, poolW + rimW*2, rimW],
      [cx, cz + poolD/2, poolW + rimW*2, rimW],
      [cx - poolW/2, cz, rimW, poolD],
      [cx + poolW/2, cz, rimW, poolD],
    ]) {
      const rim = new THREE.Mesh(new THREE.BoxGeometry(rw, 0.12, rd), stairMat)
      rim.position.set(rx, f2Y + 0.06, rz)
      levelGroups[2].add(rim)
    }

    // Collider around pool edge (prevent walking into pool)
    propColliders.push({ x: cx, z: cz, radius: Math.max(poolW, poolD) * 0.45, floor: 2 })

    // Steps leading down on one side
    const stairSide = prng() < 0.5 ? -1 : 1
    const stepCount = 3
    for (let s = 0; s < stepCount; s++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(poolW * 0.4, 0.1, 0.35), stairMat)
      step.position.set(cx, f2Y - (s+1) * (poolDepth/stepCount) + 0.05, cz + stairSide * (poolD/2 - 0.3 - s*0.35))
      levelGroups[2].add(step)
    }

    // Ladder on opposite side
    const ladderX = cx + (prng() - 0.5) * poolW * 0.5
    const ladderZ = cz - stairSide * (poolD/2 - 0.1)
    for (const lx of [-0.15, 0.15]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.2, 6), ladderMat)
      pole.position.set(ladderX + lx, f2Y + 0.3, ladderZ)
      levelGroups[2].add(pole)
    }
    for (let rung = 0; rung < 4; rung++) {
      const r = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.3, 6), ladderMat)
      r.rotation.z = Math.PI/2
      r.position.set(ladderX, f2Y - 0.2 + rung * 0.3, ladderZ)
      levelGroups[2].add(r)
    }

    // Every other room: ceiling pool (water on ceiling, dripping down)
    if (pi % 3 === 0) {
      const cPoolW = poolW * 0.7, cPoolD = poolD * 0.7
      const ceilWater = new THREE.Mesh(new THREE.PlaneGeometry(cPoolW, cPoolD), ceilPoolMat)
      ceilWater.rotation.x = Math.PI/2
      ceilWater.position.set(cx + (prng()-0.5)*2, f2Y + WALL_H - 0.02, cz + (prng()-0.5)*2)
      levelGroups[2].add(ceilWater)
      // Ceiling pool rim
      const cRim = new THREE.Mesh(new THREE.BoxGeometry(cPoolW + 0.2, 0.08, cPoolD + 0.2), tileMat)
      cRim.position.set(cx, f2Y + WALL_H - 0.06, cz)
      levelGroups[2].add(cRim)
    }
  }

  // ── Corridor features ─────────────────────────────────
  // Drain grates in corridors
  const drainMat = new THREE.MeshLambertMaterial({ color: 0x333344 })
  const drainPositions = [
    [16, 5], [16, 20], [16, 35], [16, 50],
    [32, 5], [32, 20], [32, 35], [32, 50],
    [48, 5], [48, 20], [48, 35], [48, 50],
    [61, 5], [61, 20], [61, 35], [61, 50],
    [5, 16], [20, 16], [35, 16], [50, 16],
    [5, 32], [20, 32], [35, 32], [50, 32],
    [5, 48], [20, 48], [35, 48], [50, 48],
    [5, 61], [20, 61], [35, 61], [50, 61],
  ]
  for (const [c, r] of drainPositions) {
    const drain = new THREE.Mesh(new THREE.CircleGeometry(0.3, 8), drainMat)
    drain.rotation.x = -Math.PI/2
    drain.position.set(c*CELL+CELL/2, f2Y + 0.01, r*CELL+CELL/2)
    levelGroups[2].add(drain)
  }

  // Wet floor signs (tilted yellow triangles)
  const wetSignMat = new THREE.MeshLambertMaterial({ color: 0xDDCC20 })
  const wetSignPositions = [[16,8],[32,20],[48,35],[15,50],[47,10],[61,30]]
  for (const [c,r] of wetSignPositions) {
    const g = new THREE.Group()
    // A-frame shape
    const panel1 = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.7, 0.02), wetSignMat)
    panel1.position.set(0, 0.4, 0.08)
    panel1.rotation.x = -0.15
    g.add(panel1)
    const panel2 = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.7, 0.02), wetSignMat)
    panel2.position.set(0, 0.4, -0.08)
    panel2.rotation.x = 0.15
    g.add(panel2)
    g.position.set(c*CELL+CELL/2, f2Y, r*CELL+CELL/2)
    g.rotation.y = prng() * Math.PI * 2
    levelGroups[2].add(g)
  }

  // Lifeguard chairs (tall, disturbing in empty poolroom)
  const lgChairMat = new THREE.MeshLambertMaterial({ color: 0xF0F0F0 })
  const lgPositions = [[5,5],[20,35],[52,20],[35,52],[10,50]]
  for (const [c,r] of lgPositions) {
    const g = new THREE.Group()
    // Legs (tall X-frame)
    for (const [lx, lz] of [[-0.2,-0.15],[0.2,-0.15],[-0.2,0.15],[0.2,0.15]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.5, 6), lgChairMat)
      leg.position.set(lx, 1.25, lz)
      g.add(leg)
    }
    // Seat
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.4), lgChairMat)
    seat.position.y = 2.5
    g.add(seat)
    // Back
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.04), lgChairMat)
    back.position.set(0, 2.8, -0.18)
    g.add(back)
    // Footrest
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.04, 0.25), lgChairMat)
    foot.position.y = 1.8
    g.add(foot)
    g.position.set(c*CELL+CELL/2, f2Y, r*CELL+CELL/2)
    levelGroups[2].add(g)
    propColliders.push({ x: c*CELL+CELL/2, z: r*CELL+CELL/2, radius: 0.4, floor: 2 })
  }

  // Pool noodles / floats scattered on floor (weird, out of place)
  const noodleMat = new THREE.MeshLambertMaterial({ color: 0xFF6644 })
  const noodle2Mat = new THREE.MeshLambertMaterial({ color: 0x44CC88 })
  const floatPositions = [[3,3],[10,20],[22,50],[38,8],[52,35],[16,55],[40,18],[58,52],[5,40],[48,10]]
  for (let i = 0; i < floatPositions.length; i++) {
    const [c,r] = floatPositions[i]
    const noodle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 1.5, 6),
      i % 2 === 0 ? noodleMat : noodle2Mat
    )
    noodle.rotation.z = Math.PI/2 + (prng()-0.5)*0.4
    noodle.rotation.y = prng() * Math.PI
    noodle.position.set(c*CELL+CELL/2, f2Y + 0.04, r*CELL+CELL/2)
    levelGroups[2].add(noodle)
  }

  // Diving boards (sticking out of walls at weird angles)
  const boardMat = new THREE.MeshLambertMaterial({ color: 0xEEEEDD })
  const divingPositions = [[9,5,'e'],[24,38,'s'],[39,52,'w'],[56,20,'n'],[16,10,'e']]
  for (const [r,c,dir] of divingPositions) {
    const g = new THREE.Group()
    const board = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.08, 0.5), boardMat)
    board.position.set(1.0, 1.8, 0)
    g.add(board)
    const support = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.6, 0.5), railMat)
    support.position.set(0, 1.5, 0)
    g.add(support)
    const wx = c*CELL+CELL/2, wz = r*CELL+CELL/2
    g.position.set(wx, f2Y, wz)
    if (dir === 'e') g.rotation.y = 0
    else if (dir === 'w') g.rotation.y = Math.PI
    else if (dir === 's') g.rotation.y = Math.PI/2
    else g.rotation.y = -Math.PI/2
    levelGroups[2].add(g)
  }

  // ── Upside-down elements (poolrooms) ──────────────────
  // Inverted lifeguard chairs on ceiling
  const ceilLgPositions = [[10,22],[38,6],[22,50],[54,54]]
  for (const [c,r] of ceilLgPositions) {
    const g = new THREE.Group()
    for (const [lx, lz] of [[-0.2,-0.15],[0.2,-0.15],[-0.2,0.15],[0.2,0.15]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.5, 6), lgChairMat)
      leg.position.set(lx, 1.25, lz)
      g.add(leg)
    }
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.4), lgChairMat)
    seat.position.y = 2.5
    g.add(seat)
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.04), lgChairMat)
    back.position.set(0, 2.8, -0.18)
    g.add(back)
    g.position.set(c*CELL+CELL/2, f2Y + WALL_H + 2.5, r*CELL+CELL/2)
    g.rotation.x = Math.PI
    levelGroups[2].add(g)
  }

  // Upside-down ladders hanging from ceiling
  const ceilLadderPositions = [[16,8],[32,25],[8,40],[48,50]]
  for (const [c,r] of ceilLadderPositions) {
    const g = new THREE.Group()
    for (const lx of [-0.15, 0.15]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.8, 6), ladderMat)
      pole.position.set(lx, 0.9, 0)
      g.add(pole)
    }
    for (let rung = 0; rung < 6; rung++) {
      const ru = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.3, 6), ladderMat)
      ru.rotation.z = Math.PI/2
      ru.position.set(0, 0.2 + rung * 0.3, 0)
      g.add(ru)
    }
    g.position.set(c*CELL+CELL/2, f2Y + WALL_H, r*CELL+CELL/2)
    g.rotation.x = Math.PI  // hanging upside down from ceiling
    levelGroups[2].add(g)
  }

  // Inverted pools on ceiling (water dripping "up") — in corridors
  const ceilCorridorPools = [[16,12],[32,35],[48,20],[16,50],[61,30]]
  for (const [c,r] of ceilCorridorPools) {
    // Small rectangular ceiling pool
    const pw = 1.5 + prng()*1, pd = 1.5 + prng()*1
    const cWater = new THREE.Mesh(new THREE.PlaneGeometry(pw, pd), ceilPoolMat)
    cWater.rotation.x = Math.PI/2
    cWater.position.set(c*CELL+CELL/2, f2Y + WALL_H - 0.01, r*CELL+CELL/2)
    levelGroups[2].add(cWater)
    // Rim
    const cRim = new THREE.Mesh(new THREE.BoxGeometry(pw+0.15, 0.06, pd+0.15), tileMat)
    cRim.position.set(c*CELL+CELL/2, f2Y + WALL_H - 0.04, r*CELL+CELL/2)
    levelGroups[2].add(cRim)
  }

  // Upside-down diving boards on ceiling
  const ceilDivePositions = [[6,18],[25,52],[38,16],[56,35]]
  for (const [c,r] of ceilDivePositions) {
    const g = new THREE.Group()
    const board = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.08, 0.5), boardMat)
    board.position.set(1.0, 0, 0)
    g.add(board)
    const support = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.5, 0.5), railMat)
    support.position.set(0, 0.25, 0)
    g.add(support)
    g.position.set(c*CELL+CELL/2, f2Y + WALL_H, r*CELL+CELL/2)
    g.rotation.x = Math.PI
    g.rotation.y = prng() * Math.PI * 2
    levelGroups[2].add(g)
  }
})()

// ── Floor Holes (cells with no floor, player falls through) ─
// Each hole: { floor, r, c } — which floor it's ON, drops to floor+1 (or wraps)
const HOLES = [
  // Floor 0 holes → drop to floor 1
  { floor: 0, r: 15, c: 3 },    // W tube
  { floor: 0, r: 25, c: 30 },   // CENTER hub south area
  { floor: 0, r: 40, c: 10 },   // SW main
  { floor: 0, r: 6, c: 44 },    // NE corner
  // Floor 1 holes → drop to floor 2
  { floor: 1, r: 30, c: 11 },   // west concourse near escalator
  { floor: 1, r: 28, c: 39 },   // center concourse
  { floor: 1, r: 47, c: 25 },   // south corridor
  { floor: 1, r: 11, c: 53 },   // NE upper corridor
  // Floor 2 holes → LOOP back to floor 0
  { floor: 2, r: 16, c: 32 },   // center spine intersection
  { floor: 2, r: 48, c: 16 },   // SW spine intersection
  { floor: 2, r: 16, c: 48 },   // NE spine intersection
  { floor: 2, r: 61, c: 61 },   // SE spine
]

// Remove floor geometry at hole positions and add dark pit visual
const holeDarkMat = new THREE.MeshBasicMaterial({ color: 0x0A0A0A })
for (const hole of HOLES) {
  const yOff = floorYOffsets[hole.floor]
  const wx = hole.c * CELL + CELL/2
  const wz = hole.r * CELL + CELL/2
  // Dark pit circle
  const pit = new THREE.Mesh(new THREE.CircleGeometry(CELL * 0.4, 12), holeDarkMat)
  pit.rotation.x = -Math.PI/2
  pit.position.set(wx, yOff + 0.01, wz)
  levelGroups[hole.floor].add(pit)
  // Rim glow
  const rimGeo = new THREE.RingGeometry(CELL * 0.35, CELL * 0.45, 12)
  const rim = new THREE.Mesh(rimGeo, new THREE.MeshBasicMaterial({ color: 0x222222 }))
  rim.rotation.x = -Math.PI/2
  rim.position.set(wx, yOff + 0.02, wz)
  levelGroups[hole.floor].add(rim)
}

// ── Wall Portals (in dead-end rooms) ────────────────────
// Portals appear on the wall opposite the single exit
// They teleport you to a random location on the SAME floor (disorienting)
const PORTALS = []
const portalMat = new THREE.MeshLambertMaterial({
  color: 0x1A1A22, transparent: true, opacity: 0.35, side: THREE.DoubleSide
})
const portalRimMat = new THREE.MeshBasicMaterial({ color: 0x2A2A35, transparent: true, opacity: 0.25 })

// Find dead-end-like spots and place portals
// Floor 0: trap room already exists. Add portals in some corridor ends
const portalPlacements = [
  // floor, row, col, facing direction ('n','s','e','w')
  { floor: 0, r: 1, c: 44, face: 'n' },   // NE corner pocket north wall
  { floor: 0, r: 46, c: 1, face: 's' },    // SW main south wall
  // Floor 1 portals (6 total)
  { floor: 1, r: 1, c: 1, face: 'n' },     // NW corner nook
  { floor: 1, r: 1, c: 61, face: 'n' },    // NE corner nook
  { floor: 1, r: 62, c: 1, face: 's' },    // SW corner nook
  { floor: 1, r: 62, c: 61, face: 's' },   // SE corner nook
  { floor: 1, r: 44, c: 61, face: 'e' },   // mid-east alcove
  { floor: 1, r: 13, c: 1, face: 'w' },    // mid-west alcove
  // Floor 2 portals (6 total)
  { floor: 2, r: 1, c: 1, face: 'n' },     // NW corner nook
  { floor: 2, r: 1, c: 62, face: 'n' },    // NE corner nook
  { floor: 2, r: 62, c: 1, face: 's' },    // SW corner nook
  { floor: 2, r: 62, c: 62, face: 's' },   // SE corner nook
  { floor: 2, r: 30, c: 62, face: 'e' },   // mid-east alcove
  { floor: 2, r: 14, c: 1, face: 'w' },    // mid-west alcove
]

for (const pp of portalPlacements) {
  const yOff = floorYOffsets[pp.floor]
  const wx = pp.c * CELL + CELL/2
  const wz = pp.r * CELL + CELL/2
  // Portal plane (1.8 tall, 1.2 wide)
  const portal = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.8), portalMat)
  portal.position.y = yOff + WALL_H * 0.5
  if (pp.face === 'n') { portal.position.set(wx, yOff + WALL_H*0.5, wz - CELL/2 + 0.05) }
  else if (pp.face === 's') { portal.position.set(wx, yOff + WALL_H*0.5, wz + CELL/2 - 0.05); portal.rotation.y = Math.PI }
  else if (pp.face === 'w') { portal.position.set(wx - CELL/2 + 0.05, yOff + WALL_H*0.5, wz); portal.rotation.y = Math.PI/2 }
  else { portal.position.set(wx + CELL/2 - 0.05, yOff + WALL_H*0.5, wz); portal.rotation.y = -Math.PI/2 }
  levelGroups[pp.floor].add(portal)
  // Rim (slightly larger)
  const rim = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.7, 16), portalRimMat)
  rim.position.copy(portal.position)
  rim.rotation.copy(portal.rotation)
  levelGroups[pp.floor].add(rim)
  PORTALS.push({ floor: pp.floor, x: wx, z: wz, face: pp.face })
}

// ── Multi-floor collision helper ────────────────────────
function isWallOnFloor(floorIdx, wx, wz) {
  const map = FLOOR_MAPS[floorIdx]
  const rows = FLOOR_ROWS[floorIdx]
  const cols = FLOOR_COLS[floorIdx]
  const c = Math.floor(wx / CELL)
  const r = Math.floor(wz / CELL)
  if (r < 0 || r >= rows || c < 0 || c >= cols) return true
  return map[r][c] === 1
}

function canMoveOnFloor(floorIdx, wx, wz) {
  const R = 0.45
  if (isWallOnFloor(floorIdx, wx-R, wz-R) || isWallOnFloor(floorIdx, wx+R, wz-R) ||
      isWallOnFloor(floorIdx, wx-R, wz+R) || isWallOnFloor(floorIdx, wx+R, wz+R)) return false
  for (let i = 0; i < propColliders.length; i++) {
    const p = propColliders[i]
    if (p.floor !== floorIdx) continue
    const dx = wx - p.x, dz = wz - p.z
    if (dx*dx + dz*dz < (R + p.radius) * (R + p.radius)) return false
  }
  return true
}

// ── TRAP ROOM ─────────────────────────────────────────────
// Rows 28-34, cols 2-6 — west dead zone, accessible via single-cell hallway (row 31, cols 7-17)
// Once entered, the hallway is sealed and four face-wallpapered planes slowly crush the player

const TRAP_R1 = 28, TRAP_R2 = 34, TRAP_C1 = 2, TRAP_C2 = 6
const TRAP_SEAL_R = 31, TRAP_SEAL_C = 7  // hallway cell to seal when trap activates

let trapActive = false
let trapRate   = 0.3                    // units/sec per wall (accelerates)
let trapNorthZ = TRAP_R1 * CELL         // starts at north inner edge
let trapSouthZ = (TRAP_R2 + 1) * CELL  // starts at south inner edge
let trapWestX  = TRAP_C1 * CELL        // starts at west inner edge
let trapEastX  = (TRAP_C2 + 1) * CELL  // starts at east inner edge

let trapNorthWall, trapSouthWall, trapWestWall, trapEastWall

;(function initTrapWalls() {
  const roomW = (TRAP_C2 - TRAP_C1 + 1) * CELL   // 20
  const roomD = (TRAP_R2 - TRAP_R1 + 1) * CELL   // 28
  const midX  = TRAP_C1 * CELL + roomW / 2        // 18
  const midZ  = TRAP_R1 * CELL + roomD / 2        // 126

  // North wall — sits at north edge, moves south; default PlaneGeometry normal faces +Z (toward interior)
  trapNorthWall = new THREE.Mesh(new THREE.PlaneGeometry(roomW, WALL_H), trapWallMat)
  trapNorthWall.position.set(midX, WALL_H / 2, trapNorthZ)
  trapNorthWall.visible = false
  levelGroups[0].add(trapNorthWall)

  // South wall — faces north (rotation.y = π)
  trapSouthWall = new THREE.Mesh(new THREE.PlaneGeometry(roomW, WALL_H), trapWallMat)
  trapSouthWall.rotation.y = Math.PI
  trapSouthWall.position.set(midX, WALL_H / 2, trapSouthZ)
  trapSouthWall.visible = false
  levelGroups[0].add(trapSouthWall)

  // West wall — faces east (rotation.y = π/2)
  trapWestWall = new THREE.Mesh(new THREE.PlaneGeometry(roomD, WALL_H), trapWallMat)
  trapWestWall.rotation.y = Math.PI / 2
  trapWestWall.position.set(trapWestX, WALL_H / 2, midZ)
  trapWestWall.visible = false
  levelGroups[0].add(trapWestWall)

  // East wall — faces west (rotation.y = -π/2)
  trapEastWall = new THREE.Mesh(new THREE.PlaneGeometry(roomD, WALL_H), trapWallMat)
  trapEastWall.rotation.y = -Math.PI / 2
  trapEastWall.position.set(trapEastX, WALL_H / 2, midZ)
  trapEastWall.visible = false
  levelGroups[0].add(trapEastWall)
})()

// ── TRAP ROOM — Floor 1 (Mall backroom, SW store) ─────
// Rows 38-44, cols 2-7 — single-cell exit at row 37, col 4 (service corridor)
const T1_R1 = 30, T1_R2 = 36, T1_C1 = 50, T1_C2 = 56
const T1_SEAL_R = 29, T1_SEAL_C = 49

let trap1Active = false
let trap1Rate   = 0.3
let trap1NorthZ = T1_R1 * CELL
let trap1SouthZ = (T1_R2 + 1) * CELL
let trap1WestX  = T1_C1 * CELL
let trap1EastX  = (T1_C2 + 1) * CELL

let trap1NorthWall, trap1SouthWall, trap1WestWall, trap1EastWall

;(function initTrap1Walls() {
  const roomW = (T1_C2 - T1_C1 + 1) * CELL
  const roomD = (T1_R2 - T1_R1 + 1) * CELL
  const midX  = T1_C1 * CELL + roomW / 2
  const midZ  = T1_R1 * CELL + roomD / 2

  trap1NorthWall = new THREE.Mesh(new THREE.PlaneGeometry(roomW, WALL_H), trapWallMat)
  trap1NorthWall.position.set(midX, f1Y + WALL_H/2, trap1NorthZ)
  trap1NorthWall.visible = false
  levelGroups[1].add(trap1NorthWall)

  trap1SouthWall = new THREE.Mesh(new THREE.PlaneGeometry(roomW, WALL_H), trapWallMat)
  trap1SouthWall.rotation.y = Math.PI
  trap1SouthWall.position.set(midX, f1Y + WALL_H/2, trap1SouthZ)
  trap1SouthWall.visible = false
  levelGroups[1].add(trap1SouthWall)

  trap1WestWall = new THREE.Mesh(new THREE.PlaneGeometry(roomD, WALL_H), trapWallMat)
  trap1WestWall.rotation.y = Math.PI / 2
  trap1WestWall.position.set(trap1WestX, f1Y + WALL_H/2, midZ)
  trap1WestWall.visible = false
  levelGroups[1].add(trap1WestWall)

  trap1EastWall = new THREE.Mesh(new THREE.PlaneGeometry(roomD, WALL_H), trapWallMat)
  trap1EastWall.rotation.y = -Math.PI / 2
  trap1EastWall.position.set(trap1EastX, f1Y + WALL_H/2, midZ)
  trap1EastWall.visible = false
  levelGroups[1].add(trap1EastWall)
})()

// ���─ TRAP ROOM — Floor 2 (Poolrooms, deep interior) ────
// Rows 40-47, cols 40-47 — entry via single-cell door at row 43, col 39
const T2_R1 = 40, T2_R2 = 47, T2_C1 = 40, T2_C2 = 47
const T2_SEAL_R = 43, T2_SEAL_C = 39

let trap2Active = false
let trap2Rate   = 0.25
let trap2NorthZ = T2_R1 * CELL
let trap2SouthZ = (T2_R2 + 1) * CELL
let trap2WestX  = T2_C1 * CELL
let trap2EastX  = (T2_C2 + 1) * CELL

let trap2NorthWall, trap2SouthWall, trap2WestWall, trap2EastWall

;(function initTrap2Walls() {
  const roomW = (T2_C2 - T2_C1 + 1) * CELL
  const roomD = (T2_R2 - T2_R1 + 1) * CELL
  const midX  = T2_C1 * CELL + roomW / 2
  const midZ  = T2_R1 * CELL + roomD / 2

  trap2NorthWall = new THREE.Mesh(new THREE.PlaneGeometry(roomW, WALL_H), trapWallMat)
  trap2NorthWall.position.set(midX, f2Y + WALL_H/2, trap2NorthZ)
  trap2NorthWall.visible = false
  levelGroups[2].add(trap2NorthWall)

  trap2SouthWall = new THREE.Mesh(new THREE.PlaneGeometry(roomW, WALL_H), trapWallMat)
  trap2SouthWall.rotation.y = Math.PI
  trap2SouthWall.position.set(midX, f2Y + WALL_H/2, trap2SouthZ)
  trap2SouthWall.visible = false
  levelGroups[2].add(trap2SouthWall)

  trap2WestWall = new THREE.Mesh(new THREE.PlaneGeometry(roomD, WALL_H), trapWallMat)
  trap2WestWall.rotation.y = Math.PI / 2
  trap2WestWall.position.set(trap2WestX, f2Y + WALL_H/2, midZ)
  trap2WestWall.visible = false
  levelGroups[2].add(trap2WestWall)

  trap2EastWall = new THREE.Mesh(new THREE.PlaneGeometry(roomD, WALL_H), trapWallMat)
  trap2EastWall.rotation.y = -Math.PI / 2
  trap2EastWall.position.set(trap2EastX, f2Y + WALL_H/2, midZ)
  trap2EastWall.visible = false
  levelGroups[2].add(trap2EastWall)
})()

// ── TRAP TELEGRAPH PANELS (flickering emissive outside doorway) ──
;(function initTrapPanels() {
  const panelGeo = new THREE.PlaneGeometry(1.0, 0.5)
  const emissiveMat0 = new THREE.MeshBasicMaterial({ color: 0xFF4400, transparent: true, opacity: 0.6 })
  const emissiveMat1 = new THREE.MeshBasicMaterial({ color: 0xFF4400, transparent: true, opacity: 0.6 })
  const emissiveMat2 = new THREE.MeshBasicMaterial({ color: 0xFF4400, transparent: true, opacity: 0.6 })

  // Floor 0: hallway entrance is at row 31, col 17 (east end of trap hallway facing CENTER)
  // Place panel just outside at col 18
  trapPanel0 = new THREE.Mesh(panelGeo.clone(), emissiveMat0)
  trapPanel0.position.set(17 * CELL + CELL/2, WALL_H * 0.7, 31 * CELL + CELL/2)
  trapPanel0.rotation.y = -Math.PI / 2
  trapPanel0.visible = false
  levelGroups[0].add(trapPanel0)

  // Floor 1: seal is at row 29, col 49. Panel just outside at row 29, col 48
  trapPanel1 = new THREE.Mesh(panelGeo.clone(), emissiveMat1)
  trapPanel1.position.set(48 * CELL + CELL/2, floorYOffsets[1] + WALL_H * 0.7, 29 * CELL + CELL/2)
  trapPanel1.rotation.y = -Math.PI / 2
  trapPanel1.visible = false
  levelGroups[1].add(trapPanel1)

  // Floor 2: seal is at row 43, col 39. Panel just outside at row 43, col 38
  trapPanel2 = new THREE.Mesh(panelGeo.clone(), emissiveMat2)
  trapPanel2.position.set(38 * CELL + CELL/2, floorYOffsets[2] + WALL_H * 0.7, 43 * CELL + CELL/2)
  trapPanel2.rotation.y = -Math.PI / 2
  trapPanel2.visible = false
  levelGroups[2].add(trapPanel2)
})()

// ── Player-following dynamic light ──────────────────────
const FLOOR_PLAYER_LIGHT = [
  { color: 0xFFFDE8, intensity: 1.5, distance: 12 },  // warm backrooms
  { color: 0xF8F4FF, intensity: 1.2, distance: 12 },  // sterile mall
  { color: 0x99DDFF, intensity: 1.0, distance: 12 },  // blue poolrooms
]
const playerLight = new THREE.PointLight(0xFFFDE8, 1.5, 12)
scene.add(playerLight)

// ── PLAYER ────────────────────────────────────────────────

let startRow = 1, startCol = 1
outer: for (let r = 1; r < ROWS-1; r++)
  for (let c = 1; c < COLS-1; c++)
    if (MAP[r][c] === 0) { startRow = r; startCol = c; break outer }

const START_X = startCol*CELL + CELL/2
const START_Z = startRow*CELL + CELL/2

// Cinematic start — left edge of CENTER hub looking east across its full width
const CINEMATIC_X = 18 * CELL + CELL/2   // col 18 (west edge of CENTER)
const CINEMATIC_Z = 21 * CELL + CELL/2   // row 21 (mid-height of CENTER, rows 11-32)
const CINEMATIC_YAW = -Math.PI / 2       // looking in +X across the long room

camera.position.set(CINEMATIC_X, EYE_H, CINEMATIC_Z)
let yawAngle   = CINEMATIC_YAW
let pitchAngle = 0
let gameState    = 'playing'
let deathTimer   = 0

// ── 5d. SHIELD & ALMOND WATER ────────────────────────────
let hasShield = false
let invulnTimer = 0

// ── 5e. SCORE JUICE ──────────────────────────────────────
let levelsVisited = new Set([0])
let closestUnseen = Infinity  // minimum entity distance while hunting
let scoreJuiceTimer = 0
let lastScoreJuiceMilestone = 0

// ── 5b. PLAYER FOOTSTEP & HEAD BOB ──────────────────────
let playerStepTimer = 0
let playerStepPhase = 0

// ── 5c. POST-PROCESSING ─────────────────────────────────
// postEffectsEnabled is set after isTouch is defined (see below)
let postEffectsEnabled = false
let postFlickerTimer = 3 + Math.random() * 5

// ── 5g. ENTITY STALK STATE ──────────────────────────────
// (added to entity class below)


function flashScreen(color) {
  const el = document.getElementById('screen-flash')
  el.style.background = color
  el.style.opacity = '1'
  setTimeout(() => { el.style.opacity = '0' }, 80)
}

function damagePlayer() {
  if (gameState !== 'playing') return
  if (invulnTimer > 0) return  // invulnerability active
  if (hasShield) {
    // Consume shield instead of dying
    hasShield = false
    document.getElementById('shield-icon').style.display = 'none'
    flashScreen('rgba(255,255,255,0.85)')
    invulnTimer = 3.0  // 3 seconds invulnerability
    // Play shield-break sound
    if (audioCtx && audioCtx.state === 'running') {
      const osc = audioCtx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.value = 800
      const g = audioCtx.createGain()
      g.gain.setValueAtTime(0.4, audioCtx.currentTime)
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3)
      osc.connect(g)
      g.connect(masterGainNode || audioCtx.destination)
      osc.start()
      osc.stop(audioCtx.currentTime + 0.3)
    }
    return
  }
  flashScreen('rgba(200,0,0,0.48)')
  // Mobile vibration on damage
  if (navigator.vibrate) navigator.vibrate(100)
  triggerJumpscare()
}

// ── JUMPSCARE ──────────────────────────────────────────────

let jumpscareShakeTimer = 0
const JUMPSCARE_DURATION = 0.35  // seconds

function triggerJumpscare() {
  if (gameState !== 'playing') return
  gameState = 'jumpscare'

  // Stop entity audio
  stopHuntDrone()

  // Audio sting
  playJumpscareSting()

  // Fullscreen face overlay
  const overlay = document.createElement('div')
  overlay.id = 'jumpscare-overlay'
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:90;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.85);pointer-events:none;'
  const img = document.createElement('img')
  img.src = '/ENEMY.jpg'
  img.style.cssText = 'width:60vmin;height:60vmin;object-fit:cover;transform:scale(0.8);transition:transform 0.35s ease-out;'
  overlay.appendChild(img)
  document.body.appendChild(overlay)

  // Scale-up animation with rotation jitter
  let elapsed = 0
  const jitterInterval = setInterval(() => {
    elapsed += 16
    const t = Math.min(elapsed / (JUMPSCARE_DURATION * 1000), 1)
    const scale = 0.8 + t * 0.4  // 0.8 → 1.2
    const rot = (Math.random() - 0.5) * 8  // random jitter degrees
    img.style.transform = `scale(${scale}) rotate(${rot}deg)`
  }, 16)

  // Camera shake
  jumpscareShakeTimer = JUMPSCARE_DURATION

  // After jumpscare duration, proceed to death
  setTimeout(() => {
    clearInterval(jitterInterval)
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
    camera.rotation.z = 0
    startDeath()
  }, JUMPSCARE_DURATION * 1000)
}

// ── DEATH ─────────────────────────────────────────────────

function startDeath() {
  if (gameState === 'dying' || gameState === 'dead') return
  gameState = 'dying'
  deathTimer = 0
  // Mobile vibration on death
  if (navigator.vibrate) navigator.vibrate(200)
  music.pause()
  music.currentTime = 0
  musicPlayPending = false

  const survived  = Math.floor(gameTime)
  lastSurvivedTime = gameTime
  const prevBest  = parseInt(localStorage.getItem('yerooms_best') || '0', 10)
  const isNewBest = survived > 0 && survived > prevBest
  if (isNewBest) localStorage.setItem('yerooms_best', String(survived))

  const timeEl = document.getElementById('death-time')
  const bestEl = document.getElementById('death-best')
  timeEl.textContent  = `SURVIVED  ${fmtTime(gameTime)}`
  timeEl.style.display = 'block'
  if (isNewBest) {
    bestEl.textContent   = 'NEW PERSONAL BEST'
    bestEl.style.display = 'block'
  } else if (prevBest > 0) {
    bestEl.textContent   = `BEST  ${fmtTime(prevBest)}`
    bestEl.style.display = 'block'
  } else {
    bestEl.style.display = 'none'
  }

  // 5e: Death stats
  const statsEl = document.getElementById('death-stats')
  const levelsEl = document.getElementById('death-levels')
  const closestEl = document.getElementById('death-closest')
  statsEl.style.display = 'flex'
  levelsEl.textContent = `LEVELS VISITED: ${levelsVisited.size}`
  closestEl.textContent = closestUnseen < Infinity
    ? `CLOSEST CALL: ${closestUnseen.toFixed(1)}m`
    : 'CLOSEST CALL: --'
}

function restartGame() {
  gameState = 'playing'
  deathTimer = 0
  if (!isTouch) pauseGame(); else {
    paused = false
    unlockAudio()  // re-arm iOS audio context while we have the user gesture
  }
  currentFloor = 0
  isFalling = false
  fallTimer = 0
  camera.position.set(START_X, EYE_H, START_Z)
  camera.rotation.z = 0
  yawAngle = Math.PI
  pitchAngle = 0
  document.getElementById('death-overlay').style.display = 'none'
  document.getElementById('death-vignette').style.opacity = '0'
  document.getElementById('death-time').style.display = 'none'
  document.getElementById('death-best').style.display = 'none'
  lb.classList.remove('visible', 'on-death')
  entities.forEach(e => e.reset())
  music.pause(); music.currentTime = 0
  enemyTracked = false
  spawnBangPlayed = false
  footstepTimer = 0
  jumpscareShakeTimer = 0
  stopHuntDrone()
  const jsOverlay = document.getElementById('jumpscare-overlay')
  if (jsOverlay) jsOverlay.remove()
  losGraceTimer = 0
  gameTime = 0
  // Reset traps
  if (trapActive) MAP[TRAP_SEAL_R][TRAP_SEAL_C] = 0
  trapActive = false
  trapRate   = 0.3
  trapNorthZ = TRAP_R1 * CELL
  trapSouthZ = (TRAP_R2 + 1) * CELL
  trapWestX  = TRAP_C1 * CELL
  trapEastX  = (TRAP_C2 + 1) * CELL
  trapNorthWall.position.z = trapNorthZ
  trapSouthWall.position.z = trapSouthZ
  trapWestWall.position.x  = trapWestX
  trapEastWall.position.x  = trapEastX
  trapNorthWall.visible = false
  trapSouthWall.visible = false
  trapWestWall.visible  = false
  trapEastWall.visible  = false

  if (trap1Active) MAP1[T1_SEAL_R][T1_SEAL_C] = 0
  trap1Active = false
  trap1Rate   = 0.3
  trap1NorthZ = T1_R1 * CELL
  trap1SouthZ = (T1_R2 + 1) * CELL
  trap1WestX  = T1_C1 * CELL
  trap1EastX  = (T1_C2 + 1) * CELL
  trap1NorthWall.position.z = trap1NorthZ
  trap1SouthWall.position.z = trap1SouthZ
  trap1WestWall.position.x  = trap1WestX
  trap1EastWall.position.x  = trap1EastX
  trap1NorthWall.visible = false
  trap1SouthWall.visible = false
  trap1WestWall.visible  = false
  trap1EastWall.visible  = false

  if (trap2Active) MAP2[T2_SEAL_R][T2_SEAL_C] = 0
  trap2Active = false
  trap2Rate   = 0.25
  trap2NorthZ = T2_R1 * CELL
  trap2SouthZ = (T2_R2 + 1) * CELL
  trap2WestX  = T2_C1 * CELL
  trap2EastX  = (T2_C2 + 1) * CELL
  trap2NorthWall.position.z = trap2NorthZ
  trap2SouthWall.position.z = trap2SouthZ
  trap2WestWall.position.x  = trap2WestX
  trap2EastWall.position.x  = trap2EastX
  trap2NorthWall.visible = false
  trap2SouthWall.visible = false
  trap2WestWall.visible  = false
  trap2EastWall.visible  = false

  // Reset escape holes
  if (escapeHole0Mesh) { levelGroups[0].remove(escapeHole0Mesh); escapeHole0Mesh = null }
  escapeHole0Open = false
  if (escapeHole1Mesh) { levelGroups[1].remove(escapeHole1Mesh); escapeHole1Mesh = null }
  escapeHole1Open = false
  if (escapeHole2Mesh) { levelGroups[2].remove(escapeHole2Mesh); escapeHole2Mesh = null }
  escapeHole2Open = false

  // Reset sprint/stamina
  stamina = STAMINA_MAX
  isSprinting = false
  if (breathingOsc) { try { breathingOsc.stop() } catch {} breathingOsc = null; breathingGain = null; breathingFilter = null }

  // Reset shield & invulnerability
  hasShield = false
  invulnTimer = 0
  document.getElementById('shield-icon').style.display = 'none'

  // Reset score juice stats
  levelsVisited = new Set([0])
  closestUnseen = Infinity
  scoreJuiceTimer = 0
  lastScoreJuiceMilestone = 0
  document.getElementById('death-stats').style.display = 'none'

  // Reset player footsteps
  playerStepTimer = 0
  playerStepPhase = 0

  // Reset post-processing flicker timer
  postFlickerTimer = 3 + Math.random() * 5

  // Respawn almond water pickups
  resetAlmondWater()

  // Reset ambience for new game
  ambienceStarted = false
  if (ambienceHumSource) { try { ambienceHumSource.stop() } catch {} ambienceHumSource = null; ambienceHumGain = null }
  startAmbience()
}

document.getElementById('play-again').addEventListener('click', restartGame)
document.getElementById('play-again').addEventListener('touchstart', e => {
  e.preventDefault(); restartGame()
})

// ── ENTITIES ──────────────────────────────────────────────

class Entity {
  constructor(row, col, speed = 1.6, range = 20) {
    this.spawnRow = row; this.spawnCol = col
    this.baseSpeed = speed
    this.speed = speed; this.range = range
    this.x = col*CELL + CELL/2
    this.z = row*CELL + CELL/2
    this.hitCooldown = 0
    this.wanderTimer  = 0
    this.targetX = this.x; this.targetZ = this.z
    this.bobPhase = Math.random() * Math.PI * 2
    this.facingX = 0
    this.facingZ = 1
    this.active = false
    this.hunting = false
    this.path = null
    this.pathTimer = 0
    this.spawnDelay = 20 + Math.random() * 25   // 30–45 seconds
    this.spawnElapsed = 0
    this.floor = 0  // which floor the entity is on
    this.crossFloorTimer = 0  // time spent on different floor than player
    this.firstSighting = false  // becomes true after first LOS with player
    this.stallTimer = 0          // 5g: stalk pause before advancing
    this.hasStalkedThisSighting = false  // 5g: reset when LOS breaks
    this.group = this._build()
    this.group.visible = false
    scene.add(this.group)
  }

  _build() {
    const g = new THREE.Group()

    // Face billboard — always faces camera automatically (THREE.Sprite)
    const face = new THREE.Sprite(spriteMat)
    face.scale.set(1.8, 1.8, 1)
    face.position.set(0, 1.2, 0)
    g.add(face)

    // Subtle red glow beneath the face for ambiance
    const glow = new THREE.PointLight(0xff2200, 0.6, 4)
    glow.position.set(0, 1.2, 0)
    g.add(glow)

    return g
  }

  reset() {
    this.x = this.spawnCol*CELL + CELL/2
    this.z = this.spawnRow*CELL + CELL/2
    this.hitCooldown = 0
    this.facingX = 0; this.facingZ = 1
    this.active = false
    this.hunting = false
    this.path = null
    this.pathTimer = 0
    this.spawnElapsed = 0
    this.spawnDelay = 20 + Math.random() * 25
    this.speed = this.baseSpeed
    this.floor = 0
    this.crossFloorTimer = 0
    this.firstSighting = false
    this.stallTimer = 0
    this.hasStalkedThisSighting = false
    this.group.visible = false
  }

  update(dt, px, pz, playerFloor) {
    if (!this.active) {
      this.spawnElapsed += dt
      if (this.spawnElapsed >= this.spawnDelay) {
        // Place entity at a doorway near the player's current room (on player's floor)
        this.floor = playerFloor
        const spawn = this._findSpawnNearPlayer(px, pz)
        if (spawn) {
          this.x = spawn.c * CELL + CELL / 2
          this.z = spawn.r * CELL + CELL / 2
          this.group.position.set(this.x, floorYOffsets[this.floor], this.z)
        }
        // Face toward the player on spawn so LOS / music trigger immediately
        const sdx = px - this.x, sdz = pz - this.z
        const sl = Math.hypot(sdx, sdz)
        if (sl > 0) { this.facingX = sdx / sl; this.facingZ = sdz / sl }
        this.active = true
        this.group.visible = true
        // Spawn telegraph — metallic bang from entity direction
        if (!spawnBangPlayed && audioPanner) {
          updatePannerPosition(this.x, floorYOffsets[this.floor] + 1.2, this.z)
          playSpawnBang()
          spawnBangPlayed = true
        }
      }
      return
    }

    this.hitCooldown = Math.max(0, this.hitCooldown - dt)
    this.bobPhase += dt * 1.6

    // If player is on a different floor, navigate toward nearest hole/portal to follow
    if (this.floor !== playerFloor) {
      this.crossFloorTimer += dt
      // After 30s on wrong floor, force-teleport to player's floor at opposite end
      if (this.crossFloorTimer >= 30) {
        this.floor = playerFloor
        this.crossFloorTimer = 0
        const map = FLOOR_MAPS[this.floor]
        const rows = FLOOR_ROWS[this.floor]
        const cols = FLOOR_COLS[this.floor]
        // Place at opposite end from player
        const pr = Math.floor(pz / CELL), pc = Math.floor(px / CELL)
        const targetR = rows - 1 - pr, targetC = cols - 1 - pc
        // Find nearest open cell to opposite corner
        let placed = false
        for (let rad = 0; rad < 10 && !placed; rad++) {
          for (let dr = -rad; dr <= rad && !placed; dr++) {
            for (let dc = -rad; dc <= rad && !placed; dc++) {
              const r = targetR + dr, c = targetC + dc
              if (r < 0 || r >= rows || c < 0 || c >= cols) continue
              if (map[r][c] === 0) {
                this.x = c * CELL + CELL/2
                this.z = r * CELL + CELL/2
                placed = true
              }
            }
          }
        }
        this.path = null
      } else {
        this._pursueAcrossFloors(dt, playerFloor)
      }
      this.group.position.set(this.x, floorYOffsets[this.floor] + Math.sin(this.bobPhase) * 0.08, this.z)
      return
    }
    this.crossFloorTimer = 0  // reset when on same floor

    const dx   = px - this.x
    const dz   = pz - this.z
    const dist = Math.hypot(dx, dz)

    // BFS pathfinding — recalculate on timer, or when current path is exhausted
    this.pathTimer -= dt
    if (this.pathTimer <= 0 || (this.path && this.path.length < 2)) {
      this.path = this._findPathOnFloor(this.floor, this.x, this.z, px, pz)
      this.pathTimer = 0.35
    }

    let mx = 0, mz = 0
    if (this.path && this.path.length >= 2) {
      // Consume waypoints already reached
      while (this.path.length >= 2) {
        const [wr, wc] = this.path[1]
        if (Math.hypot(wc*CELL+CELL/2 - this.x, wr*CELL+CELL/2 - this.z) < CELL * 0.55)
          this.path.shift()
        else break
      }
      const [nr, nc] = this.path.length >= 2 ? this.path[1] : this.path[0]
      const tx = nc*CELL + CELL/2, tz = nr*CELL + CELL/2
      const tl = Math.hypot(tx - this.x, tz - this.z)
      if (tl > 0.1) { mx = (tx - this.x)/tl; mz = (tz - this.z)/tl }
    } else if (dist > 0.5) {
      mx = dx/dist; mz = dz/dist  // fallback: direct
    }

    // Track facing direction from movement vector
    if (Math.abs(mx) > 0.01 || Math.abs(mz) > 0.01) {
      this.facingX = mx
      this.facingZ = mz
    }

    // 5g: Stalk state — when entity first sees player at distance > 15, pause before advancing
    const canSee = this.canSeePlayer(px, pz)
    if (canSee && dist > 15 && !this.hasStalkedThisSighting) {
      this.hasStalkedThisSighting = true
      this.stallTimer = 2 + Math.random()
    }
    if (!canSee) {
      this.hasStalkedThisSighting = false  // reset when LOS breaks
    }
    if (this.stallTimer > 0) {
      this.stallTimer -= dt
      // Entity stares but doesn't move
      this.group.position.set(this.x, floorYOffsets[this.floor] + Math.sin(this.bobPhase) * 0.08, this.z)
      if (dist < 1.9 && this.hitCooldown <= 0) {
        this.hitCooldown = HIT_COOLDOWN
        damagePlayer()
      }
      return
    }

    // Before first sighting: slow prowl. After: full speed when unseen, normal when seen
    const baseStep = this.firstSighting
      ? (this.hunting ? Math.min(this.speed * 4.5, 8.0) : this.speed)
      : this.speed * 0.5
    const step = baseStep * dt
    const nx = this.x + mx * step
    const nz = this.z + mz * step
    // Entity only collides with walls, passes through props/furniture
    if (!isWallOnFloor(this.floor, nx, this.z)) this.x = nx
    if (!isWallOnFloor(this.floor, this.x, nz)) this.z = nz

    // Check if entity stepped on a portal (same floor as player — use it to reposition)
    for (const portal of PORTALS) {
      if (portal.floor !== this.floor) continue
      const pdx = this.x - portal.x, pdz = this.z - portal.z
      if (pdx*pdx + pdz*pdz < 2.0*2.0) {
        // Use portal — teleport toward player
        this.x = px + (Math.random()-0.5)*8
        this.z = pz + (Math.random()-0.5)*8
        // Clamp to open cell
        const map = FLOOR_MAPS[this.floor]
        const r = Math.floor(this.z / CELL), c = Math.floor(this.x / CELL)
        if (r < 0 || r >= FLOOR_ROWS[this.floor] || c < 0 || c >= FLOOR_COLS[this.floor] || map[r][c] === 1) {
          this.x = px; this.z = pz  // fallback: right on player
        }
        break
      }
    }

    this.group.position.set(this.x, floorYOffsets[this.floor] + Math.sin(this.bobPhase) * 0.08, this.z)

    if (dist < 1.9 && this.hitCooldown <= 0) {
      this.hitCooldown = HIT_COOLDOWN
      damagePlayer()
    }
  }

  // Find a spawn cell far from the player — gives exploration time
  _findSpawnNearPlayer(px, pz) {
    const map = FLOOR_MAPS[this.floor]
    const rows = FLOOR_ROWS[this.floor]
    const cols = FLOOR_COLS[this.floor]
    const pc = Math.floor(px / CELL)
    const pr = Math.floor(pz / CELL)
    const candidates = []
    const SCAN = 35
    // Pass 1: wall-adjacent cells 20-30 cells away (far corners/corridors)
    for (let dr = -SCAN; dr <= SCAN; dr++) {
      for (let dc = -SCAN; dc <= SCAN; dc++) {
        const r = pr + dr, c = pc + dc
        if (r < 1 || r >= rows - 1 || c < 1 || c >= cols - 1) continue
        if (map[r][c] !== 0) continue
        const dist = Math.hypot(dr, dc)
        if (dist < 20 || dist > 30) continue
        const walls =
          (map[r-1][c] === 1 ? 1 : 0) + (map[r+1][c] === 1 ? 1 : 0) +
          (map[r][c-1] === 1 ? 1 : 0) + (map[r][c+1] === 1 ? 1 : 0)
        if (walls >= 2) candidates.push({ r, c })
      }
    }
    // Pass 2: any open cell 15-35 cells away
    if (candidates.length === 0) {
      for (let dr = -SCAN; dr <= SCAN; dr++) {
        for (let dc = -SCAN; dc <= SCAN; dc++) {
          const r = pr + dr, c = pc + dc
          if (r < 1 || r >= rows - 1 || c < 1 || c >= cols - 1) continue
          if (map[r][c] !== 0) continue
          const dist = Math.hypot(dr, dc)
          if (dist >= 15 && dist <= 35) candidates.push({ r, c })
        }
      }
    }
    if (candidates.length === 0) return null
    return candidates[0 | Math.random() * candidates.length]
  }

  // Navigate toward nearest hole or portal to change floors and follow player
  _pursueAcrossFloors(dt, playerFloor) {
    // Find nearest hole on this floor that leads toward the player's floor
    let bestDist = Infinity
    let bestX = this.x, bestZ = this.z

    // Check holes on current floor
    for (const hole of HOLES) {
      if (hole.floor !== this.floor) continue
      const hx = hole.c * CELL + CELL/2, hz = hole.r * CELL + CELL/2
      const d = Math.hypot(hx - this.x, hz - this.z)
      if (d < bestDist) { bestDist = d; bestX = hx; bestZ = hz }
    }
    // Check portals on current floor (can use to teleport, then fall through a hole)
    for (const portal of PORTALS) {
      if (portal.floor !== this.floor) continue
      const d = Math.hypot(portal.x - this.x, portal.z - this.z)
      if (d < bestDist) { bestDist = d; bestX = portal.x; bestZ = portal.z }
    }

    // Move toward the target
    const tdx = bestX - this.x, tdz = bestZ - this.z
    const tl = Math.hypot(tdx, tdz)
    if (tl > 0.5) {
      const mx = tdx/tl, mz = tdz/tl
      const step = this.speed * 3.0 * dt  // fast pursuit across floors
      const nx = this.x + mx * step
      const nz = this.z + mz * step
      // Entity only collides with walls, passes through props
      if (!isWallOnFloor(this.floor, nx, this.z)) this.x = nx
      if (!isWallOnFloor(this.floor, this.x, nz)) this.z = nz
    }

    // Check if reached a hole — fall through
    const eCol = Math.floor(this.x / CELL), eRow = Math.floor(this.z / CELL)
    for (const hole of HOLES) {
      if (hole.floor === this.floor && hole.r === eRow && hole.c === eCol) {
        this.floor = (this.floor + 1) % FLOOR_COUNT
        this.path = null
        return
      }
    }
    // Check if reached a portal — teleport near player
    for (const portal of PORTALS) {
      if (portal.floor !== this.floor) continue
      const pdx = this.x - portal.x, pdz = this.z - portal.z
      if (pdx*pdx + pdz*pdz < 2.5*2.5) {
        // Teleport to player's floor at a random open spot near player
        this.floor = playerFloor
        const map = FLOOR_MAPS[this.floor]
        const rows = FLOOR_ROWS[this.floor]
        const cols = FLOOR_COLS[this.floor]
        for (let a = 0; a < 30; a++) {
          const tr = Math.floor(Math.random() * rows)
          const tc = Math.floor(Math.random() * cols)
          if (map[tr][tc] === 0) { this.x = tc*CELL+CELL/2; this.z = tr*CELL+CELL/2; break }
        }
        this.path = null
        return
      }
    }
  }

  // BFS pathfinding on any floor
  _findPathOnFloor(floorIdx, fromX, fromZ, toX, toZ) {
    const map = FLOOR_MAPS[floorIdx]
    const rows = FLOOR_ROWS[floorIdx]
    const cols = FLOOR_COLS[floorIdx]
    const sc = Math.floor(fromX / CELL), sr = Math.floor(fromZ / CELL)
    const ec = Math.floor(toX  / CELL), er = Math.floor(toZ  / CELL)
    if (sr === er && sc === ec) return null

    const size = rows * cols
    const visited = new Uint8Array(size)
    const parentR = new Int16Array(size).fill(-1)
    const parentC = new Int16Array(size).fill(-1)
    const queue = new Int16Array(size * 2)
    let head = 0, tail = 0

    visited[sr * cols + sc] = 1
    queue[tail++] = sr; queue[tail++] = sc

    const DR = [-1, 1, 0, 0]
    const DC = [ 0, 0,-1, 1]
    let found = false

    outer: while (head < tail) {
      const r = queue[head++], c = queue[head++]
      for (let i = 0; i < 4; i++) {
        const nr = r + DR[i], nc = c + DC[i]
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue
        if (map[nr][nc] === 1) continue
        const idx = nr * cols + nc
        if (visited[idx]) continue
        visited[idx] = 1
        parentR[idx] = r; parentC[idx] = c
        if (nr === er && nc === ec) { found = true; break outer }
        queue[tail++] = nr; queue[tail++] = nc
      }
    }

    if (!found) return null
    const path = []
    let r = er, c = ec
    while (!(r === sr && c === sc)) {
      path.push([r, c])
      const idx = r * cols + c
      const pr = parentR[idx]; if (pr === -1) return null
      c = parentC[idx]; r = pr
    }
    path.push([sr, sc])
    path.reverse()
    return path
  }

  // Returns true if there is an unobstructed line of sight to the player (360°, walls only blocker)
  canSeePlayer(px, pz) {
    if (this.floor !== currentFloor) return false  // can't see across floors
    const dx = px - this.x
    const dz = pz - this.z
    const dist = Math.hypot(dx, dz)
    if (dist < 0.5) return true  // right on top

    // LOS raycast through map grid — walls are the only blocker, no FOV cone
    const steps = Math.ceil(dist / (CELL * 0.25))
    for (let i = 1; i < steps; i++) {
      const t = i / steps
      if (isWallOnFloor(this.floor, this.x + dx * t, this.z + dz * t)) return false
    }
    return true
  }
}

const entities = [
  new Entity(42, 42, 2.0, 999),  // threatening from spawn, surges when hunting
]

// ── 5d. ALMOND WATER PICKUPS ─────────────────────────────
const almondWaterPickups = []  // { mesh, floor, collected }
const almondWaterMat = new THREE.MeshBasicMaterial({ color: 0xFFD040, transparent: true, opacity: 0.75 })
const almondWaterGlowMat = new THREE.MeshBasicMaterial({ color: 0xFFE870, transparent: true, opacity: 0.3 })

function findDeadEndCells(map, rows, cols) {
  // Find cells with 3 wall neighbors (dead-end-ish)
  const cells = []
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      if (map[r][c] !== 0) continue
      const walls = (map[r-1][c] === 1 ? 1 : 0) + (map[r+1][c] === 1 ? 1 : 0) +
                    (map[r][c-1] === 1 ? 1 : 0) + (map[r][c+1] === 1 ? 1 : 0)
      if (walls >= 2) cells.push({ r, c, walls })
    }
  }
  // Sort by wall count descending (prefer more enclosed)
  cells.sort((a, b) => b.walls - a.walls)
  return cells
}

function spawnAlmondWater() {
  const floors = [
    { map: MAP, rows: ROWS, cols: COLS, idx: 0 },
    { map: MAP1, rows: F1_ROWS, cols: F1_COLS, idx: 1 },
    { map: MAP2, rows: F2_ROWS, cols: F2_COLS, idx: 2 },
  ]
  for (const fl of floors) {
    const candidates = findDeadEndCells(fl.map, fl.rows, fl.cols)
    const count = 3 + Math.floor(Math.random() * 3)  // 3-5 per floor
    const used = new Set()
    for (let i = 0; i < count && i < candidates.length; i++) {
      // Pick from top candidates, skip duplicates
      let ci = i
      while (ci < candidates.length && used.has(candidates[ci].r * 10000 + candidates[ci].c)) ci++
      if (ci >= candidates.length) break
      const cell = candidates[ci]
      used.add(cell.r * 10000 + cell.c)

      const wx = cell.c * CELL + CELL / 2 + (Math.random() - 0.5) * 1.5
      const wz = cell.r * CELL + CELL / 2 + (Math.random() - 0.5) * 1.5
      const yOff = floorYOffsets[fl.idx]

      // Bottle mesh (small cylinder)
      const bottleGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.4, 8)
      const bottle = new THREE.Mesh(bottleGeo, almondWaterMat)
      bottle.position.set(wx, yOff + 0.35, wz)

      // Glow sphere around it
      const glowGeo = new THREE.SphereGeometry(0.5, 8, 8)
      const glow = new THREE.Mesh(glowGeo, almondWaterGlowMat)
      glow.position.set(wx, yOff + 0.35, wz)

      // Small point light
      const light = new THREE.PointLight(0xFFD040, 0.5, 4)
      light.position.set(wx, yOff + 0.5, wz)

      const group = new THREE.Group()
      group.add(bottle)
      group.add(glow)
      group.add(light)
      levelGroups[fl.idx].add(group)

      almondWaterPickups.push({ group, floor: fl.idx, collected: false, x: wx, z: wz, baseY: yOff + 0.35 })
    }
  }
}

function resetAlmondWater() {
  // Remove all existing pickup meshes
  for (const pickup of almondWaterPickups) {
    const parent = pickup.group.parent
    if (parent) parent.remove(pickup.group)
  }
  almondWaterPickups.length = 0
  spawnAlmondWater()
}

spawnAlmondWater()

// ── COLLISION ─────────────────────────────────────────────

function isWall(wx, wz) {
  const c = Math.floor(wx / CELL)
  const r = Math.floor(wz / CELL)
  if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return true
  return MAP[r][c] === 1
}

function canMove(wx, wz) {
  const R = 0.45
  if (isWall(wx-R, wz-R) || isWall(wx+R, wz-R) ||
      isWall(wx-R, wz+R) || isWall(wx+R, wz+R)) return false
  // Check prop colliders (floor 0 only — legacy function)
  for (let i = 0; i < propColliders.length; i++) {
    const p = propColliders[i]
    if (p.floor !== 0) continue
    const dx = wx - p.x, dz = wz - p.z
    if (dx*dx + dz*dz < (R + p.radius) * (R + p.radius)) return false
  }
  return true
}

// BFS pathfinding — navigates through doorways, never gets stuck in walls
function findPath(fromX, fromZ, toX, toZ) {
  const sc = Math.floor(fromX / CELL), sr = Math.floor(fromZ / CELL)
  const ec = Math.floor(toX  / CELL), er = Math.floor(toZ  / CELL)
  if (sr === er && sc === ec) return null

  const size    = ROWS * COLS
  const visited = new Uint8Array(size)
  const parentR = new Int16Array(size).fill(-1)
  const parentC = new Int16Array(size).fill(-1)
  const queue   = new Int16Array(size * 2)
  let head = 0, tail = 0

  visited[sr * COLS + sc] = 1
  queue[tail++] = sr; queue[tail++] = sc

  const DR = [-1, 1, 0, 0]
  const DC = [ 0, 0,-1, 1]
  let found = false

  outer: while (head < tail) {
    const r = queue[head++], c = queue[head++]
    for (let i = 0; i < 4; i++) {
      const nr = r + DR[i], nc = c + DC[i]
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue
      if (MAP[nr][nc] === 1) continue
      const idx = nr * COLS + nc
      if (visited[idx]) continue
      visited[idx] = 1
      parentR[idx] = r; parentC[idx] = c
      if (nr === er && nc === ec) { found = true; break outer }
      queue[tail++] = nr; queue[tail++] = nc
    }
  }

  if (!found) return null

  // Reconstruct path from target back to source, then reverse
  const path = []
  let r = er, c = ec
  while (!(r === sr && c === sc)) {
    path.push([r, c])
    const idx = r * COLS + c
    const pr = parentR[idx]; if (pr === -1) return null
    c = parentC[idx]; r = pr
  }
  path.push([sr, sc])
  path.reverse()
  return path
}


// ── INPUT ─────────────────────────────────────────────────

const keys = {}
document.addEventListener('keydown', e => {
  keys[e.code] = true
  if (e.code === 'Space') {
    e.preventDefault()
    const ss = document.getElementById('start-screen')
    if (ss && getComputedStyle(ss).display !== 'none') { dismissStartScreen(); return }
    if (paused && gameState === 'playing') { enterGame() }
  }
  if (e.code === 'Escape' && gameState === 'playing' && !paused) {
    pauseGame()
  }
})
document.addEventListener('keyup', e => { keys[e.code] = false })

// ── TOUCH ─────────────────────────────────────────────────

const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0
// Set post-processing based on device capability
postEffectsEnabled = !(isTouch || (navigator.hardwareConcurrency && navigator.hardwareConcurrency < 4))
// Override with saved preference if it exists
if (_savedPostFx !== null) postEffectsEnabled = _savedPostFx === 'true'
const clickHint      = document.getElementById('click-hint')
const crosshair      = document.getElementById('crosshair')
const mobileControls = document.getElementById('mobile-controls')

const mobilePauseBtn = document.getElementById('mobile-pause')

// ── Start screen ──────────────────────────────────────────
const startScreen = document.getElementById('start-screen')
const lb = document.getElementById('leaderboard')
const lbToggle = document.getElementById('lb-toggle')

function dismissStartScreen() {
  // Request fullscreen on mobile before landscape lock
  if (isTouch && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {})
  }
  initAudioContext()
  startScreen.style.display = 'none'
  enterGame()
}
startScreen.addEventListener('click', e => {
  if (e.target.closest('#leaderboard') || e.target.closest('#lb-toggle')) return
  dismissStartScreen()
})
startScreen.addEventListener('touchend', e => {
  if (e.target.closest('#leaderboard') || e.target.closest('#lb-toggle')) return
  e.preventDefault(); dismissStartScreen()
})

// Toggle button (mobile)
lbToggle.addEventListener('click', e => {
  e.stopPropagation()
  lb.classList.toggle('visible')
})

// ── Score submission ──────────────────────────────────────
const deathNameInput = document.getElementById('death-name')
const submitBtn = document.getElementById('submit-score')
const scoreStatus = document.getElementById('score-status')

// Pre-fill from last used name
deathNameInput.value = localStorage.getItem('yerooms_name') || ''

submitBtn.addEventListener('click', async () => {
  const name = sanitizeName(deathNameInput.value)
  localStorage.setItem('yerooms_name', name)
  submitBtn.disabled = true
  scoreStatus.textContent = 'SUBMITTING...'
  const ok = await submitScore(name, lastSurvivedTime)
  scoreStatus.textContent = ok ? 'SUBMITTED' : 'FAILED — TRY AGAIN'
  if (!ok) submitBtn.disabled = false
  if (ok) renderLeaderboard()
})

if (isTouch) {
  document.getElementById('start-hint').textContent = 'TAP ANYWHERE TO ENTER'
  document.getElementById('hint-action').textContent = 'TAP TO PLAY'
  document.getElementById('hint-sub').textContent = 'JOYSTICK MOVE  ·  SWIPE LOOK'
  mobileControls.style.display = 'flex'
} else {
  mobileControls.style.display = 'none'
}

let paused = true  // always start paused — tap or Space to enter

// Silently unlock the iOS audio context using the current user gesture.
// Mute before play so there is zero audible output, unmute after pause.
function unlockAudio() {
  if (!isTouch) return
  music.muted = true
  music.play()
    .then(() => { music.pause(); music.currentTime = 0; music.muted = false })
    .catch(() => { music.muted = false })
}

function startAmbience() {
  if (ambienceStarted || !audioCtx) return
  ambienceStarted = true
  // Fluorescent hum — bandpass filtered noise at 120Hz
  const bufSize = audioCtx.sampleRate * 2
  const buf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1
  ambienceHumSource = audioCtx.createBufferSource()
  ambienceHumSource.buffer = buf
  ambienceHumSource.loop = true
  const bp = audioCtx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 120
  bp.Q.value = 5
  ambienceHumGain = audioCtx.createGain()
  ambienceHumGain.gain.value = 0.03
  ambienceHumSource.connect(bp)
  bp.connect(ambienceHumGain)
  ambienceHumGain.connect(masterGainNode || audioCtx.destination)
  ambienceHumSource.start()

  // SURVIVE text fade
  const surviveEl = document.getElementById('survive-text')
  surviveEl.style.opacity = '1'
  setTimeout(() => { surviveEl.style.opacity = '0' }, 4000)

  // Schedule 1-2 distant events within first 30 seconds
  const eventDelay1 = 8000 + Math.random() * 12000
  setTimeout(() => {
    if (!audioCtx || audioCtx.state !== 'running') return
    // Bang — noise burst
    const bBuf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.12, audioCtx.sampleRate)
    const bData = bBuf.getChannelData(0)
    for (let i = 0; i < bData.length; i++) bData[i] = Math.random() * 2 - 1
    const bSrc = audioCtx.createBufferSource()
    bSrc.buffer = bBuf
    const bFilter = audioCtx.createBiquadFilter()
    bFilter.type = 'lowpass'
    bFilter.frequency.value = 300
    const bGain = audioCtx.createGain()
    bGain.gain.setValueAtTime(0.15, audioCtx.currentTime)
    bGain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12)
    bSrc.connect(bFilter)
    bFilter.connect(bGain)
    bGain.connect(masterGainNode || audioCtx.destination)
    bSrc.start()
    bSrc.stop(audioCtx.currentTime + 0.12)
  }, eventDelay1)

  const eventDelay2 = 18000 + Math.random() * 10000
  setTimeout(() => {
    if (!audioCtx || audioCtx.state !== 'running') return
    // Second bang (slightly different character)
    const bBuf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.08, audioCtx.sampleRate)
    const bData = bBuf.getChannelData(0)
    for (let i = 0; i < bData.length; i++) bData[i] = Math.random() * 2 - 1
    const bSrc = audioCtx.createBufferSource()
    bSrc.buffer = bBuf
    const bFilter = audioCtx.createBiquadFilter()
    bFilter.type = 'bandpass'
    bFilter.frequency.value = 180
    bFilter.Q.value = 2
    const bGain = audioCtx.createGain()
    bGain.gain.setValueAtTime(0.12, audioCtx.currentTime)
    bGain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08)
    bSrc.connect(bFilter)
    bFilter.connect(bGain)
    bGain.connect(masterGainNode || audioCtx.destination)
    bSrc.start()
    bSrc.stop(audioCtx.currentTime + 0.08)
  }, eventDelay2)
}

function playTrapRumble() {
  if (!audioCtx || audioCtx.state !== 'running') return
  const bufSize = audioCtx.sampleRate * 1.0
  const buf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1
  const src = audioCtx.createBufferSource()
  src.buffer = buf
  const lp = audioCtx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 60
  lp.Q.value = 1
  const gain = audioCtx.createGain()
  gain.gain.setValueAtTime(0.3, audioCtx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 1.0)
  src.connect(lp)
  lp.connect(gain)
  gain.connect(masterGainNode || audioCtx.destination)
  src.start()
  src.stop(audioCtx.currentTime + 1.0)
}

function enterGame() {
  paused = false
  if (gameTime === 0) {
    // First entry — snap from cinematic to spawn
    currentFloor = 0
    camera.position.set(START_X, EYE_H + floorYOffsets[0], START_Z)
    yawAngle   = Math.PI
    pitchAngle = 0
    unlockAudio()
    startAmbience()
  }
  clickHint.style.display = 'none'
  const pauseMenu = document.getElementById('pause-menu')
  if (pauseMenu) pauseMenu.style.display = 'none'
  crosshair.style.display = isTouch ? 'none' : 'block'
  if (mobilePauseBtn) mobilePauseBtn.style.display = isTouch ? 'flex' : 'none'
  lb.classList.remove('visible', 'on-death')
  if (!isTouch) renderer.domElement.requestPointerLock().catch(() => {})
}

function pauseGame() {
  paused = true
  clickHint.style.display = 'flex'
  const pauseMenu = document.getElementById('pause-menu')
  if (pauseMenu) pauseMenu.style.display = 'flex'
  crosshair.style.display = 'none'
  if (mobilePauseBtn) mobilePauseBtn.style.display = 'none'
  music.pause()
  if (document.pointerLockElement) document.exitPointerLock()
}

// ── Pointer Lock mouse look (desktop only) ──────────────
if (!isTouch) {
  renderer.domElement.addEventListener('click', () => {
    if (gameState === 'playing' && !paused) return  // already locked or will lock
    if (gameState === 'playing' && paused) {
      enterGame()
      renderer.domElement.requestPointerLock()
      return
    }
  })

  renderer.domElement.addEventListener('mousedown', () => {
    if (gameState === 'playing' && !paused && !document.pointerLockElement) {
      renderer.domElement.requestPointerLock()
    }
  })

  document.addEventListener('mousemove', e => {
    if (!document.pointerLockElement) return
    if (paused || gameState !== 'playing') return
    yawAngle   -= e.movementX * MOUSE_SENS
    pitchAngle -= e.movementY * MOUSE_SENS * (invertY ? -1 : 1)
    pitchAngle  = Math.max(-1.2, Math.min(1.2, pitchAngle))
  })

  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement && gameState === 'playing' && !paused) {
      pauseGame()
    }
  })
}

const lookTouches = {}
// Retry music on ANY touch — covers D-pad, look swipes, everywhere
// (canvas touchstart alone misses D-pad button taps)
document.addEventListener('touchstart', () => {
  if (musicPlayPending && enemyTracked) {
    music.play().catch(() => {})
    musicPlayPending = false
  }
}, { passive: true, capture: true })

renderer.domElement.addEventListener('touchstart', e => {
  e.preventDefault()
  if (gameState === 'playing' && paused) { enterGame(); return }
  for (const t of e.changedTouches)
    if (t.clientX > window.innerWidth * 0.4)
      lookTouches[t.identifier] = { x: t.clientX, y: t.clientY }
}, { passive: false })
renderer.domElement.addEventListener('touchmove', e => {
  e.preventDefault()
  for (const t of e.changedTouches) {
    const p = lookTouches[t.identifier]; if (!p) continue
    yawAngle   -= (t.clientX - p.x) * LOOK_TOUCH
    pitchAngle -= (t.clientY - p.y) * LOOK_TOUCH * (invertY ? -1 : 1)
    pitchAngle  = Math.max(-1.2, Math.min(1.2, pitchAngle))
    lookTouches[t.identifier] = { x: t.clientX, y: t.clientY }
  }
}, { passive: false })
renderer.domElement.addEventListener('touchend', e => {
  for (const t of e.changedTouches) delete lookTouches[t.identifier]
})

if (mobilePauseBtn) {
  mobilePauseBtn.addEventListener('touchstart', e => {
    e.preventDefault()
    e.stopPropagation()
    if (!paused) pauseGame()
  }, { passive: false })
}

// ── PAUSE MENU CONTROLS ────────────────────────────────────
;(function initPauseMenu() {
  const pmResume = document.getElementById('pm-resume')
  const pmRestart = document.getElementById('pm-restart')
  const pmVolume = document.getElementById('pm-volume')
  const pmVolumeVal = document.getElementById('pm-volume-val')
  const pmSens = document.getElementById('pm-sens')
  const pmSensVal = document.getElementById('pm-sens-val')
  const pmInvertY = document.getElementById('pm-inverty')
  const pmPostFx = document.getElementById('pm-postfx')
  if (!pmResume) return

  // Initialize UI from current settings
  pmVolume.value = Math.round(masterVolume * 100)
  pmVolumeVal.textContent = pmVolume.value + '%'
  // Sensitivity slider: 0.001-0.005 mapped to 0-100
  const sensPercent = Math.round(((MOUSE_SENS - 0.001) / 0.004) * 100)
  pmSens.value = Math.max(0, Math.min(100, sensPercent))
  pmSensVal.textContent = pmSens.value + '%'
  pmInvertY.checked = invertY
  pmPostFx.checked = postEffectsEnabled

  pmResume.addEventListener('click', () => { if (paused && gameState === 'playing') enterGame() })
  pmResume.addEventListener('touchstart', e => { e.preventDefault(); if (paused && gameState === 'playing') enterGame() }, { passive: false })

  pmRestart.addEventListener('click', () => { restartGame() })
  pmRestart.addEventListener('touchstart', e => { e.preventDefault(); restartGame() }, { passive: false })

  pmVolume.addEventListener('input', () => {
    masterVolume = parseInt(pmVolume.value) / 100
    pmVolumeVal.textContent = pmVolume.value + '%'
    localStorage.setItem('yerooms_volume', String(masterVolume))
    if (masterGainNode) masterGainNode.gain.value = masterVolume
    music.volume = 0.08 * masterVolume
  })

  pmSens.addEventListener('input', () => {
    MOUSE_SENS = 0.001 + (parseInt(pmSens.value) / 100) * 0.004
    pmSensVal.textContent = pmSens.value + '%'
    localStorage.setItem('yerooms_sensitivity', String(MOUSE_SENS))
  })

  pmInvertY.addEventListener('change', () => {
    invertY = pmInvertY.checked
    localStorage.setItem('yerooms_invertY', String(invertY))
  })

  pmPostFx.addEventListener('change', () => {
    postEffectsEnabled = pmPostFx.checked
    localStorage.setItem('yerooms_postEffects', String(postEffectsEnabled))
  })
})()

// ── VIRTUAL JOYSTICK (mobile) ──────────────────────────────
if (isTouch) {
  const joystickZone = document.getElementById('joystick-zone')
  const joystickKnob = document.getElementById('joystick-knob')
  let joystickTouchId = null
  let joystickCenterX = 0
  let joystickCenterY = 0
  const JOYSTICK_RADIUS = 45  // max drag distance from center

  if (joystickZone) {
    joystickZone.addEventListener('touchstart', e => {
      e.preventDefault()
      const touch = e.changedTouches[0]
      joystickTouchId = touch.identifier
      const rect = joystickZone.getBoundingClientRect()
      joystickCenterX = rect.left + rect.width / 2
      joystickCenterY = rect.top + rect.height / 2
    }, { passive: false })

    joystickZone.addEventListener('touchmove', e => {
      e.preventDefault()
      for (const t of e.changedTouches) {
        if (t.identifier !== joystickTouchId) continue
        let dx = t.clientX - joystickCenterX
        let dy = t.clientY - joystickCenterY
        const dist = Math.hypot(dx, dy)
        if (dist > JOYSTICK_RADIUS) {
          dx = (dx / dist) * JOYSTICK_RADIUS
          dy = (dy / dist) * JOYSTICK_RADIUS
        }
        // Move knob visually
        joystickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`
        // Map to movement keys
        const nx = dx / JOYSTICK_RADIUS  // -1 to 1
        const ny = dy / JOYSTICK_RADIUS  // -1 to 1
        const deadzone = 0.2
        keys['KeyW'] = ny < -deadzone
        keys['KeyS'] = ny > deadzone
        keys['KeyA'] = nx < -deadzone
        keys['KeyD'] = nx > deadzone
      }
    }, { passive: false })

    const releaseJoystick = e => {
      for (const t of e.changedTouches) {
        if (t.identifier !== joystickTouchId) continue
        joystickTouchId = null
        joystickKnob.style.transform = 'translate(-50%, -50%)'
        keys['KeyW'] = false
        keys['KeyS'] = false
        keys['KeyA'] = false
        keys['KeyD'] = false
      }
    }
    joystickZone.addEventListener('touchend', releaseJoystick, { passive: false })
    joystickZone.addEventListener('touchcancel', releaseJoystick, { passive: false })
  }

  // Sprint button (kept from original)
  const sprintBtn = document.getElementById('dp-sprint')
  if (sprintBtn) {
    sprintBtn.addEventListener('touchstart', e => { e.preventDefault(); keys['ShiftLeft'] = true }, { passive: false })
    sprintBtn.addEventListener('touchend', e => { e.preventDefault(); keys['ShiftLeft'] = false }, { passive: false })
    sprintBtn.addEventListener('touchcancel', () => { keys['ShiftLeft'] = false })
  }
}

// ── GAME LOOP ─────────────────────────────────────────────

// Music triggers on enemy FOV+LOS — see Entity.canSeePlayer()

let last = performance.now()
let gameTime = 0
let lastSurvivedTime = 0
let enemyTracked = false
let losGraceTimer = 0       // how long since LOS was last held
const LOS_GRACE   = 0.5    // seconds of sustained no-LOS before music stops
const clockEl = document.getElementById('clock')

function fmtTime(s) {
  const m = 0 | (s / 60)
  const sec = 0 | (s % 60)
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
}

// 5c: Render helper — applies post-processing if enabled
function renderScene() {
  if (postEffectsEnabled) {
    renderer.setRenderTarget(postRT)
    renderer.render(scene, camera)
    renderer.setRenderTarget(null)
    postMaterial.uniforms.tDiffuse.value = postRT.texture
    postMaterial.uniforms.uTime.value = performance.now() * 0.001
    renderer.render(postScene, postCamera)
  } else {
    renderer.render(scene, camera)
  }
}

function loop() {
  requestAnimationFrame(loop)
  const now = performance.now()
  const dt  = Math.min((now - last) / 1000, 0.05)
  last = now

  if (paused) { renderScene(); return }

  if (gameState === 'jumpscare') {
    // Camera shake during jumpscare
    if (jumpscareShakeTimer > 0) {
      jumpscareShakeTimer -= dt
      camera.rotation.z = (Math.random() - 0.5) * 0.12
    }
    renderScene(); return
  }

  if (gameState === 'dying') {
    deathTimer += dt
    const t = Math.min(deathTimer / 2.8, 1)
    camera.position.y = EYE_H + floorYOffsets[currentFloor] - t * 5
    document.getElementById('death-vignette').style.opacity = t
    if (deathTimer >= 3.0) {
      gameState = 'dead'
      document.getElementById('death-overlay').style.display = 'flex'
      // Reset score submit state
      document.getElementById('submit-score').disabled = false
      document.getElementById('score-status').textContent = ''
      // Show leaderboard
      lb.classList.add('on-death', 'visible')
      renderLeaderboard()
    }
    renderScene(); return
  }
  if (gameState === 'dead') { renderScene(); return }

  if (keys['ArrowLeft'])  yawAngle += TURN_SPEED * dt
  if (keys['ArrowRight']) yawAngle -= TURN_SPEED * dt

  camera.rotation.y = yawAngle
  camera.rotation.x = pitchAngle

  const fwd   = new THREE.Vector3(-Math.sin(yawAngle), 0, -Math.cos(yawAngle))
  const right = new THREE.Vector3( Math.cos(yawAngle), 0, -Math.sin(yawAngle))
  let dx = 0, dz = 0

  if (keys['KeyW']    || keys['ArrowUp'])   { dx += fwd.x;   dz += fwd.z   }
  if (keys['KeyS']    || keys['ArrowDown']) { dx -= fwd.x;   dz -= fwd.z   }
  if (keys['KeyA'])                          { dx -= right.x; dz -= right.z }
  if (keys['KeyD'])                          { dx += right.x; dz += right.z }


  // ── Falling state ───────────────────────────────────────────
  if (isFalling) {
    fallTimer += dt
    const t = Math.min(fallTimer / FALL_DURATION, 1)
    camera.position.y = fallStartY + (fallTargetY - fallStartY) * t
    // Disorienting tilt during fall
    camera.rotation.z = Math.sin(t * Math.PI * 2) * 0.15 * (1 - t)
    // Show both floors during fall
    for (let i = 0; i < FLOOR_COUNT; i++) levelGroups[i].visible = (i === currentFloor || i === fallSourceFloor)
    // 5a: Lerp fog color between source and destination floor
    const srcColor = new THREE.Color(FLOOR_FOG[fallSourceFloor].color)
    const dstColor = new THREE.Color(FLOOR_FOG[currentFloor].color)
    srcColor.lerp(dstColor, t)
    scene.fog.color.copy(srcColor)
    scene.background.copy(srcColor)
    if (t >= 1) {
      isFalling = false
      camera.rotation.z = 0
      camera.position.y = EYE_H + floorYOffsets[currentFloor]
      setFloorFog(currentFloor)
      // 5e: Track levels visited
      levelsVisited.add(currentFloor)
    }
    renderScene(); return
  }

  // ── Sprint & Stamina ───────────────────────────────────────
  const wantSprint = (keys['ShiftLeft'] || keys['ShiftRight']) && (Math.abs(dx) > 0.001 || Math.abs(dz) > 0.001)
  isSprinting = wantSprint && stamina > 0
  if (isSprinting) {
    stamina = Math.max(0, stamina - STAMINA_DRAIN * dt)
  } else {
    stamina = Math.min(STAMINA_MAX, stamina + STAMINA_REGEN * dt)
  }
  const speedMult = isSprinting ? SPRINT_MULT : 1.0

  // Stamina bar UI
  const staminaBar = document.getElementById('stamina-bar')
  const staminaFill = document.getElementById('stamina-fill')
  if (stamina < STAMINA_MAX) {
    staminaBar.style.opacity = '1'
    staminaFill.style.width = (stamina / STAMINA_MAX * 100) + '%'
  } else {
    staminaBar.style.opacity = '0'
  }

  // FOV lerp for sprint
  const targetFov = isSprinting ? 82 : 75
  camera.fov += (targetFov - camera.fov) * Math.min(dt * 6, 1)
  camera.updateProjectionMatrix()

  // Breathing sound when stamina is empty
  if (audioCtx && audioCtx.state === 'running') {
    if (stamina <= 0) {
      if (!breathingOsc) {
        breathingOsc = audioCtx.createOscillator()
        breathingOsc.type = 'sine'
        breathingOsc.frequency.value = 2.5  // breathing rate
        breathingFilter = audioCtx.createBiquadFilter()
        breathingFilter.type = 'lowpass'
        breathingFilter.frequency.value = 400
        breathingGain = audioCtx.createGain()
        breathingGain.gain.value = 0
        breathingOsc.connect(breathingFilter)
        breathingFilter.connect(breathingGain)
        breathingGain.connect(masterGainNode || audioCtx.destination)
        breathingOsc.start()
      }
      breathingGain.gain.value = Math.min(breathingGain.gain.value + dt * 0.8, 0.12)
    } else if (breathingGain) {
      breathingGain.gain.value = Math.max(breathingGain.gain.value - dt * 0.5, 0)
      if (breathingGain.gain.value <= 0.001 && breathingOsc) {
        breathingOsc.stop()
        breathingOsc = null
        breathingGain = null
        breathingFilter = null
      }
    }
  }

  const len = Math.hypot(dx, dz)
  if (len > 0.001) {
    const step = MOVE_SPEED * speedMult * dt / len
    const nx   = camera.position.x + dx * step
    const nz   = camera.position.z + dz * step
    const prevX = camera.position.x
    const prevZ = camera.position.z
    if (canMoveOnFloor(currentFloor, nx, camera.position.z)) camera.position.x = nx
    if (canMoveOnFloor(currentFloor, camera.position.x, nz)) camera.position.z = nz
    // Safety: if we somehow ended up inside a wall cell, revert
    if (isWallOnFloor(currentFloor, camera.position.x, camera.position.z)) {
      camera.position.x = prevX
      camera.position.z = prevZ
    }
  }
  camera.position.y = EYE_H + floorYOffsets[currentFloor]

  // ── Level visibility ─────────────────────────────────────
  for (let i = 0; i < FLOOR_COUNT; i++) levelGroups[i].visible = (i === currentFloor)

  // ── Hole detection ──────────────────────────────────────────
  const pCol = Math.floor(camera.position.x / CELL)
  const pRow = Math.floor(camera.position.z / CELL)
  for (const hole of HOLES) {
    if (hole.floor === currentFloor && hole.r === pRow && hole.c === pCol) {
      const targetFloor = (currentFloor + 1) % FLOOR_COUNT
      fallStartY = camera.position.y
      fallTargetY = EYE_H + floorYOffsets[targetFloor]
      fallSourceFloor = currentFloor
      currentFloor = targetFloor
      isFalling = true
      fallTimer = 0
      flashScreen('rgba(0,0,0,0.6)')
      break
    }
  }

  // ── Portal detection ────────────────────────────────────────
  if (!isFalling) {
    for (const portal of PORTALS) {
      if (portal.floor !== currentFloor) continue
      const pdx = camera.position.x - portal.x
      const pdz = camera.position.z - portal.z
      if (pdx*pdx + pdz*pdz < 1.5*1.5) {
        // Teleport to random open cell on same floor
        const map = FLOOR_MAPS[currentFloor]
        const rows = FLOOR_ROWS[currentFloor]
        const cols = FLOOR_COLS[currentFloor]
        let attempts = 0
        while (attempts < 50) {
          const tr = Math.floor(Math.random() * rows)
          const tc = Math.floor(Math.random() * cols)
          if (map[tr][tc] === 0) {
            camera.position.x = tc * CELL + CELL/2
            camera.position.z = tr * CELL + CELL/2
            yawAngle = Math.random() * Math.PI * 2
            flashScreen('rgba(100,0,200,0.5)')
            break
          }
          attempts++
        }
        break
      }
    }
  }

  // Entity pursues across all floors
  entities.forEach(e => {
    e.update(dt, camera.position.x, camera.position.z, currentFloor)
    if (e.active) e.group.visible = (e.floor === currentFloor)
  })

  // ── Positional entity audio ────────────────────────────────
  if (audioCtx && audioCtx.state === 'running') {
    updateAudioListener()
    const enemy = entities[0]
    if (enemy.active && enemy.floor === currentFloor) {
      const eY = floorYOffsets[enemy.floor] + 1.2
      updatePannerPosition(enemy.x, eY, enemy.z)
      const edx = camera.position.x - enemy.x
      const edz = camera.position.z - enemy.z
      const eDist = Math.hypot(edx, edz)
      // Footstep thuds — rate scales with proximity, audible within 25 units
      if (eDist < 25) {
        footstepTimer -= dt
        if (footstepTimer <= 0) {
          const proxFactor = Math.max(0, 1 - eDist / 25)
          const vol = 0.15 + proxFactor * 0.6
          playFootstep(vol)
          // Interval: faster when closer (0.2s at point blank, 1.2s at max range)
          footstepTimer = 0.2 + (1 - proxFactor) * 1.0 + Math.random() * 0.15
        }
      } else {
        footstepTimer = 0
      }
      // Hunt drone — plays while entity is hunting (unseen, fast)
      if (enemy.hunting) {
        if (!huntNoiseSource) startHuntDrone()
        if (huntNoiseGain) {
          const proxFactor = Math.max(0, 1 - eDist / 25)
          const targetGain = proxFactor * 0.25
          huntNoiseGain.gain.value += (targetGain - huntNoiseGain.gain.value) * Math.min(dt * 4, 1)
        }
      } else {
        if (huntNoiseSource) stopHuntDrone()
      }
    } else {
      // Entity not on this floor or not active — silence spatial audio
      footstepTimer = 0
      if (huntNoiseSource) stopHuntDrone()
    }
  }

  // ── Trap rooms ─────────────────────────────────────────────────────────
  const playerRow = Math.floor(camera.position.z / CELL)
  const playerCol = Math.floor(camera.position.x / CELL)

  // Floor 0 trap
  // Telegraph panel flicker (always visible when player is on floor 0 and near trap)
  if (trapPanel0 && currentFloor === 0) {
    trapPanel0.visible = !trapActive  // visible until trap triggers
    if (!trapActive) trapPanel0.material.opacity = 0.3 + Math.sin(performance.now() * 0.008) * 0.3
  }
  if (!trapActive && currentFloor === 0 &&
      playerRow >= TRAP_R1 && playerRow <= TRAP_R2 &&
      playerCol >= TRAP_C1 && playerCol <= TRAP_C2) {
    trapActive = true
    MAP[TRAP_SEAL_R][TRAP_SEAL_C] = 1
    trapNorthWall.visible = true
    trapSouthWall.visible = true
    trapWestWall.visible  = true
    trapEastWall.visible  = true
    if (trapPanel0) trapPanel0.visible = false
    playTrapRumble()
  }
  if (trapActive && currentFloor === 0) {
    trapRate   = Math.min(trapRate + 0.05 * dt, 1.8)
    trapNorthZ += trapRate * dt
    trapSouthZ -= trapRate * dt
    trapWestX  += trapRate * dt
    trapEastX  -= trapRate * dt
    trapNorthWall.position.z = trapNorthZ
    trapSouthWall.position.z = trapSouthZ
    trapWestWall.position.x  = trapWestX
    trapEastWall.position.x  = trapEastX
    const margin = 0.55
    camera.position.z = Math.max(trapNorthZ + margin, Math.min(trapSouthZ - margin, camera.position.z))
    camera.position.x = Math.max(trapWestX  + margin, Math.min(trapEastX  - margin, camera.position.x))
    // Escape hatch — open when gap < 8 on either axis
    const gapX0 = trapEastX - trapWestX
    const gapZ0 = trapSouthZ - trapNorthZ
    if ((gapX0 < 8 || gapZ0 < 8) && !escapeHole0Open) {
      escapeHole0Open = true
      const roomCX = TRAP_C1 * CELL + (TRAP_C2 - TRAP_C1 + 1) * CELL / 2
      const roomCZ = TRAP_R1 * CELL + (TRAP_R2 - TRAP_R1 + 1) * CELL / 2
      escapeHole0Mesh = new THREE.Mesh(new THREE.CircleGeometry(CELL * 0.4, 12), holeDarkMat)
      escapeHole0Mesh.rotation.x = -Math.PI / 2
      escapeHole0Mesh.position.set(roomCX, 0.02, roomCZ)
      levelGroups[0].add(escapeHole0Mesh)
    }
    // Check if player steps on escape hole
    if (escapeHole0Open) {
      const roomCX = TRAP_C1 * CELL + (TRAP_C2 - TRAP_C1 + 1) * CELL / 2
      const roomCZ = TRAP_R1 * CELL + (TRAP_R2 - TRAP_R1 + 1) * CELL / 2
      const holeCol = Math.floor(roomCX / CELL)
      const holeRow = Math.floor(roomCZ / CELL)
      if (playerCol === holeCol && playerRow === holeRow) {
        const targetFloor = (currentFloor + 1) % FLOOR_COUNT
        fallStartY = camera.position.y
        fallTargetY = EYE_H + floorYOffsets[targetFloor]
        fallSourceFloor = currentFloor
        currentFloor = targetFloor
        isFalling = true
        fallTimer = 0
        flashScreen('rgba(0,0,0,0.6)')
      }
    }
    if (trapEastX - trapWestX < 3.0 || trapSouthZ - trapNorthZ < 3.0) {
      flashScreen('rgba(200,0,0,0.48)')
      startDeath()
    }
  }

  // Floor 1 trap (mall backroom)
  if (trapPanel1 && currentFloor === 1) {
    trapPanel1.visible = !trap1Active
    if (!trap1Active) trapPanel1.material.opacity = 0.3 + Math.sin(performance.now() * 0.009) * 0.3
  }
  if (!trap1Active && currentFloor === 1 &&
      playerRow >= T1_R1 && playerRow <= T1_R2 &&
      playerCol >= T1_C1 && playerCol <= T1_C2) {
    trap1Active = true
    MAP1[T1_SEAL_R][T1_SEAL_C] = 1
    trap1NorthWall.visible = true
    trap1SouthWall.visible = true
    trap1WestWall.visible  = true
    trap1EastWall.visible  = true
    if (trapPanel1) trapPanel1.visible = false
    playTrapRumble()
  }
  if (trap1Active && currentFloor === 1) {
    trap1Rate = Math.min(trap1Rate + 0.06 * dt, 2.0)
    trap1NorthZ += trap1Rate * dt
    trap1SouthZ -= trap1Rate * dt
    trap1WestX  += trap1Rate * dt
    trap1EastX  -= trap1Rate * dt
    trap1NorthWall.position.z = trap1NorthZ
    trap1SouthWall.position.z = trap1SouthZ
    trap1WestWall.position.x  = trap1WestX
    trap1EastWall.position.x  = trap1EastX
    const margin = 0.55
    camera.position.z = Math.max(trap1NorthZ + margin, Math.min(trap1SouthZ - margin, camera.position.z))
    camera.position.x = Math.max(trap1WestX  + margin, Math.min(trap1EastX  - margin, camera.position.x))
    // Escape hatch
    const gapX1 = trap1EastX - trap1WestX
    const gapZ1 = trap1SouthZ - trap1NorthZ
    if ((gapX1 < 8 || gapZ1 < 8) && !escapeHole1Open) {
      escapeHole1Open = true
      const roomCX = T1_C1 * CELL + (T1_C2 - T1_C1 + 1) * CELL / 2
      const roomCZ = T1_R1 * CELL + (T1_R2 - T1_R1 + 1) * CELL / 2
      escapeHole1Mesh = new THREE.Mesh(new THREE.CircleGeometry(CELL * 0.4, 12), holeDarkMat)
      escapeHole1Mesh.rotation.x = -Math.PI / 2
      escapeHole1Mesh.position.set(roomCX, floorYOffsets[1] + 0.02, roomCZ)
      levelGroups[1].add(escapeHole1Mesh)
    }
    if (escapeHole1Open) {
      const roomCX = T1_C1 * CELL + (T1_C2 - T1_C1 + 1) * CELL / 2
      const roomCZ = T1_R1 * CELL + (T1_R2 - T1_R1 + 1) * CELL / 2
      const holeCol = Math.floor(roomCX / CELL)
      const holeRow = Math.floor(roomCZ / CELL)
      if (playerCol === holeCol && playerRow === holeRow) {
        const targetFloor = (currentFloor + 1) % FLOOR_COUNT
        fallStartY = camera.position.y
        fallTargetY = EYE_H + floorYOffsets[targetFloor]
        fallSourceFloor = currentFloor
        currentFloor = targetFloor
        isFalling = true
        fallTimer = 0
        flashScreen('rgba(0,0,0,0.6)')
      }
    }
    if (trap1EastX - trap1WestX < 3.0 || trap1SouthZ - trap1NorthZ < 3.0) {
      flashScreen('rgba(200,0,0,0.48)')
      startDeath()
    }
  }

  // Floor 2 trap (poolroom NW chamber)
  if (trapPanel2 && currentFloor === 2) {
    trapPanel2.visible = !trap2Active
    if (!trap2Active) trapPanel2.material.opacity = 0.3 + Math.sin(performance.now() * 0.007) * 0.3
  }
  if (!trap2Active && currentFloor === 2 &&
      playerRow >= T2_R1 && playerRow <= T2_R2 &&
      playerCol >= T2_C1 && playerCol <= T2_C2) {
    trap2Active = true
    MAP2[T2_SEAL_R][T2_SEAL_C] = 1
    trap2NorthWall.visible = true
    trap2SouthWall.visible = true
    trap2WestWall.visible  = true
    trap2EastWall.visible  = true
    if (trapPanel2) trapPanel2.visible = false
    playTrapRumble()
  }
  if (trap2Active && currentFloor === 2) {
    trap2Rate = Math.min(trap2Rate + 0.04 * dt, 1.5)
    trap2NorthZ += trap2Rate * dt
    trap2SouthZ -= trap2Rate * dt
    trap2WestX  += trap2Rate * dt
    trap2EastX  -= trap2Rate * dt
    trap2NorthWall.position.z = trap2NorthZ
    trap2SouthWall.position.z = trap2SouthZ
    trap2WestWall.position.x  = trap2WestX
    trap2EastWall.position.x  = trap2EastX
    const margin = 0.55
    camera.position.z = Math.max(trap2NorthZ + margin, Math.min(trap2SouthZ - margin, camera.position.z))
    camera.position.x = Math.max(trap2WestX  + margin, Math.min(trap2EastX  - margin, camera.position.x))
    // Escape hatch
    const gapX2 = trap2EastX - trap2WestX
    const gapZ2 = trap2SouthZ - trap2NorthZ
    if ((gapX2 < 8 || gapZ2 < 8) && !escapeHole2Open) {
      escapeHole2Open = true
      const roomCX = T2_C1 * CELL + (T2_C2 - T2_C1 + 1) * CELL / 2
      const roomCZ = T2_R1 * CELL + (T2_R2 - T2_R1 + 1) * CELL / 2
      escapeHole2Mesh = new THREE.Mesh(new THREE.CircleGeometry(CELL * 0.4, 12), holeDarkMat)
      escapeHole2Mesh.rotation.x = -Math.PI / 2
      escapeHole2Mesh.position.set(roomCX, floorYOffsets[2] + 0.02, roomCZ)
      levelGroups[2].add(escapeHole2Mesh)
    }
    if (escapeHole2Open) {
      const roomCX = T2_C1 * CELL + (T2_C2 - T2_C1 + 1) * CELL / 2
      const roomCZ = T2_R1 * CELL + (T2_R2 - T2_R1 + 1) * CELL / 2
      const holeCol = Math.floor(roomCX / CELL)
      const holeRow = Math.floor(roomCZ / CELL)
      if (playerCol === holeCol && playerRow === holeRow) {
        const targetFloor = (currentFloor + 1) % FLOOR_COUNT
        fallStartY = camera.position.y
        fallTargetY = EYE_H + floorYOffsets[targetFloor]
        fallSourceFloor = currentFloor
        currentFloor = targetFloor
        isFalling = true
        fallTimer = 0
        flashScreen('rgba(0,0,0,0.6)')
      }
    }
    if (trap2EastX - trap2WestX < 3.0 || trap2SouthZ - trap2NorthZ < 3.0) {
      flashScreen('rgba(200,0,0,0.48)')
      startDeath()
    }
  }

  // Clock
  gameTime += dt
  clockEl.textContent = fmtTime(gameTime)

  // Music — plays when enemy has line-of-sight, volume scales with proximity
  const enemy = entities[0]
  if (enemy.active && enemy.floor === currentFloor) {
    const sees = enemy.canSeePlayer(camera.position.x, camera.position.z)
    enemy.hunting = !sees   // sprint while it can't see you
    if (sees) {
      losGraceTimer = 0
      if (!enemy.firstSighting) enemy.firstSighting = true
      if (!enemyTracked) {
        enemyTracked = true
        if (music.paused) music.play().catch(() => { musicPlayPending = true })
      }
      // Volume: soft at distance, present when close — range 0.08 to 0.6
      const edx = camera.position.x - enemy.x
      const edz = camera.position.z - enemy.z
      const eDist = Math.hypot(edx, edz)
      const targetVol = (0.08 + 0.52 * Math.max(0, 1 - eDist / 45)) * masterVolume
      music.volume += (targetVol - music.volume) * Math.min(dt * 2.5, 1)
    } else {
      losGraceTimer += dt
      if (enemyTracked && losGraceTimer >= LOS_GRACE) {
        enemyTracked = false
        enemy.speed = Math.min(enemy.speed + 0.4, 5.0)
        music.pause()
        music.currentTime = 0
        music.volume = 0.08 * masterVolume
        musicPlayPending = false
      }
    }
  } else if (enemy.active && enemy.floor !== currentFloor && enemyTracked) {
    // Enemy is on a different floor — cut music
    enemyTracked = false
    music.pause()
    music.currentTime = 0
    music.volume = 0.08 * masterVolume
    musicPlayPending = false
  }

  // ── 5b. Head bob & player footsteps ────────────────────────
  const isMoving = Math.abs(dx) > 0.001 || Math.abs(dz) > 0.001
  if (isMoving && gameState === 'playing') {
    const stepRate = isSprinting ? 4.0 : 3.0  // steps per second
    playerStepPhase += dt * stepRate * Math.PI * 2
    // Head bob — subtle vertical oscillation
    camera.position.y += Math.sin(playerStepPhase) * 0.04
  }

  // ── 5d. Almond water pickup check & bob animation ──────────
  for (const pickup of almondWaterPickups) {
    if (pickup.collected) continue
    // Bob animation — move entire group vertically
    const bobOffset = Math.sin(performance.now() * 0.003) * 0.1
    pickup.group.position.y = bobOffset
    // Proximity check
    if (pickup.floor === currentFloor) {
      const pdx = camera.position.x - pickup.x
      const pdz = camera.position.z - pickup.z
      if (pdx * pdx + pdz * pdz < 1.5 * 1.5) {
        pickup.collected = true
        pickup.group.visible = false
        // Refill stamina
        stamina = STAMINA_MAX
        // Grant shield
        hasShield = true
        document.getElementById('shield-icon').style.display = 'block'
        // Pickup sound
        if (audioCtx && audioCtx.state === 'running') {
          const osc = audioCtx.createOscillator()
          osc.type = 'sine'
          osc.frequency.setValueAtTime(500, audioCtx.currentTime)
          osc.frequency.linearRampToValueAtTime(800, audioCtx.currentTime + 0.12)
          const g = audioCtx.createGain()
          g.gain.setValueAtTime(0.15, audioCtx.currentTime)
          g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2)
          osc.connect(g)
          g.connect(masterGainNode || audioCtx.destination)
          osc.start()
          osc.stop(audioCtx.currentTime + 0.2)
        }
        flashScreen('rgba(255,210,40,0.3)')
      }
    }
  }

  // ── 5d. Invulnerability timer ──────────────────────────────
  if (invulnTimer > 0) {
    invulnTimer -= dt
  }

  // ── 5e. Score juice — every 30 seconds ────────────────────
  scoreJuiceTimer += dt
  const milestone = Math.floor(gameTime / 30)
  if (milestone > lastScoreJuiceMilestone && gameTime > 1) {
    lastScoreJuiceMilestone = milestone
    playScoreJuiceSting()
    // Pulse the clock element
    clockEl.style.transition = 'color 0.15s, text-shadow 0.15s'
    clockEl.style.color = 'rgba(255,240,160,0.95)'
    clockEl.style.textShadow = '0 0 12px rgba(255,220,60,0.7)'
    setTimeout(() => {
      clockEl.style.color = 'rgba(190,160,30,0.55)'
      clockEl.style.textShadow = 'none'
    }, 400)
  }

  // ── 5e. Track closest unseen distance ─────────────────────
  if (enemy.active && enemy.floor === currentFloor && enemy.hunting) {
    const edx2 = camera.position.x - enemy.x
    const edz2 = camera.position.z - enemy.z
    const eDist2 = Math.hypot(edx2, edz2)
    if (eDist2 < closestUnseen) closestUnseen = eDist2
  }

  // ── 5c. Post-processing flicker ───────────────────────────
  if (postEffectsEnabled) {
    postFlickerTimer -= dt
    if (postFlickerTimer <= 0) {
      postMaterial.uniforms.uFlicker.value = 0.85 + Math.random() * 0.1
      postFlickerTimer = 3 + Math.random() * 5
      // Reset flicker next frame
      setTimeout(() => { postMaterial.uniforms.uFlicker.value = 1.0 }, 16)
    }
  }

  // Update player light
  playerLight.position.set(camera.position.x, camera.position.y, camera.position.z)
  const plCfg = FLOOR_PLAYER_LIGHT[currentFloor]
  playerLight.color.setHex(plCfg.color)
  playerLight.intensity = plCfg.intensity
  playerLight.distance = plCfg.distance

  renderScene()
}

// Initial floor visibility
for (let i = 0; i < FLOOR_COUNT; i++) levelGroups[i].visible = (i === currentFloor)
setFloorFog(currentFloor)

loop()
