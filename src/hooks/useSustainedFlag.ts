import { useEffect, useState } from "react";

/**
 * `true` só depois que `flag` ficou verdadeira por `ms` seguidos; volta a
 * `false` na hora. Serve para faixa de estado transitório (reconexão do
 * realtime) não piscar em blips que se resolvem sozinhos.
 */
export function useSustainedFlag(flag: boolean, ms: number): boolean {
  const [sustained, setSustained] = useState(false);

  useEffect(() => {
    if (!flag) {
      setSustained(false);
      return;
    }
    const timer = setTimeout(() => setSustained(true), ms);
    return () => clearTimeout(timer);
  }, [flag, ms]);

  return sustained;
}
