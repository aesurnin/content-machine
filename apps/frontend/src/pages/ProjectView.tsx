import { useEffect, useState, useRef, useMemo } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { Group, Panel, Separator } from "react-resizable-panels"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Plus, Trash2, Video, Upload, Link, Loader2, XCircle, Square, RotateCw, RefreshCw, Pencil, Palette } from "lucide-react"
import { AssetsPanel } from "@/components/AssetsPanel"
import { UniversalViewer } from "@/components/UniversalViewer"
import { useLogs } from "@/contexts/LogsContext"
import { useSelectedVideo } from "@/contexts/SelectedVideoContext"
import { usePreviewVideo } from "@/contexts/PreviewVideoContext"
import { useAddStepPanel } from "@/contexts/AddStepPanelContext"
import { ModulePickerPanel } from "@/components/ModulePickerPanel"
import { AgentReasoningOverlay } from "@/components/AgentReasoningOverlay"

const PROJECT_LAYOUT_STORAGE_KEY = "project-layout-videos-assets-main"

const TAG_COLORS = [
  "#3b82f6", "#22c55e", "#eab308", "#f97316",
  "#ef4444", "#8b5cf6", "#ec4899", "#a1a1aa",
] as const

type VideoEntity = {
  id: string
  status: string
  displayName?: string | null
  sourceUrl?: string
  playUrl?: string
  /** Streaming URL (Range support, no full download) */
  streamUrl?: string
  metadata?: { error?: string; stopReason?: string; providerId?: string | null; tagColor?: string | null; originalReplayUrl?: string; recordingStartedAt?: string }
  createdAt?: string
}

