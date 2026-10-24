import type { ChapterTheme } from "@/lib/academy/world";
import type { World } from "./geometry";
import { LandmarkArt, PropArt, THEME } from "./world-art";

/** Where a chapter's landmark stands (world units) and how large it is drawn. */
export function landmarkAnchor(world: World, index: number) {
  const box = world.chapters[index];
  if (world.layout === "wide") return { x: box.side === "right" ? 935 : 265, y: box.top + 262, scale: 1 };
  return { x: box.side === "right" ? 418 : 182, y: box.top + 392, scale: 0.74 };
}

/** Small deterministic jitter so props do not line up in a grid. */
function jitter(seed: number, range: number) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return (value - Math.floor(value) - 0.5) * range;
}

/**
 * The scenery under the road: each chapter's terrain, landmark and props, and the mist over the
 * chapters not reached yet. One SVG in the world's units; decorative only.
 */
export function MapEnvironment({ world, chapters }: { world: World; chapters: Array<{ theme: ChapterTheme; complete: boolean }> }) {
  const wide = world.layout === "wide";
  const { width, height } = world;
  return (
    // overflow: visible lets the terrain run past the map's edges on wide screens.
    <svg className="mq-scene" viewBox={`0 0 ${width} ${height}`} overflow="visible" style={{ overflow: "visible" }} aria-hidden>
      {world.chapters.map((box) => {
        const chapter = chapters[box.index];
        const theme = THEME[chapter.theme];
        const anchor = landmarkAnchor(world, box.index);
        return (
          <g key={box.index}>
            {/* Soft patches of lighter ground give the terrain depth. */}
            {Array.from({ length: wide ? 7 : 5 }, (_, index) => (
              <ellipse
                key={index}
                cx={(index / (wide ? 6 : 4)) * width + jitter(box.index * 31 + index, wide ? 160 : 90)}
                cy={box.top + box.height * (0.25 + ((index * 37) % 60) / 100)}
                rx={wide ? 180 + jitter(index + 3, 80) : 110 + jitter(index + 5, 40)}
                ry={wide ? 70 + jitter(index + 7, 30) : 50 + jitter(index + 9, 20)}
                fill={theme.patch}
                opacity="0.22"
              />
            ))}
            {chapter.theme === "observatory" || chapter.theme === "city"
              ? Array.from({ length: wide ? 16 : 9 }, (_, index) => (
                <circle key={`s${index}`} className="mq-twinkle" cx={((index * 97) % 100) / 100 * width + jitter(index, 40)} cy={box.top + 20 + ((index * 53) % 100) / 100 * box.height * 0.9} r={index % 3 ? 1.8 : 2.8} fill="#fff" opacity="0.7" />
              ))
              : null}
            {/* The landmark on a mound. */}
            <g transform={`translate(${anchor.x} ${anchor.y}) scale(${anchor.scale})`}>
              <ellipse cx="0" cy="2" rx="210" ry="38" fill={theme.patch} opacity="0.75" />
              <LandmarkArt theme={chapter.theme} complete={chapter.complete} />
            </g>
            {/* Props beside the road, on the side away from each stop. */}
            {box.nodes.map((node, index) => {
              const away = wide ? (node.x > width / 2 ? -300 : 300) : node.x > width / 2 ? -205 : 205;
              const x = Math.max(46, Math.min(width - 46, node.x + away + jitter(box.index * 7 + index, wide ? 70 : 30)));
              return (
                <g key={`p${index}`}>
                  <g transform={`translate(${x} ${node.y + 34}) scale(${wide ? 1 : 0.85})`}><PropArt theme={chapter.theme} variant={index + box.index} /></g>
                  {wide ? <g transform={`translate(${index % 2 ? -70 : width + 70} ${node.y + 20})`}><PropArt theme={chapter.theme} variant={index + 1} /></g> : null}
                </g>
              );
            })}
          </g>
        );
      })}

      {world.fog ? (
        <g>
          <defs>
            <linearGradient id="mq-mist" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#c9d8ff" stopOpacity="0" />
              <stop offset="0.25" stopColor="#c9d8ff" stopOpacity="0.22" />
              <stop offset="1" stopColor="#c9d8ff" stopOpacity="0.32" />
            </linearGradient>
          </defs>
          {/* Distant peaks of the regions ahead, half hidden. */}
          <path
            d={`M ${-width} ${world.fog.top + 220} L ${width * 0.08} ${world.fog.top + 90} L ${width * 0.22} ${world.fog.top + 170} L ${width * 0.4} ${world.fog.top + 60} L ${width * 0.58} ${world.fog.top + 160} L ${width * 0.76} ${world.fog.top + 80} L ${width * 0.92} ${world.fog.top + 150} L ${width * 2} ${world.fog.top + 120} L ${width * 2} ${height + 200} L ${-width} ${height + 200} Z`}
            fill="#3d4f75"
            opacity="0.55"
          />
          <rect x={-width} y={world.fog.top - 60} width={width * 3} height={world.fog.height + 260} fill="url(#mq-mist)" />
        </g>
      ) : null}
    </svg>
  );
}
