import React, { useState, useEffect, useMemo } from "react"
import { AbsoluteFill, Audio, Sequence, Video, useCurrentFrame, useVideoConfig } from "remotion"
import { createTikTokStyleCaptions } from "@remotion/captions"
import type { Caption } from "@remotion/captions"

/** Video clip in RemotionScene JSON schema */
export interface SceneVideoClip {
  type: "video"
  src: string
  from: number
  durationInFrames: number
  layout?: "fill" | "contain" | "cover"
  volume?: number
  /** Horizontal offset as % of scene width; negative = left, positive = right (default 0) */
  x?: number
  /** Vertical offset as % of scene height; negative = up, positive = down (default 0) */
  y?: number
  /** Scale factor; 1 = natural size, 0.5 = half, 2 = double (default 1) */
  scale?: number
  /** Opacity 0 (transparent) to 1 (fully opaque) (default 1) */
  opacity?: number
}

/** Text overlay clip in RemotionScene JSON schema */
export interface SceneTextClip {
  type: "text"
  text: string
  from: number
  durationInFrames: number
  position?: "bottom" | "top" | "center"
  fontSize?: number
  color?: string
}

/** Audio clip in RemotionScene JSON schema */
export interface SceneAudioClip {
  type: "audio"
  src: string
  from: number
  durationInFrames: number
  volume?: number
}

/** Subtitle clip using @remotion/captions word-level timing */
export interface SceneSubtitleClip {
  type: "subtitle"
  from: number
  durationInFrames: number
  /** Word-level captions array or URL to fetch Caption[] JSON */
  captions: Caption[] | string
  /** Milliseconds window to combine words into one page (default 1200) */
  combineTokensWithinMs?: number
  /** Position on screen (default "bottom"). Ignored when x/y are set. */
  position?: "bottom" | "top" | "center" | "bottom-left" | "bottom-right" | "top-left" | "top-right"
  /** Vertical offset in px from edge (default 40). Ignored when x/y are set. */
  positionOffset?: number
  /** Horizontal offset as % from center; negative = left, positive = right (0 = center). When set with y, overrides position. */
  x?: number
  /** Vertical offset as % from center; negative = up, positive = down (0 = center). When set with x, overrides position. */
  y?: number
  fontSize?: number
  /** Inactive word color (default "#ffffff") */
  color?: string
  /** Currently spoken word color (default "#FFD700") */
  activeColor?: string
  /** Background box color as hex (default "#000000") */
  bgColor?: string
  /** Background box opacity 0–1 (default 0.75) */
  bgOpacity?: number
  /** Font family — "reels" | "clean" | "bold" or CSS font-family string (default "reels") */
  fontFamily?: string
}

export type SceneClip = SceneVideoClip | SceneTextClip | SceneAudioClip | SceneSubtitleClip

export interface RemotionSceneProps {
  scene?: {
    width?: number
    height?: number
    fps?: number
    durationInFrames?: number
    clips?: SceneClip[]
    backgroundColor?: string
    /** When true, render first video clip as scaled + blurred background */
    blurredBackground?: boolean
    /** Blur radius in px for background (default 40) */
    blurredBackgroundRadius?: number
    /** Scale factor for background video, >1 = zoomed in (default 1.2) */
    blurredBackgroundScale?: number
    /** Volume for blurred background video (0 to 1, default 0) */
    blurredBackgroundVolume?: number
  }
}

const FONT_PRESETS: Record<string, string> = {
  reels: "Bebas Neue, Impact, 'Arial Black', 'Helvetica Neue', sans-serif",
  clean: "Montserrat, system-ui, -apple-system, sans-serif",
  bold: "Oswald, Impact, 'Arial Black', sans-serif",
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "")
  const r = parseInt(h.slice(0, 2) || "0", 16)
  const g = parseInt(h.slice(2, 4) || "0", 16)
  const b = parseInt(h.slice(4, 6) || "0", 16)
  return `rgba(${r},${g},${b},${alpha})`
}

function parseCaptionsResponse(raw: unknown): Caption[] {
  if (Array.isArray(raw)) return raw
  const obj = raw as Record<string, unknown>
  const arr = obj?.captions ?? obj?.entries
  return Array.isArray(arr) ? arr : []
}

