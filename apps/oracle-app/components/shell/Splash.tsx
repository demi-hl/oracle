"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";

/**
 * Branded Oracle launch splash, brief, before the
 * shell settles. Sits above the entire stack (incl. the Backdrop) and fades
 * out. Honors reduced-motion by dismissing near-instantly.
 */
export function Splash() {
  const [show, setShow] = useState(true);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(() => setShow(false), reduce ? 220 : 1150);
    return () => clearTimeout(t);
  }, []);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          aria-hidden
          className="fixed inset-0 z-[300] grid place-items-center bg-[#0B1018]"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        >
          { }
          <motion.img
            src="/oracle-mark.svg"
            alt=""
            draggable={false}
            className="h-28 w-28 object-contain drop-shadow-[0_0_32px_rgba(124,196,255,0.22)]"
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
