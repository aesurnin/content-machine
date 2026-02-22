import { useState, useEffect, useCallback, useRef } from "react"
import { createPortal } from "react-dom"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CropModal } from "@/components/CropModal"
import { PromptBuilderModal } from "@/components/PromptBuilderModal"
import { ScenarioEditorModal, parseSlotsFromJson } from "@/components/ScenarioEditorModal"
import { VariableManagerModal } from "@/components/VariableManagerModal"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Plus,
  Trash2,
  Play,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  Loader2,
  Check,
  XCircle,
  FileDown,
  FileUp,
  Save,
  Eye,
  Clapperboard,
  Crop as CropIcon,
  Pencil,
  PlusCircle,
  MinusCircle,
  Database,
  Eraser,
  Clock,
  DollarSign,
  HelpCircle,
} from "lucide-react"
import { useSelectedVideo } from "@/contexts/SelectedVideoContext"
import { useLogs } from "@/contexts/LogsContext"
import { usePreviewVideo } from "@/contexts/PreviewVideoContext"
import { useLiveRemotion } from "@/contexts/LiveRemotionContext"
import { useAddStepPanel } from "@/contexts/AddStepPanelContext"
import { useWorkflowVariable } from "@/contexts/WorkflowVariableContext"
import { useWorkflowJob } from "@/contexts/WorkflowJobContext"

type WorkflowModuleDef = {
  id: string
  type: string
  params?: Record<string, unknown>
  outputs?: Record<string, string>
  inputs?: Record<string, string>
}

type WorkflowDefinition = {
  id?: string
  name: string
  modules: WorkflowModuleDef[]
}

type ModuleSlotDef = { key: string; label: string; kind: string }

type ModuleMeta = {
  type: string
  label: string
  description?: string
  quickParams?: string[]
  inputSlots?: ModuleSlotDef[]
  outputSlots?: ModuleSlotDef[]
  allowDynamicInputs?: boolean
  paramsSchema?: Array<{
    key: string
    label: string
    type: string
    default?: unknown
    min?: number
    max?: number
    options?: { value: string; label: string }[]
  }>
}

type StepStatus = "pending" | "running" | "done" | "error"

type TokenUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number }

function TtsCommentsJsonHelp({ content }: { content: string }) {
  const [hover, setHover] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const ref = useRef<HTMLSpanElement>(null)
  const handleMouseEnter = () => {
    const rect = ref.current?.getBoundingClientRect()
    if (rect) {
      setPos({ x: rect.left, y: rect.top })
      setHover(true)
    }
  }
  const handleMouseLeave = () => setHover(false)
  return (
    <>
      <span
        ref={ref}
        className="inline-flex cursor-help text-muted-foreground/70 hover:text-muted-foreground"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <HelpCircle className="h-3 w-3" />
      </span>
      {hover &&
        createPortal(
          <div
            className="fixed z-[9999] bg-background border border-border rounded-md shadow-lg px-2 py-1.5 text-xs max-w-[320px] break-words whitespace-normal text-foreground pointer-events-none"
            style={{ left: pos.x, top: pos.y - 8, transform: "translateY(-100%)" }}
          >
            {content}
          </div>,
          document.body
        )}
    </>
  )
}

type VideoWorkflowState = {
  currentWorkflowId: string | null
  workflow: WorkflowDefinition | null
  stepStatuses: Record<number, StepStatus>
  stepOutputUrls: Record<number, string>
  stepOutputContentTypes: Record<number, string>
  stepRemotionSceneUrls: Record<number, string>
  activeJobId: string | null
  activeJobStepIndex: number | undefined
  jobProgress: number
  jobMessage: string
  jobLogs: string[]
  jobStepIndex: number | undefined
  jobAgentReasoningSteps: string[]
  /** Token usage from last completed run (aggregated across all paid-API modules) */
  lastTotalTokenUsage: TokenUsage | null
  /** Estimated cost in USD from last completed run */
  lastTotalCostUsd: number | null
  /** Total execution time in ms from last completed run */
  lastTotalExecutionTimeMs: number | null
  runningAll: boolean
}

const defaultVideoState = (): VideoWorkflowState => ({
  currentWorkflowId: null,
  workflow: null,
  stepStatuses: {},
  stepOutputUrls: {},
  stepOutputContentTypes: {},
  stepRemotionSceneUrls: {},
  activeJobId: null,
  activeJobStepIndex: undefined,
  jobProgress: 0,
  jobMessage: "",
  jobLogs: [],
  jobStepIndex: undefined,
  jobAgentReasoningSteps: [],
  lastTotalTokenUsage: null,
  lastTotalCostUsd: null,
  lastTotalExecutionTimeMs: null,
  runningAll: false,
})

const CACHE_KEY_PREFIX = "workflow-cache"
const MAX_CACHED_LOGS = 500
const AUTOSAVE_KEY = "workflow-editor-autosave"
const AUTOSAVE_DEBOUNCE_MS = 2000

function getCacheKey(projectId: string, videoId: string) {
  return `${CACHE_KEY_PREFIX}:${projectId}:${videoId}`
}

