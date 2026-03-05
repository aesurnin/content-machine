import { useEffect, useState, useMemo } from "react"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { useLogs } from "@/contexts/LogsContext"
import {
  Upload,
  Trash2,
  Pencil,
  Music,
  Video,
  Image,
  FileQuestion,
  ChevronDown,
  ChevronUp,
  Search,
  ArrowUpDown,
  ArrowDownAZ,
} from "lucide-react"

type Category = "audio" | "video" | "images" | "other"

type LibraryItem = {
  id: string
  name: string
  tags: string[]
  type: string
  mimeType?: string | null
  createdAt?: string
}

const CATEGORIES: { id: Category; label: string; icon: typeof Music }[] = [
  { id: "audio", label: "Audio", icon: Music },
  { id: "video", label: "Video", icon: Video },
  { id: "images", label: "Images", icon: Image },
  { id: "other", label: "Other", icon: FileQuestion },
]

type SortBy = "name" | "date"

export function ContentLibrary() {
  const [category, setCategory] = useState<Category>("audio")
  const [items, setItems] = useState<LibraryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showUpload, setShowUpload] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [editTags, setEditTags] = useState("")
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<SortBy>("name")
  const [sortAsc, setSortAsc] = useState(true)
  const [search, setSearch] = useState("")
  const navigate = useNavigate()
  const { addLog } = useLogs()

  const apiPath = category === "audio" ? "audio" : category === "images" ? "image" : null

  async function fetchItems() {
    if (!apiPath) return []
    const r = await fetch(`/api/content-library/${apiPath}`, { credentials: "include" })
    if (!r.ok) {
      if (r.status === 401) navigate("/login")
      return []
    }
    return r.json()
  }

  useEffect(() => {
    addLog("[Content Library] Opened")
  }, [])

  useEffect(() => {
    setItems([])
    setExpandedId(null)
    if (category === "audio" || category === "images") {
      setLoading(true)
      addLog(`[Content Library] Loading ${category}…`)
      fetchItems().then((list) => {
        setItems(list)
        setLoading(false)
        addLog(`[Content Library] Loaded ${list.length} item(s)`)
      })
    } else {
      setLoading(false)
    }
  }, [category, addLog])

  const filteredAndSorted = useMemo(() => {
    let list = [...items]
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          (i.tags ?? []).some((t) => t.toLowerCase().includes(q))
      )
    }
    list.sort((a, b) => {
      const cmp = sortBy === "name"
        ? (a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
        : ((a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
      return sortAsc ? cmp : -cmp
    })
    return list
  }, [items, search, sortBy, sortAsc])

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    if (files.length === 0 || !apiPath) {
      addLog("[Content Library] Select files first", "error")
      return
    }
    setUploading(true)
    addLog(`[Content Library] Uploading ${files.length} file(s): ${files.map((f) => f.name).join(", ")}`)
    try {
      const formData = new FormData()
      files.forEach((f) => formData.append("file", f))
      const r = await fetch(`/api/content-library/${apiPath}`, {
        method: "POST",
        credentials: "include",
        body: formData,
      })
      if (r.ok) {
        const uploaded = await r.json()
        const list = Array.isArray(uploaded) ? uploaded : [uploaded]
        setItems((prev) => [...list, ...prev])
        setShowUpload(false)
        setFiles([])
        addLog(`[Content Library] Uploaded ${list.length} file(s): ${list.map((i: LibraryItem) => i.name).join(", ")}`)
      } else {
        const err = await r.json().catch(() => ({}))
        addLog(`[Content Library] Upload failed: ${err.error || r.status}`, "error")
      }
    } catch {
      addLog("[Content Library] Upload failed: network error", "error")
    } finally {
      setUploading(false)
    }
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault()
    if (!editingId || !apiPath) return
    addLog(`[Content Library] Updating: ${editName}`)
    try {
      const r = await fetch(`/api/content-library/${apiPath}/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: editName.trim(),
          tags: editTags.split(",").map((t) => t.trim()).filter(Boolean),
        }),
      })
      if (r.ok) {
        const updated = await r.json()
        setItems((prev) => prev.map((i) => (i.id === editingId ? updated : i)))
        setEditingId(null)
        addLog(`[Content Library] Updated: ${updated.name}`)
      } else {
        const err = await r.json().catch(() => ({}))
        addLog(`[Content Library] Update failed: ${err.error || r.status}`, "error")
      }
    } catch {
      addLog("[Content Library] Update failed: network error", "error")
    }
  }

  async function handleDelete() {
    if (!deleteConfirm || !apiPath) return
    addLog(`[Content Library] Deleting: ${deleteConfirm.name}`)
    try {
      const r = await fetch(`/api/content-library/${apiPath}/${deleteConfirm.id}`, {
        method: "DELETE",
        credentials: "include",
      })
      if (r.ok) {
        setItems((prev) => prev.filter((i) => i.id !== deleteConfirm.id))
        setDeleteConfirm(null)
        addLog(`[Content Library] Deleted: ${deleteConfirm.name}`)
      } else {
        const err = await r.json().catch(() => ({}))
        addLog(`[Content Library] Delete failed: ${err.error || r.status}`, "error")
      }
    } catch {
      addLog("[Content Library] Delete failed: network error", "error")
    }
  }

  function openEdit(item: LibraryItem) {
    setEditingId(item.id)
    setEditName(item.name)
    setEditTags((item.tags ?? []).join(", "))
    addLog(`[Content Library] Edit: ${item.name}`)
  }

  if (loading) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>

  return (
    <div className="flex h-full min-h-0">
      {/* Left sidebar */}
      <aside className="w-36 shrink-0 border-r bg-panel-1 flex flex-col">
        <div className="p-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          Categories
        </div>
        <nav className="flex-1 min-h-0 overflow-y-auto p-1">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                if (category !== c.id) addLog(`[Content Library] Category: ${c.label}`)
                setCategory(c.id)
              }}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm transition-colors ${
                category === c.id
                  ? "bg-primary/10 text-primary font-medium"
                  : "hover:bg-muted/50 text-muted-foreground hover:text-foreground"
              }`}
            >
              <c.icon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{c.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      {/* Right content */}
      <main className="flex-1 min-w-0 flex flex-col">
        {(category === "audio" || category === "images") ? (
          <>
            {/* Toolbar */}
            <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b">
              <div className="relative flex-1 max-w-xs">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-7 pl-7 text-xs"
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => {
                  const next = sortBy === "name" ? "date" : "name"
                  setSortBy(next)
                  addLog(`[Content Library] Sort by: ${next}`)
                }}
                title={sortBy === "name" ? "Sort by date" : "Sort by name"}
              >
                {sortBy === "name" ? (
                  <ArrowDownAZ className="h-3.5 w-3.5" />
                ) : (
                  <ArrowUpDown className="h-3.5 w-3.5" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => {
                  setSortAsc((a) => !a)
                  addLog(`[Content Library] Order: ${sortAsc ? "descending" : "ascending"}`)
                }}
                title={sortAsc ? "Ascending" : "Descending"}
              >
                {sortAsc ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </Button>
              {!showUpload ? (
                <Button size="sm" className="h-7 text-xs shrink-0" onClick={() => { setShowUpload(true); addLog("[Content Library] Upload form opened") }}>
                  <Upload className="h-3.5 w-3.5 mr-1.5" />
                  Upload
                </Button>
              ) : null}
            </div>

            {/* Upload form */}
            {showUpload && (
              <form
                onSubmit={handleUpload}
                className="shrink-0 border-b px-3 py-2 flex flex-wrap items-center gap-2"
              >
                <input
                  type="file"
                  accept={category === "images" ? ".jpg,.jpeg,.png" : ".mp3,.wav,.m4a,.ogg"}
                  multiple
                  onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                  className="text-xs file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:font-medium file:bg-primary file:text-primary-foreground"
                />
                {files.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {files.length} file(s)
                  </span>
                )}
                <Button type="submit" size="sm" className="h-7 text-xs" disabled={files.length === 0 || uploading}>
                  {uploading ? "Uploading…" : "Upload"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => { setShowUpload(false); setFiles([]); addLog("[Content Library] Upload cancelled") }}
                  disabled={uploading}
                >
                  Cancel
                </Button>
              </form>
            )}

            {/* File list */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              {filteredAndSorted.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  {items.length === 0
                    ? (category === "images" ? "No images. Click Upload to add." : "No audio. Click Upload to add.")
                    : "No matches for your search."}
                </div>
              ) : (
                <div className="border-t">
                  <div className="grid grid-cols-[auto_1fr_1fr_auto] gap-2 px-3 py-1.5 text-xs text-muted-foreground border-b bg-muted/20 items-center">
                    <div className="w-6" />
                    <span>Name</span>
                    <span>Tags</span>
                    <span className="w-14 text-right">Actions</span>
                  </div>
                  {filteredAndSorted.map((item) => (
                    <div key={item.id} className="border-b border-border/50">
                      <div className="grid grid-cols-[auto_1fr_1fr_auto] gap-2 px-3 py-1.5 items-center hover:bg-muted/30 group text-sm">
                        <button
                          className="w-6 p-0.5 rounded hover:bg-muted flex items-center justify-center"
                          onClick={() => {
                            const next = expandedId === item.id ? null : item.id
                            setExpandedId(next)
                            if (next) addLog(`[Content Library] Preview: ${item.name}`)
                          }}
                        >
                          {expandedId === item.id ? (
                            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                          ) : (
                            <ChevronUp className="h-3.5 w-3.5 text-muted-foreground rotate-90" />
                          )}
                        </button>
                        <div className="flex items-center gap-2 min-w-0">
                          {category === "images" && item.type === "image" ? (
                            <img
                              src={`/api/content-library/image/${item.id}/file`}
                              alt=""
                              className="h-8 w-8 object-cover rounded shrink-0"
                            />
                          ) : (
                            <Music className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate font-medium" title={item.name}>
                            {item.name}
                          </span>
                        </div>
                        <span className="truncate text-muted-foreground text-xs min-w-0">
                          {(item.tags ?? []).length ? (item.tags as string[]).join(", ") : "—"}
                        </span>
                        <div className="flex justify-end gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity w-14">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            onClick={() => openEdit(item)}
                            title="Edit"
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                            onClick={() => setDeleteConfirm({ id: item.id, name: item.name })}
                            title="Delete"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                      {expandedId === item.id && (
                        <div className="px-4 py-2 bg-muted/10 border-t border-border/30">
                          {category === "images" && item.type === "image" ? (
                            <img
                              src={`/api/content-library/image/${item.id}/file`}
                              alt={item.name}
                              className="max-h-48 max-w-md object-contain rounded"
                            />
                          ) : (
                            <audio
                              src={`/api/content-library/audio/${item.id}/file`}
                              controls
                              className="w-full max-w-md h-8"
                              preload="metadata"
                            />
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center p-8 text-center text-muted-foreground text-sm">
            <div>
              <p className="font-medium">{CATEGORIES.find((c) => c.id === category)?.label}</p>
              <p className="text-xs mt-1">Coming soon</p>
            </div>
          </div>
        )}
      </main>

      {/* Edit modal */}
      {editingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-card rounded-lg border shadow-lg w-full max-w-sm p-4">
            <h3 className="font-medium text-sm mb-3">Edit</h3>
            <form onSubmit={handleUpdate} className="space-y-2">
              <div>
                <label className="text-xs text-muted-foreground block mb-0.5">Name</label>
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Name"
                  className="h-7 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-0.5">Tags</label>
                <Input
                  value={editTags}
                  onChange={(e) => setEditTags(e.target.value)}
                  placeholder="tag1, tag2"
                  className="h-7 text-sm"
                />
              </div>
              <div className="flex gap-2 justify-end pt-1">
                <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => setEditingId(null)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" className="h-7 text-xs">Save</Button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!deleteConfirm}
        onOpenChange={(open) => !open && setDeleteConfirm(null)}
        title={category === "images" ? "Delete image" : "Delete audio"}
        message={deleteConfirm ? `Delete "${deleteConfirm.name}"? This cannot be undone.` : ""}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  )
}
