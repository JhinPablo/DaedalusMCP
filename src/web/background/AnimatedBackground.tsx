import { useEffect, useMemo, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { WorkshopScene, backgroundDuration, type SceneTheme } from "./WorkshopScene";
import { readLocal } from "../persistence";
import { useGlassSurfaces } from "../glass/use-glass";

export default function AnimatedBackground() {
  const [theme, setTheme] = useState<SceneTheme>(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  const [playing, setPlaying] = useState(false);
  const ref = useRef<PlayerRef>(null);
  const inputProps = useMemo(() => ({ theme }), [theme]);
  useGlassSurfaces(theme);
  useEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      const next =
        !reduced.matches &&
        document.visibilityState === "visible" &&
        readLocal("background-motion", true);
      try {
        if (next) ref.current?.play();
        else ref.current?.pause();
        setPlaying(next);
      } catch {
        ref.current?.pause();
        setPlaying(false);
      }
    };
    const observer = new MutationObserver(() =>
      setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light"),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    reduced.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("daedalus:appearance", update);
    window.addEventListener("storage", update);
    update();
    return () => {
      observer.disconnect();
      reduced.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("daedalus:appearance", update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return (
    <div
      className="ambient-background"
      aria-hidden="true"
      inert
      data-testid="animated-background"
      data-motion={playing ? "playing" : "paused"}
      data-theme={theme}
    >
      <div className="ambient-player">
        <Player
          ref={ref}
          component={WorkshopScene}
          inputProps={inputProps}
          compositionWidth={1600}
          compositionHeight={1000}
          durationInFrames={backgroundDuration}
          fps={24}
          loop
          controls={false}
          numberOfSharedAudioTags={0}
          autoPlay={false}
          clickToPlay={false}
          doubleClickToFullscreen={false}
          spaceKeyToPlayOrPause={false}
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    </div>
  );
}
