import { useState, useCallback, useEffect } from "react"
import ReactMarkdown from "react-markdown"
import { Button } from "@/components/ui/button"
import { RemotionPreview } from "@/components/remotion/RemotionPreview"
import type { PreviewAssetState, PreviewAssetMetadata } from "@/contexts/PreviewVideoContext"
import { useLiveRemotion } from "@/contexts/LiveRemotionContext"

function formatSize(bytes?: number): string {
  if (bytes == null) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso?: string): string {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
  } catch {
    return iso
  }
}

function formatDuration(sec?: number): string {
  if (sec == null || sec < 0) return "—"
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, "0")}`
}

function MetadataPanel({ metadata, openUrl }: { metadata?: PreviewAssetMetadata; openUrl?: string }) {
  if (!metadata && !openUrl) return null
  const hasAny = metadata && (
    metadata.size != null ||
    metadata.lastModified ||
    metadata.contentType ||
    metadata.duration != null ||
    (metadata.width != null && metadata.height != null) ||
    metadata.key ||
    metadata.tokenUsage ||
    metadata.costUsd != null ||
    metadata.executionTimeMs != null
  )
  if (!hasAny && !openUrl) return null
  const tu = metadata?.tokenUsage
  return (
    <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-2">
      <div className="font-medium text-xs uppercase tracking-wider text-muted-foreground">Metadata</div>
      <div className="grid gap-x-4 gap-y-1 text-xs">
        {metadata?.executionTimeMs != null && metadata.executionTimeMs > 0 && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Execution time</span>
            <span>{(metadata.executionTimeMs / 1000).toFixed(1)}s</span>
          </div>
        )}
        {tu && tu.total_tokens > 0 && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Tokens</span>
            <span>{tu.prompt_tokens} prompt + {tu.completion_tokens} completion = {tu.total_tokens} total</span>
          </div>
        )}
        {metadata?.costUsd != null && metadata.costUsd > 0 && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Est. cost</span>
            <span className="font-medium">${metadata.costUsd.toFixed(4)}</span>
          </div>
        )}
        {metadata?.size != null && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Size</span>
            <span>{formatSize(metadata.size)}</span>
          </div>
        )}
        {metadata?.contentType && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Type</span>
            <span>{metadata.contentType}</span>
          </div>
        )}
        {metadata?.duration != null && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Duration</span>
            <span>{formatDuration(metadata.duration)}</span>
          </div>
        )}
        {(metadata?.width != null || metadata?.height != null) && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Dimensions</span>
            <span>
              {metadata.width ?? "?"} × {metadata.height ?? "?"}
            </span>
          </div>
        )}
        {metadata?.lastModified && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Modified</span>
            <span>{formatDate(metadata.lastModified)}</span>
          </div>
        )}
        {metadata?.key && (
          <div className="pt-1">
            <span className="block text-muted-foreground mb-0.5">Key</span>
            <code className="block text-[10px] break-all bg-muted/50 rounded px-1.5 py-1">{metadata.key}</code>
          </div>
        )}
      </div>
      {openUrl && (
        <div className="pt-2 border-t">
          <a
            href={openUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:underline"
          >
            Open in new tab
          </a>
        </div>
      )}
    </div>
  )
}

type UniversalViewerProps = {
  asset: PreviewAssetState
  onClose: () => void
}

function getFullUrl(url: string): string {
  if (url.startsWith("http")) return url
  return `${window.location.origin}${url.startsWith("/") ? "" : "/"}${url}`
}

/** Derive metadata.json URL from workflow-cache output URL (output.md / output.json) */
function getModuleMetadataUrl(outputUrl: string): string | null {
  if (!outputUrl.includes("workflow-cache") || !outputUrl.includes("/file?")) return null
  if (!/path=[^&]*(?:output\.(?:md|json|txt))/i.test(outputUrl)) return null
  return outputUrl.replace(/path=[^&]+/, `path=${encodeURIComponent("metadata.json")}`)
}

function isTextContentType(contentType: string, url: string): boolean {
  if (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "application/xml" ||
    contentType === "application/yaml"
  )
    return true
  const u = url.split("?")[0].toLowerCase()
  return (
    u.endsWith(".txt") ||
    u.endsWith(".md") ||
    u.endsWith(".json") ||
    u.endsWith(".xml") ||
    u.endsWith(".yaml") ||
    u.endsWith(".yml") ||
    u.endsWith(".csv") ||
    u.endsWith(".log")
  )
}

function isMarkdownContentType(contentType: string, url: string): boolean {
  if (contentType === "text/markdown") return true
  const u = url.split("?")[0].toLowerCase()
  return u.endsWith(".md")
}

/** Detect if JSON content matches RemotionScene schema (clips, width/height/fps).
 * Exclude scenario format (has top-level "slots") — show that as text, not Remotion. */
function isRemotionSceneJson(text: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(text) as Record<string, unknown>
    // Scenario generator output has "slots" — treat as text, not Remotion
    if (Array.isArray(data?.slots)) return null
    const scene = (data.scene ?? data) as Record<string, unknown>
    const hasClips = Array.isArray(scene?.clips)
    const hasDimensions = typeof scene?.width === "number" || typeof scene?.height === "number" || typeof scene?.fps === "number"
    if (hasClips || hasDimensions) return (scene ?? data) as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

function RemotionPreviewWrapper({
  remotionSceneUrl,
  header,
}: {
  remotionSceneUrl: string
  header: React.ReactNode
}) {
  const [scene, setScene] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    setScene(null)
    const url = remotionSceneUrl.startsWith("http") || remotionSceneUrl.startsWith("/")
      ? remotionSceneUrl
      : getFullUrl(remotionSceneUrl)

    const fetchData = () => {
      fetch(url, { credentials: "include" })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        })
        .then((data) => {
          if (cancelled) return
          const sceneData = (data?.scene ?? data) as Record<string, unknown>
          setScene((prev) => {
            if (prev && JSON.stringify(prev) === JSON.stringify(sceneData)) return prev
            return sceneData
          })
          setError(null)
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e))
        })
    }

    fetchData()
    const interval = setInterval(fetchData, 3000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [remotionSceneUrl])

  if (error) {
    return (
      <div className="w-full max-w-4xl space-y-3">
        <div className="rounded-lg overflow-hidden shadow-lg border bg-background p-4">
          {header}
          <p className="text-destructive text-sm mt-2">Failed to load Remotion scene: {error}</p>
        </div>
      </div>
    )
  }
  if (scene === null) {
    return (
      <div className="w-full max-w-4xl space-y-3">
        <div className="rounded-lg overflow-hidden shadow-lg border bg-background p-8 text-center">
          {header}
          <p className="text-muted-foreground text-sm mt-4">Loading Remotion scene…</p>
        </div>
      </div>
    )
  }
  return (
    <div className="w-full max-w-4xl flex flex-col items-center space-y-3">
      <div className="rounded-lg overflow-hidden shadow-lg border bg-background flex flex-col w-full">
        {header}
      </div>
      <RemotionPreview scene={scene as Parameters<typeof RemotionPreview>[0]["scene"]} />
    </div>
  )
}

function TextContentPreview({ url, contentType }: { url: string; contentType: string }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const isMarkdown = isMarkdownContentType(contentType, url)

  useEffect(() => {
    let cancelled = false
    setError(null)
    setText(null)
    const fetchUrl = url.startsWith("http") || url.startsWith("/") ? url : getFullUrl(url)

    const fetchData = () => {
      fetch(fetchUrl, { credentials: "include" })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.text()
        })
        .then((body) => {
          if (cancelled) return
          setText((prev) => (prev === body ? prev : body))
          setError(null)
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e))
        })
    }

    fetchData()
    const interval = setInterval(fetchData, 3000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [url])

  if (error) {
    return (
      <div className="p-4 text-destructive text-sm">
        Failed to load: {error}
      </div>
    )
  }
  if (text === null) {
    return (
      <div className="p-8 text-center text-muted-foreground text-sm">
        Loading…
      </div>
    )
  }
  const remotionScene = isRemotionSceneJson(text)
  if (remotionScene) {
    return (
      <div className="flex-1 min-h-0 p-4 overflow-auto">
        <RemotionPreview scene={remotionScene as Parameters<typeof RemotionPreview>[0]["scene"]} />
      </div>
    )
  }
  return (
    <div className="p-4 flex-1 min-h-0 overflow-auto bg-background text-foreground">
      {isMarkdown ? (
        <article className="prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown
            components={{
              pre: ({ children }) => <pre className="whitespace-pre-wrap break-words">{children}</pre>,
            }}
          >
            {text}
          </ReactMarkdown>
        </article>
      ) : (
        <pre className="text-xs font-mono whitespace-pre-wrap break-words m-0">
          {text}
        </pre>
      )}
    </div>
  )
}

/** Append cache-bust param to force reload when file changes */
function withCacheBust(url: string, key: string): string {
  const sep = url.includes("?") ? "&" : "?"
  return `${url}${sep}_=${key}`
}

export function UniversalViewer({ asset, onClose }: UniversalViewerProps) {
  const [mediaMetadata, setMediaMetadata] = useState<Partial<PreviewAssetMetadata>>({})
  const [moduleMetadata, setModuleMetadata] = useState<{
    tokenUsage?: PreviewAssetMetadata["tokenUsage"]
    costUsd?: number
    executionTimeMs?: number
  } | null>(null)
  const { liveRemotion } = useLiveRemotion()

  const contentType = asset?.contentType ?? ""
  const isTextResolved = asset ? isTextContentType(contentType, asset.url) : false
  const metadataUrl = asset && isTextResolved ? getModuleMetadataUrl(asset.url) : null

  useEffect(() => {
    if (!metadataUrl) {
      setModuleMetadata(null)
      return
    }
    let cancelled = false
    setModuleMetadata(null)
    const fullUrl = metadataUrl.startsWith("http") || metadataUrl.startsWith("/") ? metadataUrl : getFullUrl(metadataUrl)

    const fetchMetadata = () => {
      fetch(fullUrl, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then(async (data: { tokenUsage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; model?: string; costUsd?: number; executionTimeMs?: number } | null) => {
          if (!data || cancelled) return
          const tu = data.tokenUsage
          const hasTokens = tu && (tu.total_tokens ?? tu.prompt_tokens + tu.completion_tokens) > 0
          const hasCost = data.costUsd != null && data.costUsd > 0
          const hasExecutionTime = data.executionTimeMs != null && data.executionTimeMs > 0
          if (!hasTokens && !hasCost && !hasExecutionTime) return
          let costUsd: number | undefined = typeof data.costUsd === "number" && data.costUsd > 0 ? data.costUsd : undefined
          if (costUsd == null && hasTokens && data.model) {
            try {
              const params = new URLSearchParams({
                model: data.model,
                prompt: String(tu!.prompt_tokens),
                completion: String(tu!.completion_tokens),
              })
              const costRes = await fetch(`/api/workflows/estimate-cost?${params}`, { credentials: "include" })
              if (costRes.ok) {
                const { costUsd: c } = await costRes.json()
                if (typeof c === "number" && c > 0) costUsd = c
              }
            } catch { /* ignore */ }
          }
          if (cancelled) return
          setModuleMetadata({
            tokenUsage: tu ?? undefined,
            costUsd,
            executionTimeMs: typeof data.executionTimeMs === 'number' && data.executionTimeMs > 0 ? data.executionTimeMs : undefined,
          })
        })
        .catch(() => {})
    }

    fetchMetadata()
    const interval = setInterval(fetchMetadata, 3000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [metadataUrl])

  const isMedia = asset && (
    contentType.startsWith("video/") ||
    contentType.startsWith("image/") ||
    contentType.startsWith("audio/") ||
    /\.(mp3|wav|ogg|m4a)$/i.test(asset.url.split("?")[0])
  )

  const handleVideoMetadata = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget
    setMediaMetadata({
      duration: v.duration,
      width: v.videoWidth,
      height: v.videoHeight,
    })
  }, [])

  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    setMediaMetadata({ width: img.naturalWidth, height: img.naturalHeight })
  }, [])

  const handleAudioMetadata = useCallback((e: React.SyntheticEvent<HTMLAudioElement>) => {
    const a = e.currentTarget
    setMediaMetadata({ duration: a.duration })
  }, [])

  if (!asset) return null

  const remotionSceneUrl = asset.remotionSceneUrl
  const isVideo = contentType.startsWith("video/")
  const isImage = contentType.startsWith("image/")
  const isAudio = contentType.startsWith("audio/") || /\.(mp3|wav|ogg|m4a)$/i.test(asset.url.split("?")[0])
  const mergedMetadata = { ...asset.metadata, ...mediaMetadata, ...moduleMetadata }
  const fullUrl = getFullUrl(asset.url)

  const header = (
    <div className="flex items-center justify-between gap-2 p-3 shrink-0 bg-muted/30 rounded-t-lg">
      <span className="text-sm font-medium truncate min-w-0">
        {asset.label ?? "Preview"}
      </span>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="outline"
          size="sm"
          asChild
        >
          <a href={fullUrl} target="_blank" rel="noopener noreferrer">
            Open in new tab
          </a>
        </Button>
        <Button variant="secondary" size="sm" onClick={onClose}>
          Back
        </Button>
      </div>
    </div>
  )

  if (asset.inlineRemotionScene) {
    const scene = (liveRemotion.scene ?? asset.inlineRemotionScene) as Parameters<typeof RemotionPreview>[0]["scene"]
    return (
      <div className="w-full max-w-4xl flex flex-col items-center space-y-3">
        <div className="rounded-lg overflow-hidden shadow-lg border bg-background flex flex-col w-full">
          {header}
        </div>
        <RemotionPreview scene={scene} />
      </div>
    )
  }

  if (remotionSceneUrl) {
    return (
      <RemotionPreviewWrapper remotionSceneUrl={remotionSceneUrl} header={header} />
    )
  }

  if (isTextResolved) {
    return (
      <div className="w-full max-w-4xl space-y-3">
        <div className="rounded-lg overflow-hidden shadow-lg border bg-background flex flex-col max-h-[75vh]">
          {header}
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            <TextContentPreview url={asset.url} contentType={contentType || "text/plain"} />
          </div>
        </div>
        <MetadataPanel metadata={mergedMetadata} openUrl={fullUrl} />
      </div>
    )
  }

  return (
    <div className="w-full max-w-4xl space-y-3">
      <div className="relative bg-black rounded-lg overflow-hidden shadow-lg">
        <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 p-3 bg-gradient-to-b from-black/80 to-transparent">
          <span className="text-sm font-medium text-white truncate min-w-0">
            {asset.label ?? "Preview"}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" asChild className="border-white/50 text-white hover:bg-white/20">
              <a href={fullUrl} target="_blank" rel="noopener noreferrer">
                Open in new tab
              </a>
            </Button>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Back
            </Button>
          </div>
        </div>
        <div className="aspect-video flex items-center justify-center bg-black min-h-[200px]">
          {isVideo && (
            <video
              src={asset.url}
              controls
              preload="metadata"
              className="w-full h-full object-contain max-h-[70vh]"
              onLoadedMetadata={handleVideoMetadata}
            />
          )}
          {isImage && (
            <img
              src={asset.url}
              alt={asset.label ?? "Preview"}
              className="max-w-full max-h-[70vh] object-contain"
              onLoad={handleImageLoad}
            />
          )}
          {isAudio && (
            <div className="w-full max-w-lg px-4 py-8">
              <audio
                src={asset.url}
                controls
                className="w-full"
                onLoadedMetadata={handleAudioMetadata}
              />
            </div>
          )}
          {!isVideo && !isImage && !isAudio && (
            <div className="p-8 text-center text-muted-foreground">
              <p className="text-sm">Preview not available for this file type</p>
              <p className="text-xs mt-1">{contentType || "Unknown type"}</p>
              <a
                href={asset.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline mt-2 inline-block"
              >
                Open in new tab
              </a>
            </div>
          )}
        </div>
      </div>
      <MetadataPanel metadata={mergedMetadata} openUrl={fullUrl} />
    </div>
  )
}
