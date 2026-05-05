/**
 * GraphView — Obsidian-style force-directed graph overlay.
 *
 * Rendering stack:
 *   • d3-force  — physics simulation (link attraction, many-body repulsion, centering)
 *   • Canvas 2D — hardware-accelerated pixel rendering via requestAnimationFrame
 *   • Manual pointer/wheel event handlers — pan & zoom without extra dependencies
 */
import {
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useState,
  type RefObject,
} from 'react'
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type Simulation,
} from 'd3-force'
import { X, MagnifyingGlass, ArrowsOut } from '@phosphor-icons/react'
import type { VaultEntry } from '../types'
import { buildGraphData, type GraphNode, type GraphLink } from '../utils/graphData'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MIN_ZOOM = 0.05
const MAX_ZOOM = 8
const NODE_BASE_RADIUS = 5
const HOVER_SCALE = 1.4
const LABEL_MIN_ZOOM = 0.55
const EDGE_COLOR_DARK = 'rgba(255,255,255,0.12)'
const EDGE_COLOR_LIGHT = 'rgba(0,0,0,0.12)'
const HOVER_RING_DARK = 'rgba(255,255,255,0.9)'
const HOVER_RING_LIGHT = 'rgba(0,0,0,0.8)'

interface Transform {
  x: number
  y: number
  k: number
}

interface Props {
  open: boolean
  entries: VaultEntry[]
  activePath?: string | null
  onSelectNote: (entry: VaultEntry) => void
  onClose: () => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function nodeRadius(node: GraphNode): number {
  return NODE_BASE_RADIUS + (node.val - 1) * 1.2
}

function resolvedNode(ref: string | GraphNode): GraphNode {
  return (typeof ref === 'string' ? null : ref) as GraphNode
}

function isDark(): boolean {
  return document.documentElement.classList.contains('dark')
    || window.matchMedia('(prefers-color-scheme: dark)').matches
}

// ---------------------------------------------------------------------------
// Canvas renderer  (called every rAF tick while simulation is warm)
// ---------------------------------------------------------------------------
function drawGraph(
  canvas: HTMLCanvasElement,
  nodes: GraphNode[],
  links: GraphLink[],
  transform: Transform,
  hoveredId: string | null,
  activeId: string | null,
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dark = isDark()
  const edgeColor = dark ? EDGE_COLOR_DARK : EDGE_COLOR_LIGHT
  const hoverRingColor = dark ? HOVER_RING_DARK : HOVER_RING_LIGHT
  const labelColor = dark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.75)'
  const bgColor = dark ? '#1a1a1a' : '#f8f8f8'

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  ctx.save()
  ctx.translate(transform.x, transform.y)
  ctx.scale(transform.k, transform.k)

  // --- Edges ---
  ctx.strokeStyle = edgeColor
  ctx.lineWidth = 1 / transform.k
  for (const link of links) {
    const s = resolvedNode(link.source)
    const t = resolvedNode(link.target)
    if (!s?.x || !t?.x) continue
    ctx.beginPath()
    ctx.moveTo(s.x, s.y ?? 0)
    ctx.lineTo(t.x, t.y ?? 0)
    ctx.stroke()
  }

  // --- Nodes ---
  for (const node of nodes) {
    if (node.x == null || node.y == null) continue
    const r = nodeRadius(node)
    const isHovered = node.id === hoveredId
    const isActive = node.id === activeId
    const displayR = isHovered ? r * HOVER_SCALE : r

    // Outer ring for hovered / active node
    if (isHovered || isActive) {
      ctx.beginPath()
      ctx.arc(node.x, node.y, displayR + 2.5 / transform.k, 0, Math.PI * 2)
      ctx.fillStyle = hoverRingColor
      ctx.fill()
    }

    // Node fill
    ctx.beginPath()
    ctx.arc(node.x, node.y, displayR, 0, Math.PI * 2)
    ctx.fillStyle = node.color
    ctx.fill()
  }

