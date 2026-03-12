import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { X, Plus, Trash2, Loader2, Pencil } from "lucide-react"

export type EnvEntry = { key: string }

interface EnvManagerModalProps {
  isOpen: boolean
  onClose: () => void
}

const MASKED_VALUE = "••••••••"

export function EnvManagerModal({ isOpen, onClose }: EnvManagerModalProps) {
  const [list, setList] = useState<EnvEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newKey, setNewKey] = useState("")
  const [newValue, setNewValue] = useState("")
  const [saving, setSaving] = useState(false)
  const [deletingKey, setDeletingKey] = useState<string | null>(null)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")

  const fetchList = async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch("/api/env", { credentials: "include" })
      if (!r.ok) throw new Error(r.status === 401 ? "Unauthorized" : "Failed to load")
      const data = await r.json()
      setList(Array.isArray(data) ? data : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load variables")
      setList([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (isOpen) {
      fetchList()
      setNewKey("")
      setNewValue("")
      setEditingKey(null)
      setEditValue("")
    }
  }, [isOpen])

  const handleEdit = async (key: string) => {
    const value = editValue.trim()
    setError(null)
    setSaving(true)
    try {
      const r = await fetch("/api/env", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
        credentials: "include",
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        throw new Error(data.error || "Failed to save")
      }
      setEditingKey(null)
      setEditValue("")
      await fetchList()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  const handleAdd = async () => {
    const key = newKey.trim()
    const value = newValue.trim()
    if (!key) return
    const validKey = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    if (!validKey) {
      setError("Key must start with a letter or underscore and contain only letters, numbers, underscore")
      return
    }
    setError(null)
    setSaving(true)
    try {
      const r = await fetch("/api/env", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
        credentials: "include",
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        throw new Error(data.error || "Failed to save")
      }
      setNewKey("")
      setNewValue("")
      await fetchList()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (key: string) => {
    setDeletingKey(key)
    setError(null)
    try {
      const r = await fetch(`/api/env/${encodeURIComponent(key)}`, {
        method: "DELETE",
        credentials: "include",
      })
      if (!r.ok) throw new Error("Failed to delete")
      await fetchList()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete")
    } finally {
      setDeletingKey(null)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="bg-background rounded-lg shadow-lg max-w-2xl w-full max-h-[90vh] flex flex-col">
        <div className="p-4 border-b flex items-center justify-between shrink-0">
          <h3 className="font-semibold">Env Manager</h3>
          <Button variant="ghost" size="icon" onClick={onClose} title="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-auto p-4 flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Variables you add here are available project-wide (e.g. in workflows and backend). Keys must be valid env names (letters, numbers, underscore). Values are never shown after saving.
          </p>

          {/* Add new */}
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[120px]">
              <label className="text-xs text-muted-foreground block mb-1">Key</label>
              <Input
                placeholder="MY_VAR"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                className="font-mono text-sm"
              />
            </div>
            <div className="flex-1 min-w-[120px]">
              <label className="text-xs text-muted-foreground block mb-1">Value</label>
              <Input
                placeholder="value"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                className="font-mono text-sm"
              />
            </div>
            <Button onClick={handleAdd} disabled={saving || !newKey.trim()} size="sm">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              <span className="ml-1">Add</span>
            </Button>
          </div>

          {error && (
            <div className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">
              {error}
            </div>
          )}

          {/* List */}
          <div>
            <h4 className="text-xs font-medium text-muted-foreground mb-2">Current variables</h4>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </div>
            ) : list.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">No variables yet. Add one above.</p>
            ) : (
              <ul className="rounded border bg-panel-3 divide-y divide-border overflow-hidden">
                {list.map(({ key: k }) => (
                  <li key={k} className="flex items-center gap-2 px-3 py-2 group">
                    <span className="font-mono text-sm font-medium shrink-0 w-40 truncate" title={k}>
                      {k}
                    </span>
                    {editingKey === k ? (
                      <>
                        <Input
                          type="password"
                          placeholder="New value"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleEdit(k)
                            if (e.key === "Escape") {
                              setEditingKey(null)
                              setEditValue("")
                            }
                          }}
                          className="font-mono text-sm flex-1 h-8"
                          autoFocus
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          className="shrink-0"
                          onClick={() => {
                            setEditingKey(null)
                            setEditValue("")
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          className="shrink-0"
                          onClick={() => handleEdit(k)}
                          disabled={saving}
                        >
                          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
                        </Button>
                      </>
                    ) : (
                      <>
                        <span className="font-mono text-sm text-muted-foreground flex-1 min-w-0">
                          {MASKED_VALUE}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0 opacity-70 hover:opacity-100"
                          onClick={() => {
                            setEditingKey(k)
                            setEditValue("")
                          }}
                          title="Edit value"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0 opacity-70 hover:opacity-100 hover:text-destructive"
                          onClick={() => handleDelete(k)}
                          disabled={deletingKey === k}
                          title="Delete"
                        >
                          {deletingKey === k ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