const SubtitleRenderer: React.FC<{ clip: SceneSubtitleClip }> = ({ clip }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const [fetchedCaptions, setFetchedCaptions] = useState<Caption[] | null>(null)

  const captionsRaw = clip.captions
  const captions: Caption[] = (() => {
    if (Array.isArray(captionsRaw)) return captionsRaw
    if (typeof captionsRaw === "string" && (captionsRaw.startsWith("http") || captionsRaw.startsWith("/"))) {
      return fetchedCaptions ?? []
    }
    return []
  })()

  useEffect(() => {
    if (typeof captionsRaw !== "string" || (!captionsRaw.startsWith("http") && !captionsRaw.startsWith("/"))) return
    let cancelled = false
    fetch(captionsRaw, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return
        setFetchedCaptions(parseCaptionsResponse(data))
      })
      .catch(() => { if (!cancelled) setFetchedCaptions([]) })
    return () => { cancelled = true }
  }, [captionsRaw])

  const {
    combineTokensWithinMs = 1200,
    position = "bottom",
    positionOffset = 40,
    x: xPercent,
    y: yPercent,
    fontSize = 36,
    color = "#ffffff",
    activeColor = "#FFD700",
    bgColor = "#000000",
    bgOpacity = 0.75,
    fontFamily: fontFamilyProp = "reels",
  } = clip

  const fontFamily = FONT_PRESETS[fontFamilyProp] ?? fontFamilyProp

  const { pages } = useMemo(
    () => createTikTokStyleCaptions({ captions, combineTokensWithinMilliseconds: combineTokensWithinMs }),
    [captions, combineTokensWithinMs],
  )

  const currentTimeMs = (frame / fps) * 1000
  const activePage = pages.find(
    (p) => currentTimeMs >= p.startMs && currentTimeMs < p.startMs + p.durationMs,
  )

  if (!activePage) return null

  const subtitleContent = (
    <div style={{ maxWidth: "85%" }}>
      <div
        style={{
          backgroundColor: hexToRgba(bgColor, bgOpacity),
          borderRadius: 8,
          padding: "12px 28px",
        }}
      >
        <div
          style={{
            fontSize,
            textAlign: "center",
            lineHeight: 1.4,
            fontFamily,
            fontWeight: 600,
            textShadow: "0 2px 6px rgba(0,0,0,0.7)",
            whiteSpace: "pre",
          }}
        >
          {activePage.tokens.map((token, i) => {
            const isActive = currentTimeMs >= token.fromMs && currentTimeMs < token.toMs
            return (
              <span key={i} style={{ color: isActive ? activeColor : color }}>
                {token.text}
              </span>
            )
          })}
        </div>
      </div>
    </div>
  )

  if (xPercent != null && yPercent != null) {
    return (
      <div
        style={{
          position: "absolute",
          top: 0, left: 0, right: 0, bottom: 0,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: `calc(50% + ${typeof yPercent === "number" ? `${yPercent}%` : yPercent})`,
            left: `calc(50% + ${typeof xPercent === "number" ? `${xPercent}%` : xPercent})`,
            transform: "translate(-50%, -50%)",
          }}
        >
          {subtitleContent}
        </div>
      </div>
    )
  }

  const offset = Math.max(0, positionOffset)
  const posMap: Record<string, React.CSSProperties> = {
    top: { top: offset, bottom: "auto", left: 0, right: 0, justifyContent: "center" },
    "top-left": { top: offset, bottom: "auto", left: offset, right: "auto", justifyContent: "flex-start" },
    "top-right": { top: offset, bottom: "auto", left: "auto", right: offset, justifyContent: "flex-end" },
    center: { top: "50%", bottom: "auto", left: 0, right: 0, transform: "translateY(-50%)", justifyContent: "center" },
    bottom: { top: "auto", bottom: offset, left: 0, right: 0, justifyContent: "center" },
    "bottom-left": { top: "auto", bottom: offset, left: offset, right: "auto", justifyContent: "flex-start" },
    "bottom-right": { top: "auto", bottom: offset, left: "auto", right: offset, justifyContent: "flex-end" },
  }

  return (
    <AbsoluteFill
      style={{
        ...(posMap[position] ?? posMap.bottom),
        display: "flex",
        alignItems: "center",
        pointerEvents: "none",
        position: "absolute",
      }}
    >
      {subtitleContent}
    </AbsoluteFill>
  )
}

