// The farm: a cross-section of soil with a chamber per agent. Pure: it turns
// the fleet and the live feeds into a grid of cells.

import type { Feed, Fleet } from '../types'
import { pack } from './ant'
import type { Cell } from './ant'

export type Chamber = {
  agentId: string
  name: string
  // Sessions the agent has run: the pellets stored in its chamber.
  runs: number
  // Ticks left of its glow: it lights up while its agent is working.
  glow: number
}

// `tool` walks up to the surface and carries a crumb back; `message` carries
// the agent's words up to you; `prompt` carries yours down.
export type Ant = { chamber: number; kind: 'tool' | 'message' | 'prompt'; at: number; isReturning: boolean }

export type Farm = { chambers: Chamber[]; ants: Ant[]; tick: number; since: number; seen: Set<string> }

const MAX_CHAMBERS = 10
const STEP = 0.04

export const seedFarm = (fleet: Fleet, at: number): Farm => {
  const runs = (agentId: string) => fleet.sessions.filter(s => s.agentId === agentId).length
  const last = (agentId: string) => Math.max(0, ...fleet.sessions.filter(s => s.agentId === agentId).map(s => s.updatedAt))
  const chambers = [...fleet.agents]
    .filter(a => runs(a.id) > 0)
    .sort((a, b) => last(b.id) - last(a.id))
    .slice(0, MAX_CHAMBERS)
    .map(a => ({ agentId: a.id, name: a.name, runs: runs(a.id), glow: 0 }))
  return { chambers, ants: [], tick: 0, since: at - 4000, seen: new Set() }
}

// One tick: new events send ants out, and every ant takes a step.
export const farmStep = (farm: Farm, feeds: Feed[]): void => {
  farm.tick += 1
  for (const feed of feeds) {
    const chamber = farm.chambers.findIndex(c => c.name === feed.agentName)
    for (const ev of feed.events) {
      if (ev.at < farm.since || farm.seen.has(ev.id)) continue
      farm.seen.add(ev.id)
      if (chamber < 0) continue
      const home = farm.chambers[chamber]
      if (home) home.glow = 40
      if (ev.type.endsWith('tool_use')) farm.ants.push({ chamber, kind: 'tool', at: 0, isReturning: false })
      else if (ev.type === 'agent.message') farm.ants.push({ chamber, kind: 'message', at: 0, isReturning: false })
      else if (ev.type === 'user.message') farm.ants.push({ chamber, kind: 'prompt', at: 1, isReturning: true })
    }
    if (feed.status === 'running' && chamber >= 0) {
      const home = farm.chambers[chamber]
      if (home) home.glow = Math.max(home.glow, 8)
    }
  }
  for (const chamber of farm.chambers) chamber.glow = Math.max(0, chamber.glow - 1)

  for (const ant of farm.ants) {
    ant.at += ant.isReturning ? -STEP : STEP
    if (ant.kind === 'tool' && !ant.isReturning && ant.at >= 1) ant.isReturning = true
  }
  farm.ants = farm.ants.filter(ant => (ant.isReturning ? ant.at > 0 : ant.at < 1))
}

const hash = (x: number, y: number) => {
  let n = (x * 374761393 + y * 668265263) | 0
  n = (n ^ (n >>> 13)) * 1274126177
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295
}

const SKY = 0x0b1622
const SOIL = [0x4a3422, 0x46311f, 0x4d3624]
const TUNNEL = 0x120b06
const ROOM = 0x120b06
const GRASS = 0x3fb950
const AMBER = 0xe8a33d

// Where each chamber sits and the path from the nest's mouth down to it:
// the shaft runs down the middle, chambers branch off left and right.
const layout = (farm: Farm, columns: number, rows: number) => {
  const surface = 3
  const mid = Math.floor(columns / 2)
  const perSide = Math.max(1, Math.ceil(farm.chambers.length / 2))
  const gap = Math.max(4, Math.floor((rows - surface - 2) / perSide))
  return farm.chambers.map((chamber, i) => {
    const isLeft = i % 2 === 0
    const depth = Math.floor(i / 2)
    const y = Math.min(rows - 3, surface + 3 + depth * gap + (isLeft ? 0 : Math.floor(gap / 2)))
    const width = Math.min(Math.floor(columns / 2) - 6, Math.max(14, chamber.name.length + 4))
    const reach = 4 + ((depth * 7 + (isLeft ? 3 : 0)) % Math.max(1, Math.floor(columns / 2) - width - 6))
    const near = isLeft ? mid - reach : mid + reach
    const x0 = isLeft ? near - width : near
    const path: [number, number][] = []
    for (let x = isLeft ? x0 + width - 1 : x0; isLeft ? x <= mid : x >= mid; x += isLeft ? 1 : -1) path.push([x, y])
    for (let row = y - 1; row >= surface; row--) path.push([mid, row])
    return { chamber, x0, y, width, path }
  })
}