function loadFromCache(projectId: string, videoId: string): Partial<VideoWorkflowState> | null {
  try {
    const raw = localStorage.getItem(getCacheKey(projectId, videoId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<VideoWorkflowState>
    if (parsed.stepStatuses) {
      const sanitized: Record<number, StepStatus> = {}
      for (const [k, v] of Object.entries(parsed.stepStatuses)) {
        if (v === "running") continue
        sanitized[Number(k)] = v as StepStatus
      }
      // If a step has an outputUrl it completed successfully — override any stale status
      if (parsed.stepOutputUrls) {
        for (const [k, url] of Object.entries(parsed.stepOutputUrls)) {
          if (url) sanitized[Number(k)] = "done"
        }
      }
      parsed.stepStatuses = sanitized
    }
    parsed.activeJobId = null
    parsed.runningAll = false
    if (parsed.lastTotalTokenUsage && typeof parsed.lastTotalTokenUsage.total_tokens !== "number") {
      parsed.lastTotalTokenUsage = undefined
    }
    if (typeof parsed.lastTotalCostUsd !== "number" || parsed.lastTotalCostUsd <= 0) {
      parsed.lastTotalCostUsd = undefined
    }
    if (typeof parsed.lastTotalExecutionTimeMs !== "number" || parsed.lastTotalExecutionTimeMs <= 0) {
      parsed.lastTotalExecutionTimeMs = undefined
    }
    return parsed
  } catch {
    return null
  }
}

function saveToCache(projectId: string, videoId: string, state: VideoWorkflowState) {
  try {
    const sanitizedStatuses: Record<number, StepStatus> = {}
    for (const [k, v] of Object.entries(state.stepStatuses)) {
      if (v !== "running") sanitizedStatuses[Number(k)] = v
    }
    const toSave = {
      currentWorkflowId: state.currentWorkflowId,
      workflow: state.workflow,
      stepStatuses: sanitizedStatuses,
      stepOutputUrls: state.stepOutputUrls,
      stepOutputContentTypes: state.stepOutputContentTypes,
      stepRemotionSceneUrls: state.stepRemotionSceneUrls,
      jobLogs: state.jobLogs.slice(-MAX_CACHED_LOGS),
      lastTotalTokenUsage: state.lastTotalTokenUsage ?? undefined,
      lastTotalCostUsd: state.lastTotalCostUsd ?? undefined,
      lastTotalExecutionTimeMs: state.lastTotalExecutionTimeMs ?? undefined,
    }
    localStorage.setItem(getCacheKey(projectId, videoId), JSON.stringify(toSave))
  } catch {
    // ignore
  }
}

function generateId() {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

export function WorkflowEditor() {
  const { selectedVideo, refreshAssets } = useSelectedVideo()
  const { addLog, fetchLogsForVideo } = useLogs()
  const workflowVariable = useWorkflowVariable()
  const { setAgentOverlay } = useWorkflowJob()
  const { setPreviewVideo } = usePreviewVideo()
  const { liveRemotion, setLiveRemotion } = useLiveRemotion()
  const { openAddStepPanel, closeAddStepPanel, setOnSelectModule } = useAddStepPanel()
  const [workflows, setWorkflows] = useState<{ id: string; name?: string }[]>([])
  const [stateByVideo, setStateByVideo] = useState<Record<string, VideoWorkflowState>>({})
  const [moduleTypes, setModuleTypes] = useState<ModuleMeta[]>([])
  const [saving, setSaving] = useState(false)
  const [newWorkflowName, setNewWorkflowName] = useState("")
  const [expandedModuleIndex, setExpandedModuleIndex] = useState<number | null>(null)
  const [cropModalOpen, setCropModalOpen] = useState(false)
  const [cropModuleIndex, setCropModuleIndex] = useState<number | null>(null)
  const [openPromptBuilder, setOpenPromptBuilder] = useState<{ index: number; paramKey: string } | null>(null)
  const [scenarioEditorOpen, setScenarioEditorOpen] = useState<number | null>(null)
  const [variableManagerOpen, setVariableManagerOpen] = useState(false)
  const [clearCacheConfirmIndex, setClearCacheConfirmIndex] = useState<number | null>(null)
  const [stepMetadataByModuleId, setStepMetadataByModuleId] = useState<Record<string, { executionTimeMs?: number; costUsd?: number }>>({})
  const [previewSlotsByModuleId, setPreviewSlotsByModuleId] = useState<Record<string, Array<{ key: string; kind: string; label?: string }>>>({})
  const [autoSave, setAutoSave] = useState(() => {
    try {
      return localStorage.getItem(AUTOSAVE_KEY) !== "false"
    } catch {
      return true
    }
  })

  const projectId = selectedVideo?.projectId
  const videoId = selectedVideo?.videoId

  const videoState = videoId ? (stateByVideo[videoId] ?? defaultVideoState()) : defaultVideoState()
  const {
    currentWorkflowId,
    workflow,
    stepStatuses,
    stepOutputUrls,
    stepOutputContentTypes,
    stepRemotionSceneUrls = {},
    activeJobId,
    jobProgress,
    jobMessage,
    jobLogs,
    jobStepIndex,
    jobAgentReasoningSteps,
    lastTotalTokenUsage,
    lastTotalCostUsd,
    lastTotalExecutionTimeMs,
    runningAll,
  } = videoState

  const isJobForCurrentVideo = activeJobId && videoId
  const showProgress = isJobForCurrentVideo
  const activeJobVideoIdRef = useRef<string | null>(null)
  const addModuleRef = useRef<(type: string) => void>(() => {})

  const updateVideoState = useCallback((vid: string, updates: Partial<VideoWorkflowState>) => {
    setStateByVideo((prev) => ({
      ...prev,
      [vid]: { ...(prev[vid] ?? defaultVideoState()), ...updates },
    }))
  }, [])

  const fetchWorkflows = useCallback(async () => {
    try {
      const r = await fetch("/api/workflows", { credentials: "include" })
      if (r.ok) {
        const list = await r.json()
        setWorkflows(list)
      }
    } catch (e) {
      addLog(`Failed to fetch workflows: ${e}`, "error")
    }
  }, [addLog])

  const fetchModuleTypes = useCallback(async () => {
    try {
      const r = await fetch("/api/workflows/modules/list", { credentials: "include" })
      if (r.ok) {
        const list = await r.json()
        setModuleTypes(list)
      }
    } catch (e) {
      addLog(`Failed to fetch module types: ${e}`, "error")
    }
  }, [addLog])

  useEffect(() => {
    fetchWorkflows()
    fetchModuleTypes()
  }, [fetchWorkflows, fetchModuleTypes])

  const workflowDataRef = useRef<string>("")
  useEffect(() => {
    if (!workflowVariable) return
    const key = workflow
      ? `${workflow.name}-${JSON.stringify(workflow.modules?.map((m) => ({ id: m.id, outputs: m.outputs })))}`
      : ""
    if (workflowDataRef.current === key) return
    workflowDataRef.current = key
    workflowVariable.setWorkflowData(
      workflow ? { name: workflow.name, modules: workflow.modules } : null,
      moduleTypes
    )
  }, [workflow, moduleTypes, workflowVariable])

  useEffect(() => {
    if (!projectId || !videoId) return
    const cached = loadFromCache(projectId, videoId)
    setStateByVideo((prev) => {
      if (prev[videoId]) return prev
      return { ...prev, [videoId]: { ...defaultVideoState(), ...cached } }
    })
  }, [projectId, videoId])

  /** R2 is single source of truth for saved workflows. When we have currentWorkflowId, fetch from R2
   * so edits made elsewhere propagate everywhere. Fallback to cached workflow only if R2 returns 404 (new/unsaved). */
  useEffect(() => {
    if (!videoId || !currentWorkflowId) return
    let cancelled = false
    fetch(`/api/workflows/${currentWorkflowId}`, { credentials: "include" })
      .then((r) => {
        if (cancelled) return null
        if (r.ok) return r.json()
        if (r.status === 404) return undefined
        return null
      })
      .then((def: WorkflowDefinition | undefined | null) => {
        if (cancelled) return
        if (def) {
          updateVideoState(videoId, { workflow: def })
        }
        // If 404, keep current workflow (new/unsaved). If error, keep as is.
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [videoId, currentWorkflowId, updateVideoState])

  const syncCacheState = useCallback(async (vid: string) => {
    const pid = projectIdRef.current
    if (!pid || !vid) return
    const wf = stateByVideoRef.current[vid]?.workflow
    if (!wf?.modules?.length) return
    try {
      const r = await fetch(`/api/projects/${pid}/videos/${vid}/workflow-cache/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ workflow: wf }),
      })
      if (!r.ok) return
      const data = await r.json() as {
        stepOutputUrls?: Record<number, string>
        stepOutputContentTypes?: Record<number, string>
        stepRemotionSceneUrls?: Record<number, string>
        stepStatuses?: Record<number, string>
        slotsByModuleId?: Record<string, Array<{ key: string; kind: string; label?: string }>>
      } | null
      if (!data) return
      if (data.slotsByModuleId && Object.keys(data.slotsByModuleId).length > 0) {
        setPreviewSlotsByModuleId((prev) => ({ ...prev, ...data.slotsByModuleId }))
      }
      setStateByVideo((prev) => {
        const s = prev[vid] ?? defaultVideoState()
        const next = { ...s }
        next.stepOutputUrls = data.stepOutputUrls ?? {}
        next.stepOutputContentTypes = data.stepOutputContentTypes ?? {}
        next.stepRemotionSceneUrls = data.stepRemotionSceneUrls ?? {}
        if (data.stepStatuses && Object.keys(data.stepStatuses).length > 0) {
          const merged: Record<number, StepStatus> = { ...s.stepStatuses }
          for (const [k, v] of Object.entries(data.stepStatuses)) {
            if (v === "done") merged[Number(k)] = "done"
          }
          next.stepStatuses = merged
        }
        return { ...prev, [vid]: next }
      })
    } catch {}
  }, [])

  /** Sync from backend cache (source of truth) after load. */
  useEffect(() => {
    if (!projectId || !videoId || !workflow?.modules?.length) return
    syncCacheState(videoId)
  }, [projectId, videoId, currentWorkflowId, syncCacheState])

  const saveCacheRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!projectId) return
    if (saveCacheRef.current) clearTimeout(saveCacheRef.current)
    saveCacheRef.current = setTimeout(() => {
      saveCacheRef.current = null
      for (const [vid, state] of Object.entries(stateByVideo)) {
        saveToCache(projectId, vid, state)
      }
    }, 500)
    return () => {
      if (saveCacheRef.current) clearTimeout(saveCacheRef.current)
    }
  }, [projectId, stateByVideo])

  const stateByVideoRef = useRef(stateByVideo)
  const projectIdRef = useRef(projectId)
  stateByVideoRef.current = stateByVideo
  projectIdRef.current = projectId ?? ""
  useEffect(() => {
    const onBeforeUnload = () => {
      const proj = projectIdRef.current
      if (!proj) return
      const state = stateByVideoRef.current
      for (const [vid, s] of Object.entries(state)) {
        saveToCache(proj, vid, s)
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [])

  const pollJob = useCallback(
    async (jobId: string) => {
      const jobVideoId = activeJobVideoIdRef.current
      if (!jobVideoId) return
      try {
        const r = await fetch(`/api/workflows/jobs/${jobId}`, { credentials: "include" })
        if (!r.ok) {
          if (r.status === 404) {
            activeJobVideoIdRef.current = null
            setStateByVideo((prev) => {
              const current = prev[jobVideoId] ?? defaultVideoState()
              const nextStatuses = { ...current.stepStatuses }
              for (const k of Object.keys(nextStatuses)) {
                if (nextStatuses[Number(k)] === "running") nextStatuses[Number(k)] = "pending"
              }
              return { ...prev, [jobVideoId]: { ...current, activeJobId: null, runningAll: false, stepStatuses: nextStatuses } }
            })
            addLog("Job no longer exists (server restarted?)", "warn", jobVideoId)
          }
          return
        }
        const job = await r.json()
        // When job completes/fails, fetch logs first so they appear together with the status update
        if ((job.status === "completed" || job.status === "failed") && projectIdRef.current && jobVideoId) {
          await fetchLogsForVideo(projectIdRef.current, jobVideoId).catch(() => {})
        } else if (projectIdRef.current && jobVideoId) {
          fetchLogsForVideo(projectIdRef.current, jobVideoId).catch(() => {})
        }
        setStateByVideo((prev) => {
          const current = prev[jobVideoId] ?? defaultVideoState()
          const wf = current.workflow
          const stepIdx = job.stepIndex
          const statuses: Record<number, StepStatus> = {}
          if (wf?.modules) {
            for (let i = 0; i < wf.modules.length; i++) {
              if (stepIdx != null) {
                statuses[i] = i < stepIdx ? "done" : i === stepIdx ? "running" : "pending"
              }
            }
          }
          const next = {
            ...current,
            jobProgress: job.progress ?? 0,
            jobMessage: job.message ?? "",
            jobLogs: job.logs ?? [],
            jobStepIndex: job.stepIndex,
            jobAgentReasoningSteps: job.agentReasoningSteps ?? [],
            ...(Object.keys(statuses).length > 0 ? { stepStatuses: statuses } : {}),
          }
          if (job.status !== "completed" && job.status !== "failed") return { ...prev, [jobVideoId]: next }
          activeJobVideoIdRef.current = null
          const stepIndex = job.stepIndex
          if (job.status === "completed") {
            const idx = stepIndex ?? (wf?.modules.length ?? 0) - 1
            const completedMod = wf?.modules?.[idx]
            if (completedMod?.type === "llm.scenario.generator" && completedMod?.id && projectIdRef.current && jobVideoId) {
              fetch(`/api/projects/${projectIdRef.current}/videos/${jobVideoId}/workflow-cache/slots/${encodeURIComponent(completedMod.id)}`, { credentials: "include" })
                .then((r) => (r.ok ? r.json() : null))
                .then((data: { slots?: Array<{ key: string; kind: string; label?: string }> } | null) => {
                  if (data?.slots?.length && completedMod?.id) {
                    setPreviewSlotsByModuleId((prev) => ({ ...prev, [completedMod.id]: data.slots! }))
                  }
                })
                .catch(() => {})
            }
            const stepOutputUrls = idx >= 0 && job.outputUrl ? { ...current.stepOutputUrls, [idx]: job.outputUrl } : current.stepOutputUrls
            const stepOutputContentTypes = idx >= 0 && job.outputContentType ? { ...current.stepOutputContentTypes, [idx]: job.outputContentType } : current.stepOutputContentTypes
            const stepRemotionSceneUrls = idx >= 0 && job.remotionSceneUrl ? { ...(current.stepRemotionSceneUrls ?? {}), [idx]: job.remotionSceneUrl } : (current.stepRemotionSceneUrls ?? {})
            // Start from current statuses so steps outside this run keep their "done" state
            const completedStatuses: Record<number, StepStatus> = { ...current.stepStatuses }
            const endIdx = stepIndex != null ? stepIndex + 1 : (wf?.modules.length ?? 0)
            for (let i = 0; i < endIdx; i++) completedStatuses[i] = "done"
            const lastTotalTokenUsage = job.totalTokenUsage && job.totalTokenUsage.total_tokens > 0 ? job.totalTokenUsage : null
            const lastTotalCostUsd = typeof job.totalCostUsd === 'number' && job.totalCostUsd > 0 ? job.totalCostUsd : null
            const lastTotalExecutionTimeMs = typeof job.totalExecutionTimeMs === 'number' && job.totalExecutionTimeMs > 0 ? job.totalExecutionTimeMs : null
            return { ...prev, [jobVideoId]: { ...next, activeJobId: null, runningAll: false, jobProgress: 100, stepOutputUrls, stepOutputContentTypes, stepRemotionSceneUrls, stepStatuses: completedStatuses, lastTotalTokenUsage, lastTotalCostUsd, lastTotalExecutionTimeMs } }
          }
          const failedIdx = job.stepResults?.findIndex((s: { success: boolean }) => !s.success) ?? stepIndex ?? 0
          // Clear outputUrl for the failed step so it won't be treated as "done" on reload
          const failedStepOutputUrls = { ...current.stepOutputUrls }
          const failedStepOutputContentTypes = { ...current.stepOutputContentTypes }
          const failedStepRemotionSceneUrls = { ...(current.stepRemotionSceneUrls ?? {}) }
          if (failedIdx >= 0) {
            delete (failedStepOutputUrls as Record<number, string>)[failedIdx]
            delete (failedStepOutputContentTypes as Record<number, string>)[failedIdx]
            delete (failedStepRemotionSceneUrls as Record<number, string>)[failedIdx]
          }
          // Preserve "done" for steps that have outputs and weren't part of this failed run
          const failedStatuses: Record<number, StepStatus> = { ...current.stepStatuses }
          for (let i = 0; i < (wf?.modules.length ?? 0); i++) {
            if (i < failedIdx) {
              failedStatuses[i] = "done"
            } else if (i === failedIdx) {
              failedStatuses[i] = "error"
            } else {
              // Keep "done" if the step has an existing output, otherwise "pending"
              failedStatuses[i] = failedStepOutputUrls[i] ? "done" : "pending"
            }
          }
          return { ...prev, [jobVideoId]: { ...next, activeJobId: null, runningAll: false, stepStatuses: failedStatuses, stepOutputUrls: failedStepOutputUrls, stepOutputContentTypes: failedStepOutputContentTypes, stepRemotionSceneUrls: failedStepRemotionSceneUrls } }
        })
        if (job.status === "completed") addLog("Workflow step completed", "info", jobVideoId)
        else if (job.status === "failed") addLog(`Failed: ${job.error}`, "error", jobVideoId)
        if ((job.status === "completed" || job.status === "failed") && jobVideoId) {
          syncCacheState(jobVideoId)
        }
      } catch {
        // ignore
      }
    },
    [addLog, fetchLogsForVideo, setPreviewSlotsByModuleId, syncCacheState]
  )

  useEffect(() => {
    if (!activeJobId) return
    const interval = setInterval(() => pollJob(activeJobId), 500)
    return () => clearInterval(interval)
  }, [activeJobId, pollJob])

  // Save to cache immediately when a job finishes (activeJobId → null) to avoid
  // race condition where beforeunload fires before React re-renders the ref.
  const prevActiveJobIdRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevActiveJobIdRef.current
    prevActiveJobIdRef.current = activeJobId ?? null
    if (prev !== null && activeJobId === null && projectId && videoId) {
      const state = stateByVideo[videoId]
      if (state) saveToCache(projectId, videoId, state)
    }
  }, [activeJobId, projectId, videoId, stateByVideo])

  useEffect(() => {
    if (!projectId || !videoId) return
    let cancelled = false
    fetch(`/api/projects/${projectId}/videos/${videoId}/workflow-cache/metadata`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: {
        metadata?: Record<string, { executionTimeMs?: number; costUsd?: number }>
        lastRun?: { totalTokenUsage?: TokenUsage; totalCostUsd?: number; totalExecutionTimeMs?: number }
      } | null) => {
        if (cancelled || !data) return
        setStepMetadataByModuleId(data.metadata ?? {})
        if (data.lastRun) {
          const lr = data.lastRun
          const lastTotalTokenUsage = lr.totalTokenUsage && lr.totalTokenUsage.total_tokens > 0 ? lr.totalTokenUsage : null
          const lastTotalCostUsd = typeof lr.totalCostUsd === "number" && lr.totalCostUsd > 0 ? lr.totalCostUsd : null
          const lastTotalExecutionTimeMs = typeof lr.totalExecutionTimeMs === "number" && lr.totalExecutionTimeMs > 0 ? lr.totalExecutionTimeMs : null
          updateVideoState(videoId, { lastTotalTokenUsage, lastTotalCostUsd, lastTotalExecutionTimeMs })
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [projectId, videoId, stepStatuses, activeJobId, lastTotalExecutionTimeMs, lastTotalCostUsd, updateVideoState])

  useEffect(() => {
    if (!setAgentOverlay) return
    const isAgentStep =
      activeJobId &&
      workflow &&
      jobStepIndex != null &&
      workflow.modules[jobStepIndex]?.type === "llm.agent"
    if (isAgentStep) {
      setAgentOverlay({
        visible: true,
        reasoningSteps: jobAgentReasoningSteps,
        jobMessage: jobMessage || "Agent thinking...",
      })
    } else {
      setAgentOverlay(null)
    }
  }, [activeJobId, workflow, jobStepIndex, jobAgentReasoningSteps, jobMessage, setAgentOverlay])

  const loadWorkflow = useCallback(
    async (id: string) => {
      if (!videoId) return
      try {
        const r = await fetch(`/api/workflows/${id}`, { credentials: "include" })
        if (r.ok) {
          const def = await r.json()
          updateVideoState(videoId, { workflow: def, currentWorkflowId: id, stepStatuses: {} })
          if (projectId) {
            fetch(`/api/projects/${projectId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ workflowId: id }),
            }).catch(() => {})
          }
        } else {
          addLog(`Workflow not found: ${id}`, "error")
        }
      } catch (e) {
        addLog(`Failed to load workflow: ${e}`, "error")
      }
    },
    [addLog, videoId, projectId, updateVideoState]
  )

  /** When new video has no workflow and project has default workflowId, auto-load it. */
  useEffect(() => {
    if (!projectId || !videoId || currentWorkflowId) return
    let cancelled = false
    fetch(`/api/projects/${projectId}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((p: { workflowId?: string } | null) => {
        if (cancelled || !p?.workflowId) return
        loadWorkflow(p.workflowId)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [projectId, videoId, currentWorkflowId, loadWorkflow])

  /** Restore active job on page reload when backend has a running job for this video */
  useEffect(() => {
    if (!projectId || !videoId) return
    let cancelled = false
    fetch(`/api/projects/${projectId}/active-workflow-jobs`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { jobs?: { videoId: string; jobId: string; workflowId?: string }[] } | null) => {
        if (cancelled || !data?.jobs) return
        const job = data.jobs.find((j) => j.videoId === videoId)
        if (!job) return
        activeJobVideoIdRef.current = videoId
        updateVideoState(videoId, { activeJobId: job.jobId, runningAll: true })
        if (job.workflowId) {
          loadWorkflow(job.workflowId)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [projectId, videoId, updateVideoState, loadWorkflow])

  const saveWorkflow = useCallback(
    async (id: string) => {
      if (!workflow) return
      setSaving(true)
      try {
        const r = await fetch(`/api/workflows/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(workflow),
        })
        if (r.ok) {
          addLog(`Workflow saved: ${id}`)
          await fetchWorkflows()
        } else {
          const err = await r.json().catch(() => ({}))
          addLog(`Save failed: ${err.error || r.status}`, "error")
        }
      } catch (e) {
        addLog(`Save failed: ${e}`, "error")
      } finally {
        setSaving(false)
      }
    },
    [workflow, addLog, fetchWorkflows]
  )

  useEffect(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, String(autoSave))
    } catch {
      // ignore
    }
  }, [autoSave])

  const autoSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!autoSave || !currentWorkflowId || !workflow) return
    if (autoSaveRef.current) clearTimeout(autoSaveRef.current)
    autoSaveRef.current = setTimeout(() => {
      autoSaveRef.current = null
      saveWorkflow(currentWorkflowId)
    }, AUTOSAVE_DEBOUNCE_MS)
    return () => {
      if (autoSaveRef.current) clearTimeout(autoSaveRef.current)
    }
  }, [autoSave, currentWorkflowId, workflow, saveWorkflow])

  const createNewWorkflow = () => {
    if (!videoId) return
    const id = `workflow_${Date.now()}`
    const name = newWorkflowName || "New Workflow"
    updateVideoState(videoId, {
      workflow: { id, name, modules: [] },
      currentWorkflowId: id,
      stepStatuses: {},
    })
    setNewWorkflowName("")
    setWorkflows((prev) => [...prev.filter((w) => w.id !== id), { id, name }])
  }

  const addModule = (type: string) => {
    if (!videoId || !workflow) return
    const meta = moduleTypes.find((m) => m.type === type)
    const params: Record<string, unknown> = {}
    for (const p of meta?.paramsSchema ?? []) {
      if (p.default !== undefined) params[p.key] = p.default
    }
    const prevModules = workflow.modules
    const lastVideoOutput = prevModules
      .flatMap((m) => (m.outputs?.video ? [m.outputs.video] : []))
      .pop()
    const lastTextOutput = prevModules
      .flatMap((m) => (m.outputs?.text ? [m.outputs.text] : []))
      .pop()
    const nextVideoNum =
      prevModules.reduce((n, m) => {
        const v = m.outputs?.video
        const match = v?.match(/^video_(\d+)$/)
        return match ? Math.max(n, parseInt(match[1], 10)) : n
      }, 0) + 1
    const nextTextNum =
      prevModules.reduce((n, m) => {
        const v = m.outputs?.text
        const match = v?.match(/^text_(\d+)$/)
        return match ? Math.max(n, parseInt(match[1], 10)) : n
      }, 0) + 1
    const nextAudioNum =
      prevModules.reduce((n, m) => {
        const vals = Object.values(m.outputs ?? {})
        for (const v of vals) {
          const match = typeof v === "string" ? v.match(/^audio_(\d+)$/) : null
          if (match) n = Math.max(n, parseInt(match[1], 10))
        }
        return n
      }, 0) + 1
    const inputs: Record<string, string> = {}
    const outputs: Record<string, string> = {}
    for (const slot of meta?.inputSlots ?? []) {
      if (slot.kind === "video") {
        inputs[slot.key] = lastVideoOutput ?? "source"
      }
      if (slot.kind === "text") {
        inputs[slot.key] = lastTextOutput ?? ""
      }
    }
    for (const slot of meta?.outputSlots ?? []) {
      if (slot.kind === "video") {
        outputs[slot.key] = `video_${nextVideoNum}`
      }
      if (slot.kind === "text") {
        outputs[slot.key] = `text_${nextTextNum}`
      }
      if (slot.kind === "file") {
        outputs[slot.key] = `audio_${nextAudioNum}`
      }
    }
    const newMod: WorkflowModuleDef = {
      id: generateId(),
      type,
      params: Object.keys(params).length ? params : undefined,
      ...(Object.keys(inputs).length ? { inputs } : undefined),
      ...(Object.keys(outputs).length ? { outputs } : undefined),
    }
    updateVideoState(videoId, {
      workflow: {
        ...workflow,
        modules: [...prevModules, newMod],
      },
    })
    if (projectId) {
      fetch(`/api/projects/${projectId}/videos/${videoId}/workflow-cache/ensure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          items: [{ moduleId: newMod.id, moduleType: type }],
        }),
      })
        .then(() => refreshAssets())
        .catch(() => {})
    }
  }
  addModuleRef.current = addModule

  useEffect(() => {
    if (!workflow || !videoId) {
      setOnSelectModule(null)
      return
    }
    setOnSelectModule((type: string) => {
      addModuleRef.current(type)
      closeAddStepPanel()
    })
    return () => setOnSelectModule(null)
  }, [workflow, videoId, setOnSelectModule, closeAddStepPanel])

  const removeModule = (index: number) => {
    if (!projectId || !videoId || !workflow) return
    const removed = workflow.modules[index]
    const nextStatuses = { ...stepStatuses }
    delete nextStatuses[index]
    updateVideoState(videoId, {
      workflow: { ...workflow, modules: workflow.modules.filter((_, i) => i !== index) },
      stepStatuses: nextStatuses,
    })
    if (removed?.id) {
      fetch(`/api/projects/${projectId}/videos/${videoId}/workflow-cache/cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ moduleIds: [removed.id] }),
      })
        .then(() => refreshAssets())
        .catch(() => {})
    }
  }

  const clearModuleCache = (index: number) => {
    if (!projectId || !videoId || !workflow) return
    const mod = workflow.modules[index]
    if (!mod?.id) return

    const nextStepOutputUrls = { ...stepOutputUrls }
    delete nextStepOutputUrls[index]
    const nextStepOutputContentTypes = { ...stepOutputContentTypes }
    delete nextStepOutputContentTypes[index]
    const nextStepRemotionSceneUrls = { ...stepRemotionSceneUrls }
    delete nextStepRemotionSceneUrls[index]
    const nextStepStatuses = { ...stepStatuses, [index]: "pending" as const }

    const stateToSave: VideoWorkflowState = {
      ...videoState,
      stepOutputUrls: nextStepOutputUrls,
      stepOutputContentTypes: nextStepOutputContentTypes,
      stepRemotionSceneUrls: nextStepRemotionSceneUrls,
      stepStatuses: nextStepStatuses,
    }
    saveToCache(projectId, videoId, stateToSave)

    updateVideoState(videoId, {
      stepOutputUrls: nextStepOutputUrls,
      stepOutputContentTypes: nextStepOutputContentTypes,
      stepRemotionSceneUrls: nextStepRemotionSceneUrls,
      stepStatuses: nextStepStatuses,
    })

    fetch(`/api/projects/${projectId}/videos/${videoId}/workflow-cache/cleanup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ moduleIds: [mod.id] }),
    })
      .then(() => {
        refreshAssets()
        return fetch(`/api/projects/${projectId}/videos/${videoId}/workflow-cache/ensure`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ items: [{ moduleId: mod.id, moduleType: mod.type }] }),
        })
      })
      .then(() => refreshAssets())
      .catch(() => {})
    addLog(`Cache cleared for step ${index + 1}: ${mod.type}`, "info", videoId)
  }

  const moveModule = (index: number, dir: "up" | "down") => {
    if (!videoId || !workflow) return
    const newIdx = dir === "up" ? index - 1 : index + 1
    if (newIdx < 0 || newIdx >= workflow.modules.length) return
    const arr = [...workflow.modules]
    ;[arr[index], arr[newIdx]] = [arr[newIdx], arr[index]]
    const nextStatuses = { ...stepStatuses }
    const a = nextStatuses[index]
    const b = nextStatuses[newIdx]
    nextStatuses[index] = b ?? "pending"
    nextStatuses[newIdx] = a ?? "pending"
    const swapByIndex = <T,>(rec: Record<number, T>): Record<number, T> => {
      const next = { ...rec }
      const va = next[index]
      const vb = next[newIdx]
      if (vb !== undefined) next[index] = vb
      else delete next[index]
      if (va !== undefined) next[newIdx] = va
      else delete next[newIdx]
      return next
    }
    const nextOutputUrls = swapByIndex(stepOutputUrls)
    const nextContentTypes = swapByIndex(stepOutputContentTypes)
    const nextRemotionUrls = swapByIndex(stepRemotionSceneUrls)
    updateVideoState(videoId, {
      workflow: { ...workflow, modules: arr },
      stepStatuses: nextStatuses,
      stepOutputUrls: nextOutputUrls,
      stepOutputContentTypes: nextContentTypes,
      stepRemotionSceneUrls: nextRemotionUrls,
    })
  }

  const updateModuleParams = (index: number, params: Record<string, unknown>) => {
    if (!videoId || !workflow) return
    const mods = [...workflow.modules]
    mods[index] = { ...mods[index], params }
    updateVideoState(videoId, { workflow: { ...workflow, modules: mods } })
    if (liveRemotion.moduleIndex === index && mods[index].type === "video.render.remotion" && String(params.sceneSource ?? mods[index].params?.sceneSource ?? "variable") === "inline") {
      const jsonStr = String(params.sceneJsonInline ?? "").trim()
      if (jsonStr) {
        try {
          const sceneData = JSON.parse(jsonStr) as Record<string, unknown>
          setLiveRemotion(index, sceneData)
        } catch {
          /* invalid JSON, keep previous scene */
        }
      }
    }
  }

  const updateModuleInputs = (index: number, inputs: Record<string, string>) => {
    if (!videoId || !workflow) return
    const mods = [...workflow.modules]
    mods[index] = { ...mods[index], inputs }
    updateVideoState(videoId, { workflow: { ...workflow, modules: mods } })
  }

  const updateModuleOutputs = (index: number, outputs: Record<string, string>) => {
    if (!videoId || !workflow) return
    const mods = [...workflow.modules]
    mods[index] = { ...mods[index], outputs }
    updateVideoState(videoId, { workflow: { ...workflow, modules: mods } })
  }

  /**
   * Rename variable: replace oldName with newName in all module INPUTS only.
   * Outputs are NOT replaced — each module's output is edited independently.
   * This avoids the bug where two modules with the same output name would both
   * get renamed when editing one of them.
   */
  const renameVariableInWorkflow = (oldName: string, newName: string) => {
    if (!videoId || !workflow || !oldName || !newName || oldName === newName || oldName === "source") return
    const mods = workflow.modules.map((m) => {
      const replace = (v: string) => (v === oldName ? newName : v)
      const inputs = m.inputs
        ? Object.fromEntries(Object.entries(m.inputs).map(([k, v]) => [k, replace(v)]))
        : undefined
      return { ...m, ...(inputs && { inputs }) }
    })
    updateVideoState(videoId, { workflow: { ...workflow, modules: mods } })
  }

  /** Build a map of variable name -> slot kind for all outputs up to (exclusive) moduleIndex. */
  const getVariableKindMap = (moduleIndex: number): Record<string, string> => {
    const map: Record<string, string> = { source: "video" }
    for (let i = 0; i < moduleIndex; i++) {
      const m = workflow?.modules[i]
      const meta = moduleTypes.find((mt) => mt.type === m?.type)
      if (!m?.outputs) continue
      for (const [slotKey, varName] of Object.entries(m.outputs)) {
        const slot = meta?.outputSlots?.find((s) => s.key === slotKey)
        map[varName] = slot?.kind ?? "file"
      }
    }
    return map
  }

  const getAvailableVariablesForModule = (moduleIndex: number): string[] => {
    return Object.keys(getVariableKindMap(moduleIndex)).sort()
  }

  /**
   * Get available variables filtered by slot kind.
   * - "video" slots -> only video variables
   * - "text" slots  -> only text variables
   * - "file" slots  -> all variables (video, text, file)
   */
  const getAvailableVariablesByKindForModule = (moduleIndex: number, kind: string): string[] => {
    const map = getVariableKindMap(moduleIndex)
    if (kind === "file") {
      return Object.keys(map).sort()
    }
    return Object.entries(map)
      .filter(([, k]) => k === kind)
      .map(([name]) => name)
      .sort()
  }

  /** Only variables that hold text (from steps with text output slots). Use for prompt placeholders. */
  const getAvailableTextVariablesForModule = (moduleIndex: number): string[] => {
    return getAvailableVariablesByKindForModule(moduleIndex, "text")
  }

  const runStep = async (stepIndex: number) => {
    if (!projectId || !videoId || !currentWorkflowId || !workflow) {
      addLog("Select a project, video and workflow first", "warn", videoId ?? undefined)
      return
    }
    updateVideoState(videoId, { stepStatuses: { ...stepStatuses, [stepIndex]: "running" }, jobLogs: [] })
    addLog(`Running step ${stepIndex + 1}...`, "info", videoId)
    try {
      const body = { projectId, videoId, workflow }
      const r = await fetch(`/api/workflows/${currentWorkflowId}/step/${stepIndex}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      })
      const data = await r.json().catch(async () => ({ error: await r.text().catch(() => String(r.status)) }))
      if (r.status === 202 && data.jobId) {
        activeJobVideoIdRef.current = videoId
        updateVideoState(videoId, { activeJobId: data.jobId, activeJobStepIndex: stepIndex })
      } else if (!r.ok) {
        updateVideoState(videoId, { stepStatuses: { ...stepStatuses, [stepIndex]: "error" } })
        addLog(`Step ${stepIndex + 1} failed: ${data.error || r.status}`, "error", videoId)
      }
    } catch (e) {
      updateVideoState(videoId, { stepStatuses: { ...stepStatuses, [stepIndex]: "error" } })
      addLog(`Step failed: ${e}`, "error", videoId)
    }
  }

  const runAll = async () => {
    if (!projectId || !videoId || !currentWorkflowId || !workflow?.modules.length) {
      addLog("Select project, video and workflow with modules", "warn", videoId ?? undefined)
      return
    }
    activeJobVideoIdRef.current = videoId
    updateVideoState(videoId, { runningAll: true, stepStatuses: {}, jobLogs: [] })
    addLog("Running workflow...", "info", videoId)
    try {
      const body = { projectId, videoId, workflow }
      const r = await fetch(`/api/workflows/${currentWorkflowId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      })
      const data = await r.json().catch(async () => ({ error: await r.text().catch(() => String(r.status)) }))
      if (r.status === 202 && data.jobId) {
        updateVideoState(videoId, { activeJobId: data.jobId, activeJobStepIndex: undefined })
      } else if (!r.ok) {
        addLog(`Workflow failed: ${data.error || r.status}`, "error", videoId)
        updateVideoState(videoId, { runningAll: false })
      }
    } catch (e) {
      addLog(`Workflow failed: ${e}`, "error", videoId)
      updateVideoState(videoId, { runningAll: false })
    }
  }

  const generateScenarioForModal = useCallback(async (prompt: string, params: Record<string, unknown>): Promise<{ json: Record<string, unknown>; slots: Array<{ key: string; kind: string; label?: string }> } | { error: string }> => {
    if (!projectId || !videoId) return { error: "No project or video" }
    addLog("Generating scenario...", "info", videoId)
    try {
      const r = await fetch(`/api/projects/${projectId}/videos/${videoId}/generate-scenario`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ prompt, params }),
      })
      const data = await r.json().catch(async () => ({ error: await r.text().catch(() => String(r.status)) }))
      if (r.ok && data.json && data.slots) {
        addLog(`Scenario generated: ${data.slots.length} slot(s)`, "info", videoId)
        return { json: data.json, slots: data.slots }
      }
      const err = data.error || String(r.status)
      addLog(`Scenario generation failed: ${err}`, "error", videoId)
      return { error: err }
    } catch (e) {
      const msg = String(e)
      addLog(`Scenario generation failed: ${msg}`, "error", videoId)
      return { error: msg }
    }
  }, [projectId, videoId, addLog])

  const exportWorkflow = () => {
    if (!workflow) return
    const blob = new Blob([JSON.stringify(workflow, null, 2)], {
      type: "application/json",
    })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = `workflow_${currentWorkflowId || "export"}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const importWorkflow = () => {
    if (!videoId) return
    const input = document.createElement("input")
    input.type = "file"
    input.accept = "application/json,.json"
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const def = JSON.parse(text) as WorkflowDefinition
        updateVideoState(videoId, {
          workflow: def,
          currentWorkflowId: def.id ?? `imported_${Date.now()}`,
          stepStatuses: {},
        })
        addLog("Workflow imported")
      } catch (err) {
        addLog(`Import failed: ${err}`, "error")
      }
    }
    input.click()
  }

  const getModuleLabel = (type: string) =>
    moduleTypes.find((m) => m.type === type)?.label ?? type

  const handlePreview = (url: string, label: string, contentType?: string, moduleType?: string, remotionSceneUrl?: string) => {
    const bustCache = (u: string) => u.startsWith("/") ? `${u}${u.includes("?") ? "&" : "?"}_t=${Date.now()}` : u
    const freshUrl = bustCache(url)
    const base = { url: freshUrl, label, contentType: contentType ?? "video/mp4" }
    const isRemotion = moduleType === "video.render.remotion"
    const sceneUrl = isRemotion ? (remotionSceneUrl ?? (url.includes("/file?") ? url.replace(/path=[^&]+/, "path=scene.json") : undefined)) : undefined
    setPreviewVideo(sceneUrl ? { ...base, remotionSceneUrl: bustCache(sceneUrl) } : base)
  }

  const handleRemotionScenePreview = (idx: number) => {
    if (!workflow) return
    const mod = workflow.modules[idx]
    const modParams = mod.params ?? {}
    const sceneSource = String(modParams.sceneSource ?? "variable")

    if (sceneSource === "inline") {
      const jsonStr = String(modParams.sceneJsonInline ?? "").trim()
      if (!jsonStr) {
        addLog("Inline JSON is empty. Enter scene JSON in the Inline JSON field.", "warn", videoId ?? undefined)
        return
      }
      try {
        const sceneData = JSON.parse(jsonStr) as Record<string, unknown>
        setPreviewVideo({
          url: "",
          label: "Remotion Scene Preview",
          contentType: "application/json",
          inlineRemotionScene: sceneData,
        })
        setLiveRemotion(idx, sceneData)
      } catch {
        addLog("Invalid JSON in Scene JSON field — check the syntax.", "error", videoId ?? undefined)
      }
    } else {
      const sceneVar = mod.inputs?.scene
      if (!sceneVar) {
        addLog("No scene variable connected. Set the Scene JSON input.", "warn", videoId ?? undefined)
        return
      }
      const sourceIdx = workflow.modules.findIndex(
        (m, i) => i < idx && m.outputs && Object.values(m.outputs).includes(sceneVar)
      )
      if (sourceIdx >= 0 && stepOutputUrls[sourceIdx]) {
        setPreviewVideo({
          url: stepOutputUrls[sourceIdx],
          label: "Remotion Scene Preview",
          contentType: "application/json",
          remotionSceneUrl: stepOutputUrls[sourceIdx],
        })
      } else {
        addLog("Run the source step first to generate scene JSON for preview.", "warn", videoId ?? undefined)
      }
    }
  }

  const [cropInputVideoUrl, setCropInputVideoUrl] = useState<string | null>(null)

  const handleOpenCrop = async (index: number) => {
    setCropModuleIndex(index)
    setCropModalOpen(true)
    setCropInputVideoUrl(null)
    if (!projectId || !videoId || !currentWorkflowId || !workflow) return
    try {
      const r = await fetch(`/api/workflows/${currentWorkflowId}/crop-input-video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ projectId, videoId, workflow, stepIndex: index }),
      })
      if (r.ok) {
        const { url } = await r.json()
        setCropInputVideoUrl(url)
      } else {
        setCropInputVideoUrl(selectedVideo?.streamUrl ?? selectedVideo?.playUrl ?? "")
      }
    } catch {
      setCropInputVideoUrl(selectedVideo?.streamUrl ?? selectedVideo?.playUrl ?? "")
    }
  }

  const handleSaveCrop = async (crop: { left: number; top: number; right: number; bottom: number }) => {
    if (cropModuleIndex === null) return
    const providerId = selectedVideo?.metadata?.providerId
    if (providerId) {
      const r = await fetch(`/api/providers/${providerId}/crop`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(crop),
      })
      if (r.ok) {
        addLog(`Provider crop saved (global preset for this provider)`, "info")
        updateModuleParams(cropModuleIndex, { ...workflow!.modules[cropModuleIndex].params, ...crop })
      } else {
        addLog(`Failed to save provider crop: ${r.status}`, "error")
      }
    } else {
      updateModuleParams(cropModuleIndex, { ...workflow!.modules[cropModuleIndex].params, ...crop })
    }
  }

  const handleTestCrop = async (crop: { left: number; top: number; right: number; bottom: number; time: number }) => {
    if (!projectId || !videoId || !currentWorkflowId || !workflow || cropModuleIndex === null) throw new Error("Missing context")
    const r = await fetch(`/api/workflows/${currentWorkflowId}/test-crop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ projectId, videoId, workflow, stepIndex: cropModuleIndex, ...crop }),
    })
    if (!r.ok) throw new Error("Failed to generate preview")
    const data = await r.json()
    return data.image
  }

  if (!projectId || !videoId) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        Select a video in the project to edit workflows
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-panel-2">
      <ConfirmDialog
        open={clearCacheConfirmIndex !== null}
        onOpenChange={(open) => !open && setClearCacheConfirmIndex(null)}
        title="Clear cache"
        message={
          clearCacheConfirmIndex != null && workflow?.modules[clearCacheConfirmIndex]
            ? `Clear cache for step ${clearCacheConfirmIndex + 1} (${workflow.modules[clearCacheConfirmIndex].type})? The step will need to be re-run.`
            : "Clear cache for this step?"
        }
        confirmLabel="Clear cache"
        variant="destructive"
        onConfirm={() => {
          if (clearCacheConfirmIndex != null) {
            clearModuleCache(clearCacheConfirmIndex)
          }
        }}
      />
      <div className="px-4 pt-3 pb-3 border-b shrink-0">
        <div className="flex items-center gap-3 flex-wrap">
          <select
            className="h-8 rounded-md border border-input bg-background px-3 text-sm min-w-[160px] focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
            value={currentWorkflowId ?? ""}
            onChange={(e) => {
              const v = e.target.value
              if (v) loadWorkflow(v)
              else if (videoId) updateVideoState(videoId, { currentWorkflowId: null, workflow: null })
            }}
          >
            <option value="">— Select workflow —</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name ?? w.id}
              </option>
            ))}
          </select>
          <div className="h-5 w-px bg-border" aria-hidden />
          <div className="flex items-center gap-1.5">
            <Input
              className="h-8 w-36 text-sm"
              placeholder="New workflow name"
              value={newWorkflowName}
              onChange={(e) => setNewWorkflowName(e.target.value)}
            />
            <Button variant="outline" size="sm" className="h-8" onClick={createNewWorkflow}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              New
            </Button>
          </div>
          <div className="h-5 w-px bg-border" aria-hidden />
          <label className="flex items-center gap-2 px-2.5 py-1.5 rounded-md hover:bg-muted/60 cursor-pointer select-none transition-colors">
            <input
              type="checkbox"
              checked={autoSave}
              onChange={(e) => setAutoSave(e.target.checked)}
              className="h-4 w-4 rounded border-input accent-primary cursor-pointer"
            />
            <span className="text-xs font-medium text-foreground">Auto-save</span>
          </label>
          <div className="h-5 w-px bg-border" aria-hidden />
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2"
              onClick={() => currentWorkflowId && saveWorkflow(currentWorkflowId)}
              disabled={!currentWorkflowId || saving}
              title="Save workflow"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            </Button>
            <Button variant="ghost" size="sm" className="h-8 px-2" onClick={exportWorkflow} disabled={!workflow} title="Export">
              <FileDown className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="sm" className="h-8 px-2" onClick={importWorkflow} title="Import">
              <FileUp className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2"
              onClick={() => setVariableManagerOpen(true)}
              title="Variable Manager"
            >
              <Database className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {(lastTotalExecutionTimeMs != null && lastTotalExecutionTimeMs > 0) || (lastTotalCostUsd != null && lastTotalCostUsd > 0) ? (
        <div className="px-4 py-2.5 bg-primary/5 border-b border-primary/10 shrink-0 flex items-center gap-6">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Last run</span>
          {lastTotalExecutionTimeMs != null && lastTotalExecutionTimeMs > 0 && (
            <div className="flex items-center gap-1.5">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold text-foreground">{(lastTotalExecutionTimeMs / 1000).toFixed(1)}s</span>
            </div>
          )}
          {lastTotalCostUsd != null && lastTotalCostUsd > 0 && (
            <div className="flex items-center gap-1.5">
              <DollarSign className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold text-foreground">${lastTotalCostUsd.toFixed(4)}</span>
            </div>
          )}
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {workflow && (
          <>
            {(showProgress && activeJobId) || lastTotalTokenUsage || lastTotalCostUsd || lastTotalExecutionTimeMs ? (
              <div className="rounded-lg border bg-muted/40 p-3 space-y-2.5 shadow-sm">
                {activeJobId && (
                  <div className="flex items-center justify-between text-xs gap-2">
                    <span className="font-medium truncate">{jobMessage || "Running..."}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-6 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={async () => {
                          try {
                            const r = await fetch(`/api/queue/jobs/${activeJobId}/kill`, { method: "POST", credentials: "include" })
                            if (r.ok) addLog("Cancellation requested", "info", videoId ?? undefined)
                          } catch { addLog("Cancel request failed", "error", videoId ?? undefined) }
                        }}
                      >
                        Cancel
                      </Button>
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                    </div>
                  </div>
                )}
                {activeJobId && (
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all duration-300 rounded-full"
                      style={{ width: `${jobProgress}%` }}
                    />
                  </div>
                )}
                {((lastTotalTokenUsage?.total_tokens ?? 0) > 0 || (lastTotalCostUsd != null && lastTotalCostUsd > 0) || (lastTotalExecutionTimeMs != null && lastTotalExecutionTimeMs > 0)) && (
                  <div className="text-xs text-muted-foreground pt-1 border-t space-y-0.5">
                    {lastTotalExecutionTimeMs != null && lastTotalExecutionTimeMs > 0 && (
                      <div>Execution time: {(lastTotalExecutionTimeMs / 1000).toFixed(1)}s</div>
                    )}
                    {lastTotalTokenUsage && lastTotalTokenUsage.total_tokens > 0 && (
                      <div>Total tokens: {lastTotalTokenUsage.prompt_tokens} prompt + {lastTotalTokenUsage.completion_tokens} completion = {lastTotalTokenUsage.total_tokens} total</div>
                    )}
                    {lastTotalCostUsd != null && lastTotalCostUsd > 0 && (
                      <div className="font-medium text-foreground">Estimated cost: ${lastTotalCostUsd.toFixed(4)}</div>
                    )}
                  </div>
                )}
              </div>
            ) : null}
            <div className="flex items-center justify-between px-1">
              <span className="text-sm font-medium text-muted-foreground">
                {workflow.name} · {workflow.modules.length} {workflow.modules.length === 1 ? "module" : "modules"}
              </span>
              <Button
                size="sm"
                className="h-8"
                onClick={runAll}
                disabled={runningAll || !!activeJobId || !workflow.modules.length}
              >
                {runningAll ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                ) : (
                  <Play className="h-3.5 w-3.5 mr-1.5" />
                )}
                Run All
              </Button>
            </div>

            <div className="space-y-2.5">
              {workflow.modules.map((mod, idx) => (
                <ModuleBlock
                  key={mod.id}
                  module={mod}
                  index={idx}
                  moduleTypes={moduleTypes}
                  status={stepStatuses[idx] ?? "pending"}
                  projectId={projectId}
                  videoId={videoId}
                  stepMetadata={stepMetadataByModuleId[mod.id]}
                  outputUrl={stepOutputUrls[idx]}
                  remotionSceneUrl={stepRemotionSceneUrls[idx]}
                  expanded={expandedModuleIndex === idx}
                  onToggleExpand={() => setExpandedModuleIndex((i) => (i === idx ? null : idx))}
                  onRemove={() => removeModule(idx)}
                  onMoveUp={() => moveModule(idx, "up")}
                  onMoveDown={() => moveModule(idx, "down")}
                  onParamsChange={(params) => updateModuleParams(idx, params)}
                  onInputsChange={(inputs) => updateModuleInputs(idx, inputs)}
                  onOutputsChange={(outputs) => updateModuleOutputs(idx, outputs)}
                  onRenameVariable={renameVariableInWorkflow}
                  onRunStep={() => runStep(idx)}
                  onClearCache={() => setClearCacheConfirmIndex(idx)}
                  onPreview={() => stepOutputUrls[idx] && handlePreview(stepOutputUrls[idx], `Step ${idx + 1}`, stepOutputContentTypes[idx], mod.type, stepRemotionSceneUrls[idx])}
                  onScenePreview={
                    mod.type === "video.render.remotion"
                      ? () => handleRemotionScenePreview(idx)
                      : undefined
                  }
                  getModuleLabel={getModuleLabel}
                  getAvailableVariables={() => getAvailableVariablesForModule(idx)}
                  getAvailableVariablesByKind={(kind) => getAvailableVariablesByKindForModule(idx, kind)}
                  onOpenCrop={() => handleOpenCrop(idx)}
                  onOpenPromptBuilder={(paramKey) => setOpenPromptBuilder({ index: idx, paramKey })}
                  previewSlots={mod.type === "llm.scenario.generator" ? previewSlotsByModuleId[mod.id] : undefined}
                  onOpenScenarioEditor={
                    mod.type === "llm.scenario.generator"
                      ? () => setScenarioEditorOpen(idx)
                      : undefined
                  }
                />
              ))}
              <div className="flex justify-center pt-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/80"
                  onClick={openAddStepPanel}
                  title="Add step"
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
      {openPromptBuilder && workflow && (() => {
        const { index, paramKey } = openPromptBuilder
        const mod = workflow.modules[index]
        const params = mod?.params ?? {}
        const currentValue = String(params[paramKey] ?? "")
        const meta = moduleTypes.find((m) => m.type === mod?.type)
        const paramLabel = meta?.paramsSchema?.find((p) => p.key === paramKey)?.label ?? paramKey
        return (
          <PromptBuilderModal
            isOpen={true}
            onClose={() => setOpenPromptBuilder(null)}
            value={currentValue}
            onChange={(v) => updateModuleParams(index, { ...params, [paramKey]: v })}
            availableVariables={getAvailableTextVariablesForModule(index)}
            label={paramLabel}
          />
        )
      })()}

      {scenarioEditorOpen !== null && workflow && (() => {
        const idx = scenarioEditorOpen
        const mod = workflow.modules[idx]
        const params = mod?.params ?? {}
        return (
          <ScenarioEditorModal
            isOpen={true}
            onClose={() => setScenarioEditorOpen(null)}
            initialPrompt={String(params.prompt ?? "")}
            initialSceneJson={String(params.sceneJson ?? "")}
            onSave={(prompt, sceneJson, slots) => {
              updateModuleParams(idx, { ...params, prompt, sceneJson })
              if (mod?.id && slots.length > 0) {
                setPreviewSlotsByModuleId((prev) => ({ ...prev, [mod.id]: slots }))
              }
            }}
            onGenerate={(prompt) => generateScenarioForModal(prompt, params)}
          />
        )
      })()}

      {cropModalOpen && cropModuleIndex !== null && workflow && (cropInputVideoUrl ?? selectedVideo?.streamUrl ?? selectedVideo?.playUrl) && (
        <CropModal
          isOpen={cropModalOpen}
          onClose={() => { setCropModalOpen(false); setCropInputVideoUrl(null) }}
          onSave={handleSaveCrop}
          videoUrl={cropInputVideoUrl ?? selectedVideo!.streamUrl ?? selectedVideo!.playUrl!}
          providerId={selectedVideo?.metadata?.providerId ?? null}
          initialCrop={(() => {
            const p = workflow.modules[cropModuleIndex].params ?? {};
            return {
              left: Math.min(100, Math.max(0, Number(p.left ?? 0))),
              top: Math.min(100, Math.max(0, Number(p.top ?? 0))),
              right: Math.min(100, Math.max(0, Number(p.right ?? 0))),
              bottom: Math.min(100, Math.max(0, Number(p.bottom ?? 0))),
            };
          })()}
          onTestCrop={handleTestCrop}
        />
      )}

      <VariableManagerModal
        isOpen={variableManagerOpen}
        onClose={() => setVariableManagerOpen(false)}
        workflow={workflow}
        moduleTypes={moduleTypes}
      />
    </div>
  )
}

function ModuleBlock({
  module,
  index,
  moduleTypes,
  status,
  stepMetadata,
  outputUrl,
  expanded,
  projectId,
  videoId,
  onToggleExpand,
  onRemove,
  onMoveUp,
  onMoveDown,
  onParamsChange,
  onInputsChange,
  onOutputsChange,
  onRenameVariable,
  onRunStep,
  onClearCache,
  onPreview,
  onScenePreview,
  remotionSceneUrl,
  getModuleLabel,
  getAvailableVariables,
  getAvailableVariablesByKind,
  onOpenCrop,
  onOpenPromptBuilder,
  previewSlots,
  onOpenScenarioEditor,
}: {
  module: WorkflowModuleDef
  index: number
  moduleTypes: ModuleMeta[]
  status: StepStatus
  stepMetadata?: { executionTimeMs?: number; costUsd?: number }
  outputUrl?: string
  expanded: boolean
  projectId?: string
  videoId?: string
  onToggleExpand: () => void
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onParamsChange: (params: Record<string, unknown>) => void
  onInputsChange: (inputs: Record<string, string>) => void
  onOutputsChange: (outputs: Record<string, string>) => void
  onRenameVariable?: (oldName: string, newName: string) => void
  onRunStep: () => void
  onClearCache: () => void
  onPreview: () => void
  onScenePreview?: () => void
  remotionSceneUrl?: string
  getModuleLabel: (type: string) => string
  getAvailableVariables: () => string[]
  getAvailableVariablesByKind: (kind: string) => string[]
  onOpenCrop?: () => void
  onOpenPromptBuilder?: (paramKey: string) => void
  previewSlots?: Array<{ key: string; kind: string; label?: string }>
  onOpenScenarioEditor?: () => void
}) {
  const meta = moduleTypes.find((m) => m.type === module.type)
  const params = module.params ?? {}
  const paramsSchema = meta?.paramsSchema ?? []
  const [scenarioSlots, setScenarioSlots] = useState<Array<{ key: string; kind: string; label?: string }> | null>(null)
  const [audioLibraryOptions, setAudioLibraryOptions] = useState<Array<{ value: string; label: string }> | null>(null)
  const [audioTags, setAudioTags] = useState<string[] | null>(null)
  const [imageLibraryOptions, setImageLibraryOptions] = useState<Array<{ value: string; label: string }> | null>(null)

  useEffect(() => {
    if (module.type !== "llm.scenario.generator" || !projectId || !videoId || status !== "done") {
      setScenarioSlots(null)
      return
    }
    let cancelled = false
    fetch(`/api/projects/${projectId}/videos/${videoId}/workflow-cache/slots/${encodeURIComponent(module.id)}`, {
      credentials: "include",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { slots?: Array<{ key: string; kind: string; label?: string }> } | null) => {
        if (cancelled || !data?.slots) return
        setScenarioSlots(data.slots)
      })
      .catch(() => setScenarioSlots(null))
    return () => { cancelled = true }
  }, [module.type, module.id, projectId, videoId, status])

  useEffect(() => {
    if (module.type !== "audio.library.select") {
      setAudioLibraryOptions(null)
      setAudioTags(null)
      return
    }
    let cancelled = false
    Promise.all([
      fetch("/api/content-library/audio?forSelect=1", { credentials: "include" }).then((r) => (r.ok ? r.json() : [])),
      fetch("/api/content-library/audio/tags", { credentials: "include" }).then((r) => (r.ok ? r.json() : [])),
    ]).then(([list, tags]: [Array<{ id: string; name: string }>, string[]]) => {
      if (cancelled) return
      setAudioLibraryOptions(list.map((i) => ({ value: i.id, label: i.name })))
      setAudioTags(Array.isArray(tags) ? tags : [])
    }).catch(() => {
      if (!cancelled) setAudioLibraryOptions(null)
    })
    return () => { cancelled = true }
  }, [module.type])

  useEffect(() => {
    if (module.type !== "video.heygen.avatar" && module.type !== "video.fal.veed-fabric") {
      setImageLibraryOptions(null)
      return
    }
    let cancelled = false
    fetch("/api/content-library/image?forSelect=1", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Array<{ id: string; name: string }>) => {
        if (cancelled) return
        setImageLibraryOptions(list.map((i) => ({ value: i.id, label: i.name })))
      })
      .catch(() => {
        if (!cancelled) setImageLibraryOptions(null)
      })
    return () => { cancelled = true }
  }, [module.type])

  const paramsToShow = expanded
    ? paramsSchema.filter((p) => {
        if (module.type === "video.render.remotion") {
          if (p.key === "sceneSource") return false
          if (p.key === "sceneJsonInline") return false
        }
        if (module.type === "llm.scenario.generator") {
          if (p.key === "sceneJson") return false
          if (p.key === "prompt") return false
        }
        if (module.type === "audio.library.select") {
          const mode = String(params.mode ?? "fixed")
          if (p.key === "audioId" && mode !== "fixed") return false
          if (p.key === "randomTag" && mode !== "random_by_tag") return false
        }
        return true
      })
    : []
  const outputFocusValueRef = useRef<Record<string, string>>({})

  const StatusIcon = () => {
    if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
    if (status === "done") return <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-500" />
    if (status === "error") return <XCircle className="h-3.5 w-3.5 text-destructive" />
    return <span className="w-3.5 h-3.5 rounded-full border-2 border-muted-foreground/40 bg-transparent" title="Pending" />
  }

  const statusStyles = {
    done: "border-l-4 border-l-green-500 bg-green-500/5 dark:bg-green-500/10",
    running: "border-l-4 border-l-primary bg-primary/5 dark:bg-primary/10",
    error: "border-l-4 border-l-destructive bg-destructive/5 dark:bg-destructive/10",
    pending: "border-l-4 border-l-muted/50",
  }

  const renderParam = (p: { key: string; label: string; type: string; default?: unknown; min?: number; max?: number; options?: { value: string; label: string }[] }) => {
    const promptVal = String(params[p.key] ?? p.default ?? "")
    const isPureVariable = /^\{\{([A-Za-z0-9_]+)\}\}$/.test(promptVal.trim())
    const textVars = getAvailableVariablesByKind("text")

    return (
    <div key={p.key} className={`flex ${p.type === "json" ? "items-start" : "items-center"} gap-2`}>
      <label className={`text-xs text-muted-foreground w-20 shrink-0 ${p.type === "json" ? "pt-1.5" : ""}`}>{p.label}</label>
      {p.type === "json" && (
        <textarea
          className="h-32 rounded-md border border-input bg-background px-2 py-1.5 text-xs flex-1 font-mono resize-y min-h-[80px]"
          value={String(params[p.key] ?? p.default ?? "")}
          onChange={(e) => onParamsChange({ ...params, [p.key]: e.target.value })}
          placeholder='{"clips": [], "fps": 30, "width": 1920, "height": 1080}'
          spellCheck={false}
        />
      )}
      {p.type === "prompt" && (
        <div className="flex-1 flex items-center gap-2 min-w-0">
          <div className="flex rounded-md border border-input overflow-hidden shrink-0">
            <button
              type="button"
              className={`px-2.5 py-1 text-xs ${!isPureVariable ? "bg-primary text-primary-foreground" : "bg-muted/50 text-muted-foreground hover:bg-muted"}`}
              onClick={() => onParamsChange({ ...params, [p.key]: "" })}
            >
              Manual
            </button>
            <button
              type="button"
              className={`px-2.5 py-1 text-xs ${isPureVariable ? "bg-primary text-primary-foreground" : "bg-muted/50 text-muted-foreground hover:bg-muted"}`}
              onClick={() => {
                const first = textVars[0]
                onParamsChange({ ...params, [p.key]: first ? `{{${first}}}` : "" })
              }}
            >
              Variable
            </button>
          </div>
          {isPureVariable ? (
            <select
              className="h-7 rounded-md border border-input bg-background px-2 text-xs flex-1"
              value={promptVal.match(/\{\{([A-Za-z0-9_]+)\}\}/)?.[1] ?? ""}
              onChange={(e) => onParamsChange({ ...params, [p.key]: e.target.value ? `{{${e.target.value}}}` : "" })}
            >
              <option value="">— Select —</option>
              {textVars.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          ) : (
            <>
              <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
                {(promptVal || "Empty").slice(0, 50)}
                {(promptVal.length > 50) ? "…" : ""}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0"
                onClick={() => onOpenPromptBuilder?.(p.key)}
              >
                <Pencil className="h-3 w-3 mr-1" />
                Edit
              </Button>
            </>
          )}
        </div>
      )}
      {p.type === "number" && (() => {
        const raw = Number(params[p.key] ?? p.default ?? 0)
        const clamped = p.min != null || p.max != null
          ? Math.max(p.min ?? -Infinity, Math.min(p.max ?? Infinity, raw))
          : raw
        return (
          <Input
            type="number"
            className="h-7 text-xs"
            value={clamped}
            min={p.min}
            max={p.max}
            onChange={(e) => {
              let v = parseFloat(e.target.value) || 0
              if (p.min != null) v = Math.max(p.min, v)
              if (p.max != null) v = Math.min(p.max, v)
              onParamsChange({ ...params, [p.key]: v })
            }}
          />
        )
      })()}
      {p.type === "string" && (() => {
        const isAudioLibrarySelect = module.type === "audio.library.select" && p.key === "audioId"
        const isAudioRandomTag = module.type === "audio.library.select" && p.key === "randomTag"
        const isHeyGenImageId = module.type === "video.heygen.avatar" && p.key === "imageId"
        const isFalImageId = module.type === "video.fal.veed-fabric" && p.key === "imageId"
        const isAnyImageId = isHeyGenImageId || isFalImageId
        const tagOptions = (audioTags ?? []).map((t) => ({ value: t, label: t }))
        const options = isAudioLibrarySelect ? audioLibraryOptions : isAnyImageId ? imageLibraryOptions : isAudioRandomTag ? tagOptions : p.options
        if (isAudioRandomTag && tagOptions.length === 0) {
          return (
            <Input
              type="text"
              className="h-7 text-xs flex-1"
              value={String(params[p.key] ?? p.default ?? "")}
              onChange={(e) => onParamsChange({ ...params, [p.key]: e.target.value })}
              placeholder="Enter tag (add tags to audio items in Content Library)"
            />
          )
        }
        if (isAnyImageId && imageLibraryOptions && imageLibraryOptions.length === 0) {
          return (
            <span className="text-xs text-muted-foreground flex-1">
              No images in library. Add avatar images in Content Library → Images.
            </span>
          )
        }
        if (options && options.length > 0) {
          const selectedId = String(params[p.key] ?? p.default ?? "")
          return (
            <div className="flex-1 flex items-center gap-2 min-w-0">
              {isAnyImageId && selectedId && (
                <img
                  src={`/api/content-library/image/${selectedId}/file`}
                  alt=""
                  className="h-10 w-10 object-cover rounded shrink-0 border border-border"
                />
              )}
              <select
                className="h-7 rounded-md border border-input bg-background px-2 text-xs flex-1 min-w-0"
                value={selectedId}
                onChange={(e) => onParamsChange({ ...params, [p.key]: e.target.value })}
                disabled={(isAudioLibrarySelect && audioLibraryOptions === null) || (isAnyImageId && imageLibraryOptions === null)}
              >
                {(isAudioLibrarySelect || isAnyImageId) && <option value="">— Select —</option>}
                {isAudioRandomTag && <option value="">— Select tag —</option>}
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )
        }
        return (
          <Input
            type="text"
            className="h-7 text-xs flex-1"
            value={String(params[p.key] ?? p.default ?? "")}
            onChange={(e) => onParamsChange({ ...params, [p.key]: e.target.value })}
          />
        )
      })()}
      {p.type === "boolean" && (
        <input
          type="checkbox"
          checked={Boolean(params[p.key] ?? p.default)}
          onChange={(e) => onParamsChange({ ...params, [p.key]: e.target.checked })}
          className="h-4 w-4"
        />
      )}
    </div>
  )
  }

  return (
    <div className={`rounded-lg border bg-panel-3 text-sm transition-all duration-200 ${expanded ? "p-3 shadow-sm" : "px-3 py-2"} ${statusStyles[status]}`}>
      <div className={`flex items-center justify-between gap-2 ${expanded ? "mb-3" : ""}`}>
        <div
          className="flex items-center gap-2.5 min-w-0 flex-1 cursor-pointer group"
          onClick={onToggleExpand}
          onKeyDown={(e) => e.key === "Enter" && onToggleExpand()}
          role="button"
          tabIndex={0}
        >
          <button
            type="button"
            className="shrink-0 p-0.5 -ml-0.5 rounded hover:bg-muted/60 transition-colors"
            onClick={(e) => { e.stopPropagation(); onToggleExpand() }}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground transition-colors" />
            )}
          </button>
          <StatusIcon />
          <span className={`font-medium truncate ${status === "pending" ? "text-muted-foreground" : ""}`}>{getModuleLabel(module.type)}</span>
          <span className="text-xs text-muted-foreground tabular-nums">#{index + 1}</span>
          {status === "running" && <span className="text-xs text-primary font-medium">Running…</span>}
          {stepMetadata && (stepMetadata.executionTimeMs != null || stepMetadata.costUsd != null) && (
            <span className="text-xs text-muted-foreground ml-auto flex items-center gap-2 shrink-0">
              {stepMetadata.executionTimeMs != null && stepMetadata.executionTimeMs > 0 && (
                <span className="flex items-center gap-1" title="Execution time">
                  <Clock className="h-3 w-3" />
                  {(stepMetadata.executionTimeMs / 1000).toFixed(1)}s
                </span>
              )}
              {stepMetadata.costUsd != null && stepMetadata.costUsd > 0 && (
                <span className="flex items-center gap-1" title="Cost">
                  <DollarSign className="h-3 w-3" />
                  ${stepMetadata.costUsd.toFixed(4)}
                </span>
              )}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {onScenePreview && (
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onScenePreview} title="Preview scene JSON in Remotion player">
              <Clapperboard className="h-3 w-3" />
            </Button>
          )}
          {outputUrl && (
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onPreview} title="Preview result">
              <Eye className="h-3 w-3" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onRunStep}
            title="Run this step"
            disabled={status === "running"}
          >
            <Play className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onClearCache}
            title="Clear cache"
            disabled={status === "running"}
          >
            <Eraser className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onMoveUp} title="Move up">
            <ChevronUp className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onMoveDown} title="Move down">
            <ChevronDown className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={onRemove} title="Remove">
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {expanded && ((meta?.inputSlots?.length ?? 0) > 0 || module.type === "llm.scenario.generator") && (
        <div className="space-y-2 mb-3 pt-2 border-t">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Inputs</span>
            {module.type === "llm.scenario.generator" && onOpenScenarioEditor && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={onOpenScenarioEditor}
              >
                <Pencil className="h-3.5 w-3.5 mr-1.5" />
                Edit
              </Button>
            )}
            {meta?.allowDynamicInputs && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-5 w-5 text-primary hover:text-primary hover:bg-primary/10"
                onClick={() => {
                  const currentKeys = Object.keys(module.inputs ?? {}).filter(k => k.startsWith("media_"))
                  const nextIdx = currentKeys.length > 0 
                    ? Math.max(...currentKeys.map(k => parseInt(k.split("_")[1]))) + 1 
                    : 1
                  onInputsChange({ ...(module.inputs ?? {}), [`media_${nextIdx}`]: "" })
                }}
                title="Add media input"
              >
                <PlusCircle className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          {(() => {
            let slots: ModuleSlotDef[] = [...(meta?.inputSlots ?? [])]
            const slotsFromJson = parseSlotsFromJson(String(params.sceneJson ?? ""))
            const effectiveScenarioSlots =
              slotsFromJson.length > 0
                ? slotsFromJson
                : status === "done"
                  ? (scenarioSlots ?? previewSlots)
                  : (previewSlots ?? scenarioSlots)
            if (module.type === "llm.scenario.generator" && effectiveScenarioSlots?.length) {
              slots = [...slots, ...effectiveScenarioSlots.map((s) => ({
                key: s.key,
                label: s.label ?? s.key,
                kind: s.kind === "audio" ? "file" : s.kind,
              }))]
            }
            if (meta?.allowDynamicInputs) {
              const extraKeys = Object.keys(module.inputs ?? {})
                .filter(k => k.startsWith("media_") && !slots.some(s => s.key === k))
                .sort((a, b) => parseInt(a.split("_")[1]) - parseInt(b.split("_")[1]))
              for (const k of extraKeys) {
                const idx = parseInt(k.split("_")[1])
                slots.push({ key: k, label: `Media ${idx + 1}`, kind: "file" })
              }
            }

            return (
              <>
                {module.type === "llm.scenario.generator" && !effectiveScenarioSlots?.length && (
                  <p className="text-xs text-muted-foreground py-1">Click Edit to open the scenario editor — enter JSON manually or use Generate from prompt.</p>
                )}
                {slots.map((slot) => {
              if (module.type === "video.render.remotion" && slot.key === "scene") {
                const sceneSource = String(params.sceneSource ?? "variable")
                return (
                  <div key={slot.key} className="flex items-start gap-2">
                    <label className="text-xs text-muted-foreground w-20 shrink-0 pt-1.5">{slot.label}</label>
                    <div className="flex-1 flex flex-col gap-1.5">
                      <div className="flex rounded-md border border-input overflow-hidden w-fit shrink-0">
                        <button
                          type="button"
                          className={`px-2.5 py-1 text-xs ${sceneSource === "variable" ? "bg-primary text-primary-foreground" : "bg-muted/50 text-muted-foreground hover:bg-muted"}`}
                          onClick={() => onParamsChange({ ...params, sceneSource: "variable" })}
                        >
                          Variable
                        </button>
                        <button
                          type="button"
                          className={`px-2.5 py-1 text-xs ${sceneSource === "inline" ? "bg-primary text-primary-foreground" : "bg-muted/50 text-muted-foreground hover:bg-muted"}`}
                          onClick={() => onParamsChange({ ...params, sceneSource: "inline" })}
                        >
                          Inline JSON
                        </button>
                      </div>
                      {sceneSource === "variable" ? (
                        <select
                          className="h-7 rounded-md border border-input bg-background px-2 text-xs flex-1"
                          value={module.inputs?.[slot.key] ?? ""}
                          onChange={(e) => onInputsChange({ ...(module.inputs ?? {}), [slot.key]: e.target.value })}
                        >
                          <option value="">— None —</option>
                          {getAvailableVariablesByKind(slot.kind).map((v) => (
                            <option key={v} value={v}>({v})</option>
                          ))}
                        </select>
                      ) : (
                        <textarea
                          className="h-36 rounded-md border border-input bg-background px-2 py-1.5 text-xs font-mono resize-y min-h-[80px]"
                          value={String(params.sceneJsonInline ?? "")}
                          onChange={(e) => onParamsChange({ ...params, sceneJsonInline: e.target.value })}
                          placeholder='{"clips": [], "fps": 30, "width": 1920, "height": 1080}'
                          spellCheck={false}
                        />
                      )}
                    </div>
                  </div>
                )
              }

              const ttsCommentsJsonTooltip = module.type === "tts.elevenlabs" && slot.key === "text"
                ? "Expected JSON array of segments: [{ \"time\": \"MM:SS\" or \"HH:MM:SS\", \"text\": \"speech text\" }]. Optional: duration, comment_for_ai_assistent."
                : undefined
              return (
              <div key={slot.key} className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground w-20 shrink-0 flex items-center gap-1">
                  {slot.label}
                  {ttsCommentsJsonTooltip && (
                    <TtsCommentsJsonHelp content={ttsCommentsJsonTooltip} />
                  )}
                </label>
                <div className="flex-1 flex items-center gap-1.5">
                  <select
                    className="h-7 rounded-md border border-input bg-background px-2 text-xs flex-1"
                    value={module.inputs?.[slot.key] ?? ""}
                    onChange={(e) =>
                      onInputsChange({ ...(module.inputs ?? {}), [slot.key]: e.target.value })
                    }
                  >
                    <option value="">— None —</option>
                    {getAvailableVariablesByKind(slot.kind).map((v) => (
                      <option key={v} value={v}>
                        ({v})
                      </option>
                    ))}
                  </select>
                  {meta?.allowDynamicInputs && slot.key.startsWith("media_") && slots.filter(s => s.key.startsWith("media_")).length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      onClick={() => {
                        const nextInputs = { ...(module.inputs ?? {}) }
                        delete nextInputs[slot.key]
                        onInputsChange(nextInputs)
                      }}
                      title="Remove input"
                    >
                      <MinusCircle className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
              )
            })}
              </>
            )
          })()}
        </div>
      )}
      {expanded && (meta?.outputSlots?.length ?? 0) > 0 && (
        <div className="space-y-2 mb-3 pt-2 border-t">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Outputs</span>
          {meta!.outputSlots!.map((slot) => {
            const slotKey = slot.key
            const currentVal = module.outputs?.[slotKey] ?? ""
            return (
              <div key={slotKey} className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground w-20 shrink-0">{slot.label}</label>
                <div className="flex-1 flex items-center gap-1.5">
                  <Input
                    type="text"
                    className={`h-7 text-xs flex-1 font-mono ${currentVal ? "bg-primary/5 border-primary/20" : ""}`}
                    placeholder={`e.g. (video_${index + 1})`}
                    value={currentVal}
                    title={currentVal ? `Variable: (${currentVal})` : undefined}
                    onFocus={() => { outputFocusValueRef.current[slotKey] = currentVal }}
                    onChange={(e) => onOutputsChange({ ...(module.outputs ?? {}), [slotKey]: e.target.value })}
                    onBlur={(e) => {
                      const oldVal = outputFocusValueRef.current[slotKey]
                      const newVal = e.target.value.trim()
                      if (onRenameVariable && oldVal && newVal && oldVal !== newVal) {
                        onRenameVariable(oldVal, newVal)
                      }
                      delete outputFocusValueRef.current[slotKey]
                    }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}
      {paramsToShow.length > 0 && (
        <div className="space-y-2 pt-2 border-t">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Parameters</span>
          <div className="space-y-2">
            {paramsToShow.map((p) => renderParam(p))}
          </div>
        </div>
      )}
      {expanded && module.type === "video.crop" && (
        <Button variant="outline" size="sm" className="w-full mt-3" onClick={() => onOpenCrop?.()}>
          <CropIcon className="h-3.5 w-3.5 mr-2" />
          Interactive Crop
        </Button>
      )}
    </div>
  )
}
