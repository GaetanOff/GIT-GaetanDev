import type { Commit } from '@shared/types'

export interface GraphEdge {
  /** Lane at the top or middle of the row. */
  from: number
  /** Lane at the bottom or middle of the row. */
  to: number
  color: number
}

export interface GraphRow {
  col: number
  color: number
  /** Edges in the top half: lanes flowing into this row. */
  top: GraphEdge[]
  /** Edges in the bottom half: lanes leaving this row. */
  bottom: GraphEdge[]
  width: number
  merge: boolean
}

interface Lane {
  sha: string
  color: number
}

/**
 * Streaming lane assignment for a topo-ordered log. Each lane waits for a
 * commit; a commit takes the first lane waiting for it (others merge in), then
 * hands its lane to its first parent and opens lanes for the other parents.
 * State is kept between pages so "load more" extends the graph seamlessly.
 */
export class GraphBuilder {
  private lanes: (Lane | null)[] = []
  private nextColor = 0

  reset(): void {
    this.lanes = []
    this.nextColor = 0
  }

  add(commits: Commit[]): GraphRow[] {
    return commits.map(c => this.row(c))
  }

  private row(c: Commit): GraphRow {
    const lanes = this.lanes
    const before = lanes.slice()

    let col = lanes.findIndex(l => l?.sha === c.sha)
    let color: number
    if (col < 0) {
      col = lanes.findIndex(l => l === null)
      if (col < 0) col = lanes.length
      color = this.nextColor++
    } else {
      color = lanes[col]!.color
    }

    const top: GraphEdge[] = []
    before.forEach((l, i) => {
      if (!l) return
      // Lanes waiting for this commit converge on its node; the rest pass through.
      top.push({ from: i, to: l.sha === c.sha ? col : i, color: l.color })
      if (l.sha === c.sha && i !== col) lanes[i] = null
    })

    // First parent continues this lane; other parents join an existing lane or open one.
    lanes[col] = c.parents[0] ? { sha: c.parents[0], color } : null
    const targets: { lane: number; color: number }[] = []
    if (c.parents[0]) targets.push({ lane: col, color })
    for (const p of c.parents.slice(1)) {
      let lane = lanes.findIndex(l => l?.sha === p)
      if (lane < 0) {
        lane = lanes.findIndex(l => l === null)
        const l = { sha: p, color: this.nextColor++ }
        if (lane < 0) { lane = lanes.length; lanes.push(l) } else lanes[lane] = l
      }
      targets.push({ lane, color: lanes[lane]!.color })
    }

    const bottom: GraphEdge[] = []
    lanes.forEach((l, i) => {
      if (l && i !== col && before[i]?.sha === l.sha) bottom.push({ from: i, to: i, color: l.color })
    })
    for (const t of targets) bottom.push({ from: col, to: t.lane, color: t.lane === col ? color : t.color })

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    const width = Math.max(before.length, lanes.length, col + 1)
    return { col, color, top, bottom, width, merge: c.parents.length > 1 }
  }
}

/** Lane colours: the SSH server palette, in an order that keeps neighbours distinct. */
export const LANE_COLORS = ['#4ade80', '#60a5fa', '#c084fc', '#fcd34d', '#2dd4bf', '#f472b6', '#67e8f9', '#f87171']
export const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length]