export const farmCells = (farm: Farm, columns: number, rows: number): string => {
  const grid: Cell[][] = []
  const surface = 3
  const mid = Math.floor(columns / 2)
  for (let y = 0; y < rows; y++) {
    const row: Cell[] = []
    for (let x = 0; x < columns; x++) {
      if (y < surface) {
        const star = hash(x, y) > 0.985
        row.push([star ? '·' : ' ', 0x6e7681, SKY])
      } else if (y === surface) {
        row.push([hash(x, 99) > 0.6 ? '▄' : '▃', GRASS, SKY])
      } else {
        const grain = hash(x, y)
        const bg = SOIL[Math.floor(hash(x >> 3, y >> 2) * SOIL.length)] ?? 0x4a3422
        row.push([grain > 0.95 ? '∙' : grain > 0.9 ? '·' : ' ', 0x6b4f37, bg])
      }
    }
    grid.push(row)
  }
  const put = (x: number, y: number, cell: Cell) => {
    const row = grid[y]
    if (row && x >= 0 && x < columns) row[x] = cell
  }
  const write = (x: number, y: number, text: string, fg: number, bg: number) => {
    ;[...text].forEach((glyph, i) => put(x + i, y, [glyph, fg, bg]))
  }

  write(Math.max(0, mid - 9), 1, '❯ your terminal', 0xe6edf3, SKY)
  put(mid, surface, [' ', 0, TUNNEL])
  put(mid, 2, ['▼', AMBER, SKY])

  const spots = layout(farm, columns, rows)
  // Tunnels first, so chambers sit over their ends.
  for (const spot of spots) for (const [x, y] of spot.path) put(x, y, [' ', 0, TUNNEL])
  for (const spot of spots) {
    const { chamber, x0, y, width } = spot
    const isLit = chamber.glow > 0
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const isCorner = dy !== 0 && (dx === 0 || dx === width - 1)
        if (!isCorner) put(x0 + dx, y + dy, [' ', 0, ROOM])
      }
    }
    const name = chamber.name.length > width - 2 ? `${chamber.name.slice(0, width - 3)}…` : chamber.name
    write(x0 + Math.floor((width - name.length) / 2), y, name, isLit ? 0x7ee787 : 0xc9d1d9, ROOM)
    const pellets = Math.min(width - 4, chamber.runs)
    write(x0 + Math.floor((width - pellets) / 2), y + 1, '•'.repeat(pellets), isLit && farm.tick % 6 < 3 ? 0xf0c000 : 0x9a6b2f, ROOM)
    if (isLit) write(x0 + 2, y - 1, farm.tick % 8 < 4 ? '✦ working' : '✧ working', 0x7ee787, ROOM)
  }

  for (const ant of farm.ants) {
    const spot = spots[ant.chamber]
    if (!spot) continue
    const index = Math.max(0, Math.min(spot.path.length - 1, Math.round(ant.at * (spot.path.length - 1))))
    const [x, y] = spot.path[index] ?? [mid, surface]
    const color = ant.kind === 'message' ? 0x7ee787 : ant.kind === 'prompt' ? 0xffffff : AMBER
    put(x, y, ['ж', color, TUNNEL])
    // What it carries trails a cell behind it.
    if (ant.kind !== 'tool' || ant.isReturning) {
      const behind = spot.path[Math.max(0, Math.min(spot.path.length - 1, index + (ant.isReturning ? 1 : -1)))]
      if (behind && (behind[0] !== x || behind[1] !== y)) put(behind[0], behind[1], ['•', ant.kind === 'tool' ? 0x58a6ff : color, TUNNEL])
    }
  }

  return pack(grid.flat())
}
