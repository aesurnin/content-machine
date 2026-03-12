import { createContext, useContext, useState, type ReactNode } from "react"

export type AgentOverlayData = {
  visible: boolean
  reasoningSteps: string[]
  jobMessage: string
}

type WorkflowJobContextValue = {
  agentOverlay: AgentOverlayData | null
  setAgentOverlay: (data: AgentOverlayData | null) => void
}

const WorkflowJobContext = createContext<WorkflowJobContextValue | null>(null)

export function WorkflowJobProvider({ children }: { children: ReactNode }) {
  const [agentOverlay, setAgentOverlay] = useState<AgentOverlayData | null>(null)
  return (
    <WorkflowJobContext.Provider value={{ agentOverlay, setAgentOverlay }}>
      {children}
    </WorkflowJobContext.Provider>
  )
}

export function useWorkflowJob() {
  const ctx = useContext(WorkflowJobContext)
  return ctx
}
