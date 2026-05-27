import { Link, createRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Route as rootRoute } from "./__root";
import { api, ApiError } from "../api";

interface Space {
  id: string;
  slug: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  createdBySub: string;
  memberRole: "owner" | "editor" | "viewer" | null;
}

function SpacesList() {
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  async function reload() {
    try {
      const data = await api.get<Space[]>("/api/spaces");
      setSpaces(data);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(String(err));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  return (
    <>
      <div className="scribe-header__row">
        <h1 style={{ margin: 0 }}>Spaces</h1>
        <button onClick={() => setModalOpen(true)}>New space</button>
      </div>
      {error && <div className="scribe-error">{error}</div>}
      {!spaces ? (
        <p className="scribe-empty">loading</p>
      ) : spaces.length === 0 ? (
        <p className="scribe-empty">No accessible spaces yet.</p>
      ) : (
        <div className="scribe-card-grid">
          {spaces.map((s) => (
            <Link key={s.id} to="/spaces/$slug" params={{ slug: s.slug }} className="scribe-card">
              <div className="scribe-card__title">{s.name}</div>
              <div className="scribe-card__role">{s.memberRole ?? "public"}</div>
              {s.description && <div>{s.description}</div>}
            </Link>
          ))}
        </div>
      )}
      {modalOpen && (
        <CreateSpaceModal
          onClose={() => setModalOpen(false)}
          onCreated={async () => {
            setModalOpen(false);
            await reload();
          }}
        />
      )}
    </>
  );
}

function CreateSpaceModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<Space>("/api/spaces", { slug, name, description, visibility });
      onCreated();
      void navigate({ to: "/spaces/$slug", params: { slug: created.slug } });
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scribe-modal" role="dialog" aria-modal="true">
      <div className="scribe-modal__body">
        <h2 style={{ margin: 0 }}>New space</h2>
        <label>
          Slug
          <input
            value={slug}
            onChange={(e) => setSlug(e.currentTarget.value)}
            placeholder="my-team"
            autoFocus
          />
        </label>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="My Team" />
        </label>
        <label>
          Description
          <textarea
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            rows={3}
          />
        </label>
        <label>
          Visibility
          <select value={visibility} onChange={(e) => setVisibility(e.currentTarget.value as "private" | "public")}>
            <option value="private">Private</option>
            <option value="public">Public</option>
          </select>
        </label>
        {error && <div className="scribe-error">{error}</div>}
        <div className="scribe-row">
          <button onClick={submit} disabled={busy || !slug || !name}>Create</button>
          <button className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/spaces",
  component: SpacesList,
});
