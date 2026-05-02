import { Link, Route, Routes } from "react-router-dom";
import { NewVault } from "./routes/NewVault.tsx";
import { VaultsList } from "./routes/VaultsList.tsx";

export function App() {
  return (
    <div className="page">
      <nav className="nav">
        <Link to="/vaults" className="brand">
          Parachute Hub <span className="sub">vault management</span>
        </Link>
        <Link to="/vaults">Vaults</Link>
        <a href="/" title="Hub discovery page (top-level)">
          Discovery
        </a>
      </nav>

      <Routes>
        <Route path="/" element={<VaultsList />} />
        <Route path="/vaults" element={<VaultsList />} />
        <Route path="/vaults/new" element={<NewVault />} />
        <Route
          path="*"
          element={
            <div className="empty">
              404 — back to <Link to="/vaults">vaults</Link>.
            </div>
          }
        />
      </Routes>
    </div>
  );
}