export function ProjectView({
  videosVisible = true,
  assetsVisible = true,
}: {
  videosVisible?: boolean
  assetsVisible?: boolean
} = {}) {
  const { id } = useParams<{ id: string }>()
  const [project, setProject] = useState<{ id: string; name: string } | null>(null)
  const [videos, setVideos] = useState<VideoEntity[]>([])
  const [selectedVideo, setSelectedVideo] = useState<VideoEntity | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [urlInput, setUrlInput] = useState("")
  const [urlLoading, setUrlLoading] = useState(false)
  const [providerMeta, setProviderMeta] = useState<{
    name: string
    playSelectors: string[]
    endSelectors: string[]
    idleValueSelector?: string
    idleSeconds: number
    consoleEndPatterns: string[]
  } | null>(null)
  const [providerDetecting, setProviderDetecting] = useState(false)
  const [, setRecordingTick] = useState(0)
  const [livePreviewUrl, setLivePreviewUrl] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [durationLimit, setDurationLimit] = useState<number | null>(null)
  const [editingVideoId, setEditingVideoId] = useState<string | null>(null)
  const [editingVideoName, setEditingVideoName] = useState("")
  const [videoToDelete, setVideoToDelete] = useState<VideoEntity | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [activeWorkflowVideoIds, setActiveWorkflowVideoIds] = useState<Set<string>>(new Set())
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([])
  const [updatingProvider, setUpdatingProvider] = useState(false)
  const [tagPickerVideoId, setTagPickerVideoId] = useState<string | null>(null)
  const [updatingTag, setUpdatingTag] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const prevActiveWorkflowVideoIdsRef = useRef<Set<string>>(new Set())
  const selectedVideoIdRef = useRef<string | null>(null)
  const navigate = useNavigate()

  selectedVideoIdRef.current = selectedVideo?.id ?? null

  const savedLayout = ((): { videos: number; assets: number; main: number } => {
    const defaults = { videos: 20, assets: 20, main: 60 }
    try {
      const s = localStorage.getItem(PROJECT_LAYOUT_STORAGE_KEY)
      if (s) {
        const parsed = JSON.parse(s) as { videos?: number; assets?: number; main?: number }
        if (
          typeof parsed.videos === "number" &&
          typeof parsed.assets === "number" &&
          typeof parsed.main === "number" &&
          parsed.videos >= 10 &&
          parsed.assets >= 10 &&
          parsed.main >= 25
        ) {
          return { videos: parsed.videos, assets: parsed.assets, main: parsed.main }
        }
      }
    } catch {
      /* ignore */
    }
    return defaults
  })()

  const layout = (() => {
    const { videos: v, assets: a, main: m } = savedLayout
    if (!videosVisible && !assetsVisible) return { main: 100 } as Record<string, number>
    if (!videosVisible) return { assets: a, main: 100 - a }
    if (!assetsVisible) return { videos: v, main: 100 - v }
    return { videos: v, assets: a, main: m }
  })()
  const { addLog, setActiveVideoId, fetchLogsForVideo } = useLogs()
  const { setSelectedVideo: setGlobalSelectedVideo, refreshAssets } = useSelectedVideo()
  const { previewVideo, setPreviewVideo } = usePreviewVideo()
  const { addStepPanelOpen } = useAddStepPanel()

  async function fetchProject() {
    if (!id) return
    const r = await fetch(`/api/projects/${id}`, { credentials: "include" })
    if (!r.ok) throw new Error("Not found")
    return r.json()
  }

  useEffect(() => {
    fetch("/api/providers", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => setProviders(list))
      .catch(() => {})
  }, [])

  async function fetchVideos() {
    if (!id) return []
    const r = await fetch(`/api/projects/${id}/videos?_=${Date.now()}`, {
      credentials: "include",
      cache: "no-store",
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
    })
    return r.ok ? r.json() : []
  }

  function refreshVideosAndSelection() {
    fetchVideos().then((vids: VideoEntity[]) => {
      setVideos(vids)
      setSelectedVideo((prev) => {
        if (!prev) return null
        const found = vids.find((v) => v.id === prev.id)
        if (found && prev.status === "processing" && found.status !== "processing") {
          refreshAssets()
        }
        return found ?? prev
      })
      setGlobalSelectedVideo((prev) => {
        if (!prev) return prev
        const found = vids.find((v) => v.id === prev.videoId)
        return found ? { ...prev, metadata: found.metadata } : prev
      })
    })
  }

  useEffect(() => {
    setActiveVideoId(selectedVideo?.id ?? null)
  }, [selectedVideo?.id, setActiveVideoId])

  useEffect(() => {
    if (!id || !selectedVideo) return
    fetchLogsForVideo(id, selectedVideo.id)
    const interval = setInterval(() => fetchLogsForVideo(id, selectedVideo.id), 2000)
    return () => clearInterval(interval)
  }, [id, selectedVideo?.id, fetchLogsForVideo])

  useEffect(() => {
    if (!id) return
    addLog(`Loading project ${id}`)
    fetchProject()
      .then((p) => {
        setProject(p)
        addLog(`Project loaded: ${p?.name}`)
      })
      .catch(() => {
        addLog("Project not found, redirecting", "warn")
        navigate("/dashboard")
      })
    fetchVideos().then((vids) => {
      setVideos(vids)
      addLog(`Loaded ${vids.length} video(s)`)
    })
  }, [id, navigate, addLog])

  const hasProcessing = videos.some((v) => v.status === "processing")
  useEffect(() => {
    if (!hasProcessing) return
    fetch("/api/config", { credentials: "include" })
      .then((r) => r.ok ? r.json() : {})
      .then((c: { durationLimit?: number }) => setDurationLimit(c.durationLimit ?? null))
      .catch(() => {})
  }, [hasProcessing])
  useEffect(() => {
    if (!id || !hasProcessing) return
    const interval = setInterval(refreshVideosAndSelection, 1500)
    return () => clearInterval(interval)
  }, [id, hasProcessing])

  /** Poll active workflow jobs for busy indicators on video cards. Refresh assets when workflow completes for selected video. */
  useEffect(() => {
    if (!id) return
    const fetchActive = () => {
      fetch(`/api/projects/${id}/active-workflow-jobs`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { jobs?: { videoId: string }[] } | null) => {
          const next = new Set(data?.jobs?.map((j) => j.videoId) ?? [])
          setActiveWorkflowVideoIds((prev) => {
            const selectedId = selectedVideoIdRef.current
            if (selectedId && prev.has(selectedId) && !next.has(selectedId)) {
              refreshAssets()
            }
            return next
          })
        })
        .catch(() => setActiveWorkflowVideoIds(new Set()))
    }
    fetchActive()
    const interval = setInterval(fetchActive, 2000)
    return () => clearInterval(interval)
  }, [id, refreshAssets])

  /** Refresh assets periodically while workflow running or video recording (catches new outputs) */
  useEffect(() => {
    const workflowActive = selectedVideo?.id && activeWorkflowVideoIds.has(selectedVideo.id)
    const recording = selectedVideo?.status === "processing"
    if (!selectedVideo?.id || (!workflowActive && !recording)) return
    const interval = setInterval(refreshAssets, 5000)
    return () => clearInterval(interval)
  }, [selectedVideo?.id, selectedVideo?.status, activeWorkflowVideoIds, refreshAssets])

  useEffect(() => {
    if (!selectedVideo || selectedVideo.status !== "processing") return
    const interval = setInterval(() => setRecordingTick((t) => t + 1), 1000)
    return () => clearInterval(interval)
  }, [selectedVideo?.id, selectedVideo?.status])

  useEffect(() => {
    if (!videoToDelete) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setVideoToDelete(null)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [videoToDelete])

  useEffect(() => {
    if (!id) return
    const onVideoReRecorded = (e: CustomEvent<{ projectId: string; videoId: string }>) => {
      if (e.detail.projectId === id) refreshVideosAndSelection()
    }
    window.addEventListener("video-rerecorded", onVideoReRecorded as EventListener)
    return () => window.removeEventListener("video-rerecorded", onVideoReRecorded as EventListener)
  }, [id])

  // Detect provider when URL changes (debounced)
  useEffect(() => {
    const u = urlInput.trim()
    if (!u || u.length < 10) {
      setProviderMeta(null)
      return
    }
    const t = setTimeout(async () => {
      setProviderDetecting(true)
      try {
        const r = await fetch(`/api/providers/detect?url=${encodeURIComponent(u)}`, {
          credentials: "include",
        })
        const data = await r.json()
        if (data.provider) {
          setProviderMeta({
            name: data.provider.name,
            playSelectors: data.provider.playSelectors || [],
            endSelectors: data.provider.endSelectors || [],
            idleValueSelector: data.provider.idleValueSelector,
            idleSeconds: data.provider.idleSeconds ?? 40,
            consoleEndPatterns: data.provider.consoleEndPatterns || [],
          })
        } else {
          setProviderMeta(null)
        }
      } catch {
        setProviderMeta(null)
      } finally {
        setProviderDetecting(false)
      }
    }, 400)
    return () => clearTimeout(t)
  }, [urlInput])

  // Poll live preview (what the worker is actually recording)
  useEffect(() => {
    if (!id || !selectedVideo || selectedVideo.status !== "processing") {
      if (livePreviewUrl) {
        URL.revokeObjectURL(livePreviewUrl)
        setLivePreviewUrl(null)
      }
      return
    }
    const videoId = selectedVideo.id
    let revoked = false
    const poll = async () => {
      try {
        const r = await fetch(`/api/projects/${id}/videos/${videoId}/live-preview?_=${Date.now()}`, {
          credentials: "include",
          cache: "no-store",
        })
        if (revoked) return
        if (r.status === 200) {
          const blob = await r.blob()
          if (revoked) return
          setLivePreviewUrl((old) => {
            if (old) URL.revokeObjectURL(old)
            return URL.createObjectURL(blob)
          })
        } else {
          setLivePreviewUrl((old) => {
            if (old) URL.revokeObjectURL(old)
            return null
          })
        }
      } catch {
        if (!revoked) setLivePreviewUrl((old) => (old ? old : null))
      }
    }
    poll()
    const interval = setInterval(poll, 800)
    return () => {
      revoked = true
      clearInterval(interval)
      setLivePreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old)
        return null
      })
    }
  }, [id, selectedVideo?.id, selectedVideo?.status])

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !id) return
    addLog(`Upload started: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`)
    setUploading(true)
    setUploadProgress(0)

    const form = new FormData()
    form.append("file", file)

    const xhr = new XMLHttpRequest()
    xhr.open("POST", `/api/projects/${id}/videos/upload`)
    xhr.withCredentials = true

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        setUploadProgress(Math.round((ev.loaded / ev.total) * 100))
      } else {
        setUploadProgress(null)
      }
    }

    xhr.onload = () => {
      setUploading(false)
      setUploadProgress(null)
      e.target.value = ""
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const v = JSON.parse(xhr.responseText)
          setVideos((prev) => [...prev, v])
          setSelectedVideo(v)
          setShowAddForm(false)
          if (id) setGlobalSelectedVideo({ projectId: id, videoId: v.id, sourceUrl: v.sourceUrl, playUrl: v.playUrl, streamUrl: v.streamUrl, metadata: v.metadata })
          addLog(`Video uploaded: ${v.id.slice(0, 8)}...`, "info", v.id)
        } catch {
          addLog("Failed to parse upload response", "error")
        }
      } else {
        addLog(`Upload failed: ${xhr.status} ${xhr.statusText}`, "error")
      }
    }

    xhr.onerror = () => {
      setUploading(false)
      setUploadProgress(null)
      e.target.value = ""
      addLog("Upload failed: network error", "error")
    }

    xhr.send(form)
  }

  async function handleUrlSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!urlInput.trim() || !id) return
    addLog(`Adding video by URL: ${urlInput.trim()}`)
    setUrlLoading(true)
    try {
      const r = await fetch(`/api/projects/${id}/videos/url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: urlInput.trim() }),
        credentials: "include",
      })
      if (r.ok) {
        const v = await r.json()
        setVideos((prev) => [...prev, v])
        setSelectedVideo(v)
        setShowAddForm(false)
        setUrlInput("")
        setProviderMeta(null)
        if (id) setGlobalSelectedVideo({ projectId: id, videoId: v.id, sourceUrl: v.sourceUrl, playUrl: v.playUrl, streamUrl: v.streamUrl, metadata: v.metadata })
        addLog(`Video added by URL: ${v.id.slice(0, 8)}...`, "info", v.id)
      } else {
        const err = await r.json().catch(() => ({}))
        addLog(`URL add failed: ${err.error || r.status}`, "error")
      }
    } catch {
      addLog("URL add failed: network error", "error")
    } finally {
      setUrlLoading(false)
    }
  }

  async function handleStopRecording(e: React.MouseEvent, video: VideoEntity) {
    e.stopPropagation()
    if (!id) return
    addLog(`Stopping recording ${video.id.slice(0, 8)}...`, "info", video.id)
    setStopping(true)
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 15000)
      const r = await fetch(`/api/projects/${id}/videos/${video.id}/stop`, {
        method: "POST",
        credentials: "include",
        signal: ctrl.signal,
      })
      clearTimeout(t)
      if (r.ok) {
        addLog(`Recording will stop and save shortly (worker must be running)`)
        refreshVideosAndSelection()
      } else {
        const err = await r.json().catch(() => ({}))
        addLog(`Stop failed: ${err.error || r.status}`, "error")
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "network error"
      addLog(`Stop failed: ${msg}. Is the backend running?`, "error")
    } finally {
      setStopping(false)
    }
  }

  async function handleRestartVideo(e: React.MouseEvent, video: VideoEntity) {
    e.stopPropagation()
    if (!id) return
    addLog(`Restarting recording ${video.id.slice(0, 8)}...`, "info", video.id)
    setRestarting(true)
    try {
      const r = await fetch(`/api/projects/${id}/videos/${video.id}/restart`, {
        method: "POST",
        credentials: "include",
      })
      if (r.ok) {
        addLog(`Recording restarted`)
        refreshVideosAndSelection()
        setTimeout(refreshVideosAndSelection, 500)
      } else {
        const err = await r.json().catch(() => ({}))
        addLog(`Restart failed: ${err.error || r.status}`, "error")
      }
    } catch {
      addLog("Restart failed: network error", "error")
    } finally {
      setRestarting(false)
    }
  }

  async function handleCancelRecording(e: React.MouseEvent, video: VideoEntity) {
    e.stopPropagation()
    if (!id) return
    addLog(`Cancelling recording ${video.id.slice(0, 8)}...`, "info", video.id)
    setCancelling(true)
    try {
      const r = await fetch(`/api/projects/${id}/videos/${video.id}/cancel`, {
        method: "POST",
        credentials: "include",
      })
      if (r.ok) {
        addLog(`Recording cancelled`)
        refreshVideosAndSelection()
        setTimeout(refreshVideosAndSelection, 500)
        setTimeout(refreshVideosAndSelection, 1500)
      } else {
        const err = await r.json().catch(() => ({}))
        addLog(`Cancel failed: ${err.error || r.status}`, "error")
      }
    } catch {
      addLog("Cancel failed: network error", "error")
    } finally {
      setCancelling(false)
    }
  }

  function handleDeleteClick(e: React.MouseEvent, video: VideoEntity) {
    e.stopPropagation()
    setVideoToDelete(video)
  }

  function handleDeleteCancel() {
    setVideoToDelete(null)
  }

  async function handleDeleteConfirm() {
    const video = videoToDelete
    if (!video || !id) return
    setDeleting(true)
    addLog(`Deleting video ${video.id.slice(0, 8)}...`, "info", video.id)
    try {
      const r = await fetch(`/api/projects/${id}/videos/${video.id}`, {
        method: "DELETE",
        credentials: "include",
      })
      if (r.ok) {
        setVideos((prev) => prev.filter((v) => v.id !== video.id))
        if (selectedVideo?.id === video.id) {
          setSelectedVideo(null)
        }
        setVideoToDelete(null)
        addLog(`Video deleted`)
      } else {
        addLog(`Delete failed: ${r.status}`, "error")
      }
    } finally {
      setDeleting(false)
    }
  }

  function handleAddClick() {
    setSelectedVideo(null)
    setGlobalSelectedVideo(null)
    setShowAddForm(true)
    addLog("Add video form opened")
  }

  function handleVideoClick(video: VideoEntity) {
    if (video.id !== selectedVideo?.id) setEditingVideoId(null)
    setSelectedVideo(video)
    setShowAddForm(false)
    setPreviewVideo(null)
    if (id) {
      setGlobalSelectedVideo({
        projectId: id,
        videoId: video.id,
        sourceUrl: video.sourceUrl,
        playUrl: video.playUrl,
        streamUrl: video.streamUrl,
        metadata: video.metadata,
      })
    }
    addLog(`Selected video ${video.id.slice(0, 8)}`, "info", video.id)
  }

  async function handleRenameVideo(video: VideoEntity, newName: string) {
    if (!id) return
    try {
      const r = await fetch(`/api/projects/${id}/videos/${video.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: newName.trim() || null }),
        credentials: "include",
      })
      if (r.ok) {
        const displayName = newName.trim() || null
        setVideos((prev) =>
          prev.map((v) =>
            v.id === video.id ? { ...v, displayName } : v
          )
        )
        if (selectedVideo?.id === video.id) {
          setSelectedVideo((prev) => (prev ? { ...prev, displayName } : null))
        }
      }
    } finally {
      setEditingVideoId(null)
    }
  }

  async function handleUpdateVideoProvider(video: VideoEntity, providerId: string | null) {
    if (!id) return
    setUpdatingProvider(true)
    try {
      const r = await fetch(`/api/projects/${id}/videos/${video.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: { providerId } }),
        credentials: "include",
      })
      if (r.ok) {
        const meta = { ...video.metadata, providerId }
        setVideos((prev) =>
          prev.map((v) => (v.id === video.id ? { ...v, metadata: meta } : v))
        )
        if (selectedVideo?.id === video.id) {
          setSelectedVideo((prev) => (prev ? { ...prev, metadata: meta } : null))
          setGlobalSelectedVideo((prev) =>
            prev && prev.videoId === video.id ? { ...prev, metadata: meta } : prev
          )
        }
      }
    } finally {
      setUpdatingProvider(false)
    }
  }

  async function handleUpdateVideoTag(video: VideoEntity, tagColor: string | null) {
    if (!id) return
    setUpdatingTag(true)
    try {
      const r = await fetch(`/api/projects/${id}/videos/${video.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: { ...video.metadata, tagColor } }),
        credentials: "include",
      })
      if (r.ok) {
        const meta = { ...video.metadata, tagColor }
        setVideos((prev) =>
          prev.map((v) => (v.id === video.id ? { ...v, metadata: meta } : v))
        )
        if (selectedVideo?.id === video.id) {
          setSelectedVideo((prev) => (prev ? { ...prev, metadata: meta } : null))
          setGlobalSelectedVideo((prev) =>
            prev && prev.videoId === video.id ? { ...prev, metadata: meta } : prev
          )
        }
        setTagPickerVideoId(null)
      }
    } finally {
      setUpdatingTag(false)
    }
  }

  const duplicateDisplayNames = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const v of videos) {
      const n = (v.displayName ?? "").trim()
      if (n) counts[n] = (counts[n] ?? 0) + 1
    }
    return new Set(Object.keys(counts).filter((n) => counts[n] > 1))
  }, [videos])

  function getVideoLabel(v: VideoEntity) {
    let base: string
    if (v.displayName?.trim()) {
      base = v.displayName
    } else if (v.status === "processing") {
      return "Recording..."
    } else if (v.status === "cancelled") {
      return "Cancelled"
    } else if (v.status === "failed") {
      return "Failed"
    } else if (v.sourceUrl) {
      return `Video ${v.id.slice(0, 8)}`
    } else {
      return "No video"
    }
    if (duplicateDisplayNames.has(base.trim())) {
      return `${base} (${v.id.slice(0, 8)})`
    }
    return base
  }

  if (!project) return <div className="p-8">Loading...</div>

  return (
    <div className="h-full bg-panel-0 flex flex-col">
      <Group
          key={`${videosVisible}-${assetsVisible}`}
          id="project-videos-assets-main"
          orientation="horizontal"
          className="flex-1 min-h-0"
          defaultLayout={layout}
          resizeTargetMinimumSize={{ coarse: 24, fine: 6 }}
          onLayoutChanged={(l) => {
            const next = { ...savedLayout }
            if (typeof l.videos === "number" && videosVisible) next.videos = l.videos
            if (typeof l.assets === "number" && assetsVisible) next.assets = l.assets
            if (typeof l.main === "number") next.main = l.main
            localStorage.setItem(PROJECT_LAYOUT_STORAGE_KEY, JSON.stringify(next))
          }}
        >
          {videosVisible && (
            <>
          <Panel
            id="videos"
            defaultSize={`${layout.videos}%`}
            minSize="15%"
            maxSize="35%"
            collapsible
            collapsedSize={0}
            className="min-w-0 flex flex-col border-r border-border bg-panel-1"
          >
          <div className="flex items-center justify-between px-2 py-2 border-b border-border/50 shrink-0" style={{ height: 32 }}>
            <span className="text-xs text-muted-foreground/70 font-medium">VIDEOS</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={handleAddClick}
              title="Add video"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-1.5 min-h-0">
            {[...videos]
              .sort((a, b) => getVideoLabel(a).localeCompare(getVideoLabel(b), undefined, { sensitivity: "base" }))
              .map((v) => {
              const isBusy = activeWorkflowVideoIds.has(v.id)
              return (
              <div key={v.id} className="flex flex-col gap-0">
              <div
                className={`group flex items-center gap-2 px-2 py-2 rounded-md cursor-pointer hover:bg-muted/80 transition-colors ${
                  selectedVideo?.id === v.id && !showAddForm ? "bg-muted" : ""
                } ${isBusy ? "border-l-2 border-l-primary bg-primary/5" : v.metadata?.tagColor ? "border-l-2" : ""}`}
                style={v.metadata?.tagColor && !isBusy ? { borderLeftColor: v.metadata.tagColor } : undefined}
                onClick={() => handleVideoClick(v)}
              >
                {isBusy ? (
                  <Loader2 className="h-4 w-4 shrink-0 text-primary animate-spin" />
                ) : (
                  <Video className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                {editingVideoId === v.id && selectedVideo?.id !== v.id ? (
                  <Input
                    className="h-6 flex-1 text-sm min-w-0"
                    value={editingVideoName}
                    onChange={(e) => setEditingVideoName(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => handleRenameVideo(v, editingVideoName)}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === "Enter") handleRenameVideo(v, editingVideoName)
                      if (e.key === "Escape") setEditingVideoId(null)
                    }}
                    autoFocus
                  />
                ) : editingVideoId === v.id ? (
                  <span className="flex-1 text-sm truncate min-w-0 text-muted-foreground">Editing above...</span>
                ) : (
                  <>
                    <span
                      className="flex-1 text-sm truncate min-w-0"
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        setEditingVideoId(v.id)
                        setEditingVideoName(v.displayName || "")
                      }}
                    >
                      {getVideoLabel(v)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditingVideoId(v.id)
                        setEditingVideoName(v.displayName || "")
                      }}
                      title="Rename"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation()
                        setTagPickerVideoId(tagPickerVideoId === v.id ? null : v.id)
                      }}
                      title="Tag color"
                    >
                      <Palette
                        className="h-3.5 w-3.5"
                        style={v.metadata?.tagColor ? { color: v.metadata.tagColor } : undefined}
                      />
                    </Button>
                  </>
                )}
                {v.status === "failed" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => { e.stopPropagation(); handleRestartVideo(e, v) }}
                    title="Restart"
                    disabled={restarting}
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => handleDeleteClick(e, v)}
                  title="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
              {tagPickerVideoId === v.id && (
                <div
                  className="flex items-center gap-1.5 px-2 py-1.5 bg-muted/50 rounded-b-md border-t border-border/50"
                  onClick={(e) => e.stopPropagation()}
                >
                  {TAG_COLORS.map((color) => (
                    <button
                      key={color}
                      className="w-5 h-5 rounded-full border-2 border-transparent hover:scale-110 hover:border-foreground/50 transition-all shrink-0"
                      style={{ backgroundColor: color }}
                      onClick={() => handleUpdateVideoTag(v, color)}
                      title="Set tag"
                    />
                  ))}
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground px-2"
                    onClick={() => handleUpdateVideoTag(v, null)}
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>
            )
            })}
          </div>
        </Panel>
        <Separator className="shrink-0" />
            </>
          )}
          {assetsVisible && (
            <>
        <Panel
          id="assets"
            defaultSize={`${layout.assets}%`}
            minSize="15%"
          maxSize="35%"
          collapsible
          collapsedSize={0}
          className="min-w-0 flex flex-col border-r border-border bg-panel-1"
        >
          <div className="flex items-center justify-between px-2 py-2 border-b border-border/50 shrink-0" style={{ height: 32 }}>
            <span className="text-xs text-muted-foreground/70 font-medium">ASSETS</span>
            <button
              className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => refreshAssets()}
              title="Reload"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            <AssetsPanel hideHeader />
          </div>
        </Panel>
        <Separator className="shrink-0" />
            </>
          )}
        <Panel id="main" defaultSize={`${layout.main}%`} minSize="25%" className="min-w-0 flex flex-col bg-panel-0 relative">
          <AgentReasoningOverlay />
          <>
          {selectedVideo && !showAddForm && (
            <div className="w-full max-w-4xl mx-auto px-6 pt-3 pb-2 flex items-center gap-2 shrink-0 flex-wrap">
              {editingVideoId === selectedVideo.id ? (
                <Input
                  className="h-8 flex-1 font-medium min-w-[120px]"
                  value={editingVideoName}
                  onChange={(e) => setEditingVideoName(e.target.value)}
                  onBlur={() => handleRenameVideo(selectedVideo, editingVideoName)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRenameVideo(selectedVideo, editingVideoName)
                    if (e.key === "Escape") setEditingVideoId(null)
                  }}
                  autoFocus
                />
              ) : (
                <div
                  className="flex items-center gap-2 cursor-pointer hover:bg-muted/50 rounded px-2 py-1 -mx-2"
                  onClick={() => {
                    setEditingVideoId(selectedVideo.id)
                    setEditingVideoName(selectedVideo.displayName || "")
                  }}
                >
                  <span className="font-medium">{getVideoLabel(selectedVideo)}</span>
                </div>
              )}
              <div className="flex items-center gap-2" title="Video provider for crop preset. Set to use global crop per provider in workflow.">
                <span className="text-xs text-muted-foreground">Provider:</span>
                <select
                  className="h-8 rounded-md border border-input bg-background px-2.5 text-sm min-w-[140px] focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 disabled:opacity-50"
                  value={selectedVideo.metadata?.providerId ?? ""}
                  onChange={(e) => handleUpdateVideoProvider(selectedVideo, e.target.value || null)}
                  disabled={updatingProvider}
                >
                  <option value="">— Select —</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2" title="Tag color">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() => setTagPickerVideoId(tagPickerVideoId === selectedVideo.id ? null : selectedVideo.id)}
                >
                  <Palette
                    className="h-4 w-4"
                    style={selectedVideo.metadata?.tagColor ? { color: selectedVideo.metadata.tagColor } : undefined}
                  />
                </Button>
                {tagPickerVideoId === selectedVideo.id && (
                  <div className="flex items-center gap-1.5">
                    {TAG_COLORS.map((color) => (
                      <button
                        key={color}
                        className="w-5 h-5 rounded-full border-2 border-transparent hover:scale-110 hover:border-foreground/50 transition-all shrink-0"
                        style={{ backgroundColor: color }}
                        onClick={() => handleUpdateVideoTag(selectedVideo, color)}
                        title="Set tag"
                      />
                    ))}
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground px-2"
                      onClick={() => handleUpdateVideoTag(selectedVideo, null)}
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="flex-1 flex items-center justify-center p-6 min-h-0 min-w-0 overflow-auto">
          {showAddForm ? (
            <div className="w-full max-w-md space-y-6">
              <h3 className="font-medium text-center">Add video</h3>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={handleFileChange}
              />
              <div
                className={`rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
                  uploading
                    ? "border-primary/50 bg-primary/5 cursor-wait"
                    : "border-muted-foreground/25 hover:border-muted-foreground/50 cursor-pointer"
                }`}
                onClick={() => !uploading && fileInputRef.current?.click()}
              >
                {uploading ? (
                  <>
                    <Loader2 className="h-10 w-10 mx-auto text-primary mb-3 animate-spin" />
                    <p className="text-muted-foreground mb-4">
                      Uploading...
                      {uploadProgress != null && ` ${uploadProgress}%`}
                    </p>
                    <div className="w-full max-w-xs mx-auto h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all duration-300"
                        style={{
                          width:
                            uploadProgress != null
                              ? `${uploadProgress}%`
                              : "30%",
                        }}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <Upload className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                    <p className="text-muted-foreground mb-4">
                      Upload file from computer
                    </p>
                    <Button variant="outline">Select file</Button>
                  </>
                )}
              </div>
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-background px-2 text-muted-foreground">or</span>
                </div>
              </div>
              <form onSubmit={handleUrlSubmit} className="flex gap-2">
                <div className="relative flex-1">
                  <Link className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="url"
                    placeholder="Video URL"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <Button type="submit" disabled={urlLoading || !urlInput.trim()}>
                  {urlLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    "Add"
                  )}
                </Button>
              </form>
              {providerDetecting && (
                <p className="text-xs text-muted-foreground text-center">Detecting provider...</p>
              )}
              {providerMeta && !providerDetecting && (
                <div className="rounded-lg border bg-card p-3 text-sm space-y-2">
                  <p className="font-medium text-primary">{providerMeta.name}</p>
                  <div className="space-y-1 text-muted-foreground">
                    <p><span className="text-foreground">Start:</span> {providerMeta.playSelectors.length ? providerMeta.playSelectors.join(", ") : "—"}</p>
                    <p><span className="text-foreground">End:</span> {providerMeta.idleValueSelector ? `Idle ${providerMeta.idleSeconds}s on "${providerMeta.idleValueSelector}"` : providerMeta.endSelectors.length ? providerMeta.endSelectors.join(", ") : "—"}</p>
                    {providerMeta.consoleEndPatterns.length > 0 && (
                      <p><span className="text-foreground">Console:</span> {providerMeta.consoleEndPatterns.join(", ")}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : selectedVideo?.status === "processing" ? (
            <div className="w-full max-w-4xl flex flex-col gap-2">
              <div className="relative aspect-video bg-black rounded-lg overflow-hidden shadow-lg">
                {livePreviewUrl ? (
                  <img
                    src={livePreviewUrl}
                    alt="Live preview (what is being recorded)"
                    className="w-full h-full object-contain bg-black"
                  />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center gap-3 bg-muted text-muted-foreground">
                    <Loader2 className="h-12 w-12 animate-spin" />
                    <p className="text-sm">Preview will appear here once the worker starts recording.</p>
                  </div>
                )}
                <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-black/80 to-transparent p-3">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-md bg-primary/90 px-2.5 py-1 text-sm font-medium text-primary-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Recording
                    </span>
                    {(() => {
                      const startAt = selectedVideo.metadata?.recordingStartedAt ?? selectedVideo.createdAt
                      if (!startAt) return null
                      const elapsed = Math.floor((Date.now() - new Date(startAt).getTime()) / 1000)
                      if (Number.isNaN(elapsed) || elapsed < 0) return null
                      return (
                        <span className="text-xs text-white/80">
                          {elapsed}s
                          {durationLimit != null && ` / ${durationLimit}s max`}
                        </span>
                      )
                    })()}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={(e) => handleStopRecording(e, selectedVideo)}
                      disabled={stopping || cancelling}
                      className="gap-1.5"
                    >
                      <Square className="h-3.5 w-3.5" />
                      {stopping ? "Stopping..." : "Stop & Save"}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={(e) => handleCancelRecording(e, selectedVideo)}
                      disabled={cancelling || stopping}
                      className="gap-1.5"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      {cancelling ? "Cancelling..." : "Cancel"}
                    </Button>
                  </div>
                </div>
              </div>
              <p className="text-sm text-muted-foreground text-center">
                Live preview of what is being recorded. Video + audio will be saved when the replay ends or after Stop.
                {durationLimit != null && (
                  <span className="block mt-1 text-xs">
                    Max duration: {Math.floor(durationLimit / 60)} min
                  </span>
                )}
                {selectedVideo.metadata?.stopReason && (
                  <span className="block mt-1 text-xs">
                    Stop reason: {selectedVideo.metadata.stopReason}
                  </span>
                )}
              </p>
            </div>
          ) : selectedVideo?.status === "cancelled" ? (
            <div className="w-full max-w-md text-center">
              <XCircle className="h-12 w-12 mx-auto mb-2 opacity-50 text-muted-foreground" />
              <p className="font-medium">Recording cancelled</p>
              <p className="text-sm text-muted-foreground mt-1">
                The recording was stopped before completion.
              </p>
            </div>
          ) : selectedVideo?.status === "failed" ? (
            <div className="w-full max-w-md text-center">
              <Video className="h-12 w-12 mx-auto mb-2 opacity-50 text-destructive" />
              <p className="font-medium">Recording failed</p>
              <p className="text-sm text-muted-foreground mt-1">
                {selectedVideo.metadata?.error ?? "Unknown error"}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={(e) => handleRestartVideo(e, selectedVideo)}
                disabled={restarting}
              >
                {restarting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RotateCw className="h-4 w-4 mr-2" />}
                Restart
              </Button>
            </div>
          ) : (previewVideo && (previewVideo.url || previewVideo.inlineRemotionScene || previewVideo.remotionSceneUrl)) ? (
            <UniversalViewer asset={previewVideo} onClose={() => setPreviewVideo(null)} />
          ) : (selectedVideo?.streamUrl ?? selectedVideo?.playUrl ?? selectedVideo?.sourceUrl) ? (
            <div className="w-full max-w-4xl space-y-2">
              <div className={`relative aspect-video bg-black rounded-lg overflow-hidden shadow-lg ${activeWorkflowVideoIds.has(selectedVideo!.id) ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""}`}>
                <video
                  src={selectedVideo!.streamUrl ?? selectedVideo!.playUrl ?? selectedVideo!.sourceUrl}
                  controls
                  preload="metadata"
                  className="w-full h-full object-contain"
                />
                {activeWorkflowVideoIds.has(selectedVideo!.id) && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40 pointer-events-none">
                    <span className="inline-flex items-center gap-2 rounded-md bg-primary/90 px-3 py-2 text-sm font-medium text-primary-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Workflow running
                    </span>
                  </div>
                )}
              </div>
              {selectedVideo.metadata?.stopReason && (
                <p className="text-xs text-center text-muted-foreground">
                  Stopped: {selectedVideo.metadata.stopReason}
                </p>
              )}
            </div>
          ) : selectedVideo ? (
            <div className="text-center text-muted-foreground">
              <Video className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>No preview</p>
            </div>
          ) : (
            <div
              className="w-full max-w-md rounded-lg border-2 border-dashed border-muted-foreground/25 p-12 text-center cursor-pointer hover:border-muted-foreground/50 transition-colors"
              onClick={handleAddClick}
            >
              <Plus className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground mb-2">No video selected</p>
              <p className="text-sm text-muted-foreground">
              Click «+» on the left or here to add a video
            </p>
          </div>
        )}
          </div>
          {addStepPanelOpen && (
            <div className="absolute inset-0 z-10 flex flex-col bg-background/95 backdrop-blur-[2px]">
              <ModulePickerPanel />
            </div>
          )}
          </>
        </Panel>
      </Group>

      {/* Delete confirmation dialog */}
      {videoToDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={handleDeleteCancel}
        >
          <div
            className="rounded-lg border bg-card p-6 shadow-lg max-w-md mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-semibold text-lg mb-2">Delete video?</h3>
            <p className="text-muted-foreground text-sm mb-4">
              Are you sure you want to delete &quot;{getVideoLabel(videoToDelete)}&quot;? This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={handleDeleteCancel} disabled={deleting}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleDeleteConfirm}
                disabled={deleting}
              >
                {deleting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Deleting...
                  </>
                ) : (
                  "Delete"
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