  // --- Labels (only when zoomed in enough) ---
  if (transform.k >= LABEL_MIN_ZOOM) {
    ctx.fillStyle = labelColor
    const fontSize = Math.max(9, Math.min(13, 11 / transform.k))
    ctx.font = `${fontSize}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (const node of nodes) {
      if (node.x == null || node.y == null) continue
      const r = nodeRadius(node)
      const label = node.label.length > 28 ? node.label.slice(0, 26) + '…' : node.label
      ctx.fillText(label, node.x, node.y + r + 3 / transform.k)
    }
  }

  ctx.restore()
}

// ---------------------------------------------------------------------------
// Hit testing — returns the node under (canvasX, canvasY) or null
// ---------------------------------------------------------------------------
function hitTestNode(
  nodes: GraphNode[],
  canvasX: number,
  canvasY: number,
  transform: Transform,
): GraphNode | null {
  const gx = (canvasX - transform.x) / transform.k
  const gy = (canvasY - transform.y) / transform.k
  let best: GraphNode | null = null
  let bestDist = Infinity
  for (const node of nodes) {
    if (node.x == null || node.y == null) continue
    const dx = gx - node.x
    const dy = gy - (node.y ?? 0)
    const dist = Math.sqrt(dx * dx + dy * dy)
    const r = nodeRadius(node) * HOVER_SCALE + 4
    if (dist < r && dist < bestDist) {
      bestDist = dist
      best = node
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// useGraphSimulation — sets up d3-force, returns live nodes/links refs
// ---------------------------------------------------------------------------
function useGraphSimulation(
  graphData: ReturnType<typeof buildGraphData>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  transformRef: RefObject<Transform>,
  animFrameRef: RefObject<number>,
  hoveredIdRef: RefObject<string | null>,
  activePathRef: RefObject<string | null>,
) {
  const simRef = useRef<Simulation<GraphNode, GraphLink> | null>(null)
  const nodesRef = useRef<GraphNode[]>([])
  const linksRef = useRef<GraphLink[]>([])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Clone data so d3 can mutate it freely
    const nodes: GraphNode[] = graphData.nodes.map((n) => ({ ...n }))
    const links: GraphLink[] = graphData.links.map((l) => ({ ...l }))
    nodesRef.current = nodes
    linksRef.current = links

    const w = canvas.clientWidth || 800
    const h = canvas.clientHeight || 600

    const sim = forceSimulation<GraphNode>(nodes)
      .force(
        'link',
        forceLink<GraphNode, GraphLink>(links)
          .id((d) => d.id)
          .distance(60)
          .strength(0.4),
      )
      .force('charge', forceManyBody<GraphNode>().strength(-120))
      .force('center', forceCenter(w / 2, h / 2))
      .force('collide', forceCollide<GraphNode>((d) => nodeRadius(d) + 4))
      .alphaDecay(0.025)

    simRef.current = sim

    const render = () => {
      const c = canvasRef.current
      if (!c) return
      drawGraph(c, nodesRef.current, linksRef.current, transformRef.current, hoveredIdRef.current, activePathRef.current)
    }

    sim.on('tick', render)

    // Keep rendering even after simulation cools (for hover/pan/zoom)
    const loop = () => {
      render()
      animFrameRef.current = requestAnimationFrame(loop)
    }
    animFrameRef.current = requestAnimationFrame(loop)

    return () => {
      sim.stop()
      cancelAnimationFrame(animFrameRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData])

  return { simRef, nodesRef, linksRef }
}

// ---------------------------------------------------------------------------
// GraphView component
// ---------------------------------------------------------------------------
export function GraphView({ open, entries, activePath, onSelectNote, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const transformRef = useRef<Transform>({ x: 0, y: 0, k: 1 })
  const animFrameRef = useRef<number>(0)
  const hoveredIdRef = useRef<string | null>(null)
  const activePathRef = useRef<string | null>(activePath ?? null)
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; label: string } | null>(null)

  // Drag / pan state
  const isPanningRef = useRef(false)
  const panStartRef = useRef({ mx: 0, my: 0, tx: 0, ty: 0 })

  // Node drag state
  const draggingNodeRef = useRef<GraphNode | null>(null)

  // Keep activePathRef in sync
  useEffect(() => { activePathRef.current = activePath ?? null }, [activePath])

  const graphData = useMemo(() => buildGraphData(entries), [entries])

  const { simRef, nodesRef, linksRef } = useGraphSimulation(
    graphData,
    canvasRef,
    transformRef,
    animFrameRef,
    hoveredIdRef,
    activePathRef,
  )

  // ---------- Fit graph to canvas on first load ----------
  const fitGraph = useCallback(() => {
    const canvas = canvasRef.current
    const nodes = nodesRef.current
    if (!canvas || nodes.length === 0) return

    const xs = nodes.map((n) => n.x ?? 0)
    const ys = nodes.map((n) => n.y ?? 0)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const gw = maxX - minX || 1
    const gh = maxY - minY || 1

    const scaleX = (canvas.clientWidth * 0.85) / gw
    const scaleY = (canvas.clientHeight * 0.85) / gh
    const k = Math.min(scaleX, scaleY, MAX_ZOOM)
    const x = canvas.clientWidth / 2 - (k * (minX + maxX)) / 2
    const y = canvas.clientHeight / 2 - (k * (minY + maxY)) / 2
    transformRef.current = { x, y, k }
  }, [nodesRef])

  // Resize observer — keep canvas pixel dimensions in sync with layout
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => {
      canvas.width = canvas.clientWidth * devicePixelRatio
      canvas.height = canvas.clientHeight * devicePixelRatio
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.scale(devicePixelRatio, devicePixelRatio)
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  // Fit once simulation settles
  useEffect(() => {
    const sim = simRef.current
    if (!sim) return
    const timeout = setTimeout(fitGraph, 1200)
    return () => clearTimeout(timeout)
  }, [simRef, fitGraph, graphData])

  // ---------- Zoom (wheel) ----------
  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    const t = transformRef.current
    const nextK = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, t.k * factor))
    // Zoom around mouse cursor
    transformRef.current = {
      x: mx - (mx - t.x) * (nextK / t.k),
      y: my - (my - t.y) * (nextK / t.k),
      k: nextK,
    }
  }, [])

  // ---------- Pointer events (pan + node drag + click) ----------
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const hit = hitTestNode(nodesRef.current, mx, my, transformRef.current)

    if (hit) {
      draggingNodeRef.current = hit
      hit.fx = hit.x
      hit.fy = hit.y
      simRef.current?.alphaTarget(0.1).restart()
    } else {
      isPanningRef.current = true
      panStartRef.current = {
        mx,
        my,
        tx: transformRef.current.x,
        ty: transformRef.current.y,
      }
    }
    canvas.setPointerCapture(e.pointerId)
  }, [nodesRef, simRef])

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    if (draggingNodeRef.current) {
      const node = draggingNodeRef.current
      const t = transformRef.current
      node.fx = (mx - t.x) / t.k
      node.fy = (my - t.y) / t.k
      return
    }

    if (isPanningRef.current) {
      const { mx: sx, my: sy, tx, ty } = panStartRef.current
      transformRef.current = {
        ...transformRef.current,
        x: tx + (mx - sx),
        y: ty + (my - sy),
      }
      return
    }

    // Hover detection
    const hit = hitTestNode(nodesRef.current, mx, my, transformRef.current)
    hoveredIdRef.current = hit?.id ?? null
    canvas.style.cursor = hit ? 'pointer' : 'grab'
    setHoveredNode(hit)
    if (hit) {
      setTooltip({ x: e.clientX, y: e.clientY, label: hit.label })
    } else {
      setTooltip(null)
    }
  }, [nodesRef])

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    const node = draggingNodeRef.current
    if (node) {
      node.fx = null
      node.fy = null
      simRef.current?.alphaTarget(0)
      draggingNodeRef.current = null
    }

    if (isPanningRef.current) {
      isPanningRef.current = false
    } else if (!node && canvas) {
      // It was a click — navigate to the node under the pointer
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const hit = hitTestNode(nodesRef.current, mx, my, transformRef.current)
      if (hit) {
        onSelectNote(hit.entry)
        onClose()
      }
    }
  }, [nodesRef, simRef, onSelectNote, onClose])

  // ---------- Keyboard shortcut (Escape to close) ----------
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  // ---------- Legend data ----------
  const typeColorEntries = useMemo(() => {
    const seen = new Map<string, string>()
    for (const node of graphData.nodes) {
      if (node.type && !seen.has(node.type)) seen.set(node.type, node.color)
    }
    return Array.from(seen.entries()).slice(0, 6)
  }, [graphData.nodes])

  if (!open) return null

  const nodeCount = graphData.nodes.length
  const edgeCount = graphData.links.length

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)' }}
      data-testid="graph-view-overlay"
    >
      {/* Top bar */}
      <div
        className="flex items-center justify-between px-4 py-2 border-b"
        style={{
          background: 'var(--sidebar)',
          borderColor: 'var(--border)',
        }}
      >
        <div className="flex items-center gap-3">
          <span className="font-semibold text-sm" style={{ color: 'var(--foreground)' }}>
            Knowledge Graph
          </span>
          <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
            {nodeCount} notes · {edgeCount} connections
            {graphData.totalEntries > nodeCount && (
              <span className="ml-1 italic">
                (top {nodeCount} of {graphData.totalEntries} shown)
              </span>
            )}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={fitGraph}
            title="Fit to screen"
            className="p-1.5 rounded transition-colors"
            style={{ color: 'var(--muted-foreground)' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--foreground)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--muted-foreground)')}
            data-testid="graph-fit-button"
          >
            <ArrowsOut size={16} />
          </button>
          <button
            onClick={onClose}
            title="Close graph (Esc)"
            className="p-1.5 rounded transition-colors"
            style={{ color: 'var(--muted-foreground)' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--foreground)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--muted-foreground)')}
            data-testid="graph-close-button"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        className="flex-1 w-full"
        style={{ display: 'block', cursor: 'grab', touchAction: 'none' }}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        data-testid="graph-canvas"
      />

      {/* Bottom-left hint */}
      <div
        className="absolute bottom-4 left-4 flex items-center gap-2 text-xs px-2 py-1 rounded"
        style={{
          background: 'var(--sidebar)',
          color: 'var(--muted-foreground)',
          border: '1px solid var(--border)',
        }}
      >
        <MagnifyingGlass size={12} />
        Scroll to zoom · Drag to pan · Click a node to open
      </div>

      {/* Bottom-right legend */}
      {typeColorEntries.length > 0 && (
        <div
          className="absolute bottom-4 right-4 text-xs px-3 py-2 rounded"
          style={{
            background: 'var(--sidebar)',
            border: '1px solid var(--border)',
            color: 'var(--muted-foreground)',
          }}
          data-testid="graph-legend"
        >
          <div className="mb-1 font-medium" style={{ color: 'var(--foreground)' }}>Types</div>
          <div className="flex flex-col gap-1">
            {typeColorEntries.map(([type, color]) => (
              <div key={type} className="flex items-center gap-1.5">
                <span
                  className="inline-block rounded-full flex-shrink-0"
                  style={{ width: 8, height: 8, background: color }}
                />
                <span>{type}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Hover tooltip */}
      {tooltip && (
        <div
          className="fixed pointer-events-none z-50 rounded px-2 py-1 text-xs shadow"
          style={{
            left: tooltip.x + 14,
            top: tooltip.y - 28,
            background: 'var(--popover)',
            color: 'var(--popover-foreground)',
            border: '1px solid var(--border)',
            maxWidth: 260,
          }}
          data-testid="graph-tooltip"
        >
          {hoveredNode?.type && (
            <span
              className="mr-1.5 font-medium"
              style={{ color: hoveredNode.color }}
            >
              {hoveredNode.type}
            </span>
          )}
          {tooltip.label}
        </div>
      )}
    </div>
  )
}
