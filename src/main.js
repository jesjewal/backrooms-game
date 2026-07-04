import * as THREE from 'three'

// ── SUPABASE LEADERBOARD ────────────────────────────────────
const SUPABASE_URL = 'https://ptclkghlduibzvnsedyj.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0Y2xrZ2hsZHVpYnp2bnNlZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxNzM4NzgsImV4cCI6MjA5ODc0OTg3OH0.m5JG63oKd4T66Y0AT9JMsG30nueNRbDzCZqxLZHmNA'

async function submitScore(name, timeSeconds) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/scores`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ name: name.toUpperCase(), time_seconds: timeSeconds })
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

async function renderLeaderboard() {
  const list = document.getElementById('lb-list')
  const empty = document.getElementById('lb-empty')
  const scores = await getLeaderboard()
  if (scores.length === 0) { empty.style.display = 'block'; list.innerHTML = ''; return }
  empty.style.display = 'none'
  list.innerHTML = scores.map((s, i) =>
    `<div class="lb-row"><span class="lb-rank">${i+1}.</span><span class="lb-name">${s.name}</span><span class="lb-time">${formatTime(s.time_seconds)}</span></div>`
  ).join('')
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
let musicPlayPending = false  // retry on next touch if browser blocked autoplay

// ── CONSTANTS ─────────────────────────────────────────────
const MAX_HEALTH   = 1
const CELL         = 4
const WALL_H       = 3.0
const EYE_H        = 1.65
const MOVE_SPEED   = 5
const TURN_SPEED   = 2.2
const LOOK_TOUCH   = 0.005
const FOV          = 90
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

const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth/window.innerHeight, 0.05, 80)
camera.rotation.order = 'YXZ'

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight)
  camera.aspect = window.innerWidth/window.innerHeight
  camera.updateProjectionMatrix()
})

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

const BASE_PT   = 2.5
const allLights = []

for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) {
    const wx = col*CELL + CELL/2
    const wz = row*CELL + CELL/2

    if (MAP[row][col] === 1) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(CELL, WALL_H, CELL), wallMat)
      m.position.set(wx, WALL_H/2, wz)
      scene.add(m)
    } else {
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(CELL, CELL), floorMat)
      floor.rotation.x = -Math.PI/2
      floor.position.set(wx, 0, wz)
      scene.add(floor)

      const ceil = new THREE.Mesh(new THREE.PlaneGeometry(CELL, CELL), ceilMat)
      ceil.rotation.x = Math.PI/2
      ceil.position.set(wx, WALL_H, wz)
      scene.add(ceil)

      // Panels every other cell — visual only, no shader uniforms
      if ((row + col) % 2 === 0) {
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.0), panelMat)
        panel.rotation.x = Math.PI / 2
        panel.position.set(wx, WALL_H - 0.015, wz)
        scene.add(panel)
      }
      // Actual lights sparse — every 4th cell to stay under uniform limits
      if (row % 4 === 2 && col % 4 === 2) {
        const pt = new THREE.PointLight(0xFFFDE8, BASE_PT, 22)
        pt.position.set(wx, WALL_H - 0.08, wz)
        scene.add(pt)
        allLights.push(pt)
      }
    }
  }
}

const ambientLight = new THREE.AmbientLight(0xD4B020, 1.4)
scene.add(ambientLight)

// ── PROPS — furniture embedded in walls/floors/ceilings ───
const propColliders = []  // { x, z, radius }
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
      propColliders.push({ x: prop.position.x, z: prop.position.z, radius: 0.6 })
    }
    scene.add(prop)
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
const FALL_DURATION = 0.7

// ── Floor 1 Map — Mall/Tile ─────────────────────────────
const F1_ROWS = 48, F1_COLS = 48
const MAP1 = (() => {
  const m = Array.from({ length: F1_ROWS }, () => new Array(F1_COLS).fill(1))
  const open = (r1, r2, c1, c2) => {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) m[r][c] = 0
  }
  // Main concourse (wider, full east-west)
  open(20, 28, 1, 46)
  // Secondary concourse (north-south through center)
  open(1, 46, 22, 26)
  // North wing stores
  open(2, 8, 2, 10)
  open(2, 8, 12, 20)
  open(2, 8, 28, 36)
  open(2, 8, 38, 46)
  open(10, 18, 2, 7)
  open(10, 18, 9, 14)
  open(10, 18, 16, 20)
  open(10, 18, 28, 33)
  open(10, 18, 35, 40)
  open(10, 18, 42, 46)
  // South wing stores
  open(30, 36, 2, 10)
  open(30, 36, 12, 20)
  open(30, 36, 28, 36)
  open(30, 36, 38, 46)
  open(38, 46, 2, 7)
  open(38, 46, 9, 14)
  open(38, 46, 16, 20)
  open(38, 46, 28, 33)
  open(38, 46, 35, 40)
  open(38, 46, 42, 46)
  // Cross corridors connecting stores to concourse
  open(8, 19, 8, 8)
  open(8, 19, 14, 14)
  open(8, 19, 20, 20)
  open(8, 19, 28, 28)
  open(8, 19, 34, 34)
  open(8, 19, 42, 42)
  open(29, 37, 8, 8)
  open(29, 37, 14, 14)
  open(29, 37, 20, 20)
  open(29, 37, 28, 28)
  open(29, 37, 34, 34)
  open(29, 37, 42, 42)
  // Food court (large open area NW)
  open(2, 8, 2, 20)
  // Anchor store (large SE)
  open(38, 46, 35, 46)
  // Service corridors (skinny, behind stores)
  open(9, 9, 2, 20)
  open(9, 9, 28, 46)
  open(37, 37, 2, 20)
  open(37, 37, 28, 46)
  open(19, 19, 1, 46)
  open(29, 29, 1, 46)
  // Restroom hallways (dead ends)
  open(1, 1, 2, 4)
  open(1, 1, 44, 46)
  open(46, 47, 2, 3)
  open(46, 47, 45, 46)
  // Escalator bays (open areas for escalator props)
  open(20, 28, 10, 12)   // west escalator bay
  open(20, 28, 36, 38)   // east escalator bay
  // Dead-end trap rooms (single exit)
  open(2, 4, 44, 46)     // NE corner
  open(44, 46, 2, 4)     // SW corner
  return m
})()

// ── Floor 2 Map — Poolrooms (labyrinthine with pool chambers) ──
const F2_ROWS = 48, F2_COLS = 48
const MAP2 = (() => {
  const m = Array.from({ length: F2_ROWS }, () => new Array(F2_COLS).fill(1))
  const open = (r1, r2, c1, c2) => {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) m[r][c] = 0
  }
  // Main spine corridors (narrow, 2-wide)
  open(1, 46, 23, 24)    // N-S spine
  open(23, 24, 1, 46)    // E-W spine
  // Secondary corridors branching off spine
  open(1, 46, 11, 12)    // N-S west
  open(1, 46, 35, 36)    // N-S east
  open(11, 12, 1, 46)    // E-W north
  open(35, 36, 1, 46)    // E-W south
  // Pool chambers (medium rooms connected by single-cell doorways)
  open(2, 9, 2, 9)       // NW pool room
  open(2, 9, 14, 21)     // N center-west pool
  open(2, 9, 26, 33)     // N center-east pool
  open(2, 9, 38, 45)     // NE pool room
  open(14, 21, 2, 9)     // W upper pool
  open(14, 21, 14, 21)   // Center-NW pool
  open(14, 21, 26, 33)   // Center-NE pool
  open(14, 21, 38, 45)   // E upper pool
  open(26, 33, 2, 9)     // W lower pool
  open(26, 33, 14, 21)   // Center-SW pool
  open(26, 33, 26, 33)   // Center-SE pool
  open(26, 33, 38, 45)   // E lower pool
  open(38, 45, 2, 9)     // SW pool room
  open(38, 45, 14, 21)   // S center-west pool
  open(38, 45, 26, 33)   // S center-east pool
  open(38, 45, 38, 45)   // SE pool room
  // Narrow connecting passages (1-wide, maze-like)
  open(10, 10, 4, 6)     // connects NW to W upper
  open(10, 10, 16, 18)   // connects N center-west down
  open(10, 10, 28, 30)   // connects N center-east down
  open(10, 10, 40, 42)   // connects NE down
  open(13, 13, 5, 5)     // single cell door NW→W upper
  open(13, 13, 17, 17)   // single cell door
  open(13, 13, 29, 29)
  open(13, 13, 41, 41)
  open(22, 22, 5, 5)     // doors into center pools
  open(22, 22, 17, 17)
  open(22, 22, 29, 29)
  open(22, 22, 41, 41)
  open(25, 25, 5, 5)
  open(25, 25, 17, 17)
  open(25, 25, 29, 29)
  open(25, 25, 41, 41)
  open(34, 34, 5, 5)
  open(34, 34, 17, 17)
  open(34, 34, 29, 29)
  open(34, 34, 41, 41)
  open(37, 37, 4, 6)
  open(37, 37, 16, 18)
  open(37, 37, 28, 30)
  open(37, 37, 40, 42)
  // Winding side passages
  open(5, 5, 10, 10)
  open(6, 9, 10, 10)
  open(5, 5, 37, 37)
  open(6, 9, 37, 37)
  open(42, 42, 10, 10)
  open(39, 42, 10, 10)
  open(42, 42, 37, 37)
  open(39, 42, 37, 37)
  // Dead-end alcoves (portal spots)
  open(1, 2, 1, 1)       // NW corner nook
  open(45, 46, 46, 46)   // SE corner nook
  open(45, 46, 1, 1)     // SW corner nook
  open(1, 2, 46, 46)     // NE corner nook
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
  ctx.strokeStyle = 'rgba(160,150,135,0.5)'
  ctx.lineWidth = 2
  for (let i = 0; i <= S; i += 64) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, S); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(S, i); ctx.stroke()
  }
  for (let i = 0; i < 5000; i++) {
    ctx.fillStyle = `rgba(80,70,60,${Math.random()*0.03})`
    ctx.fillRect(Math.random()*S, Math.random()*S, Math.random()*4+1, 1)
  }
  const t = new THREE.CanvasTexture(cv)
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(8, 8)
  return new THREE.MeshLambertMaterial({ map: t })
})()
const f1CeilMat = new THREE.MeshLambertMaterial({ color: 0xF4F0E8 })

const f1Y = floorYOffsets[1]
for (let row = 0; row < F1_ROWS; row++) {
  for (let col = 0; col < F1_COLS; col++) {
    const wx = col*CELL + CELL/2, wz = row*CELL + CELL/2
    if (MAP1[row][col] === 1) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(CELL, WALL_H, CELL), f1WallMat)
      m.position.set(wx, f1Y + WALL_H/2, wz)
      scene.add(m)
    } else {
      const fl = new THREE.Mesh(new THREE.PlaneGeometry(CELL, CELL), f1FloorMat)
      fl.rotation.x = -Math.PI/2; fl.position.set(wx, f1Y, wz); scene.add(fl)
      const cl = new THREE.Mesh(new THREE.PlaneGeometry(CELL, CELL), f1CeilMat)
      cl.rotation.x = Math.PI/2; cl.position.set(wx, f1Y + WALL_H, wz); scene.add(cl)
      if (row % 5 === 2 && col % 5 === 2) {
        const pt = new THREE.PointLight(0xF8F4FF, 2.0, 20)
        pt.position.set(wx, f1Y + WALL_H - 0.08, wz); scene.add(pt)
      }
    }
  }
}
scene.add(new THREE.AmbientLight(0xF0ECFF, 0.6))

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

  // West escalator bay (cols 10-12, rows 22-26)
  const esc1 = makeEscalator(11 * CELL + CELL/2, 23 * CELL + CELL/2)
  scene.add(esc1)
  propColliders.push({ x: 11*CELL+CELL/2, z: 23*CELL+CELL/2, radius: 1.2 })

  const esc2 = makeEscalator(11 * CELL + CELL/2, 26 * CELL + CELL/2)
  esc2.rotation.y = Math.PI  // facing opposite direction
  scene.add(esc2)
  propColliders.push({ x: 11*CELL+CELL/2, z: 26*CELL+CELL/2, radius: 1.2 })

  // East escalator bay (cols 36-38, rows 22-26)
  const esc3 = makeEscalator(37 * CELL + CELL/2, 23 * CELL + CELL/2)
  scene.add(esc3)
  propColliders.push({ x: 37*CELL+CELL/2, z: 23*CELL+CELL/2, radius: 1.2 })

  const esc4 = makeEscalator(37 * CELL + CELL/2, 26 * CELL + CELL/2)
  esc4.rotation.y = Math.PI
  scene.add(esc4)
  propColliders.push({ x: 37*CELL+CELL/2, z: 26*CELL+CELL/2, radius: 1.2 })

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

  // Center concourse fountain
  const fountain1 = makeFountain(24 * CELL + CELL/2, 24 * CELL + CELL/2)
  scene.add(fountain1)
  propColliders.push({ x: 24*CELL+CELL/2, z: 24*CELL+CELL/2, radius: 2.2 })

  // Food court fountain (smaller)
  const fountain2 = makeFountain(10 * CELL + CELL/2, 5 * CELL + CELL/2)
  scene.add(fountain2)
  propColliders.push({ x: 10*CELL+CELL/2, z: 5*CELL+CELL/2, radius: 2.2 })

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
    [4, 21], [8, 21], [14, 21], [18, 21], [30, 21], [34, 21], [40, 21], [44, 21],
    [4, 28], [8, 28], [14, 28], [18, 28], [30, 28], [34, 28], [40, 28], [44, 28],
  ]
  for (const [c, r] of benchPositions) {
    const bench = makeBench(c*CELL+CELL/2, r*CELL+CELL/2, r === 21 ? 0 : Math.PI)
    scene.add(bench)
    propColliders.push({ x: c*CELL+CELL/2, z: r*CELL+CELL/2, radius: 0.5 })
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
    [3, 20], [3, 28], [15, 20], [15, 28], [33, 20], [33, 28], [45, 20], [45, 28],
    [22, 3], [26, 3], [22, 45], [26, 45],
  ]
  for (const [c, r] of planterPositions) {
    scene.add(makePlanter(c*CELL+CELL/2, r*CELL+CELL/2))
    propColliders.push({ x: c*CELL+CELL/2, z: r*CELL+CELL/2, radius: 0.6 })
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
  scene.add(makeDirectory(22*CELL+CELL/2, 20*CELL+CELL/2, 0))
  propColliders.push({ x: 22*CELL+CELL/2, z: 20*CELL+CELL/2, radius: 0.4 })
  scene.add(makeDirectory(26*CELL+CELL/2, 28*CELL+CELL/2, Math.PI))
  propColliders.push({ x: 26*CELL+CELL/2, z: 28*CELL+CELL/2, radius: 0.4 })

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

  const trashPositions = [[6,21],[12,21],[20,21],[28,21],[36,21],[42,21],
                          [6,28],[12,28],[20,28],[28,28],[36,28],[42,28]]
  for (const [c,r] of trashPositions) {
    scene.add(makeTrashCan(c*CELL+CELL/2, r*CELL+CELL/2))
    propColliders.push({ x: c*CELL+CELL/2, z: r*CELL+CELL/2, radius: 0.35 })
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
      scene.add(makeFoodCourtTable(c*CELL+CELL/2, r*CELL+CELL/2))
      propColliders.push({ x: c*CELL+CELL/2, z: r*CELL+CELL/2, radius: 0.9 })
    }
  }

  // ── Ceiling skylights (glass panels in ceiling) ───────
  const skylightMat = new THREE.MeshBasicMaterial({ color: 0xCCDDFF, transparent: true, opacity: 0.3 })
  const skylightPositions = [[12,24],[18,24],[30,24],[36,24],[42,24]]
  for (const [c,r] of skylightPositions) {
    const skylight = new THREE.Mesh(new THREE.PlaneGeometry(CELL*2.5, CELL*2.5), skylightMat)
    skylight.rotation.x = Math.PI/2
    skylight.position.set(c*CELL+CELL/2, f1Y + WALL_H - 0.02, r*CELL+CELL/2)
    scene.add(skylight)
    // Brighter light under skylight
    const sLight = new THREE.PointLight(0xFFFFEE, 1.2, 15)
    sLight.position.set(c*CELL+CELL/2, f1Y + WALL_H - 0.3, r*CELL+CELL/2)
    scene.add(sLight)
  }

  // ── Upside-down elements (mall) ───────────────────────
  // Benches on ceiling
  const ceilBenchPositions = [[6,24],[16,24],[32,24],[38,24]]
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
    scene.add(g)
  }

  // Upside-down food court tables on ceiling
  const ceilTablePositions = [[5,4],[9,6],[14,4],[17,7]]
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
    scene.add(g)
  }

  // Upside-down escalator (going into the floor)
  const escDown = makeEscalator(24*CELL+CELL/2, 14*CELL+CELL/2)
  escDown.rotation.x = Math.PI
  escDown.position.y = f1Y + WALL_H + 1
  scene.add(escDown)

  // Inverted planter hanging from ceiling
  const ceilPlanterPositions = [[8,12],[20,35],[40,14],[34,40]]
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
    scene.add(g)
  }
})()

// ── Build Floor 2 Geometry ───────────���──────────────────
const f2WallMat = new THREE.MeshLambertMaterial({ color: 0xE8F4FA })
const f2FloorMat = (() => {
  const S = 512, cv = document.createElement('canvas')
  cv.width = cv.height = S
  const ctx = cv.getContext('2d')
  ctx.fillStyle = '#D8E8F0'
  ctx.fillRect(0, 0, S, S)
  // Tile grid
  ctx.strokeStyle = 'rgba(100,160,190,0.25)'
  ctx.lineWidth = 1
  for (let i = 0; i <= S; i += 32) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, S); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(S, i); ctx.stroke()
  }
  // Wet spots
  for (let i = 0; i < 30; i++) {
    ctx.fillStyle = `rgba(150,200,220,${Math.random()*0.08})`
    ctx.beginPath()
    ctx.arc(Math.random()*S, Math.random()*S, Math.random()*20+5, 0, Math.PI*2)
    ctx.fill()
  }
  const t = new THREE.CanvasTexture(cv)
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(8, 8)
  return new THREE.MeshLambertMaterial({ map: t })
})()
const f2CeilMat = new THREE.MeshLambertMaterial({ color: 0xF0F8FF })
const f2ColMat = new THREE.MeshLambertMaterial({ color: 0xC8D8E4 })

const f2Y = floorYOffsets[2]
for (let row = 0; row < F2_ROWS; row++) {
  for (let col = 0; col < F2_COLS; col++) {
    const wx = col*CELL + CELL/2, wz = row*CELL + CELL/2
    if (MAP2[row][col] === 1) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(CELL, WALL_H, CELL), f2WallMat)
      m.position.set(wx, f2Y + WALL_H/2, wz)
      scene.add(m)
    } else {
      const fl = new THREE.Mesh(new THREE.PlaneGeometry(CELL, CELL), f2FloorMat)
      fl.rotation.x = -Math.PI/2; fl.position.set(wx, f2Y, wz); scene.add(fl)
      const cl = new THREE.Mesh(new THREE.PlaneGeometry(CELL, CELL), f2CeilMat)
      cl.rotation.x = Math.PI/2; cl.position.set(wx, f2Y + WALL_H, wz); scene.add(cl)
      // Pillars in corridors
      if ((row === 11 || row === 12 || row === 23 || row === 24 || row === 35 || row === 36) && col % 4 === 2) {
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, WALL_H, 8), f2ColMat)
        pillar.position.set(wx, f2Y + WALL_H/2, wz)
        scene.add(pillar)
        propColliders.push({ x: wx, z: wz, radius: 0.3 })
      }
      if (row % 7 === 0 && col % 7 === 0) {
        const pt = new THREE.PointLight(0x99DDFF, 1.2, 18)
        pt.position.set(wx, f2Y + WALL_H - 0.08, wz); scene.add(pt)
      }
    }
  }
}
scene.add(new THREE.AmbientLight(0x88CCEE, 0.4))

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
    { r1: 2, r2: 9, c1: 2, c2: 9 },
    { r1: 2, r2: 9, c1: 14, c2: 21 },
    { r1: 2, r2: 9, c1: 26, c2: 33 },
    { r1: 2, r2: 9, c1: 38, c2: 45 },
    { r1: 14, r2: 21, c1: 2, c2: 9 },
    { r1: 14, r2: 21, c1: 14, c2: 21 },
    { r1: 14, r2: 21, c1: 26, c2: 33 },
    { r1: 14, r2: 21, c1: 38, c2: 45 },
    { r1: 26, r2: 33, c1: 2, c2: 9 },
    { r1: 26, r2: 33, c1: 14, c2: 21 },
    { r1: 26, r2: 33, c1: 26, c2: 33 },
    { r1: 26, r2: 33, c1: 38, c2: 45 },
    { r1: 38, r2: 45, c1: 2, c2: 9 },
    { r1: 38, r2: 45, c1: 14, c2: 21 },
    { r1: 38, r2: 45, c1: 26, c2: 33 },
    { r1: 38, r2: 45, c1: 38, c2: 45 },
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
    scene.add(basin)

    // Water surface
    const water = new THREE.Mesh(new THREE.PlaneGeometry(poolW - 0.1, poolD - 0.1), poolWaterMat)
    water.rotation.x = -Math.PI/2
    water.position.set(cx, f2Y - 0.05, cz)
    scene.add(water)

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
      scene.add(rim)
    }

    // Collider around pool edge (prevent walking into pool)
    propColliders.push({ x: cx, z: cz, radius: Math.max(poolW, poolD) * 0.45 })

    // Steps leading down on one side
    const stairSide = prng() < 0.5 ? -1 : 1
    const stepCount = 3
    for (let s = 0; s < stepCount; s++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(poolW * 0.4, 0.1, 0.35), stairMat)
      step.position.set(cx, f2Y - (s+1) * (poolDepth/stepCount) + 0.05, cz + stairSide * (poolD/2 - 0.3 - s*0.35))
      scene.add(step)
    }

    // Ladder on opposite side
    const ladderX = cx + (prng() - 0.5) * poolW * 0.5
    const ladderZ = cz - stairSide * (poolD/2 - 0.1)
    for (const lx of [-0.15, 0.15]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.2, 6), ladderMat)
      pole.position.set(ladderX + lx, f2Y + 0.3, ladderZ)
      scene.add(pole)
    }
    for (let rung = 0; rung < 4; rung++) {
      const r = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.3, 6), ladderMat)
      r.rotation.z = Math.PI/2
      r.position.set(ladderX, f2Y - 0.2 + rung * 0.3, ladderZ)
      scene.add(r)
    }

    // Every other room: ceiling pool (water on ceiling, dripping down)
    if (pi % 3 === 0) {
      const cPoolW = poolW * 0.7, cPoolD = poolD * 0.7
      const ceilWater = new THREE.Mesh(new THREE.PlaneGeometry(cPoolW, cPoolD), ceilPoolMat)
      ceilWater.rotation.x = Math.PI/2
      ceilWater.position.set(cx + (prng()-0.5)*2, f2Y + WALL_H - 0.02, cz + (prng()-0.5)*2)
      scene.add(ceilWater)
      // Ceiling pool rim
      const cRim = new THREE.Mesh(new THREE.BoxGeometry(cPoolW + 0.2, 0.08, cPoolD + 0.2), tileMat)
      cRim.position.set(cx, f2Y + WALL_H - 0.06, cz)
      scene.add(cRim)
      // Drip light (blue glow from ceiling water)
      const dripLight = new THREE.PointLight(0x44AACC, 0.8, 12)
      dripLight.position.set(cx, f2Y + WALL_H - 0.4, cz)
      scene.add(dripLight)
    }
  }

  // ── Corridor features ─────────────────────────────────
  // Drain grates in corridors
  const drainMat = new THREE.MeshLambertMaterial({ color: 0x333344 })
  const drainPositions = [
    [12, 5], [12, 15], [12, 30], [12, 40],
    [24, 5], [24, 15], [24, 30], [24, 40],
    [36, 5], [36, 15], [36, 30], [36, 40],
    [5, 12], [15, 12], [30, 12], [40, 12],
    [5, 24], [15, 24], [30, 24], [40, 24],
    [5, 36], [15, 36], [30, 36], [40, 36],
  ]
  for (const [c, r] of drainPositions) {
    const drain = new THREE.Mesh(new THREE.CircleGeometry(0.3, 8), drainMat)
    drain.rotation.x = -Math.PI/2
    drain.position.set(c*CELL+CELL/2, f2Y + 0.01, r*CELL+CELL/2)
    scene.add(drain)
  }

  // Wet floor signs (tilted yellow triangles)
  const wetSignMat = new THREE.MeshLambertMaterial({ color: 0xDDCC20 })
  const wetSignPositions = [[12,8],[24,17],[36,29],[11,40],[35,7]]
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
    scene.add(g)
  }

  // Lifeguard chairs (tall, disturbing in empty poolroom)
  const lgChairMat = new THREE.MeshLambertMaterial({ color: 0xF0F0F0 })
  const lgPositions = [[5,5],[17,29],[40,17],[29,41]]
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
    scene.add(g)
    propColliders.push({ x: c*CELL+CELL/2, z: r*CELL+CELL/2, radius: 0.4 })
  }

  // Pool noodles / floats scattered on floor (weird, out of place)
  const noodleMat = new THREE.MeshLambertMaterial({ color: 0xFF6644 })
  const noodle2Mat = new THREE.MeshLambertMaterial({ color: 0x44CC88 })
  const floatPositions = [[3,3],[7,16],[19,40],[30,7],[42,30],[15,42],[33,15],[44,44]]
  for (let i = 0; i < floatPositions.length; i++) {
    const [c,r] = floatPositions[i]
    const noodle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 1.5, 6),
      i % 2 === 0 ? noodleMat : noodle2Mat
    )
    noodle.rotation.z = Math.PI/2 + (prng()-0.5)*0.4
    noodle.rotation.y = prng() * Math.PI
    noodle.position.set(c*CELL+CELL/2, f2Y + 0.04, r*CELL+CELL/2)
    scene.add(noodle)
  }

  // Diving boards (sticking out of walls at weird angles)
  const boardMat = new THREE.MeshLambertMaterial({ color: 0xEEEEDD })
  const divingPositions = [[9,5,'e'],[21,30,'s'],[33,42,'w'],[45,17,'n']]
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
    scene.add(g)
  }

  // ── Upside-down elements (poolrooms) ──────────────────
  // Inverted lifeguard chairs on ceiling
  const ceilLgPositions = [[8,18],[30,5],[18,38],[42,42]]
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
    scene.add(g)
  }

  // Upside-down ladders hanging from ceiling
  const ceilLadderPositions = [[14,6],[28,20],[6,32],[40,38]]
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
    scene.add(g)
  }

  // Inverted pools on ceiling (water dripping "up") — in corridors
  const ceilCorridorPools = [[12,10],[24,28],[36,16],[12,38]]
  for (const [c,r] of ceilCorridorPools) {
    // Small rectangular ceiling pool
    const pw = 1.5 + prng()*1, pd = 1.5 + prng()*1
    const cWater = new THREE.Mesh(new THREE.PlaneGeometry(pw, pd), ceilPoolMat)
    cWater.rotation.x = Math.PI/2
    cWater.position.set(c*CELL+CELL/2, f2Y + WALL_H - 0.01, r*CELL+CELL/2)
    scene.add(cWater)
    // Rim
    const cRim = new THREE.Mesh(new THREE.BoxGeometry(pw+0.15, 0.06, pd+0.15), tileMat)
    cRim.position.set(c*CELL+CELL/2, f2Y + WALL_H - 0.04, r*CELL+CELL/2)
    scene.add(cRim)
  }

  // Upside-down diving boards on ceiling
  const ceilDivePositions = [[4,14],[20,40],[34,8],[44,28]]
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
    scene.add(g)
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
  { floor: 1, r: 24, c: 5 },    // concourse west
  { floor: 1, r: 24, c: 38 },   // concourse east
  { floor: 1, r: 35, c: 22 },   // south store
  // Floor 2 holes → LOOP back to floor 0
  { floor: 2, r: 12, c: 12 },   // NW pool
  { floor: 2, r: 35, c: 35 },   // SE pool
  { floor: 2, r: 12, c: 35 },   // NE pool
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
  scene.add(pit)
  // Rim glow
  const rimGeo = new THREE.RingGeometry(CELL * 0.35, CELL * 0.45, 12)
  const rim = new THREE.Mesh(rimGeo, new THREE.MeshBasicMaterial({ color: 0x222222 }))
  rim.rotation.x = -Math.PI/2
  rim.position.set(wx, yOff + 0.02, wz)
  scene.add(rim)
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
  { floor: 1, r: 2, c: 45, face: 'n' },    // NE trap room
  { floor: 1, r: 46, c: 3, face: 's' },    // SW trap room
  { floor: 2, r: 1, c: 45, face: 'n' },    // NE alcove
  { floor: 2, r: 46, c: 2, face: 's' },    // SW alcove
  { floor: 2, r: 46, c: 45, face: 's' },   // SE alcove
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
  scene.add(portal)
  // Rim (slightly larger)
  const rim = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.7, 16), portalRimMat)
  rim.position.copy(portal.position)
  rim.rotation.copy(portal.rotation)
  scene.add(rim)
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
  // Props only collide on floor 0 (where they're placed)
  if (floorIdx === 0) {
    for (let i = 0; i < propColliders.length; i++) {
      const p = propColliders[i]
      const dx = wx - p.x, dz = wz - p.z
      if (dx*dx + dz*dz < (R + p.radius) * (R + p.radius)) return false
    }
  }
  // Floor 2 columns
  if (floorIdx === 2) {
    for (let i = 0; i < propColliders.length; i++) {
      const p = propColliders[i]
      if (p.radius === 0.3) { // pillar colliders
        const dx = wx - p.x, dz = wz - p.z
        if (dx*dx + dz*dz < (R + p.radius) * (R + p.radius)) return false
      }
    }
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
  scene.add(trapNorthWall)

  // South wall — faces north (rotation.y = π)
  trapSouthWall = new THREE.Mesh(new THREE.PlaneGeometry(roomW, WALL_H), trapWallMat)
  trapSouthWall.rotation.y = Math.PI
  trapSouthWall.position.set(midX, WALL_H / 2, trapSouthZ)
  trapSouthWall.visible = false
  scene.add(trapSouthWall)

  // West wall — faces east (rotation.y = π/2)
  trapWestWall = new THREE.Mesh(new THREE.PlaneGeometry(roomD, WALL_H), trapWallMat)
  trapWestWall.rotation.y = Math.PI / 2
  trapWestWall.position.set(trapWestX, WALL_H / 2, midZ)
  trapWestWall.visible = false
  scene.add(trapWestWall)

  // East wall — faces west (rotation.y = -π/2)
  trapEastWall = new THREE.Mesh(new THREE.PlaneGeometry(roomD, WALL_H), trapWallMat)
  trapEastWall.rotation.y = -Math.PI / 2
  trapEastWall.position.set(trapEastX, WALL_H / 2, midZ)
  trapEastWall.visible = false
  scene.add(trapEastWall)
})()

// ── TRAP ROOM — Floor 1 (Mall backroom, SW dead-end) ─────
// Rows 44-46, cols 2-4 — single-cell exit at row 43, col 3
const T1_R1 = 44, T1_R2 = 46, T1_C1 = 2, T1_C2 = 4
const T1_SEAL_R = 43, T1_SEAL_C = 3

let trap1Active = false
let trap1Rate   = 0.35
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
  scene.add(trap1NorthWall)

  trap1SouthWall = new THREE.Mesh(new THREE.PlaneGeometry(roomW, WALL_H), trapWallMat)
  trap1SouthWall.rotation.y = Math.PI
  trap1SouthWall.position.set(midX, f1Y + WALL_H/2, trap1SouthZ)
  trap1SouthWall.visible = false
  scene.add(trap1SouthWall)

  trap1WestWall = new THREE.Mesh(new THREE.PlaneGeometry(roomD, WALL_H), trapWallMat)
  trap1WestWall.rotation.y = Math.PI / 2
  trap1WestWall.position.set(trap1WestX, f1Y + WALL_H/2, midZ)
  trap1WestWall.visible = false
  scene.add(trap1WestWall)

  trap1EastWall = new THREE.Mesh(new THREE.PlaneGeometry(roomD, WALL_H), trapWallMat)
  trap1EastWall.rotation.y = -Math.PI / 2
  trap1EastWall.position.set(trap1EastX, f1Y + WALL_H/2, midZ)
  trap1EastWall.visible = false
  scene.add(trap1EastWall)
})()

// ── TRAP ROOM — Floor 2 (Poolrooms, NW pool chamber) ────
// Rows 2-9, cols 2-9 — entry via single-cell door at row 10, col 5
const T2_R1 = 2, T2_R2 = 9, T2_C1 = 2, T2_C2 = 9
const T2_SEAL_R = 10, T2_SEAL_C = 5

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
  scene.add(trap2NorthWall)

  trap2SouthWall = new THREE.Mesh(new THREE.PlaneGeometry(roomW, WALL_H), trapWallMat)
  trap2SouthWall.rotation.y = Math.PI
  trap2SouthWall.position.set(midX, f2Y + WALL_H/2, trap2SouthZ)
  trap2SouthWall.visible = false
  scene.add(trap2SouthWall)

  trap2WestWall = new THREE.Mesh(new THREE.PlaneGeometry(roomD, WALL_H), trapWallMat)
  trap2WestWall.rotation.y = Math.PI / 2
  trap2WestWall.position.set(trap2WestX, f2Y + WALL_H/2, midZ)
  trap2WestWall.visible = false
  scene.add(trap2WestWall)

  trap2EastWall = new THREE.Mesh(new THREE.PlaneGeometry(roomD, WALL_H), trapWallMat)
  trap2EastWall.rotation.y = -Math.PI / 2
  trap2EastWall.position.set(trap2EastX, f2Y + WALL_H/2, midZ)
  trap2EastWall.visible = false
  scene.add(trap2EastWall)
})()

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


function flashScreen(color) {
  const el = document.getElementById('screen-flash')
  el.style.background = color
  el.style.opacity = '1'
  setTimeout(() => { el.style.opacity = '0' }, 80)
}

function damagePlayer() {
  if (gameState !== 'playing') return
  flashScreen('rgba(200,0,0,0.48)')
  startDeath()
}

// ── DEATH ─────────────────────────────────────────────────

function startDeath() {
  if (gameState !== 'playing') return
  gameState = 'dying'
  deathTimer = 0
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
  trap1Rate   = 0.35
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
    this.spawnDelay = 30 + Math.random() * 15   // 30–45 seconds
    this.spawnElapsed = 0
    this.floor = 0  // which floor the entity is on
    this.crossFloorTimer = 0  // time spent on different floor than player
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
    this.spawnDelay = 30 + Math.random() * 15
    this.speed = this.baseSpeed
    this.floor = 0
    this.crossFloorTimer = 0
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

    // Move faster while hunting (no LOS) so it closes the gap unseen
    const step = (this.hunting ? Math.min(this.speed * 4.5, 9.0) : this.speed) * dt
    const nx = this.x + mx * step
    const nz = this.z + mz * step
    if (canMoveOnFloor(this.floor, nx, this.z)) this.x = nx
    if (canMoveOnFloor(this.floor, this.x, nz)) this.z = nz

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

  // Find a doorway cell near the player — close enough to be clearly visible
  _findSpawnNearPlayer(px, pz) {
    const map = FLOOR_MAPS[this.floor]
    const rows = FLOOR_ROWS[this.floor]
    const cols = FLOOR_COLS[this.floor]
    const pc = Math.floor(px / CELL)
    const pr = Math.floor(pz / CELL)
    const candidates = []
    // Pass 1: doorway cells (≥2 wall neighbors) within 4-6 cells
    for (let dr = -6; dr <= 6; dr++) {
      for (let dc = -6; dc <= 6; dc++) {
        const r = pr + dr
        const c = pc + dc
        if (r < 1 || r >= rows - 1 || c < 1 || c >= cols - 1) continue
        if (map[r][c] !== 0) continue
        const dist = Math.hypot(dr, dc)
        if (dist < 4 || dist > 6) continue
        const walls =
          (map[r-1][c] === 1 ? 1 : 0) + (map[r+1][c] === 1 ? 1 : 0) +
          (map[r][c-1] === 1 ? 1 : 0) + (map[r][c+1] === 1 ? 1 : 0)
        if (walls >= 2) candidates.push({ r, c })
      }
    }
    // Pass 2: any open cell in range if no doorway found
    if (candidates.length === 0) {
      for (let dr = -6; dr <= 6; dr++) {
        for (let dc = -6; dc <= 6; dc++) {
          const r = pr + dr, c = pc + dc
          if (r < 1 || r >= rows - 1 || c < 1 || c >= cols - 1) continue
          if (map[r][c] !== 0) continue
          const dist = Math.hypot(dr, dc)
          if (dist >= 4 && dist <= 6) candidates.push({ r, c })
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
      if (canMoveOnFloor(this.floor, nx, this.z)) this.x = nx
      if (canMoveOnFloor(this.floor, this.x, nz)) this.z = nz
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
  // Check prop colliders
  for (let i = 0; i < propColliders.length; i++) {
    const p = propColliders[i]
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
let actionTriggered = false

document.addEventListener('keydown', e => {
  keys[e.code] = true
  if (e.code === 'Space') {
    e.preventDefault()
    if (startScreen.style.display !== 'none') { dismissStartScreen(); return }
    if (paused && gameState === 'playing') { enterGame() }
    else { actionTriggered = true }
  }
  if (e.code === 'Escape' && gameState === 'playing' && !paused) {
    pauseGame()
  }
})
document.addEventListener('keyup', e => { keys[e.code] = false })

// ── TOUCH ─────────────────────────────────────────────────

const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0
const clickHint      = document.getElementById('click-hint')
const crosshair      = document.getElementById('crosshair')
const mobileControls = document.getElementById('mobile-controls')

const mobilePauseBtn = document.getElementById('mobile-pause')

// ── Start screen ──────────────────────────────────────────
const startScreen = document.getElementById('start-screen')
const lb = document.getElementById('leaderboard')
const lbToggle = document.getElementById('lb-toggle')

function dismissStartScreen() {
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
  const name = deathNameInput.value.trim() || 'ANON'
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
  document.getElementById('hint-sub').textContent = '← → TURN  ·  ▲ ▼ MOVE'
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

function enterGame() {
  paused = false
  if (gameTime === 0) {
    // First entry — snap from cinematic to spawn
    currentFloor = 0
    camera.position.set(START_X, EYE_H + floorYOffsets[0], START_Z)
    yawAngle   = Math.PI
    pitchAngle = 0
    unlockAudio()
  }
  clickHint.style.display = 'none'
  crosshair.style.display = isTouch ? 'none' : 'block'
  if (mobilePauseBtn) mobilePauseBtn.style.display = isTouch ? 'flex' : 'none'
  lb.classList.remove('visible', 'on-death')
}

function pauseGame() {
  paused = true
  clickHint.style.display = 'flex'
  crosshair.style.display = 'none'
  if (mobilePauseBtn) mobilePauseBtn.style.display = 'none'
  music.pause()
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
    pitchAngle -= (t.clientY - p.y) * LOOK_TOUCH
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

if (isTouch) {
  // D-pad button → key mappings
  const dpadMap = {
    'dp-up':    'KeyW',
    'dp-down':  'KeyS',
    'dp-left':  'ArrowLeft',
    'dp-right': 'ArrowRight',
  }
  for (const [id, key] of Object.entries(dpadMap)) {
    const btn = document.getElementById(id)
    if (!btn) continue
    btn.addEventListener('touchstart',  e => { e.preventDefault(); keys[key] = true  }, { passive: false })
    btn.addEventListener('touchend',    e => { e.preventDefault(); keys[key] = false }, { passive: false })
    btn.addEventListener('touchcancel', e => { keys[key] = false })
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

function loop() {
  requestAnimationFrame(loop)
  const now = performance.now()
  const dt  = Math.min((now - last) / 1000, 0.05)
  last = now

  if (paused) { renderer.render(scene, camera); return }

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
      lbToggle.classList.add('show')
      renderLeaderboard()
    }
    renderer.render(scene, camera); return
  }
  if (gameState === 'dead') { renderer.render(scene, camera); return }

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


  // ── Falling state ───────────────────────���──────────────────
  if (isFalling) {
    fallTimer += dt
    const t = Math.min(fallTimer / FALL_DURATION, 1)
    camera.position.y = fallStartY + (fallTargetY - fallStartY) * t
    // Disorienting tilt during fall
    camera.rotation.z = Math.sin(t * Math.PI * 2) * 0.15 * (1 - t)
    if (t >= 1) {
      isFalling = false
      camera.rotation.z = 0
      camera.position.y = EYE_H + floorYOffsets[currentFloor]
    }
    renderer.render(scene, camera); return
  }

  const len = Math.hypot(dx, dz)
  if (len > 0.001) {
    const step = MOVE_SPEED * dt / len
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

  // ── Hole detection ──────────────────────────────────────────
  const pCol = Math.floor(camera.position.x / CELL)
  const pRow = Math.floor(camera.position.z / CELL)
  for (const hole of HOLES) {
    if (hole.floor === currentFloor && hole.r === pRow && hole.c === pCol) {
      const targetFloor = (currentFloor + 1) % FLOOR_COUNT
      fallStartY = camera.position.y
      fallTargetY = EYE_H + floorYOffsets[targetFloor]
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

  // ── Trap rooms ─────────────────────────────────────────────────────────
  const playerRow = Math.floor(camera.position.z / CELL)
  const playerCol = Math.floor(camera.position.x / CELL)

  // Floor 0 trap
  if (!trapActive && currentFloor === 0 &&
      playerRow >= TRAP_R1 && playerRow <= TRAP_R2 &&
      playerCol >= TRAP_C1 && playerCol <= TRAP_C2) {
    trapActive = true
    MAP[TRAP_SEAL_R][TRAP_SEAL_C] = 1
    trapNorthWall.visible = true
    trapSouthWall.visible = true
    trapWestWall.visible  = true
    trapEastWall.visible  = true
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
    if (trapEastX - trapWestX < 3.0 || trapSouthZ - trapNorthZ < 3.0) {
      flashScreen('rgba(200,0,0,0.48)')
      startDeath()
    }
  }

  // Floor 1 trap (mall backroom)
  if (!trap1Active && currentFloor === 1 &&
      playerRow >= T1_R1 && playerRow <= T1_R2 &&
      playerCol >= T1_C1 && playerCol <= T1_C2) {
    trap1Active = true
    MAP1[T1_SEAL_R][T1_SEAL_C] = 1
    trap1NorthWall.visible = true
    trap1SouthWall.visible = true
    trap1WestWall.visible  = true
    trap1EastWall.visible  = true
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
    if (trap1EastX - trap1WestX < 3.0 || trap1SouthZ - trap1NorthZ < 3.0) {
      flashScreen('rgba(200,0,0,0.48)')
      startDeath()
    }
  }

  // Floor 2 trap (poolroom NW chamber)
  if (!trap2Active && currentFloor === 2 &&
      playerRow >= T2_R1 && playerRow <= T2_R2 &&
      playerCol >= T2_C1 && playerCol <= T2_C2) {
    trap2Active = true
    MAP2[T2_SEAL_R][T2_SEAL_C] = 1
    trap2NorthWall.visible = true
    trap2SouthWall.visible = true
    trap2WestWall.visible  = true
    trap2EastWall.visible  = true
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
      if (!enemyTracked) {
        enemyTracked = true
        if (music.paused) music.play().catch(() => { musicPlayPending = true })
      }
      // Volume: soft at distance, present when close — range 0.08 to 0.6
      const edx = camera.position.x - enemy.x
      const edz = camera.position.z - enemy.z
      const eDist = Math.hypot(edx, edz)
      const targetVol = 0.08 + 0.52 * Math.max(0, 1 - eDist / 45)
      music.volume += (targetVol - music.volume) * Math.min(dt * 2.5, 1)
    } else {
      losGraceTimer += dt
      if (enemyTracked && losGraceTimer >= LOS_GRACE) {
        enemyTracked = false
        enemy.speed = Math.min(enemy.speed + 0.4, 5.0)
        music.pause()
        music.currentTime = 0
        music.volume = 0.08
        musicPlayPending = false
      }
    }
  } else if (enemy.active && enemy.floor !== currentFloor && enemyTracked) {
    // Enemy is on a different floor — cut music
    enemyTracked = false
    music.pause()
    music.currentTime = 0
    music.volume = 0.08
    musicPlayPending = false
  }

  if (actionTriggered) actionTriggered = false

  renderer.render(scene, camera)
}

loop()
