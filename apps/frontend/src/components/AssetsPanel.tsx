import { useState, useEffect } from "react"
import { File, ChevronDown, ChevronRight, Loader2, Folder, Trash2, Eye, SquareArrowOutUpRight, RefreshCw, CheckSquare, Square } from "lucide-react"
import { useSelectedVideo } from "@/contexts/SelectedVideoContext"
import { usePreviewVideo } from "@/contexts/PreviewVideoContext"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"

type Asset = {
  key: string
  shortKey: string
  size?: number
  lastModified?: string
  contentType?: string
  previewUrl?: string
}

function formatSize(bytes?: number): string {
  if (bytes == null) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso?: string): string {
  if (!iso) return "—"
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    })
  } catch {
    return iso
  }
}

type WorkflowCacheFolder = { folderName: string; moduleId: string }

type PendingDelete =
  | { type: "asset"; asset: Asset }
  | { type: "cache"; folder: WorkflowCacheFolder }
  | { type: "bulk"; assetKeys: string[] }
  | null

export function AssetsPanel({ hideHeader }: { hideHeader?: boolean } = {}) {
  const { selectedVideo, assetsRefreshTrigger, refreshAssets } = useSelectedVideo()
  const { setPreviewVideo } = usePreviewVideo()
  const [assets, setAssets] = useState<Asset[]>([])
  const [workflowCache, setWorkflowCache] = useState<WorkflowCacheFolder[]>([])
  const [loading, setLoading] = useState(false)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null)
  const [selectedAssetKeys, setSelectedAssetKeys] = useState<Set<string>>(new Set())

  const projectId = selectedVideo?.projectId
  const videoId = selectedVideo?.videoId

  useEffect(() => {
    if (!projectId || !videoId) {
      setAssets([])
      setWorkflowCache([])
      return
    }
    setLoading(true)
    Promise.all([
      fetch(`/api/projects/${projectId}/videos/${videoId}/assets`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : { assets: [] }))
        .then((data) => data.assets ?? []),
      fetch(`/api/projects/${projectId}/videos/${videoId}/workflow-cache`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : { workflowCache: [] }))
        .then((data) => data.workflowCache ?? []),
    ])
      .then(([a, w]) => {
        setAssets(a)
        setWorkflowCache(w)
      })
      .catch(() => {
        setAssets([])
        setWorkflowCache([])
      })
      .finally(() => setLoading(false))
  }, [projectId, videoId, assetsRefreshTrigger])

  if (!projectId || !videoId) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        Select a video to view assets
      </div>
    )
  }

  const selectedCount = selectedAssetKeys.size

  const handleConfirmDelete = async () => {
    if (!pendingDelete || !projectId || !videoId) return
    if (pendingDelete.type === "bulk") {
      const { assetKeys } = pendingDelete
      if (assetKeys.length > 0) {
        await fetch(`/api/projects/${projectId}/videos/${videoId}/assets`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ keys: assetKeys }),
        }).then((r) => r.ok && refreshAssets())
        setSelectedAssetKeys(new Set())
        refreshAssets()
      }
    } else if (pendingDelete.type === "asset") {
      await fetch(`/api/projects/${projectId}/videos/${videoId}/assets`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ key: pendingDelete.asset.key }),
      }).then((r) => r.ok && refreshAssets())
    } else if (pendingDelete.type === "cache") {
      await fetch(`/api/projects/${projectId}/videos/${videoId}/workflow-cache/cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ moduleIds: [pendingDelete.folder.moduleId] }),
      }).then((r) => r.ok && refreshAssets())
    }
  }

  const handleBulkDeleteRequest = () => {
    if (selectedCount === 0) return
    setPendingDelete({
      type: "bulk",
      assetKeys: Array.from(selectedAssetKeys),
    })
  }

  const toggleAssetSelection = (key: string) => {
    setSelectedAssetKeys((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectAll = () => {
    setSelectedAssetKeys(new Set(assets.map((a) => a.key)))
  }

  const clearSelection = () => {
    setSelectedAssetKeys(new Set())
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Delete confirmation"
        message={
          pendingDelete?.type === "bulk"
            ? `Delete ${pendingDelete.assetKeys.length} asset(s)? This cannot be undone.`
            : pendingDelete?.type === "asset"
              ? `Delete "${pendingDelete.asset.shortKey}"? This cannot be undone.`
              : pendingDelete?.type === "cache"
                ? `Delete workflow cache folder "${pendingDelete.folder.folderName}"? This cannot be undone.`
                : ""
        }
        confirmLabel="Delete"
        loadingLabel="Deleting…"
        variant="destructive"
        onConfirm={handleConfirmDelete}
      />
      {!hideHeader && (
        <div className="px-3 pt-3 pb-2 border-b shrink-0 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Assets
            </span>
            <button
              className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              onClick={() => refreshAssets()}
              disabled={loading}
              title="Reload"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
          {!loading && assets.length > 0 && (
            <div className="flex items-center gap-1.5">
              <button
                className="text-xs px-2 py-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                onClick={selectAll}
                title="Select all"
              >
                Select all
              </button>
              {selectedCount > 0 && (
                <>
                  <button
                    className="text-xs px-2 py-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                    onClick={clearSelection}
                    title="Clear selection"
                  >
                    Clear
                  </button>
                  <button
                    className="text-xs px-2 py-1 rounded hover:bg-destructive/20 hover:text-destructive text-muted-foreground"
                    onClick={handleBulkDeleteRequest}
                    title="Delete selected"
                  >
                    Delete {selectedCount}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : assets.length === 0 && workflowCache.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No assets found</p>
        ) : (
          <div className="space-y-1">
            {workflowCache.length > 0 && (
              <div className="mb-2">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-1">
                  Workflow cache
                </span>
                {workflowCache.map((folder) => (
                  <WorkflowCacheRow
                    key={folder.moduleId}
                    folder={folder}
                    projectId={projectId}
                    videoId={videoId}
                    onDeleteRequest={() => setPendingDelete({ type: "cache", folder })}
                    onPreview={setPreviewVideo}
                  />
                ))}
              </div>
            )}
            {assets.length > 0 && (
              <>
                {workflowCache.length > 0 && (
                  <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-1 block mt-2">
                    R2 assets
                  </span>
                )}
                {assets.map((asset) => (
                  <AssetRow
                    key={asset.key}
                    asset={asset}
                    expanded={expandedKey === asset.key}
                    selected={selectedAssetKeys.has(asset.key)}
                    onToggleSelection={() => toggleAssetSelection(asset.key)}
                    onToggle={() => setExpandedKey((k) => (k === asset.key ? null : asset.key))}
                    onPreview={() =>
                      asset.previewUrl &&
                      setPreviewVideo({
                        url: asset.previewUrl,
                        label: asset.shortKey,
                        contentType: asset.contentType,
                        metadata: {
                          size: asset.size,
                          lastModified: asset.lastModified,
                          key: asset.key,
                          contentType: asset.contentType,
                        },
                      })
                    }
                    onDelete={() => setPendingDelete({ type: "asset", asset })}
                  />
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function getContentTypeFromExt(filename: string): string {
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] ?? ""
  const map: Record<string, string> = {
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
    ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".xml": "application/xml",
    ".yaml": "text/yaml", ".yml": "text/yaml", ".csv": "text/csv", ".log": "text/plain",
  }
  return map[ext] ?? "application/octet-stream"
}

type CacheEntry = { name: string; type: "file" | "dir"; size?: number; lastModified?: string; r2Url?: string }

function WorkflowCacheRow({
  folder,
  projectId,
  videoId,
  onDeleteRequest,
  onPreview,
}: {
  folder: WorkflowCacheFolder
  projectId: string
  videoId: string
  onDeleteRequest: () => void
  onPreview: (v: { url: string; label: string; contentType: string; metadata?: Record<string, unknown> }) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [entries, setEntries] = useState<CacheEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [pathStack, setPathStack] = useState<string[]>([])
  const [expandedEntryKey, setExpandedEntryKey] = useState<string | null>(null)

  const currentPath = pathStack.length > 0 ? pathStack.join("/") : undefined

  useEffect(() => {
    if (!expanded || !projectId || !videoId) return
    setLoading(true)
    const url = currentPath
      ? `/api/projects/${projectId}/videos/${videoId}/workflow-cache/${encodeURIComponent(folder.folderName)}/contents?path=${encodeURIComponent(currentPath)}`
      : `/api/projects/${projectId}/videos/${videoId}/workflow-cache/${encodeURIComponent(folder.folderName)}/contents`
    fetch(url, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { entries: [] }))
      .then((data) => setEntries(data.entries ?? []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false))
  }, [expanded, projectId, videoId, folder.folderName, currentPath])

  const goInto = (name: string) => {
    setPathStack((prev) => [...prev, name])
    setExpandedEntryKey(null)
  }

  const goUp = () => {
    setPathStack((prev) => prev.slice(0, -1))
    setExpandedEntryKey(null)
  }

  const goToRoot = () => {
    setPathStack([])
    setExpandedEntryKey(null)
  }

  return (
    <div className="rounded border mt-1 overflow-hidden bg-panel-3">
      <div
        className="flex items-center gap-2 px-2 py-1.5 group cursor-pointer hover:bg-muted/50"
        onClick={() => setExpanded((prev) => !prev)}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 font-mono text-xs truncate" title={folder.folderName}>
          {folder.folderName}
        </span>
        <button
          className="shrink-0 p-1 rounded hover:bg-destructive/20 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation()
            onDeleteRequest()
          }}
          title="Delete"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      {expanded && (
        <div className="border-t bg-panel-2 px-2 py-1.5 text-xs">
          {pathStack.length > 0 && (
            <div className="flex items-center gap-1 mb-2 flex-wrap">
              <button
                className="text-primary hover:underline"
                onClick={(e) => {
                  e.stopPropagation()
                  goToRoot()
                }}
              >
                {folder.folderName}
              </button>
              {pathStack.map((seg, i) => (
                <span key={i} className="flex items-center gap-1">
                  <span className="text-muted-foreground">/</span>
                  <button
                    className="text-primary hover:underline"
                    onClick={(e) => {
                      e.stopPropagation()
                      setPathStack((prev) => prev.slice(0, i + 1))
                    }}
                  >
                    {seg}
                  </button>
                </span>
              ))}
            </div>
          )}
          {loading ? (
            <div className="flex items-center gap-2 py-2 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Loading…</span>
            </div>
          ) : entries.length === 0 ? (
            <p className="text-muted-foreground py-2">Empty</p>
          ) : (
            <ul className="space-y-0.5 max-h-48 overflow-y-auto">
              {pathStack.length > 0 && (
                <li>
                  <button
                    className="flex items-center gap-2 w-full text-left hover:bg-muted/50 rounded px-1.5 py-0.5 -ml-1.5"
                    onClick={(e) => {
                      e.stopPropagation()
                      goUp()
                    }}
                  >
                    <Folder className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">..</span>
                  </button>
                </li>
              )}
              {entries.map((entry) => {
                const relPath = currentPath ? `${currentPath}/${entry.name}` : entry.name
                const isExpanded = entry.type === "file" && expandedEntryKey === relPath
                const isFile = entry.type === "file"
                return (
                  <li key={entry.name}>
                    {entry.type === "dir" ? (
                      <button
                        className="flex items-center gap-2 w-full text-left hover:bg-muted/50 rounded px-1.5 py-0.5 -ml-1.5"
                        onClick={(e) => {
                          e.stopPropagation()
                          goInto(entry.name)
                        }}
                      >
                        <Folder className="h-3 w-3 text-muted-foreground shrink-0" />
                        <span className="truncate">{entry.name}</span>
                      </button>
                    ) : (
                      <div className="rounded border bg-panel-3/50 mb-0.5 overflow-hidden">
                        <div
                          className="flex items-center gap-2 px-1.5 py-0.5 -ml-1.5 group/row cursor-pointer hover:bg-muted/50"
                          onClick={() => setExpandedEntryKey((k) => (k === relPath ? null : relPath))}
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                          )}
                          <File className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span className="truncate flex-1">{entry.name}</span>
                          {entry.size != null && (
                            <span className="text-muted-foreground shrink-0">{formatSize(entry.size)}</span>
                          )}
                          {isFile && (
                            <span className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity">
                              <button
                                className="p-1 rounded hover:bg-muted"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  const url = entry.r2Url ?? `/api/projects/${projectId}/videos/${videoId}/workflow-cache/${encodeURIComponent(folder.folderName)}/file?path=${encodeURIComponent(relPath)}`
                                  onPreview({
                                    url,
                                    label: `${folder.folderName}/${relPath}`,
                                    contentType: getContentTypeFromExt(entry.name),
                                    metadata: { size: entry.size, lastModified: entry.lastModified },
                                  })
                                }}
                                title="Preview in main area"
                              >
                                <Eye className="h-3 w-3" />
                              </button>
                              <a
                                href={entry.r2Url ?? `/api/projects/${projectId}/videos/${videoId}/workflow-cache/${encodeURIComponent(folder.folderName)}/file?path=${encodeURIComponent(relPath)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-1 rounded hover:bg-muted inline-flex"
                                onClick={(e) => e.stopPropagation()}
                                title="Open in new tab"
                              >
                                <SquareArrowOutUpRight className="h-3 w-3" />
                              </a>
                            </span>
                          )}
                        </div>
                        {isExpanded && (
                          <div className="px-2 pb-2 pt-0 space-y-1 text-xs text-muted-foreground border-t bg-panel-2">
                            <div className="flex justify-between gap-4">
                              <span>Size</span>
                              <span>{formatSize(entry.size)}</span>
                            </div>
                            <div className="flex justify-between gap-4">
                              <span>Modified</span>
                              <span>{formatDate(entry.lastModified)}</span>
                            </div>
                            <div className="flex justify-between gap-4">
                              <span>Type</span>
                              <span>{getContentTypeFromExt(entry.name)}</span>
                            </div>
                            <div className="pt-1">
                              <span className="block text-muted-foreground/70 mb-0.5">Full path</span>
                              <code className="block text-[10px] break-all bg-muted/50 rounded px-1.5 py-1">
                                {folder.folderName}/{relPath}
                              </code>
                            </div>
                            {isFile && (
                              <div className="mt-2 flex gap-3">
                                <button
                                  className="text-xs text-primary hover:underline"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    const url = `/api/projects/${projectId}/videos/${videoId}/workflow-cache/${encodeURIComponent(folder.folderName)}/file?path=${encodeURIComponent(relPath)}`
                                    onPreview({
                                      url,
                                      label: `${folder.folderName}/${relPath}`,
                                      contentType: getContentTypeFromExt(entry.name),
                                      metadata: { size: entry.size, lastModified: entry.lastModified },
                                    })
                                  }}
                                >
                                  Preview in main area
                                </button>
                                <a
                                  href={entry.r2Url ?? `/api/projects/${projectId}/videos/${videoId}/workflow-cache/${encodeURIComponent(folder.folderName)}/file?path=${encodeURIComponent(relPath)}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs text-primary hover:underline"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  Open in new tab
                                </a>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function AssetRow({
  asset,
  expanded,
  selected,
  onToggleSelection,
  onToggle,
  onPreview,
  onDelete,
}: {
  asset: Asset
  expanded: boolean
  selected?: boolean
  onToggleSelection?: () => void
  onToggle: () => void
  onPreview: () => void
  onDelete: () => void
}) {
  return (
    <div className={`rounded border text-sm ${selected ? "ring-1 ring-primary bg-primary/5" : "bg-panel-3"}`}>
      <div
        className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-muted/50 group"
        onClick={onToggle}
      >
        {onToggleSelection ? (
          <button
            className="shrink-0 p-0.5 rounded hover:bg-muted"
            onClick={(e) => {
              e.stopPropagation()
              onToggleSelection()
            }}
            title={selected ? "Deselect" : "Select"}
          >
            {selected ? (
              <CheckSquare className="h-3.5 w-3.5 text-primary" />
            ) : (
              <Square className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </button>
        ) : null}
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate min-w-0 font-mono text-xs" title={asset.key}>
          {asset.shortKey}
        </span>
        {asset.previewUrl && (
          <span className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              className="p-1 rounded hover:bg-muted"
              onClick={(e) => {
                e.stopPropagation()
                onPreview()
              }}
              title="Preview in main area"
            >
              <Eye className="h-3 w-3" />
            </button>
            <a
              href={asset.previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1 rounded hover:bg-muted inline-flex"
              onClick={(e) => e.stopPropagation()}
              title="Open in new tab"
            >
              <SquareArrowOutUpRight className="h-3 w-3" />
            </a>
          </span>
        )}
        <button
          className="shrink-0 p-1 rounded hover:bg-destructive/20 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title="Delete"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      {expanded && (
        <div className="px-2 pb-2 pt-0 space-y-1 text-xs text-muted-foreground border-t">
          <div className="flex justify-between gap-4">
            <span>Size</span>
            <span>{formatSize(asset.size)}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span>Modified</span>
            <span>{formatDate(asset.lastModified)}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span>Type</span>
            <span>{asset.contentType ?? "—"}</span>
          </div>
          <div className="pt-1">
            <span className="block text-muted-foreground/70 mb-0.5">Full key</span>
            <code className="block text-[10px] break-all bg-muted/50 rounded px-1.5 py-1">
              {asset.key}
            </code>
          </div>
          {asset.previewUrl && (
            <div className="mt-2 flex gap-3">
              <button className="text-xs text-primary hover:underline" onClick={onPreview}>
                Preview in main area
              </button>
              <a
                href={asset.previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline"
              >
                Open in new tab
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
