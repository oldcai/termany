import cursor from "../assets/agents/cursor.svg?raw";
import cursorUrl from "../assets/agents/cursor.svg?url";
import grok from "../assets/agents/grok.svg?raw";
import grokUrl from "../assets/agents/grok.svg?url";
import kilo from "../assets/agents/kilocode.svg?raw";
import kiloUrl from "../assets/agents/kilocode.svg?url";
import kimi from "../assets/agents/kimi.svg?raw";
import kimiUrl from "../assets/agents/kimi.svg?url";
import opencode from "../assets/agents/opencode.svg?raw";
import opencodeUrl from "../assets/agents/opencode.svg?url";

// Only these bundled, trusted SVGs are inlined. Replace their white strokes
// with the theme's foreground while keeping colored details such as Kimi's dot.
const themedLogos = new Map([
  [cursorUrl, cursor], [grokUrl, grok], [kiloUrl, kilo], [kimiUrl, kimi], [opencodeUrl, opencode],
].map(([url, svg]) => [url, svg.replace(/fill="#fff"/g, 'fill="currentColor"')]));

export function AgentLogo({ src }: { src: string }) {
  const svg = themedLogos.get(src);
  return svg
    ? <span className="agent-brand-logo" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
    : <img src={src} alt="" />;
}
