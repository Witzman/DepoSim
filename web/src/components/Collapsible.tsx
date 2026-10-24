import { useState, type ReactNode } from "react";

interface Props {
  /** On a narrow screen the content sits in a <details>; elsewhere it is shown as it is. */
  narrow: boolean;
  title: string;
  /** Open on its own as long as the person has not toggled it. */
  openByDefault?: boolean;
  children: ReactNode;
}

export function Collapsible({ narrow, title, openByDefault = false, children }: Props) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  if (!narrow) return <>{children}</>;
  const open = chosen ?? openByDefault;
  // A person's click wins; programmatic changes of `open` must not count as one.
  return (
    <details className="fold" open={open}>
      <summary onClick={(e) => { e.preventDefault(); setChosen(!open); }}>{title}</summary>
      {children}
    </details>
  );
}
