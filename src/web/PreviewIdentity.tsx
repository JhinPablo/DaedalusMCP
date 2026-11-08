export function PreviewIdentity({ deployedBuildId }: { deployedBuildId?: string }) {
  const expected = new URLSearchParams(location.search).get("preview");
  if (!expected || !/^[a-f0-9]{40}$/.test(expected)) return null;
  const actual = import.meta.env.VITE_DAEDALUS_BUILD_ID ?? "local";
  if (!deployedBuildId)
    return (
      <div className="preview-identity" role="status">
        Comprobando el commit de esta preview…
      </div>
    );
  return (
    <div
      className="preview-identity"
      role={actual !== expected || deployedBuildId !== expected ? "alert" : "status"}
    >
      {actual === expected && deployedBuildId === expected ? (
        <>
          Vista previa verificada · commit <code>{actual.slice(0, 8)}</code>. Estás en
          el entorno de pruebas.
        </>
      ) : (
        <>
          Esta preview fue reemplazada. Esperabas <code>{expected.slice(0, 8)}</code>;
          el servidor corresponde a <code>{deployedBuildId.slice(0, 8)}</code> y esta
          página a <code>{actual.slice(0, 8)}</code>. Consulta el candidato actual en
          Publicaciones.
        </>
      )}
    </div>
  );
}
