import { createContext, useContext } from "react";

/** Opens the manual (#57) at a chapter. The app provides it; outside of it the link does nothing. */
export const HowtoContext = createContext<(chapter: string) => void>(() => {});

/** A small "Mehr dazu" after a heading: opens the manual at that chapter without leaving the game. */
export function MoreLink({ chapter }: { chapter: string }) {
  const open = useContext(HowtoContext);
  return <button type="button" className="link more-link" data-testid={`more-${chapter}`} onClick={() => open(chapter)}>Mehr dazu</button>;
}
