import { useRef, useState, useEffect } from "react"
import { useLocation } from "react-router-dom"
import { Group, Panel, Separator } from "react-resizable-panels"
import { PanelRightOpen, Trash2, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LogsPanel } from "@/components/LogsPanel"
import { WorkflowEditor } from "@/components/WorkflowEditor"
import { useLogs } from "@/contexts/LogsContext"
import type { RefObject } from "react"
import type { PanelImperativeHandle } from "react-resizable-panels"

const RIGHT_LAYOUT_STORAGE_KEY = "app-layout-right-workflow-logs"

export function RightPanel({
  panelRef,
  workflowVisible = true,
  logsVisible = true,
}: {
  panelRef: RefObject<PanelImperativeHandle | null>
  workflowVisible?: boolean
  logsVisible?: boolean
}) {
  const location = useLocation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [isNarrow, setIsNarrow] = useState(false)
  const isProjectPage = location.pathname.startsWith("/projects/")


  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setIsNarrow(el.offsetWidth < 60)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const defaultLayout = (): { workflow: number; logs: number } => {
    try {
      const s = localStorage.getItem(RIGHT_LAYOUT_STORAGE_KEY)
      if (s) {
        const parsed = JSON.parse(s) as { workflow?: number; logs?: number }
        if (typeof parsed.workflow === "number" && typeof parsed.logs === "number") {
          return { workflow: parsed.workflow, logs: parsed.logs }
        }
      }
    } catch {
      /* ignore */
    }
    return { workflow: 50, logs: 50 }
  }

  const layout = defaultLayout()

  const handleExpand = () => {
    panelRef.current?.expand()
  }

  const rightLayout = (() => {
    if (!isProjectPage) return { logs: 100 } as const
    const { workflow: w, logs: l } = layout
    if (!workflowVisible && !logsVisible) return { logs: 100 } as const
    if (!workflowVisible) return { logs: 100 } as const
    if (!logsVisible) return { workflow: 100 } as const
    return { workflow: w, logs: l }
  })()

  if (isNarrow) {
    return (
      <div ref={containerRef} className="h-full w-full flex flex-col items-center justify-center gap-2 py-2 bg-panel-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleExpand}
          title="Expand panel"
        >
          <PanelRightOpen className="h-4 w-4" />
        </Button>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="h-full w-full flex flex-col min-w-0 bg-panel-1 border-l border-border">
      <Group
        key={workflowVisible ? "workflow" : "no-workflow"}
        id="right-workflow-logs"
        orientation="vertical"
        className="flex-1 min-h-0 right-panel-group"
        defaultLayout={rightLayout as { [id: string]: number }}
        resizeTargetMinimumSize={{ coarse: 32, fine: 20 }}
        onLayoutChanged={(l) => {
          if (typeof l.workflow === "number" && typeof l.logs === "number") {
            localStorage.setItem(RIGHT_LAYOUT_STORAGE_KEY, JSON.stringify({ workflow: l.workflow, logs: l.logs }))
          }
        }}
      >
        {isProjectPage && workflowVisible && (
          <Panel
            id="workflow"
            defaultSize={`${rightLayout.workflow ?? 50}%`}
            minSize="20%"
            className="min-h-0 flex flex-col border-b border-border"
          >
            <div className="flex items-center justify-between px-2 py-2 border-b border-border/50 shrink-0" style={{ height: 32 }}>
              <span className="text-xs text-muted-foreground/70 font-medium">WORKFLOW</span>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              <WorkflowEditor />
            </div>
          </Panel>
        )}
        {isProjectPage && workflowVisible && logsVisible && (
          <Separator className="shrink-0" />
        )}
        {logsVisible && (
          <Panel
            id="logs"
            defaultSize={`${rightLayout.logs ?? 50}%`}
            minSize="20%"
            className="min-h-0 flex flex-col"
          >
            <LogsPanelHeader />
            <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
              <LogsPanel embedded hideHeader />
            </div>
          </Panel>
        )}
      </Group>
    </div>
  )
}

function formatLogTime(d: Date) {
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}

function LogsPanelHeader() {
  const { logs, clearLogs } = useLogs()
  const [copied, setCopied] = useState(false)

  const copyAllLogs = async () => {
    if (logs.length === 0) return
    const text = logs
      .map((log) => `${formatLogTime(log.timestamp)} ${log.message}`)
      .join("\n")
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex items-center justify-between px-2 py-2 border-b border-border/50 shrink-0" style={{ height: 32 }}>
      <span className="text-xs text-muted-foreground/70 font-medium">LOGS</span>
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={copyAllLogs}
          disabled={logs.length === 0}
          title={copied ? "Copied!" : "Copy all logs"}
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={clearLogs}
          title="Clear logs"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
