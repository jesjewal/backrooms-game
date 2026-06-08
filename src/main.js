import * as THREE from 'three'

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

// Unlock HTML Audio for iOS Safari on the very first user gesture (silent)
const _unlockAudio = () => {
  music.muted = true
  music.play().then(() => { music.pause(); music.currentTime = 0; music.muted = false }).catch(() => { music.muted = false })
  document.removeEventListener('touchstart', _unlockAudio, true)
  document.removeEventListener('click',      _unlockAudio, true)
}
document.addEventListener('touchstart', _unlockAudio, { capture: true, once: true })
document.addEventListener('click',      _unlockAudio, { capture: true, once: true })

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

const wallMat   = new THREE.MeshLambertMaterial({ map: makeWallTex(faceImg) })
// Regenerate wall texture once image is confirmed loaded
faceImg.onload = () => {
  wallMat.map.dispose()
  wallMat.map = makeWallTex(faceImg)
  wallMat.needsUpdate = true
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
  gameState = 'dying'
  deathTimer = 0
}

function restartGame() {
  gameState = 'playing'
  deathTimer = 0
  if (!isTouch) pauseGame(); else paused = false
  camera.position.set(START_X, EYE_H, START_Z)
  yawAngle = Math.PI
  pitchAngle = 0
  document.getElementById('death-overlay').style.display = 'none'
  document.getElementById('death-vignette').style.opacity = '0'
  entities.forEach(e => e.reset())
  music.pause(); music.currentTime = 0
  enemyTracked = false
  losGraceTimer = 0
  gameTime = 0
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
    this.spawnDelay = 15 + Math.random() * 5   // 20–30 seconds
    this.spawnElapsed = 0
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
    this.spawnDelay = 15 + Math.random() * 5
    this.speed = this.baseSpeed
    this.group.visible = false
  }

  update(dt, px, pz) {
    if (!this.active) {
      this.spawnElapsed += dt
      if (this.spawnElapsed >= this.spawnDelay) {
        // Place entity at a doorway near the player's current room
        const spawn = this._findSpawnNearPlayer(px, pz)
        if (spawn) {
          this.x = spawn.c * CELL + CELL / 2
          this.z = spawn.r * CELL + CELL / 2
          this.group.position.set(this.x, 0, this.z)
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

    const dx   = px - this.x
    const dz   = pz - this.z
    const dist = Math.hypot(dx, dz)

    // BFS pathfinding — recalculate on timer, or when current path is exhausted
    this.pathTimer -= dt
    if (this.pathTimer <= 0 || (this.path && this.path.length < 2)) {
      this.path = findPath(this.x, this.z, px, pz)
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
    const step = (this.hunting ? Math.min(this.speed * 3.0, 7.0) : this.speed) * dt
    const nx = this.x + mx * step
    const nz = this.z + mz * step
    if (canMove(nx, this.z)) this.x = nx
    if (canMove(this.x, nz)) this.z = nz

    this.group.position.set(this.x, Math.sin(this.bobPhase) * 0.08, this.z)

    if (dist < 1.9 && this.hitCooldown <= 0) {
      this.hitCooldown = HIT_COOLDOWN
      damagePlayer()
    }
  }

  // Find a doorway cell near the player — close enough to be clearly visible
  _findSpawnNearPlayer(px, pz) {
    const pc = Math.floor(px / CELL)
    const pr = Math.floor(pz / CELL)
    const candidates = []
    // Pass 1: doorway cells (≥2 wall neighbors) within 4-6 cells — close enough to see immediately
    for (let dr = -6; dr <= 6; dr++) {
      for (let dc = -6; dc <= 6; dc++) {
        const r = pr + dr
        const c = pc + dc
        if (r < 1 || r >= ROWS - 1 || c < 1 || c >= COLS - 1) continue
        if (MAP[r][c] !== 0) continue
        const dist = Math.hypot(dr, dc)
        if (dist < 4 || dist > 6) continue
        const walls =
          (MAP[r-1][c] === 1 ? 1 : 0) + (MAP[r+1][c] === 1 ? 1 : 0) +
          (MAP[r][c-1] === 1 ? 1 : 0) + (MAP[r][c+1] === 1 ? 1 : 0)
        if (walls >= 2) candidates.push({ r, c })
      }
    }
    // Pass 2: any open cell in range if no doorway found
    if (candidates.length === 0) {
      for (let dr = -6; dr <= 6; dr++) {
        for (let dc = -6; dc <= 6; dc++) {
          const r = pr + dr, c = pc + dc
          if (r < 1 || r >= ROWS - 1 || c < 1 || c >= COLS - 1) continue
          if (MAP[r][c] !== 0) continue
          const dist = Math.hypot(dr, dc)
          if (dist >= 4 && dist <= 6) candidates.push({ r, c })
        }
      }
    }
    if (candidates.length === 0) return null
    return candidates[0 | Math.random() * candidates.length]
  }

  // Returns true if there is an unobstructed line of sight to the player (360°, walls only blocker)
  canSeePlayer(px, pz) {
    const dx = px - this.x
    const dz = pz - this.z
    const dist = Math.hypot(dx, dz)
    if (dist < 0.5) return true  // right on top

    // LOS raycast through map grid — walls are the only blocker, no FOV cone
    const steps = Math.ceil(dist / (CELL * 0.25))
    for (let i = 1; i < steps; i++) {
      const t = i / steps
      if (isWall(this.x + dx * t, this.z + dz * t)) return false
    }
    return true
  }
}

const entities = [
  new Entity(42, 42, 1.4, 999),  // starts faster, speeds up each time LOS breaks
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
  return !isWall(wx-R, wz-R) && !isWall(wx+R, wz-R) &&
         !isWall(wx-R, wz+R) && !isWall(wx+R, wz+R)
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

if (isTouch) {
  document.getElementById('hint-action').textContent = 'TAP TO PLAY'
  document.getElementById('hint-sub').textContent = '← → TURN  ·  ▲ ▼ MOVE'
  mobileControls.style.display = 'flex'
} else {
  mobileControls.style.display = 'none'
}

let paused = true  // always start paused — tap or Space to enter

function enterGame() {
  paused = false
  if (gameTime === 0) {
    // First entry — snap from cinematic to spawn
    camera.position.set(START_X, EYE_H, START_Z)
    yawAngle   = Math.PI
    pitchAngle = 0
  }
  clickHint.style.display = 'none'
  crosshair.style.display = isTouch ? 'none' : 'block'
  if (mobilePauseBtn) mobilePauseBtn.style.display = isTouch ? 'flex' : 'none'
}

function pauseGame() {
  paused = true
  clickHint.style.display = 'flex'
  crosshair.style.display = 'none'
  if (mobilePauseBtn) mobilePauseBtn.style.display = 'none'
  music.pause()
}

const lookTouches = {}
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
    camera.position.y = EYE_H - t * 5
    document.getElementById('death-vignette').style.opacity = t
    if (deathTimer >= 3.0) {
      gameState = 'dead'
      document.getElementById('death-overlay').style.display = 'flex'
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


  const len = Math.hypot(dx, dz)
  if (len > 0.001) {
    const step = MOVE_SPEED * dt / len
    const nx   = camera.position.x + dx * step
    const nz   = camera.position.z + dz * step
    const prevX = camera.position.x
    const prevZ = camera.position.z
    if (canMove(nx, camera.position.z)) camera.position.x = nx
    if (canMove(camera.position.x, nz)) camera.position.z = nz
    // Safety: if we somehow ended up inside a wall cell, revert
    if (isWall(camera.position.x, camera.position.z)) {
      camera.position.x = prevX
      camera.position.z = prevZ
    }
  }
  camera.position.y = EYE_H

  entities.forEach(e => e.update(dt, camera.position.x, camera.position.z))

  // Clock
  gameTime += dt
  clockEl.textContent = fmtTime(gameTime)

  // Music — plays when enemy has line-of-sight, volume scales with proximity
  const enemy = entities[0]
  if (enemy.active) {
    const sees = enemy.canSeePlayer(camera.position.x, camera.position.z)
    enemy.hunting = !sees   // sprint while it can't see you
    if (sees) {
      losGraceTimer = 0
      if (!enemyTracked) {
        enemyTracked = true
        if (music.paused) music.play().catch(() => {})
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
        enemy.speed = Math.min(enemy.speed + 0.25, 3.8)
        music.pause()
        music.currentTime = 0
        music.volume = 0.08
      }
    }
  }

  if (actionTriggered) actionTriggered = false

  renderer.render(scene, camera)
}

loop()