export const SceneComposition: React.FC<RemotionSceneProps> = ({ scene }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const clips = scene?.clips ?? []
  const backgroundColor = scene?.backgroundColor ?? "#0a0a0a"
  const blurredBg = scene?.blurredBackground ?? false
  const blurRadius = scene?.blurredBackgroundRadius ?? 40
  const blurScale = scene?.blurredBackgroundScale ?? 1.2
  const blurVolume = scene?.blurredBackgroundVolume ?? 0

  const firstVideoClip = clips.find((c) => c.type === "video")

  return (
    <AbsoluteFill style={{ backgroundColor }}>
      {blurredBg && firstVideoClip && (
        <AbsoluteFill style={{ overflow: "hidden" }}>
          <AbsoluteFill
            style={{
              transform: `scale(${blurScale})`,
              filter: `blur(${blurRadius}px)`,
            }}
          >
            <Sequence
              from={firstVideoClip.from}
              durationInFrames={firstVideoClip.durationInFrames}
            >
              <AbsoluteFill>
                <Video
                  src={firstVideoClip.src}
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  volume={blurVolume}
                  crossOrigin="anonymous"
                />
              </AbsoluteFill>
            </Sequence>
          </AbsoluteFill>
        </AbsoluteFill>
      )}
      {clips.map((clip, idx) => {
        if (clip.type === "video") {
          const hasTransform = clip.x != null || clip.y != null || clip.scale != null
          const transform = hasTransform
            ? `translate(${clip.x ?? 0}%, ${clip.y ?? 0}%) scale(${clip.scale ?? 1})`
            : undefined
          return (
            <Sequence key={idx} from={clip.from} durationInFrames={clip.durationInFrames}>
              <AbsoluteFill
                style={{
                  objectFit: clip.layout ?? "contain",
                  ...(transform ? { transform, transformOrigin: "center center" } : {}),
                  ...(clip.opacity != null ? { opacity: clip.opacity } : {}),
                }}
              >
                <Video
                  src={clip.src}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: clip.layout ?? "contain",
                  }}
                  volume={clip.volume}
                  crossOrigin="anonymous"
                />
              </AbsoluteFill>
            </Sequence>
          )
        }
        if (clip.type === "text") {
          const pos = clip.position ?? "bottom"
          const posStyle =
            pos === "bottom"
              ? { bottom: 0, left: 0, right: 0, justifyContent: "center" as const }
              : pos === "top"
                ? { top: 0, left: 0, right: 0, justifyContent: "center" as const }
                : { top: "50%", left: 0, right: 0, justifyContent: "center" as const, transform: "translateY(-50%)" }
          return (
            <Sequence key={idx} from={clip.from} durationInFrames={clip.durationInFrames}>
              <AbsoluteFill
                style={{
                  ...posStyle,
                  display: "flex",
                  alignItems: "center",
                  padding: 24,
                  pointerEvents: "none",
                }}
              >
                <div
                  style={{
                    fontSize: clip.fontSize ?? 48,
                    color: clip.color ?? "#ffffff",
                    textShadow: "0 2px 4px rgba(0,0,0,0.8)",
                    textAlign: "center",
                  }}
                >
                  {clip.text}
                </div>
              </AbsoluteFill>
            </Sequence>
          )
        }
        if (clip.type === "audio") {
          return (
            <Sequence key={idx} from={clip.from} durationInFrames={clip.durationInFrames}>
              <Audio src={clip.src} volume={clip.volume} useWebAudioApi crossOrigin="anonymous" />
            </Sequence>
          )
        }
        if (clip.type === "subtitle") {
          return (
            <Sequence key={idx} from={clip.from} durationInFrames={clip.durationInFrames}>
              <SubtitleRenderer clip={clip} />
            </Sequence>
          )
        }
        return null
      })}
      {clips.length === 0 && (
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            color: "rgba(255,255,255,0.5)",
            fontSize: 24,
          }}
        >
          <div>Scene preview — {Math.floor(frame / fps)}s</div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  )
}
