import { useState, useMemo, useEffect } from 'react'
import type { VaultEntry } from '../../types'
import { buildGraphData } from './useGraphData'
import { GraphView } from './GraphView'
import { GraphControls } from './GraphControls'

interface GraphViewPanelProps {
  entries: VaultEntry[]
  onNavigate: (entry: VaultEntry) => void
  onCreateNote?: (title: string) => void
}

// Premium hook that reactive-ly tracks document dark theme changes
function useIsDarkMode() {
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains('dark')
  )

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'))
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    return () => observer.disconnect()
  }, [])

  return isDark
}

export function GraphViewPanel({
  entries,
  onNavigate,
  onCreateNote,
}: GraphViewPanelProps) {
  const [search, setSearch] = useState('')
  const [showOrphans, setShowOrphans] = useState(true)
  const [showGhosts, setShowGhosts] = useState(true)
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null)
  const [depth, setDepth] = useState(2)

  const isDarkMode = useIsDarkMode()

  const graphData = useMemo(
    () => buildGraphData(entries, { showOrphans, showGhosts, searchFilter: search }),
    [entries, showOrphans, showGhosts, search]
  )

  // Reset focus when focus node is removed from filtered data
  useEffect(() => {
    if (focusNodeId) {
      const nodeExists = graphData.nodes.some((n) => n.id === focusNodeId)
      if (!nodeExists) {
        setFocusNodeId(null)
      }
    }
  }, [graphData, focusNodeId])

  const handleNodeClick = (nodeTitle: string) => {
    const resolvedEntry = entries.find(
      (e) => e.title.toLowerCase() === nodeTitle.toLowerCase()
    )

    if (resolvedEntry) {
      onNavigate(resolvedEntry)
    } else if (onCreateNote) {
      const confirmCreate = window.confirm(
        `Note "${nodeTitle}" does not exist. Would you like to create it?`
      )
      if (confirmCreate) {
        onCreateNote(nodeTitle)
      }
    }
  }

  return (
    <div className="relative h-full w-full">
      <GraphView
        data={graphData}
        focusNodeId={focusNodeId}
        depth={depth}
        onNodeClick={handleNodeClick}
        isDarkMode={isDarkMode}
      />
      <GraphControls
        depth={depth}
        onDepthChange={setDepth}
        showOrphans={showOrphans}
        onShowOrphansChange={setShowOrphans}
        showGhosts={showGhosts}
        onShowGhostsChange={setShowGhosts}
        search={search}
        onSearchChange={setSearch}
        isFocused={!!focusNodeId}
        onClearFocus={() => setFocusNodeId(null)}
        focusNodeId={focusNodeId}
      />
    </div>
  )
}
export default GraphViewPanel
