import { useId } from "react";
import { AbsoluteFill, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
export const backgroundDuration = 960;
export type SceneTheme = "light" | "dark";
function Architecture({ theme }: { theme: SceneTheme }) {
  const frame = useCurrentFrame(),
    { durationInFrames } = useVideoConfig();
  const phase = (frame / durationInFrames) * 2 * Math.PI;
  return (
    <image
      href={staticFile(
        `backgrounds/workshop-${theme === "dark" ? "night" : "day"}.png`,
      )}
      x={-12 + Math.sin(phase) * 4}
      y={-8 + Math.cos(phase) * 2}
      width="1624"
      height="1016"
      preserveAspectRatio="xMidYMid slice"
    />
  );
}
function Atmosphere({ theme, id }: { theme: SceneTheme; id: string }) {
  const frame = useCurrentFrame(),
    { durationInFrames } = useVideoConfig();
  const phase = (frame / durationInFrames) * 2 * Math.PI;
  return (
    <g data-frame={frame}>
      <ellipse
        cx={1080 + Math.sin(phase) * 25}
        cy={225 + Math.cos(phase) * 4}
        rx="220"
        ry="90"
        fill={theme === "dark" ? "#a9c8db" : "#fff9df"}
        opacity={theme === "dark" ? 0.025 : 0.045}
      />
      <g
        clipPath={`url(#${id}-sea)`}
        stroke={theme === "dark" ? "#b1d4e3" : "#f7f1dd"}
        strokeWidth="1.1"
        fill="none"
      >
        {Array.from({ length: 24 }, (_, i) => (
          <path
            key={i}
            d={`M${500 + ((i * 83) % 1030) + Math.sin(phase + i) * 12} ${642 + ((i * 13) % 125)}q20 ${Math.sin(phase + i) * 1.2} ${36 + (i % 12)} 0`}
            opacity={0.035 + (1 + Math.sin(phase + i)) * 0.055}
          />
        ))}
      </g>
      <path
        d={`M0 205 360 ${375 + Math.sin(phase) * 18}v130L0 370Z`}
        fill={theme === "dark" ? "#071321" : "#687574"}
        opacity={theme === "dark" ? 0.025 : 0.04 + (1 + Math.cos(phase)) * 0.015}
      />
      {theme === "dark" && (
        <g fill="#c3dce8">
          {Array.from({ length: 14 }, (_, i) => (
            <circle
              key={i}
              cx={420 + ((i * 173) % 1120)}
              cy={50 + ((i * 67) % 370)}
              r={i % 3 === 0 ? 1 : 0.6}
              opacity={0.08 + (1 + Math.sin(phase + i)) * 0.08}
            />
          ))}
        </g>
      )}
    </g>
  );
}
export function WorkshopScene({ theme }: { theme: SceneTheme }) {
  const id = useId().replaceAll(":", "");
  return (
    <AbsoluteFill style={{ background: theme === "dark" ? "#132330" : "#e3e9e8" }}>
      <svg
        viewBox="0 0 1600 1000"
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
      >
        <defs>
          <clipPath id={`${id}-sea`}>
            <path d="M400 625h1200v135H710l-110-40H400Z" />
          </clipPath>
        </defs>
        <Architecture theme={theme} />
        <Atmosphere theme={theme} id={id} />
      </svg>
    </AbsoluteFill>
  );
}
