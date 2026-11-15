// Placeholder (scaffold). Domain 2 replaces this with the session controller.
import { useEffect } from "react";
import { onEvent } from "@/lib/ipc";

export default function App() {
  useEffect(() => {
    const un = onEvent("debug:inject", (p) => console.log("[brain] debug:inject", p));
    return () => {
      un.then((f) => f());
    };
  }, []);
  return <div data-label="brain">brain</div>;
}
