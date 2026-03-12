import { useWorkflowJob } from "@/contexts/WorkflowJobContext"
import { Brain } from "lucide-react"

export function AgentReasoningOverlay() {
  const ctx = useWorkflowJob()
  const agentOverlay = ctx?.agentOverlay

  if (!agentOverlay?.visible) return null

  return (
    <div
      className="absolute inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm border border-border rounded-lg shadow-xl overflow-hidden"
      style={{ minHeight: 200 }}
    >
      <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/50 shrink-0">
        <Brain className="h-4 w-4 text-primary animate-pulse" />
        <span className="text-sm font-medium">Agent reasoning</span>
        <span className="text-xs text-muted-foreground truncate flex-1">{agentOverlay.jobMessage}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4 font-mono text-sm">
        {agentOverlay.reasoningSteps.length === 0 ? (
          <div className="text-muted-foreground italic">Waiting for agent response...</div>
        ) : (
          agentOverlay.reasoningSteps.map((content: string, i: number) => (
            <div key={i} className="rounded-md bg-muted/30 p-3 border-l-2 border-primary/50">
              <div className="text-xs text-muted-foreground mb-1.5">Step {i + 1}</div>
              <div className="whitespace-pre-wrap text-foreground/90">{content}</div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
