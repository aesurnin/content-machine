import { useState, useEffect, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { X, Sparkles, Loader2 } from "lucide-react"
import { RemotionPreview } from "@/components/remotion/RemotionPreview"

export function parseSlotsFromJson(jsonStr: string): Array<{ key: string; kind: string; label?: string }> {
  const trimmed = jsonStr.trim()
  if (!trimmed) return []
  try {
    const obj = JSON.parse(trimmed) as { slots?: unknown[] }
    if (!Array.isArray(obj.slots)) return []
    return obj.slots
      .filter((s): s is Record<string, unknown> => s != null && typeof s === "object")
      .map((s) => ({
        key: String(s.key ?? ""),
        kind: String(s.kind ?? "video"),
        label: typeof s.label === "string" ? s.label : undefined,
      }))
      .filter((s) => s.key)
  } catch {
    return []
  }
}

/** Extract scene object from scenario JSON for Remotion preview. */
function extractSceneFromScenario(jsonStr: string): Record<string, unknown> | null {
  const trimmed = jsonStr.trim()
  if (!trimmed) return null
  try {
    const obj = JSON.parse(trimmed) as { scene?: Record<string, unknown> }
    const scene = obj?.scene
    if (scene && typeof scene === "object" && Array.isArray(scene.clips)) return scene
    return null
  } catch {
    return null
  }
}

/** Replace {{slot_key}} placeholders in scene with actual URLs for preview. */
function resolveScenePlaceholders(
  scene: Record<string, unknown>,
  slotUrls: Record<string, string>
): Record<string, unknown> {
  const replaceInValue = (v: unknown): unknown => {
    if (v === null || v === undefined) return v
    if (typeof v === "string") {
      const match = v.match(/^\{\{([A-Za-z0-9_]+)\}\}$/)
      if (match) {
        const url = slotUrls[match[1]]
        return url ?? v
      }
      return v.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_, name) => slotUrls[name] ?? `{{${name}}}`)
    }
    if (Array.isArray(v)) return v.map(replaceInValue)
    if (typeof v === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v)) out[k] = replaceInValue(val)
      return out
    }
    return v
  }
  return replaceInValue(scene) as Record<string, unknown>
}

export interface ScenarioEditorModalProps {
  isOpen: boolean
  onClose: () => void
  initialPrompt: string
  initialSceneJson: string
  /** Map slot key -> URL for Remotion preview. Placeholders {{slot_key}} are replaced with these URLs. */
  slotUrls?: Record<string, string>
  onSave: (prompt: string, sceneJson: string, slots: Array<{ key: string; kind: string; label?: string }>) => void
  /** Generate receives prompt and current scenario JSON. Current scenario is always sent as context. */
  onGenerate: (prompt: string, currentSceneJson: string) => Promise<{ json: Record<string, unknown>; slots: Array<{ key: string; kind: string; label?: string }> } | { error: string }>
}

export function ScenarioEditorModal({
  isOpen,
  onClose,
  initialPrompt,
  initialSceneJson,
  slotUrls = {},
  onSave,
  onGenerate,
}: ScenarioEditorModalProps) {
  const [prompt, setPrompt] = useState(initialPrompt)
  const [sceneJson, setSceneJson] = useState(initialSceneJson)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    if (isOpen) {
      setPrompt(initialPrompt)
      setSceneJson(initialSceneJson)
    }
  }, [isOpen, initialPrompt, initialSceneJson])

  const sceneForPreview = useMemo(() => {
    const raw = extractSceneFromScenario(sceneJson)
    if (!raw) return null
    return resolveScenePlaceholders(raw, slotUrls)
  }, [sceneJson, slotUrls])
  const canGenerate = prompt.trim().length > 0

  const handleGenerate = async () => {
    if (!canGenerate) return
    setGenerating(true)
    try {
      const result = await onGenerate(prompt.trim(), sceneJson)
      if ("error" in result) {
        return
      }
      setSceneJson(JSON.stringify(result.json, null, 2))
    } finally {
      setGenerating(false)
    }
  }

  const handleSave = () => {
    const slots = parseSlotsFromJson(sceneJson)
    onSave(prompt, sceneJson, slots)
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="bg-background rounded-lg shadow-lg w-full max-w-[95vw] h-[90vh] flex flex-col overflow-hidden">
        <div className="p-4 border-b flex items-center justify-between shrink-0">
          <h3 className="font-semibold">Scenario Editor</h3>
          <Button variant="ghost" size="icon" onClick={onClose} title="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div
          className="flex-1 min-h-0 grid"
          style={{ gridTemplateColumns: "minmax(320px, 2fr) minmax(240px, 1.5fr) minmax(200px, 1fr)" }}
        >
          <div className="min-w-0 flex flex-col border-r overflow-hidden">
            <div className="p-2 border-b shrink-0">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Preview</span>
            </div>
            <div className="flex-1 min-h-0 overflow-auto p-2">
              {sceneForPreview ? (
                <RemotionPreview scene={sceneForPreview} className="w-full" />
              ) : (
                <div className="flex items-center justify-center h-full min-h-[200px] text-muted-foreground text-sm">
                  Enter valid scenario JSON to see preview
                </div>
              )}
            </div>
          </div>
          <div className="min-w-0 flex flex-col overflow-hidden">
            <div className="p-2 border-b shrink-0">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Scenario JSON</label>
            </div>
            <div className="flex-1 min-h-0 overflow-auto p-2">
              <textarea
                className="w-full h-full min-h-[200px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono resize-none"
                value={sceneJson}
                onChange={(e) => setSceneJson(e.target.value)}
                placeholder='{"slots": [...], "scene": {...}}'
                spellCheck={false}
              />
            </div>
          </div>
          <div className="min-w-0 flex flex-col overflow-hidden">
            <div className="p-2 border-b shrink-0">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Prompts</label>
            </div>
            <div className="flex-1 min-h-0 overflow-auto p-2 flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">
                Describe your changes. Current scenario is always sent to the model as context.
              </p>
              <textarea
                className="flex-1 min-h-[120px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono resize-y"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="e.g. Add a text overlay at the top. Make the first clip 5 seconds longer."
                spellCheck={false}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleGenerate}
                disabled={!canGenerate || generating}
              >
                {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Sparkles className="h-3.5 w-3.5 mr-1.5" />}
                Generate
              </Button>
            </div>
          </div>
        </div>

        <div className="p-4 border-t flex justify-end gap-2 shrink-0">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave}>
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}
