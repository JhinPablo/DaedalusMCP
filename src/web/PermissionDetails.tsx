import type { ReactNode } from "react";

const labels: Record<string, string> = {
  command: "Comando",
  cwd: "Carpeta de trabajo",
  reason: "Motivo",
  justification: "Justificación",
  network: "Acceso a red",
  filesystem: "Archivos",
  permissions: "Permisos solicitados",
  commandActions: "Operaciones previstas",
  path: "Ruta",
  paths: "Rutas",
  action: "Acción",
  type: "Tipo",
  read: "Lectura",
  write: "Escritura",
  writeRoots: "Carpetas de escritura",
  readRoots: "Carpetas de lectura",
  additionalPermissions: "Permisos adicionales",
  requestedPermissions: "Permisos solicitados",
  description: "Descripción",
  allowedDomains: "Dominios permitidos",
  enabled: "Habilitado",
};
const technical = new Set(["threadId", "turnId", "itemId", "callId", "questions"]);
export function readablePermission(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function Value({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  value = readablePermission(value);
  if (value === null || value === undefined) return <span>No especificado</span>;
  if (typeof value === "boolean") return <span>{value ? "Sí" : "No"}</span>;
  if (depth > 6) return <pre>{JSON.stringify(value, null, 2)}</pre>;
  if (Array.isArray(value))
    return value.length ? (
      <ul>
        {value.map((v, i) => (
          <li key={i}>
            <Value value={v} depth={depth + 1} />
          </li>
        ))}
      </ul>
    ) : (
      <span>Ninguno</span>
    );
  if (typeof value === "object")
    return (
      <dl className="permission-fields">
        {Object.entries(value)
          .filter(([key]) => !technical.has(key))
          .map(([key, v]) => (
            <div key={key}>
              <dt>
                {labels[key] ??
                  key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ")}
              </dt>
              <dd>
                {key === "command" &&
                Array.isArray(v) &&
                v.every((item) => typeof item === "string") ? (
                  <pre>
                    <code>{v.join(" ")}</code>
                  </pre>
                ) : (
                  <Value value={v} depth={depth + 1} />
                )}
              </dd>
            </div>
          ))}
      </dl>
    );
  return <span className="preserve">{String(value)}</span>;
}
export function PermissionDetails({ details }: { details: unknown }) {
  return (
    <div className="permission-details">
      <Value value={details} />
    </div>
  );
}

export function permissionDescription(description: string) {
  const parsed = readablePermission(description);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    for (const key of ["reason", "justification", "description", "message"])
      if (typeof record[key] === "string") return record[key] as string;
    return "Revisa la operación y el alcance solicitados antes de decidir.";
  }
  return description;
}
