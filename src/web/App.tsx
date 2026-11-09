import {
  useCallback,
  useEffect,
  useRef,
  useState,
  lazy,
  Suspense,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Code2,
  Copy,
  FileText,
  GitBranch,
  Layers,
  Link2,
  Menu,
  MessageSquare,
  Network,
  Plus,
  Radio,
  RefreshCw,
  Send,
  ShieldCheck,
  Square,
  Terminal,
  Workflow,
  X,
} from "lucide-react";
import type {
  AgentRun,
  Proposal,
  Session,
  Workspace,
  PermissionRequest,
} from "../shared/model";
import { request, useWorkspace } from "./api";
import { readLocal, writeLocal, useLocalText } from "./persistence";
import { Releases } from "./Releases";
import { BrowserNotifications } from "./BrowserNotifications";
import { PreviewIdentity } from "./PreviewIdentity";
import { Appearance } from "./Appearance";
import { PermissionDetails, permissionDescription } from "./PermissionDetails";
import { canRetryPreflight } from "../shared/run-state";
import { Flow, WorkflowGuide } from "./Flow";
import skillLock from "../../skills-lock.json";

type Page =
  "workshop" | "execution" | "console" | "skills" | "connections" | "releases";
const MarkdownMessage = lazy(() => import("./MarkdownMessage"));
const phases: Record<string, string> = {
  idea: "Idea inicial",
  planning: "Explorando",
  approach: "Enfoque por aprobar",
  plan: "Prompt por aprobar",
  executing: "En ejecución",
  review: "Revisión final",
  completed: "Revisado",
  paused: "Necesita atención",
  cancelled: "Cancelado",
};
const runLabels: Record<string, string> = {
  queued: "En cola",
  running: "En curso",
  waiting_permission: "Espera tu permiso",
  completed: "Completada",
  failed: "Fallida",
  cancelled: "Cancelada",
  uncertain: "Resultado por reconciliar",
};
const currentVersion = (s: Session) => s.versions.at(-1);
const stamp = (date: string) =>
  new Date(date).toLocaleTimeString("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
function Mark() {
  return (
    <svg width="30" height="30" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M4 26V6h24v20H12V14h8v5M8 26V10h16v12H16v-4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="square"
      />
    </svg>
  );
}
function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty-block">
      <strong>{title}</strong>
      <div>{children}</div>
    </div>
  );
}
export function App() {
  const closeModal = useCallback(() => setModal(null), []);
  const { state, error, refresh, updateAvailable, deployedBuildId } = useWorkspace();
  const [page, setPage] = useState<Page>(() =>
      location.hash === "#releases" ? "releases" : "workshop",
    ),
    [sessionId, setSessionId] = useState<string | undefined>(() =>
      /^#chat\/[a-zA-Z0-9-]{1,100}$/.test(location.hash)
        ? location.hash.slice(6)
        : readLocal("selected-session", undefined),
    ),
    [projectFilter, setProjectFilter] = useState(""),
    [newChat, setNewChat] = useState(
      () =>
        !location.hash.startsWith("#chat/") &&
        readLocal<string>("selected-session", "") === "__new__",
    ),
    [selected, setSelected] = useState<string>();
  const [modal, setModal] = useState<"create" | "branch" | "edit" | null>(null),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [mobileNav, setMobileNav] = useState(false),
    [supportPanel, setSupportPanel] = useState<"proposal" | "flow" | "activity" | null>(
      null,
    );
  const visibleSessions =
    state?.sessions.filter((s) => !projectFilter || s.projectId === projectFilter) ??
    [];
  const session = newChat
      ? undefined
      : (visibleSessions.find((s) => s.id === sessionId) ?? visibleSessions.at(-1)),
    version = session && currentVersion(session);
  const [draft, setDraft] = useState(""),
    [reason, setReason] = useState("");
  const chatInput = useRef<HTMLTextAreaElement>(null),
    chatBody = useRef<HTMLDivElement>(null);
  const previousVersion = useRef<{ sessionId: string; digest: string } | null>(null);
  const [chatProjectId, setChatProjectId] = useState("");
  const targetProject =
    session?.projectId ||
    projectFilter ||
    chatProjectId ||
    state?.projects[0]?.id ||
    "";
  const [message, setMessage] = useLocalText(
    `draft:${targetProject}:${session?.id ?? "new"}`,
  );
  useEffect(() => {
    writeLocal("selected-session", sessionId);
  }, [sessionId]);
  useEffect(() => {
    if (chatBody.current) chatBody.current.scrollTop = chatBody.current.scrollHeight;
  }, [session?.messages.length, session?.phase]);
  useEffect(() => {
    setSelected(undefined);
    setReason("");
  }, [session?.id]);
  useEffect(() => {
    setDraft(version?.proposal.prompt ?? "");
    if (
      version &&
      session &&
      previousVersion.current?.sessionId === session.id &&
      previousVersion.current.digest !== version.digest
    )
      setSupportPanel("proposal");
    previousVersion.current =
      version && session ? { sessionId: session.id, digest: version.digest } : null;
  }, [version?.digest, session?.id]);
  useEffect(() => {
    if (!supportPanel) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !modal) {
        setSupportPanel(null);
        chatInput.current?.focus();
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [supportPanel, modal]);
  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    setNotice("");
    try {
      const result = await request<unknown>(path, body);
      await refresh();
      return result;
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "No se pudo completar la operación.");
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const safe = (fn: () => Promise<unknown>) => {
    void fn().catch(() => {});
  };
  const nav = (p: Page) => {
    setPage(p);
    setMobileNav(false);
  };
  const runs = state?.runs.filter((r) => r.sessionId === session?.id) ?? [];
  const sessionReleases =
    state?.releases.filter((r) => r.sessionId === session?.id) ?? [];
  const planningConnector = state?.connectors.find(
    (c) => c.id === state.projects.find((p) => p.id === targetProject)?.connectorId,
  );
  const plannerLabel = planningConnector?.planningModel ?? "Planificador de Daedalus";
  const selectedNode = session?.nodes.find((n) => n.id === selected);
  const pending = state?.permissions.filter((p) => !p.decision) ?? [];
  const anyOnline = state?.connectors.some(
    (c) => Date.now() - Date.parse(c.lastSeen) < 45000,
  );
  const hasActive = runs.some((r) =>
    ["queued", "running", "waiting_permission", "uncertain"].includes(r.status),
  );
  const executionApproved = session?.approvals.some(
    (a) =>
      a.milestone === "execution" &&
      a.version === version?.version &&
      a.digest === version?.digest &&
      a.decision === "approved",
  );
  const canResume =
    session?.phase === "paused" &&
    executionApproved &&
    !hasActive &&
    !session.tasks.some((t) => t.status === "failed");
  function resumePlan() {
    if (!session || !canResume) return;
    safe(() => act("/sessions/" + session.id + "/resume", {}));
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!message.trim() || busy || hasActive || !targetProject) return;
    const reply = (await act("/chat", {
      sessionId: session?.id,
      projectId: targetProject,
      message: message.trim(),
    })) as { sessionId: string };
    setSessionId(reply.sessionId);
    setProjectFilter(targetProject);
    setNewChat(false);
    setMessage("");
    setSupportPanel(null);
  }
  function startChat() {
    setSessionId("__new__");
    setNewChat(true);
    setSupportPanel(null);
    setMessage("");
    setSelected(undefined);
    setPage("workshop");
    setMobileNav(false);
    requestAnimationFrame(() => chatInput.current?.focus());
  }
  async function decide(decision: "approved" | "rejected" | "changes") {
    if (!session || !version) return;
    const milestone = session.approvals.some(
      (a) =>
        a.milestone === "approach" &&
        a.version === version.version &&
        a.digest === version.digest &&
        a.decision === "approved",
    )
      ? "execution"
      : "approach";
    await act("/sessions/" + session.id + "/decision", {
      milestone,
      version: version.version,
      digest: version.digest,
      decision,
      explanation: reason,
    });
    setReason("");
    if (milestone === "execution" && decision === "approved")
      setSupportPanel("activity");
  }
  return (
    <div className={"app-shell " + (page === "workshop" ? "chat-app" : "")}>
      <aside className={"sidebar " + (mobileNav ? "nav-open" : "")}>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            nav("workshop");
          }}
        >
          <Mark />
          <span>
            Daedalus<small>Taller de ideas</small>
          </span>
        </a>
        <div className="workspace-label">
          <span className="avatar">Tú</span>
          <span>
            Espacio personal<small>Arquitectura & ejecución</small>
          </span>
        </div>
        <label className="project-switch">
          Proyecto
          <select
            aria-label="Filtrar por proyecto"
            value={projectFilter}
            onChange={(e) => {
              setProjectFilter(e.target.value);
              setSessionId(undefined);
              setSelected(undefined);
            }}
          >
            <option value="">Todos los proyectos</option>
            {state?.projects.map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="nav-group">Tu taller</div>
        <nav aria-label="Navegación principal">
          {(
            [
              ["workshop", MessageSquare, "Chats"],
              ["releases", ArrowDownToLine, "Publicaciones"],
              ["execution", Workflow, "Ejecución"],
              ["console", Terminal, "Consola"],
              ["skills", Layers, "Biblioteca de skills"],
              ["connections", Link2, "Conexiones"],
            ] as const
          ).map(([key, Icon, label]) => (
            <div className="nav-entry" key={key}>
              <button
                className={"nav-link " + (page === key ? "active" : "")}
                onClick={() => nav(key)}
              >
                <Icon size={17} />
                {label}
                {key === "execution" && pending.length > 0 && (
                  <span className="nav-count">{pending.length}</span>
                )}
              </button>
              {key === "workshop" && (
                <button className="nav-link nav-suboption" onClick={startChat}>
                  <Plus size={15} />
                  Nuevo chat
                </button>
              )}
            </div>
          ))}
        </nav>
        <div className="session-heading">
          <span>Sesiones</span>
          <button
            className="icon-button"
            aria-label="Nueva idea"
            onClick={() => setModal("create")}
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="session-list">
          {visibleSessions.length ? (
            visibleSessions
              .slice()
              .reverse()
              .map((s) => (
                <button
                  key={s.id}
                  className={"session-link " + (session?.id === s.id ? "active" : "")}
                  onClick={() => {
                    setSessionId(s.id);
                    setNewChat(false);
                    nav("workshop");
                  }}
                >
                  <MessageSquare size={14} />
                  <span>{s.title}</span>
                </button>
              ))
          ) : (
            <p className="subtle">Tu próxima idea empieza aquí.</p>
          )}
        </div>
        <div className="sidebar-bottom">
          <button className="connection-summary" onClick={() => nav("connections")}>
            <span className={"status-dot " + (anyOnline ? "online" : "")} />
            <span>
              {anyOnline ? "Equipo conectado" : "Conector sin conexión"}
              <small>
                {anyOnline ? "Listo para trabajar" : "Configura tu estación local"}
              </small>
            </span>
            <ChevronRight size={15} />
          </button>
          <div className="footnote">
            Daedalus <span>v0.1</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="Abrir navegación"
            onClick={() => setMobileNav(!mobileNav)}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumb">
            <span>Mi taller</span>
            <ChevronRight size={13} />
            <span>
              {state?.projects.find(
                (p) => p.id === (session?.projectId || projectFilter),
              )?.name ?? "De la idea a la ejecución"}
            </span>
          </div>
          <div className="topbar-right">
            <Appearance>
              <BrowserNotifications
                state={state}
                openSession={(id) => {
                  if (!state?.sessions.some((s) => s.id === id)) return;
                  setSessionId(id);
                  setNewChat(false);
                  setPage("workshop");
                  setSupportPanel("activity");
                }}
              />
            </Appearance>
            <ShieldCheck size={15} />
            <span>Aprobación humana</span>
            <button
              className="icon-button"
              aria-label="Actualizar estado"
              title={error ? "Sin conexión con el servidor" : "Estado sincronizado"}
              onClick={() => void refresh()}
            >
              <RefreshCw size={15} />
            </button>
          </div>
        </header>
        <main className={"sheet " + (page === "workshop" ? "chat-sheet" : "")}>
          <PreviewIdentity deployedBuildId={deployedBuildId} />
          {updateAvailable && (
            <div className="notice" role="status">
              Hay una nueva versión de Daedalus. Tu borrador está guardado.
              <button onClick={() => location.reload()}>Actualizar ahora</button>
            </div>
          )}
          {(error || notice) && (
            <div className="notice" role="alert">
              {notice || error}
              <button
                className="icon-button"
                aria-label="Cerrar aviso"
                onClick={() => setNotice("")}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {!state ? (
            <div className="loading-state">
              <Mark />
              <h1>Abriendo el taller</h1>
              <p>{error || "Conectando con Daedalus…"}</p>
              <button onClick={() => void refresh()}>Reintentar</button>
            </div>
          ) : (
            <>
              {page !== "workshop" && (
                <div className="page-heading">
                  <div>
                    <div className="eyebrow">
                      {page === "releases"
                        ? "Publicaciones"
                        : page === "execution"
                          ? "Del plan al resultado"
                          : page === "skills"
                            ? "Conocimiento con procedencia"
                            : page === "console"
                              ? "Registro de actividad"
                              : "Tu estación de trabajo"}
                    </div>
                    <h1>
                      {page === "releases"
                        ? "Publicaciones"
                        : page === "execution"
                          ? "Ejecución"
                          : page === "console"
                            ? "Consola"
                            : page === "skills"
                              ? "Biblioteca de skills"
                              : "Conexiones"}
                    </h1>
                    <p>
                      {page === "execution"
                        ? "Tareas, permisos y evidencia del trabajo aprobado."
                        : page === "skills"
                          ? "Cada especialidad tiene un lugar en el proceso."
                          : page === "console"
                            ? "Lo que ocurrió, en el orden en que ocurrió."
                            : "El panel coordina. Tu equipo conserva las credenciales y ejecuta."}
                    </p>
                  </div>
                  <div className="heading-actions">
                    {session && page === "execution" && (
                      <span className={"phase phase-" + session.phase}>
                        <span className="status-dot" />
                        {phases[session.phase]}
                      </span>
                    )}
                  </div>
                </div>
              )}
              {page === "workshop" && (
                <>
                  <div className="workshop-toolbar">
                    <div className="view-label">
                      <MessageSquare size={15} />
                      <h1 title={session?.title}>{session?.title ?? "Conversación"}</h1>
                      {session && (
                        <span className="subtle">{session.nodes.length} nodos</span>
                      )}
                    </div>
                    <div className="toolbar-actions">
                      <button
                        className="context-toggle"
                        aria-label="Ver propuesta"
                        aria-expanded={supportPanel === "proposal"}
                        onClick={() =>
                          setSupportPanel((s) => (s === "proposal" ? null : "proposal"))
                        }
                      >
                        <FileText size={15} />
                        <span>Propuesta</span>
                        {version && <small>v{version.version}</small>}
                      </button>
                      <button
                        className="context-toggle"
                        aria-label="Ver flujo de ideas"
                        aria-expanded={supportPanel === "flow"}
                        onClick={() =>
                          setSupportPanel((s) => (s === "flow" ? null : "flow"))
                        }
                      >
                        <Network size={15} />
                        <span>Flujo</span>
                      </button>
                      <button
                        className="context-toggle"
                        aria-label="Ver agentes"
                        aria-expanded={supportPanel === "activity"}
                        onClick={() =>
                          setSupportPanel((s) => (s === "activity" ? null : "activity"))
                        }
                      >
                        <Workflow size={15} />
                        <span>Agentes</span>
                      </button>
                      {session && (
                        <>
                          <button
                            className="text-button"
                            onClick={() => {
                              setSelected(session.nodes[0]?.id);
                              setModal("branch");
                            }}
                          >
                            <GitBranch size={14} />
                            Ramificar
                          </button>
                          {version && (
                            <button
                              className="text-button"
                              onClick={() => setModal("edit")}
                              disabled={hasActive}
                            >
                              <FileText size={14} />
                              Editar plan
                            </button>
                          )}
                        </>
                      )}
                      <span className="mono">
                        {version ? "v" + version.version : "Inicio"}
                      </span>
                    </div>
                  </div>
                  <div
                    className={
                      "workshop-layout chat-layout " +
                      (supportPanel ? "with-context" : "")
                    }
                  >
                    <section
                      className="conversation-main"
                      aria-label="Chat con Daedalus"
                    >
                      <div
                        className="conversation-scroll"
                        ref={chatBody}
                        role="log"
                        aria-label="Mensajes de la conversación"
                        aria-live="polite"
                      >
                        <div className="conversation-content">
                          <>
                            {session?.messages.map((m) => (
                              <article className={"message " + m.role} key={m.id}>
                                <div>
                                  {m.role === "user"
                                    ? "Tú"
                                    : (m.model ?? "Daedalus · planificación")}
                                  <time>{stamp(m.createdAt)}</time>
                                </div>
                                <div className="message-content">
                                  <Suspense
                                    fallback={<p className="preserve">{m.content}</p>}
                                  >
                                    <MarkdownMessage content={m.content} />
                                  </Suspense>
                                </div>
                              </article>
                            ))}
                            {pending
                              .filter((p) => runs.some((r) => r.id === p.runId))
                              .map((p) => (
                                <PermissionCard
                                  key={p.id}
                                  permission={p}
                                  busy={busy}
                                  act={act}
                                />
                              ))}
                            {sessionReleases.map((release) => (
                              <article
                                className="chat-delivery"
                                key={release.id}
                                aria-label="Entrega del cambio"
                              >
                                <strong>
                                  {release.status === "ready"
                                    ? "Tu vista previa está lista"
                                    : release.status === "published"
                                      ? "Cambio publicado"
                                      : release.status === "superseded"
                                        ? "Candidato reemplazado"
                                        : release.status === "failed"
                                          ? "No se pudo preparar la vista previa"
                                          : "Preparando tu cambio"}
                                </strong>
                                <p>
                                  Rama <code>{release.branch}</code> · commit{" "}
                                  <code>{release.commit.slice(0, 8)}</code>
                                </p>
                                <div className="button-row">
                                  {release.prUrl && (
                                    <a
                                      href={release.prUrl + "/files"}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      Ver cambios del PR #{release.prNumber}
                                    </a>
                                  )}
                                  {release.previewUrl &&
                                    ["ready", "approved", "publishing"].includes(
                                      release.status,
                                    ) && (
                                      <a
                                        href={release.previewUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        Abrir preview verificada
                                      </a>
                                    )}
                                  <button
                                    className="text-button"
                                    onClick={() => nav("releases")}
                                  >
                                    Ver publicación
                                  </button>
                                </div>
                                {release.status === "superseded" && (
                                  <p>
                                    El staging compartido está reservado para otro
                                    candidato. El PR conserva estos cambios.
                                  </p>
                                )}
                                {release.error && <p role="alert">{release.error}</p>}
                              </article>
                            ))}
                            {!session && (
                              <article className="chat-welcome">
                                <Mark />
                                <h2>Habla con Daedalus</h2>
                                <p>
                                  Cuéntame qué quieres crear, mejorar o resolver.
                                  Exploraremos la idea antes de preparar el prompt para
                                  Codex.
                                </p>
                                <div className="chat-agents">
                                  <span>{plannerLabel} · ideas y planeación</span>
                                  <span>Codex · código y revisión</span>
                                </div>
                              </article>
                            )}
                            {hasActive && (
                              <div className="chat-progress" role="status">
                                <span className="status-dot online" />
                                {runs.some(
                                  (r) =>
                                    r.kind === "planning" &&
                                    ["queued", "running"].includes(r.status),
                                )
                                  ? "El planificador está atendiendo tu petición."
                                  : "Hay trabajo de agentes en esta conversación."}
                                <button
                                  className="text-button"
                                  onClick={() => setSupportPanel("activity")}
                                >
                                  Ver actividad
                                </button>
                              </div>
                            )}
                            {runs.filter((r) => r.kind === "planning").at(-1)
                              ?.status === "failed" && (
                              <div className="chat-error" role="alert">
                                <strong>No se pudo completar la respuesta</strong>
                                <p>
                                  {
                                    runs.filter((r) => r.kind === "planning").at(-1)
                                      ?.error
                                  }
                                </p>
                                <button
                                  className="text-button"
                                  onClick={() => setSupportPanel("activity")}
                                >
                                  Ver detalle
                                </button>
                              </div>
                            )}
                            {session?.phase === "paused" && executionApproved && (
                              <div className="chat-error" role="status">
                                <strong>El plan está pausado</strong>
                                <p>
                                  {
                                    session.tasks.filter(
                                      (task) => task.status === "completed",
                                    ).length
                                  }{" "}
                                  de {session.tasks.length} tareas completadas.
                                </p>
                                {canResume ? (
                                  <button
                                    className="primary"
                                    disabled={busy}
                                    onClick={resumePlan}
                                  >
                                    Continuar plan aprobado
                                  </button>
                                ) : (
                                  <button
                                    className="text-button"
                                    onClick={() => setSupportPanel("activity")}
                                  >
                                    Revisar tareas y bloqueos
                                  </button>
                                )}
                              </div>
                            )}
                            {version && (
                              <button
                                className="text-button"
                                onClick={() => setSupportPanel("proposal")}
                              >
                                {executionApproved
                                  ? `Revisar propuesta v${version.version}`
                                  : `Revisar propuesta v${version.version} para ejecutar`}
                                <ArrowRight size={14} />
                              </button>
                            )}
                          </>
                        </div>
                      </div>
                      <form className="composer" onSubmit={(e) => safe(() => send(e))}>
                        {!session && (
                          <label className="chat-project">
                            Proyecto
                            <select
                              aria-label="Proyecto de la conversación"
                              value={targetProject}
                              onChange={(e) => {
                                setChatProjectId(e.target.value);
                                setProjectFilter(e.target.value);
                                setNewChat(true);
                              }}
                            >
                              <option value="" disabled>
                                Conecta un proyecto para comenzar
                              </option>
                              {state.projects.map((p) => (
                                <option value={p.id} key={p.id}>
                                  {p.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        <label className="field-label" htmlFor="planner-message">
                          Tu petición
                        </label>
                        <textarea
                          id="planner-message"
                          ref={chatInput}
                          value={message}
                          onChange={(e) => setMessage(e.target.value)}
                          placeholder="Escribe aquí qué necesitas…"
                          onKeyDown={(e) => {
                            if (
                              e.key === "Enter" &&
                              (e.ctrlKey || e.metaKey) &&
                              !e.nativeEvent.isComposing
                            ) {
                              e.preventDefault();
                              e.currentTarget.form?.requestSubmit();
                            }
                          }}
                        />
                        <div>
                          <span>{plannerLabel}</span>
                          <button
                            className="primary icon-button"
                            type="submit"
                            aria-label="Enviar petición"
                            disabled={
                              busy || hasActive || !message.trim() || !targetProject
                            }
                          >
                            <Send size={15} />
                          </button>
                        </div>
                        {!targetProject && (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => nav("connections")}
                          >
                            Conectar mi equipo
                            <ArrowRight size={13} />
                          </button>
                        )}
                      </form>
                    </section>
                    {supportPanel && (
                      <aside
                        className="context-panel"
                        aria-label="Contexto de la conversación"
                      >
                        <div className="context-heading">
                          <div className="context-tabs" aria-label="Vistas de contexto">
                            <button
                              aria-pressed={supportPanel === "proposal"}
                              onClick={() => setSupportPanel("proposal")}
                            >
                              Propuesta
                            </button>
                            <button
                              aria-pressed={supportPanel === "flow"}
                              onClick={() => setSupportPanel("flow")}
                            >
                              Flujo
                            </button>
                            <button
                              aria-pressed={supportPanel === "activity"}
                              onClick={() => setSupportPanel("activity")}
                            >
                              Agentes
                            </button>
                          </div>
                          <button
                            className="icon-button"
                            aria-label="Cerrar contexto"
                            onClick={() => {
                              setSupportPanel(null);
                              chatInput.current?.focus();
                            }}
                          >
                            <X size={16} />
                          </button>
                        </div>
                        {supportPanel === "flow" ? (
                          <section
                            className="canvas-region"
                            aria-label="Lienzo de ideas"
                          >
                            {session ? (
                              <Flow
                                compact
                                session={session}
                                selected={selected}
                                onSelect={(id) => {
                                  setSelected(id);
                                  setSupportPanel("proposal");
                                }}
                              />
                            ) : (
                              <WorkflowGuide />
                            )}
                            <div className="canvas-caption">
                              Ideas, alternativas y decisiones
                            </div>
                          </section>
                        ) : supportPanel === "activity" ? (
                          <div className="context-activity">
                            <h2>Actividad de los agentes</h2>
                            {pending
                              .filter((p) => runs.some((r) => r.id === p.runId))
                              .map((p) => (
                                <PermissionCard
                                  key={p.id}
                                  permission={p}
                                  busy={busy}
                                  act={act}
                                />
                              ))}
                            {!runs.length ? (
                              <Empty title="Sin agentes en ejecución">
                                Escribe tu petición para comenzar. Codex implementa
                                después de tu aprobación.
                              </Empty>
                            ) : (
                              runs
                                .slice()
                                .reverse()
                                .map((run) => (
                                  <RunCard
                                    key={run.id}
                                    run={run}
                                    state={state}
                                    act={act}
                                  />
                                ))
                            )}
                            {session && hasActive && (
                              <button
                                onClick={() =>
                                  safe(() =>
                                    act("/sessions/" + session.id + "/cancel", {}),
                                  )
                                }
                              >
                                <Square size={14} /> Cancelar sesión
                              </button>
                            )}
                          </div>
                        ) : (
                          <>
                            <div className="rail-body">
                              {selectedNode ? (
                                <>
                                  <button
                                    className="back-link"
                                    onClick={() => setSelected(undefined)}
                                  >
                                    <ArrowLeft size={13} />
                                    Volver a la propuesta
                                  </button>
                                  <span className="detail-type">Nodo seleccionado</span>
                                  <h2>{selectedNode.title}</h2>
                                  <p className="preserve">{selectedNode.content}</p>
                                  <div className="button-row">
                                    <button
                                      onClick={() =>
                                        safe(() =>
                                          act("/sessions/" + session!.id + "/node", {
                                            id: selectedNode.id,
                                            collapsed: !selectedNode.collapsed,
                                          }),
                                        )
                                      }
                                    >
                                      {selectedNode.collapsed ? "Expandir" : "Contraer"}{" "}
                                      rama
                                    </button>
                                    <button onClick={() => setModal("branch")}>
                                      <GitBranch size={14} />
                                      Ramificar
                                    </button>
                                  </div>
                                </>
                              ) : version ? (
                                <>
                                  <div className="version-label">
                                    <span className="line-dot" />
                                    Propuesta v{version.version}
                                    <code>{version.digest.slice(0, 8)}</code>
                                  </div>
                                  <h2>{version.proposal.objective}</h2>
                                  <p>{version.proposal.scope}</p>
                                  <h3>Alternativas</h3>
                                  {version.proposal.alternatives.map((a, i) => (
                                    <article className="alternative" key={i}>
                                      <span className="alternative-number">
                                        {String(i + 1).padStart(2, "0")}
                                      </span>
                                      <div>
                                        <strong>{a.title}</strong>
                                        <p>{a.explanation}</p>
                                        <small>{a.tradeoffs}</small>
                                      </div>
                                    </article>
                                  ))}
                                  <h3>Dirección recomendada</h3>
                                  <p className="recommendation">
                                    {version.proposal.recommendation}
                                  </p>
                                  <h3>Crítica previa</h3>
                                  <p>{version.proposal.critique}</p>
                                  <label
                                    className="field-label"
                                    htmlFor="approved-prompt"
                                  >
                                    Prompt para Codex
                                  </label>
                                  <textarea
                                    id="approved-prompt"
                                    className="prompt-editor"
                                    value={draft}
                                    onChange={(e) => setDraft(e.target.value)}
                                    readOnly={hasActive}
                                  />
                                  {draft !== version.proposal.prompt && (
                                    <button
                                      disabled={busy || hasActive || !draft.trim()}
                                      onClick={() =>
                                        safe(() =>
                                          act(
                                            "/sessions/" + session!.id + "/proposal",
                                            {
                                              ...version.proposal,
                                              prompt: draft,
                                            },
                                          ),
                                        )
                                      }
                                    >
                                      Guardar nueva versión
                                    </button>
                                  )}
                                  <div className="scope-note">
                                    <ShieldCheck size={16} />
                                    <span>
                                      {version.proposal.tasks.length} tareas · Hasta 3
                                      ejecutores.
                                      <br />
                                      El conector creará commits locales para integrar
                                      tareas; sin push ni despliegue automático.
                                    </span>
                                  </div>
                                  <details className="task-plan">
                                    <summary>
                                      Tareas, áreas y criterios de aceptación
                                    </summary>
                                    {version.proposal.tasks.map((t) => (
                                      <article key={t.id}>
                                        <h3>{t.title}</h3>
                                        <p>{t.prompt}</p>
                                        <p>
                                          <strong>Áreas:</strong>{" "}
                                          {t.areas.join(", ") || "Proyecto autorizado"}
                                        </p>
                                        <p>
                                          <strong>Skills:</strong>{" "}
                                          {t.skills.join(", ") ||
                                            "Sin skills adicionales"}
                                        </p>
                                        <p>
                                          <strong>Depende de:</strong>{" "}
                                          {t.dependsOn.join(", ") || "Sin dependencias"}
                                        </p>
                                        <ul>
                                          {t.acceptance.map((a, i) => (
                                            <li key={i}>{a}</li>
                                          ))}
                                        </ul>
                                      </article>
                                    ))}
                                  </details>
                                  {session.versions.length > 1 && (
                                    <details className="task-plan">
                                      <summary>
                                        Versiones anteriores (
                                        {session.versions.length - 1})
                                      </summary>
                                      {session.versions
                                        .slice(0, -1)
                                        .reverse()
                                        .map((v) => (
                                          <article key={v.version}>
                                            <h3>
                                              Versión {v.version} ·{" "}
                                              {v.proposal.objective}
                                            </h3>
                                            <p>{v.proposal.recommendation}</p>
                                            <pre>{v.proposal.prompt}</pre>
                                            <small>
                                              Digest: {v.digest.slice(0, 12)}
                                            </small>
                                          </article>
                                        ))}
                                    </details>
                                  )}
                                </>
                              ) : (
                                <>
                                  <div className="rail-intro">
                                    <span className="intro-symbol">
                                      <Mark />
                                    </span>
                                    <h2>
                                      {session
                                        ? "Dale una dirección"
                                        : "Una buena idea merece un buen plan."}
                                    </h2>
                                    <p>
                                      {session
                                        ? "Cuéntale al planificador qué debe explorar. Aquí aparecerán las alternativas y la recomendación."
                                        : "Daedalus conecta la exploración con la ejecución. Tú eliges el camino y apruebas el trabajo."}
                                    </p>
                                  </div>
                                  <div className="process-owner">
                                    <span>Explorar y planear</span>
                                    <strong>{plannerLabel}</strong>
                                  </div>
                                  <div className="process-owner">
                                    <span>Construir y revisar</span>
                                    <strong>
                                      Codex <small>con tu sesión de ChatGPT</small>
                                    </strong>
                                  </div>
                                  {!state.projects.length && (
                                    <div className="setup-callout">
                                      <Link2 size={17} />
                                      <p>
                                        Conecta tu equipo para elegir un proyecto y
                                        comenzar.
                                      </p>
                                      <button
                                        className="text-button"
                                        onClick={() => nav("connections")}
                                      >
                                        Configurar conexión
                                        <ArrowRight size={14} />
                                      </button>
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                            {session &&
                              version &&
                              !selectedNode &&
                              supportPanel === "proposal" &&
                              !hasActive &&
                              !session.approvals.some(
                                (a) =>
                                  a.milestone === "execution" &&
                                  a.version === version.version &&
                                  a.decision === "approved",
                              ) &&
                              !["completed", "cancelled"].includes(session.phase) && (
                                <div className="approval-box">
                                  <label htmlFor="decision-reason">
                                    Comentario sobre tu decisión
                                  </label>
                                  <input
                                    id="decision-reason"
                                    value={reason}
                                    onChange={(e) => setReason(e.target.value)}
                                    placeholder="Ajustes, límites o motivo"
                                  />
                                  <button
                                    className="primary"
                                    disabled={busy || draft !== version.proposal.prompt}
                                    onClick={() => safe(() => decide("approved"))}
                                  >
                                    <ShieldCheck size={16} />
                                    {session.approvals.some(
                                      (a) =>
                                        a.version === version.version &&
                                        a.milestone === "approach" &&
                                        a.decision === "approved",
                                    )
                                      ? "Aprobar prompt y ejecutar"
                                      : "Aprobar enfoque"}
                                  </button>
                                  <div className="decision-actions">
                                    <button
                                      className="text-button"
                                      disabled={busy || !reason.trim()}
                                      onClick={() => safe(() => decide("changes"))}
                                    >
                                      Solicitar cambios
                                    </button>
                                    <button
                                      className="text-button"
                                      disabled={busy}
                                      onClick={() => safe(() => decide("rejected"))}
                                    >
                                      Rechazar
                                    </button>
                                  </div>
                                </div>
                              )}
                          </>
                        )}
                      </aside>
                    )}
                  </div>
                  {!session && (
                    <div className="workshop-bottom">
                      <span>
                        <ShieldCheck size={15} />
                        Nada se ejecuta sin tu aprobación.
                      </span>
                      <button
                        className="text-button"
                        onClick={() => setModal("create")}
                      >
                        Empezar con una idea
                        <ArrowRight size={15} />
                      </button>
                    </div>
                  )}
                </>
              )}
              {page === "execution" && (
                <section className="content-page">
                  {session && (
                    <div className="execution-summary">
                      <span>{session.title}</span>
                      <span>
                        {session.tasks.filter((t) => t.status === "completed").length} /{" "}
                        {session.tasks.length} tareas completadas
                      </span>
                      {hasActive && (
                        <button
                          onClick={() =>
                            safe(() => act("/sessions/" + session.id + "/cancel", {}))
                          }
                        >
                          <Square size={13} />
                          Detener ejecución
                        </button>
                      )}
                      {canResume && (
                        <button disabled={busy} onClick={resumePlan}>
                          Continuar plan aprobado
                        </button>
                      )}
                    </div>
                  )}
                  {pending.map((p) => (
                    <PermissionCard key={p.id} permission={p} busy={busy} act={act} />
                  ))}
                  {!runs.length ? (
                    <Empty title="El trabajo empieza con tu decisión">
                      Aprueba primero el enfoque y después el prompt. Las tareas
                      aparecerán aquí cuando estén autorizadas.
                    </Empty>
                  ) : (
                    runs.map((r) => (
                      <RunCard key={r.id} run={r} state={state} act={act} />
                    ))
                  )}
                  {session && (
                    <>
                      <h2 className="section-title">Historial de aprobaciones</h2>
                      {session.approvals.length ? (
                        session.approvals
                          .slice()
                          .reverse()
                          .map((a) => (
                            <div className="approval-row" key={a.id}>
                              <ShieldCheck size={16} />
                              <span>
                                {a.milestone === "approach" ? "Enfoque" : "Ejecución"} ·
                                v{a.version}
                                <small>
                                  {a.explanation || "Sin comentario adicional"}
                                </small>
                              </span>
                              <span>
                                {a.decision === "approved"
                                  ? "Aprobado"
                                  : a.decision === "changes"
                                    ? "Cambios solicitados"
                                    : "Rechazado"}
                              </span>
                              <time>{stamp(a.createdAt)}</time>
                            </div>
                          ))
                      ) : (
                        <p className="subtle">Todavía no hay decisiones registradas.</p>
                      )}
                    </>
                  )}
                </section>
              )}
              {page === "console" && (
                <section className="content-page">
                  <div className="console-heading">
                    <span>
                      <Radio size={14} />
                      Registro persistente
                    </span>
                    <span>{state.events.length} eventos</span>
                  </div>
                  <div className="console-log">
                    {state.events.length ? (
                      state.events
                        .slice()
                        .reverse()
                        .map((e) => (
                          <div className="log-row" key={e.id}>
                            <time>{stamp(e.at)}</time>
                            <code>{e.type}</code>
                            <p>{e.message}</p>
                          </div>
                        ))
                    ) : (
                      <Empty title="El taller está en silencio">
                        Las conexiones, decisiones y ejecuciones dejarán su registro
                        aquí.
                      </Empty>
                    )}
                  </div>
                </section>
              )}
              {page === "releases" && (
                <Releases releases={state.releases ?? []} busy={busy} act={act} />
              )}
              {page === "skills" && (
                <section className="content-page">
                  <div className="section-intro">
                    <h2>Un oficio para cada tarea</h2>
                    <p>
                      Las skills se cargan cuando son pertinentes. Cada ejecución
                      conserva la revisión utilizada.
                    </p>
                  </div>
                  <div className="skill-list">
                    {skillLock.sources.map((s, i) => (
                      <article className="skill-row" key={s.id}>
                        <span className="skill-index">0{i + 1}</span>
                        <div>
                          <h2>{s.name}</h2>
                          <p>{s.purpose}</p>
                          <a href={s.repository} target="_blank" rel="noreferrer">
                            {s.repository.replace("https://github.com/", "")}
                            <ArrowRight size={12} />
                          </a>
                        </div>
                        <div className="skill-revision">
                          <span>Revisión fijada</span>
                          <code>{s.revision.slice(0, 10)}</code>
                        </div>
                      </article>
                    ))}
                  </div>
                  <div className="scope-note">
                    <Layers size={17} />
                    <p>
                      La instalación conserva los archivos de licencia y los recursos de
                      cada fuente. Las actualizaciones requieren modificar el lock y
                      sincronizar de forma explícita.
                    </p>
                  </div>
                </section>
              )}
              {page === "connections" && (
                <Connections state={state} act={act} busy={busy} />
              )}
            </>
          )}
        </main>
      </div>
      {modal && state && (
        <Modal
          title={
            modal === "create"
              ? "Una nueva idea"
              : modal === "branch"
                ? "Explorar otro camino"
                : "Editar la propuesta"
          }
          close={closeModal}
        >
          {modal === "create" ? (
            <CreateForm
              state={state}
              busy={busy}
              initialProjectId={projectFilter}
              onConnect={() => {
                setModal(null);
                nav("connections");
              }}
              onSubmit={async (projectId, title, idea) => {
                const s = (await act("/sessions", {
                  projectId,
                  title,
                  idea,
                })) as Session;
                setSessionId(s.id);
                setProjectFilter(projectId);
                setNewChat(false);
                setSupportPanel(null);
                setPage("workshop");
                setModal(null);
              }}
            />
          ) : modal === "branch" && session ? (
            <BranchForm
              onSubmit={async (title, content) => {
                await act("/sessions/" + session.id + "/branch", {
                  parentId: selected ?? session.nodes[0].id,
                  title,
                  content,
                });
                setModal(null);
              }}
            />
          ) : version ? (
            <EditForm
              proposal={version.proposal}
              onSubmit={async (proposal) => {
                await act("/sessions/" + session!.id + "/proposal", proposal);
                setModal(null);
              }}
            />
          ) : null}
        </Modal>
      )}
    </div>
  );
}
function RunCard({
  run,
  state,
  act,
}: {
  run: AgentRun;
  state: Workspace;
  act: (path: string, body?: unknown) => Promise<unknown>;
}) {
  const [evidence, setEvidence] = useState(""),
    [outcome, setOutcome] = useState<"completed" | "failed">("failed");
  return (
    <article className="run-card">
      <div className="run-heading">
        <span className={"run-icon " + run.status}>
          <Code2 size={19} />
        </span>
        <div>
          <h2>
            {run.kind === "planning"
              ? "Exploración y planeación"
              : run.kind === "review"
                ? "Revisión independiente"
                : (state.sessions
                    .find((s) => s.id === run.sessionId)
                    ?.tasks.find((t) => t.id === run.taskId)?.title ??
                  "Tarea de implementación")}
          </h2>
          <span>
            {run.model ??
              (run.kind === "planning"
                ? "Planificador de Daedalus"
                : "Codex · ChatGPT")}{" "}
            · <code>{run.id.slice(0, 8)}</code>
          </span>
        </div>
        <span className={"phase phase-" + run.status}>{runLabels[run.status]}</span>
      </div>
      {run.error && <p className="run-error">{run.error}</p>}
      {canRetryPreflight(run) && (
        <div className="retry-preflight">
          <p>La tarea falló durante la preparación; Codex no llegó a iniciarla.</p>
          <button
            onClick={() => void act("/runs/" + run.id + "/retry", {}).catch(() => {})}
          >
            <RefreshCw size={14} /> Reintentar preparación
          </button>
        </div>
      )}
      {run.status === "uncertain" && (
        <div>
          <p>
            Inspecciona la sesión local y el worktree. Daedalus conserva el estado y no
            repetirá esta ejecución.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act("/runs/" + run.id + "/reconcile", { outcome, evidence }).catch(
                () => {},
              );
            }}
          >
            <label>
              Evidencia de la inspección
              <textarea
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
                required
                minLength={10}
                placeholder="Qué comprobaste en la sesión y los archivos locales"
              />
            </label>
            <label>
              Resultado comprobado
              <select
                value={outcome}
                onChange={(e) => setOutcome(e.target.value as "completed" | "failed")}
              >
                <option value="failed">
                  Descartar esta ejecución; volver a planear
                </option>
                {run.kind !== "planning" && (
                  <option value="completed">
                    La tarea terminó; conservar el resultado
                  </option>
                )}
              </select>
            </label>
            <button disabled={evidence.trim().length < 10}>
              Registrar reconciliación
            </button>
          </form>
        </div>
      )}
      {run.branch && (
        <div className="run-branch">
          <GitBranch size={14} />
          <code>{run.branch}</code>
        </div>
      )}
      {run.worktree && (
        <details>
          <summary>Carpeta de trabajo</summary>
          <code className="break">{run.worktree}</code>
        </details>
      )}
      {run.output && (
        <details open={run.kind === "review"}>
          <summary>Resultado y pruebas</summary>
          <pre>{run.output}</pre>
        </details>
      )}
      {run.changes && (
        <details>
          <summary>Archivos y cambios</summary>
          <pre>{run.changes}</pre>
        </details>
      )}
      {state.artifacts
        .filter((a) => a.runId === run.id)
        .map((a) => (
          <a className="artifact-link" key={a.id} href={"/api/artifacts/" + a.id}>
            <ArrowDownToLine size={14} />
            {a.name}
          </a>
        ))}
    </article>
  );
}
function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first =
      dialog.current?.querySelector<HTMLElement>("input,textarea,select") ??
      dialog.current?.querySelector<HTMLElement>("button");
    first?.focus();
    const f = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "Tab") {
        const elements = Array.from(
          dialog.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input,textarea,select,a[href]",
          ) ?? [],
        );
        const first = elements[0],
          last = elements.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", f);
    return () => {
      window.removeEventListener("keydown", f);
      previous?.focus();
    };
  }, [close]);
  return (
    <div className="modal-backdrop" onClick={close}>
      <section
        ref={dialog}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2 id="modal-title">{title}</h2>
          <button className="icon-button" aria-label="Cerrar diálogo" onClick={close}>
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function PermissionCard({
  permission,
  busy,
  act,
}: {
  permission: PermissionRequest;
  busy: boolean;
  act: (path: string, body?: unknown) => Promise<unknown>;
}) {
  const questions =
    (
      permission.details as {
        questions?: Array<{
          id: string;
          question: string;
          options?: Array<{ label: string; description?: string }>;
        }>;
      }
    )?.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const question = permission.method === "item/tool/requestUserInput";
  function decide(decision: "accept" | "decline") {
    void act("/permissions/" + permission.id, { decision, answers }).catch(() => {});
  }
  return (
    <article className="permission-card">
      <div>
        <ShieldCheck size={20} />
        <h2>
          {question ? "Codex necesita una respuesta" : "Codex solicita tu autorización"}
        </h2>
      </div>
      <p>{permissionDescription(permission.description)}</p>
      {questions.map((q) => (
        <label key={q.id}>
          {q.question}
          {q.options?.length ? (
            <select
              value={answers[q.id]?.[0] ?? ""}
              onChange={(e) =>
                setAnswers((old) => ({ ...old, [q.id]: [e.target.value] }))
              }
            >
              <option value="" disabled>
                Selecciona una respuesta
              </option>
              {q.options.map((o) => (
                <option key={o.label} value={o.label}>
                  {o.label}
                  {o.description ? " · " + o.description : ""}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={answers[q.id]?.[0] ?? ""}
              onChange={(e) =>
                setAnswers((old) => ({ ...old, [q.id]: [e.target.value] }))
              }
            />
          )}
        </label>
      ))}
      <PermissionDetails details={permission.details} />
      <details>
        <summary>Ver datos técnicos originales (JSON)</summary>
        <pre>{JSON.stringify(permission.details, null, 2)}</pre>
      </details>
      {permission.method === "item/permissions/requestApproval" && (
        <p>
          Se puede autorizar la red solicitada. Las ampliaciones de escritura fuera del
          proyecto permanecen bloqueadas.
        </p>
      )}
      <div className="button-row">
        <button
          className="primary"
          disabled={busy || (question && questions.some((q) => !answers[q.id]?.[0]))}
          onClick={() => decide("accept")}
        >
          {question ? "Enviar respuestas" : "Permitir esta operación"}
        </button>
        <button disabled={busy} onClick={() => decide("decline")}>
          {question ? "Omitir" : "Denegar"}
        </button>
      </div>
    </article>
  );
}
function CreateForm({
  state,
  busy,
  initialProjectId,
  onSubmit,
  onConnect,
}: {
  state: Workspace;
  busy: boolean;
  initialProjectId?: string;
  onSubmit: (project: string, title: string, idea: string) => Promise<void>;
  onConnect: () => void;
}) {
  const [project, setProject] = useState(
      initialProjectId || state.projects[0]?.id || "",
    ),
    [title, setTitle] = useState(""),
    [idea, setIdea] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(project, title, idea).catch(() => {});
      }}
    >
      <p className="subtle">
        Describe el resultado que buscas. Las decisiones técnicas vienen después.
      </p>
      <label>
        Proyecto
        <select value={project} onChange={(e) => setProject(e.target.value)} required>
          <option value="" disabled>
            Elige un proyecto registrado
          </option>
          {state.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.rootLabel}
            </option>
          ))}
        </select>
      </label>
      {!state.projects.length && (
        <button className="text-button" type="button" onClick={onConnect}>
          Conectar un proyecto
          <ArrowRight size={14} />
        </button>
      )}
      <label>
        Nombre de la idea
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          required
          placeholder="¿Qué vamos a crear?"
        />
      </label>
      <label>
        Punto de partida
        <textarea
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          required
          rows={5}
          maxLength={30000}
          placeholder="El problema, para quién y qué debería cambiar…"
        />
      </label>
      <button className="primary" disabled={busy || !project}>
        Crear idea
        <ArrowRight size={15} />
      </button>
    </form>
  );
}
function BranchForm({
  onSubmit,
}: {
  onSubmit: (title: string, content: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(""),
    [content, setContent] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(title, content).catch(() => {});
      }}
    >
      <label>
        Nombre del camino
        <input required value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        Idea o pregunta
        <textarea
          required
          rows={6}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </label>
      <button className="primary">
        Crear rama
        <GitBranch size={15} />
      </button>
    </form>
  );
}
function EditForm({
  proposal,
  onSubmit,
}: {
  proposal: Proposal;
  onSubmit: (proposal: Proposal) => Promise<void>;
}) {
  const [value, setValue] = useState(JSON.stringify(proposal, null, 2)),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        try {
          const data = JSON.parse(value) as Proposal;
          void onSubmit(data).catch((err) => setError(err.message));
        } catch {
          setError("Revisa la sintaxis JSON.");
        }
      }}
    >
      <p>
        Modificar la propuesta creará una versión nueva y requerirá aprobarla de nuevo.
      </p>
      <label>
        Plan completo
        <textarea
          className="json-editor"
          rows={18}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button className="primary">Guardar nueva versión</button>
    </form>
  );
}
function Connections({
  state,
  act,
  busy,
}: {
  state: Workspace;
  act: (path: string, body?: unknown) => Promise<unknown>;
  busy: boolean;
}) {
  const [label, setLabel] = useState("Mi equipo"),
    [role, setRole] = useState<"connector" | "mcp">("connector"),
    [token, setToken] = useState(""),
    [copied, setCopied] = useState(false);
  return (
    <section className="content-page connections">
      <div className="connection-grid">
        <div>
          <h2>Motores locales</h2>
          <p>
            El conector enlaza tu equipo con Daedalus mediante una conexión saliente. No
            abre puertos públicos.
          </p>
        </div>
        <div>
          {state.connectors.length ? (
            state.connectors.map((c) => (
              <article className="connector-card" key={c.id}>
                <div>
                  <strong>{c.name}</strong>
                  <span className="phase">
                    {Date.now() - Date.parse(c.lastSeen) < 45000
                      ? "Conectado"
                      : "Sin conexión"}
                  </span>
                </div>
                <p>
                  <span className={"status-dot " + (c.opencode ? "online" : "")} />
                  OpenCode · {c.model ?? "DeepSeek gratuito"}
                  {" · "}
                  {c.opencode ? "Disponible" : "No disponible"}
                </p>
                {c.planningModel && (
                  <p>
                    <span className={"status-dot " + (c.planning ? "online" : "")} />
                    Planeación · {c.planningModel}
                  </p>
                )}
                <p>
                  <span className={"status-dot " + (c.codex ? "online" : "")} />
                  Codex · sesión de ChatGPT
                </p>
                {c.error && <p className="run-error preserve">{c.error}</p>}
                <small>Última señal: {stamp(c.lastSeen)}</small>
              </article>
            ))
          ) : (
            <Empty title="Todavía no hay un equipo conectado">
              Inicia el conector local con una credencial de este panel.
            </Empty>
          )}
        </div>
      </div>
      <div className="connection-grid">
        <div>
          <h2>Preparar tu estación</h2>
          <p>
            Configuración inicial en Windows. Después, todo el trabajo se dirige desde
            este panel.
          </p>
        </div>
        <ol className="setup-steps">
          <li>
            <strong>Autentica los motores</strong>
            <code>codex login</code>
            <p>
              Elige ChatGPT. Inicia OpenCode con su modelo DeepSeek gratuito y el
              servidor en localhost.
            </p>
          </li>
          <li>
            <strong>Registra tus carpetas</strong>
            <p>
              Copia <code>connector.example.json</code> a{" "}
              <code>connector.local.json</code>. Define la URL de Daedalus y las raíces
              de tus proyectos.
            </p>
          </li>
          <li>
            <strong>Sincroniza las skills</strong>
            <code>npm run skills:sync</code>
          </li>
          <li>
            <strong>Inicia el conector</strong>
            <p>
              Guarda la credencial en <code>DAEDALUS_CONNECTOR_TOKEN</code> de tu
              entorno local.
            </p>
            <code>npm run connector</code>
            <p>
              En desarrollo local, el conector lee automáticamente su credencial de{" "}
              <code>.daedalus/</code>.
            </p>
          </li>
        </ol>
      </div>
      <div className="connection-grid">
        <div>
          <h2>Credenciales</h2>
          <p>
            Crea accesos separados para conectores y clientes MCP. Ninguno puede aprobar
            planes.
          </p>
          <p>
            Servidor MCP: <code>{location.origin}/mcp</code>
          </p>
        </div>
        <div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act("/credentials", { label, role })
                .then((r) => {
                  setToken((r as { token: string }).token);
                  setCopied(false);
                })
                .catch(() => {});
            }}
          >
            <label>
              Nombre
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                required
              />
            </label>
            <label>
              Tipo de acceso
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as "connector" | "mcp")}
              >
                <option value="connector">Conector local</option>
                <option value="mcp">Cliente MCP</option>
              </select>
            </label>
            <button disabled={busy}>Crear credencial</button>
          </form>
          {token && (
            <div className="token-result">
              <label>
                Credencial nueva · cópiala ahora
                <textarea readOnly value={token} aria-label="Credencial nueva" />
              </label>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(token).then(() => setCopied(true));
                }}
              >
                <Copy size={14} />
                {copied ? "Copiada" : "Copiar"}
              </button>
              <button onClick={() => setToken("")}>Ocultar</button>
            </div>
          )}
          {state.credentials.map((c) => (
            <div className="credential-row" key={c.id}>
              <span>
                {c.label}
                <small>
                  {c.role} · {c.revokedAt ? "Revocada" : "Activa"}
                </small>
              </span>
              {!c.revokedAt && (
                <button
                  className="text-button"
                  onClick={() => {
                    void act("/credentials/" + c.id + "/revoke", {}).catch(() => {});
                  }}
                >
                  Revocar
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
