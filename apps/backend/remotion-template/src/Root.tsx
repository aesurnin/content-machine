import React from 'react';
import { Composition } from 'remotion';
import { SceneComposition, type RemotionSceneProps } from './SceneComposition';

// Load Reels-style fonts (Bebas Neue, Montserrat, Oswald)
const FONT_LINK =
  "https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Montserrat:wght@600;700&family=Oswald:wght@600;700&display=swap";

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_FPS = 30;
const DEFAULT_DURATION = 30 * 30; // 30 seconds

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <link rel="stylesheet" href={FONT_LINK} />
      <Composition
        id="Scene"
        component={SceneComposition}
        durationInFrames={DEFAULT_DURATION}
        fps={DEFAULT_FPS}
        width={DEFAULT_WIDTH}
        height={DEFAULT_HEIGHT}
        defaultProps={{
          scene: {
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            fps: DEFAULT_FPS,
            durationInFrames: DEFAULT_DURATION,
            clips: [],
            backgroundColor: '#0a0a0a',
          },
        } as RemotionSceneProps}
        calculateMetadata={({ props }) => {
          const s = props.scene;
          if (!s) {
            return {
              width: DEFAULT_WIDTH,
              height: DEFAULT_HEIGHT,
              fps: DEFAULT_FPS,
              durationInFrames: DEFAULT_DURATION,
            };
          }
          const duration =
            s.durationInFrames ??
            (s.clips?.length
              ? Math.max(
                  ...(s.clips?.map((c) => c.from + c.durationInFrames) ?? [0])
                )
              : DEFAULT_DURATION);
          return {
            width: s.width ?? DEFAULT_WIDTH,
            height: s.height ?? DEFAULT_HEIGHT,
            fps: s.fps ?? DEFAULT_FPS,
            durationInFrames: duration,
          };
        }}
      />
    </>
  );
};
