import { useEffect, useState } from "react";

const QUERY = "(max-width: 600px)";

/** True on phone-width screens. Follows rotation and resizing. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof matchMedia === "function" && matchMedia(QUERY).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(QUERY);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}
