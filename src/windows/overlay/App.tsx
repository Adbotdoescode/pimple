import "./overlay.css";
import { useSession } from "../../lib/sessionMirror";
import { OverlayRoot } from "./OverlayRoot";

export default function App() {
  const snapshot = useSession((s) => s);
  return <OverlayRoot snapshot={snapshot} />;
}
