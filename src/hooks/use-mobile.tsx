import * as React from "react";

// Breakpoints seguindo Tailwind CSS
const BREAKPOINTS = {
  xs: 0,
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
} as const;

type Breakpoint = keyof typeof BREAKPOINTS;

const MOBILE_BREAKPOINT = BREAKPOINTS.md;

export function useIsMobile() {
  // Resolvido de forma síncrona no primeiro render: evitar o flash de layout
  // desktop (e a desmontagem/refetch que ele causa) em toda abertura no celular.
  const [isMobile, setIsMobile] = React.useState<boolean>(
    () => typeof window !== "undefined" && window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches,
  );

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}

export function useBreakpoint(): Breakpoint {
  const [breakpoint, setBreakpoint] = React.useState<Breakpoint>("md");

  React.useEffect(() => {
    const getBreakpoint = (): Breakpoint => {
      const width = window.innerWidth;
      if (width >= BREAKPOINTS["2xl"]) return "2xl";
      if (width >= BREAKPOINTS.xl) return "xl";
      if (width >= BREAKPOINTS.lg) return "lg";
      if (width >= BREAKPOINTS.md) return "md";
      if (width >= BREAKPOINTS.sm) return "sm";
      return "xs";
    };

    const handleResize = () => setBreakpoint(getBreakpoint());
    handleResize();

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return breakpoint;
}

export function useIsBreakpoint(target: Breakpoint): boolean {
  const current = useBreakpoint();
  return current === target;
}

export function useIsBreakpointUp(target: Breakpoint): boolean {
  const [isUp, setIsUp] = React.useState(false);

  React.useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${BREAKPOINTS[target]}px)`);
    const onChange = () => setIsUp(mql.matches);
    mql.addEventListener("change", onChange);
    setIsUp(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, [target]);

  return isUp;
}

export function useIsBreakpointDown(target: Breakpoint): boolean {
  const [isDown, setIsDown] = React.useState(false);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${BREAKPOINTS[target] - 1}px)`);
    const onChange = () => setIsDown(mql.matches);
    mql.addEventListener("change", onChange);
    setIsDown(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, [target]);

  return isDown;
}

export function useTouchDevice(): boolean {
  const [isTouch, setIsTouch] = React.useState(false);

  React.useEffect(() => {
    const checkTouch = () => {
      setIsTouch(
        "ontouchstart" in window ||
        navigator.maxTouchPoints > 0 ||
        // @ts-expect-error - msMaxTouchPoints is IE specific
        navigator.msMaxTouchPoints > 0
      );
    };
    checkTouch();
  }, []);

  return isTouch;
}

export function useOrientation(): "portrait" | "landscape" {
  const [orientation, setOrientation] = React.useState<"portrait" | "landscape">("portrait");

  React.useEffect(() => {
    const updateOrientation = () => {
      if (window.screen?.orientation?.type) {
        setOrientation(
          window.screen.orientation.type.includes("portrait") ? "portrait" : "landscape"
        );
      } else {
        setOrientation(window.innerHeight > window.innerWidth ? "portrait" : "landscape");
      }
    };

    updateOrientation();
    window.addEventListener("resize", updateOrientation);
    window.addEventListener("orientationchange", updateOrientation);

    return () => {
      window.removeEventListener("resize", updateOrientation);
      window.removeEventListener("orientationchange", updateOrientation);
    };
  }, []);

  return orientation;
}

export function useSafeAreaInsets() {
  const [insets, setInsets] = React.useState({
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  });

  React.useEffect(() => {
    const computeInsets = () => {
      const style = getComputedStyle(document.documentElement);
      setInsets({
        top: parseInt(style.getPropertyValue("--sat") || "0", 10),
        right: parseInt(style.getPropertyValue("--sar") || "0", 10),
        bottom: parseInt(style.getPropertyValue("--sab") || "0", 10),
        left: parseInt(style.getPropertyValue("--sal") || "0", 10),
      });
    };

    // Set CSS variables for safe area
    document.documentElement.style.setProperty("--sat", "env(safe-area-inset-top)");
    document.documentElement.style.setProperty("--sar", "env(safe-area-inset-right)");
    document.documentElement.style.setProperty("--sab", "env(safe-area-inset-bottom)");
    document.documentElement.style.setProperty("--sal", "env(safe-area-inset-left)");

    computeInsets();
  }, []);

  return insets;
}
