/**
 * Transforms VaultEntry[] into a graph of nodes + edges for the GraphView component.
 * Leverages the existing buildInspectorLinkIndex and resolveEntry utilities.
 */
import type { VaultEntry } from '../types'
import { buildInspectorLinkIndex } from '../components/inspector/useInspectorData'
import { resolveEntry, wikilinkTarget } from './wikilink'

// Canvas-compatible hex colours (matching the app's CSS palette variables)
const CANVAS_TYPE_COLORS: Record<string, string> = {
  Project: '#E53E3E',
  Experiment: '#E53E3E',
  Responsibility: '#805AD5',
  Procedure: '#805AD5',
  Person: '#D69E2E',
  Event: '#4299E1',
  Topic: '#38A169',
  Type: '#155DFF',
  Note: '#9CA3AF',
}

const CANVAS_PALETTE: Record<string, string> = {
  red: '#E53E3E',
  orange: '#D9730D',
  yellow: '#D69E2E',
  green: '#38A169',
  blue: '#155DFF',
  purple: '#805AD5',
  teal: '#319795',
  pink: '#D53F8C',
  gray: '#9CA3AF',
}

const DEFAULT_NODE_COLOR = '#9CA3AF'

export interface GraphNode {
  id: string
  label: string
  type: string | null
  color: string
  /** Relative size — drives node radius in the renderer */
  val: number
  entry: VaultEntry
  // Populated by d3-force simulation at runtime
  x?: number
  y?: number
  vx?: number
  vy?: number
  fx?: number | null
  fy?: number | null
}

export interface GraphLink {
  source: string | GraphNode
  target: string | GraphNode
}

export interface GraphData {
  nodes: GraphNode[]
  links: GraphLink[]
  /** Total entries in the vault (may exceed nodes.length when capped) */
  totalEntries: number
}

function canvasColor(colorKey?: string | null): string | null {
  if (!colorKey) return null
  const palette = CANVAS_PALETTE[colorKey.toLowerCase()]
  if (palette) return palette
  // Accept raw hex / rgb values
  if (colorKey.startsWith('#') || colorKey.startsWith('rgb')) return colorKey
  return null
}

/** Build a type-name → VaultEntry map from entries that have isA === null (i.e. they ARE types). */
function buildTypeMap(entries: VaultEntry[]): Map<string, VaultEntry> {
  const map = new Map<string, VaultEntry>()
  for (const e of entries) {
    if (e.isA === null && e.color != null) {
      map.set(e.title.toLowerCase(), e)
    }
  }
  return map
}

/**
 * Derives graph nodes and edges from the vault entries.
 * For vaults > MAX_NODES entries, the top most-connected notes are kept.
 * Edges are deduplicated — bidirectional duplicates are collapsed into one undirected edge.
 */
const MAX_NODES = 2000

export function buildGraphData(entries: VaultEntry[]): GraphData {
  if (entries.length === 0) return { nodes: [], links: [] }

  const linkIndex = buildInspectorLinkIndex(entries)
  const typeMap = buildTypeMap(entries)

  // --- Score every entry by total connections (used for capping large vaults) ---
  const scoreEntry = (e: VaultEntry) =>
    (linkIndex.backlinks.get(e.path)?.length ?? 0)
    + (linkIndex.referencedBy.get(e.path)?.length ?? 0)
    + e.outgoingLinks.length
    + Object.values(e.relationships).reduce((n, refs) => n + refs.length, 0)

  const sorted = entries.slice().sort((a, b) => scoreEntry(b) - scoreEntry(a))
  const limited = sorted.slice(0, MAX_NODES)

  // --- Nodes ---
  const nodes: GraphNode[] = limited.map((e) => {
    const totalLinks = scoreEntry(e)

    const typeEntry = e.isA ? typeMap.get(e.isA.toLowerCase()) : undefined
    const color =
      canvasColor(typeEntry?.color)
      ?? CANVAS_TYPE_COLORS[e.isA ?? '']
      ?? DEFAULT_NODE_COLOR

    return {
      id: e.path,
      label: e.title,
      type: e.isA,
      color,
      val: Math.max(1, Math.min(totalLinks * 0.4 + 1, 10)),
      entry: e,
    }
  })

  // --- Edges ---
  const nodeSet = new Set(nodes.map((n) => n.id))
  const edgeSet = new Set<string>()
  const links: GraphLink[] = []

  function addEdge(sourcePath: string, targetPath: string) {
    if (!targetPath || targetPath === sourcePath) return
    if (!nodeSet.has(sourcePath) || !nodeSet.has(targetPath)) return
    // Deduplicate bidirectional edges by sorting the pair
    const key = sourcePath < targetPath
      ? `${sourcePath}\x00${targetPath}`
      : `${targetPath}\x00${sourcePath}`
    if (edgeSet.has(key)) return
    edgeSet.add(key)
    links.push({ source: sourcePath, target: targetPath })
  }

  for (const entry of entries) {
    // Body wikilinks → edges
    for (const link of entry.outgoingLinks) {
      const resolved = resolveEntry(entries, link)
      if (resolved) addEdge(entry.path, resolved.path)
    }

    // Frontmatter relationships → edges (skip the "Type" key — those are type assignments)
    for (const [key, refs] of Object.entries(entry.relationships)) {
      if (key === 'Type') continue
      for (const ref of refs) {
        const target = wikilinkTarget(ref)
        const resolved = resolveEntry(entries, target)
        if (resolved) addEdge(entry.path, resolved.path)
      }
    }
  }

  return { nodes, links, totalEntries: entries.length }
}
