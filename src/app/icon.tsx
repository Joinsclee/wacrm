import { ImageResponse } from "next/og";

// Favicon: la red de nodos de JoinsClee WaCrm en blanco sobre un cuadro
// oscuro redondeado (la "versión oscura" del logo). Next.js lo renderiza
// en build y auto-inyecta <link rel="icon"> en el <head>. Esta ruta tiene
// precedencia sobre src/app/favicon.ico (el default de Next, que puede
// quedarse en disco sin estorbar o eliminarse).
//
// El SVG se pasa como data URI a un <img> (en vez de dibujar elementos
// SVG sueltos) para que la máscara de los nodos "anillo" se rasterice
// igual que en el componente BrandLogo.

export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><mask id="h"><rect width="200" height="200" fill="#fff"/><circle cx="28" cy="100" r="6.4" fill="#000"/><circle cx="78" cy="78" r="6.4" fill="#000"/><circle cx="128" cy="86" r="6.4" fill="#000"/><circle cx="172" cy="102" r="6.4" fill="#000"/></mask><g mask="url(#h)" stroke="#fff" fill="#fff" stroke-width="5" stroke-linecap="round"><line x1="100" y1="25" x2="45" y2="46"/><line x1="100" y1="25" x2="78" y2="78"/><line x1="100" y1="25" x2="128" y2="86"/><line x1="100" y1="25" x2="155" y2="48"/><line x1="45" y1="46" x2="28" y2="100"/><line x1="45" y1="46" x2="78" y2="78"/><line x1="155" y1="48" x2="128" y2="86"/><line x1="155" y1="48" x2="172" y2="102"/><line x1="28" y1="100" x2="78" y2="78"/><line x1="28" y1="100" x2="48" y2="165"/><line x1="28" y1="100" x2="88" y2="140"/><line x1="78" y1="78" x2="128" y2="86"/><line x1="78" y1="78" x2="88" y2="140"/><line x1="128" y1="86" x2="172" y2="102"/><line x1="128" y1="86" x2="88" y2="140"/><line x1="128" y1="86" x2="155" y2="165"/><line x1="172" y1="102" x2="155" y2="165"/><line x1="172" y1="102" x2="88" y2="140"/><line x1="88" y1="140" x2="48" y2="165"/><line x1="88" y1="140" x2="100" y2="182"/><line x1="88" y1="140" x2="155" y2="165"/><line x1="48" y1="165" x2="100" y2="182"/><line x1="100" y1="182" x2="155" y2="165"/><circle cx="28" cy="100" r="15" stroke="none"/><circle cx="78" cy="78" r="15" stroke="none"/><circle cx="128" cy="86" r="15" stroke="none"/><circle cx="172" cy="102" r="15" stroke="none"/><circle cx="100" cy="25" r="8" stroke="none"/><circle cx="45" cy="46" r="8" stroke="none"/><circle cx="155" cy="48" r="8" stroke="none"/><circle cx="88" cy="140" r="8" stroke="none"/><circle cx="48" cy="165" r="8" stroke="none"/><circle cx="100" cy="182" r="8" stroke="none"/><circle cx="155" cy="165" r="8" stroke="none"/></g></svg>`;

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0b0d10", // near-black, matches the dark logo variant
          borderRadius: 6,
        }}
      >
        <img
          width={24}
          height={24}
          alt=""
          src={`data:image/svg+xml;base64,${btoa(LOGO_SVG)}`}
        />
      </div>
    ),
    { ...size },
  );
}
