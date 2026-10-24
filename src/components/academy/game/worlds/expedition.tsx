import { CHAPTERS } from "@/lib/academy/world";
import { LandmarkArt, PropArt, THEME } from "../world-art";
import { rand, type RegionProps } from "./shared";

/** Market Expedition: one illustrated region (terrain patches, the chapter's landmark and props). */
export function ExpeditionRegion({ index, box, width, wide, anchor, complete }: RegionProps) {
  const theme = CHAPTERS[Math.min(index, CHAPTERS.length - 1)].theme;
  const style = THEME[theme];
  return (
    <g>
      {/* Soft patches of lighter ground give the terrain depth. */}
      {Array.from({ length: wide ? 7 : 5 }, (_, item) => (
        <ellipse
          key={item}
          cx={(item / (wide ? 6 : 4)) * width + (rand(index * 31 + item) - 0.5) * (wide ? 160 : 90)}
          cy={box.top + box.height * (0.25 + ((item * 37) % 60) / 100)}
          rx={wide ? 180 + (rand(item + 3) - 0.5) * 80 : 110 + (rand(item + 5) - 0.5) * 40}
          ry={wide ? 70 + (rand(item + 7) - 0.5) * 30 : 50 + (rand(item + 9) - 0.5) * 20}
          fill={style.patch}
          opacity="0.22"
        />
      ))}
      {theme === "observatory" || theme === "city"
        ? Array.from({ length: wide ? 16 : 9 }, (_, item) => (
          <circle key={`s${item}`} className="mq-twinkle" cx={((item * 97) % 100) / 100 * width + (rand(item) - 0.5) * 40} cy={box.top + 20 + ((item * 53) % 100) / 100 * box.height * 0.9} r={item % 3 ? 1.8 : 2.8} fill="#fff" opacity="0.7" />
        ))
        : null}
      <g transform={`translate(${anchor.x} ${anchor.y}) scale(${anchor.scale})`}>
        <ellipse cx="0" cy="2" rx="210" ry="38" fill={style.patch} opacity="0.75" />
        <LandmarkArt theme={theme} complete={complete} />
      </g>
      {box.nodes.map((node, item) => {
        const away = wide ? (node.x > width / 2 ? -300 : 300) : node.x > width / 2 ? -205 : 205;
        const x = Math.max(46, Math.min(width - 46, node.x + away + (rand(index * 7 + item) - 0.5) * (wide ? 70 : 30)));
        return (
          <g key={item}>
            <g transform={`translate(${x} ${node.y + 34}) scale(${wide ? 1 : 0.85})`}><PropArt theme={theme} variant={item + index} /></g>
            {wide ? <g transform={`translate(${item % 2 ? -70 : width + 70} ${node.y + 20})`}><PropArt theme={theme} variant={item + 1} /></g> : null}
          </g>
        );
      })}
    </g>
  );
}
