import { useId } from "react";

interface BrandLogoProps {
  className?: string;
}

// Marca de JoinsClee WaCrm: una red de nodos monocroma. Se dibuja con
// `currentColor`, así que hereda el color del texto — blanco sobre
// fondos oscuros, negro sobre claros — y una sola pieza sirve para
// ambos temas. La máscara recorta el centro de los cuatro nodos grandes
// para el efecto "anillo" (y corta las aristas que cruzarían el hueco,
// igual que en el logo original). `useId` evita colisiones de máscara
// si el logo se renderiza más de una vez en la misma página.
export function BrandLogo({ className }: BrandLogoProps) {
  const maskId = useId();
  return (
    <svg
      viewBox="0 0 200 200"
      className={className}
      fill="none"
      aria-hidden="true"
    >
      <mask id={maskId}>
        <rect x="0" y="0" width="200" height="200" fill="white" />
        <circle cx="28" cy="100" r="6.4" fill="black" />
        <circle cx="78" cy="78" r="6.4" fill="black" />
        <circle cx="128" cy="86" r="6.4" fill="black" />
        <circle cx="172" cy="102" r="6.4" fill="black" />
      </mask>
      <g
        mask={`url(#${maskId})`}
        stroke="currentColor"
        fill="currentColor"
        strokeWidth="4.4"
        strokeLinecap="round"
      >
        <line x1="100" y1="25" x2="45" y2="46" />
        <line x1="100" y1="25" x2="78" y2="78" />
        <line x1="100" y1="25" x2="128" y2="86" />
        <line x1="100" y1="25" x2="155" y2="48" />
        <line x1="45" y1="46" x2="28" y2="100" />
        <line x1="45" y1="46" x2="78" y2="78" />
        <line x1="155" y1="48" x2="128" y2="86" />
        <line x1="155" y1="48" x2="172" y2="102" />
        <line x1="28" y1="100" x2="78" y2="78" />
        <line x1="28" y1="100" x2="48" y2="165" />
        <line x1="28" y1="100" x2="88" y2="140" />
        <line x1="78" y1="78" x2="128" y2="86" />
        <line x1="78" y1="78" x2="88" y2="140" />
        <line x1="128" y1="86" x2="172" y2="102" />
        <line x1="128" y1="86" x2="88" y2="140" />
        <line x1="128" y1="86" x2="155" y2="165" />
        <line x1="172" y1="102" x2="155" y2="165" />
        <line x1="172" y1="102" x2="88" y2="140" />
        <line x1="88" y1="140" x2="48" y2="165" />
        <line x1="88" y1="140" x2="100" y2="182" />
        <line x1="88" y1="140" x2="155" y2="165" />
        <line x1="48" y1="165" x2="100" y2="182" />
        <line x1="100" y1="182" x2="155" y2="165" />
        <circle cx="28" cy="100" r="14" stroke="none" />
        <circle cx="78" cy="78" r="14" stroke="none" />
        <circle cx="128" cy="86" r="14" stroke="none" />
        <circle cx="172" cy="102" r="14" stroke="none" />
        <circle cx="100" cy="25" r="7" stroke="none" />
        <circle cx="45" cy="46" r="7" stroke="none" />
        <circle cx="155" cy="48" r="7" stroke="none" />
        <circle cx="88" cy="140" r="7" stroke="none" />
        <circle cx="48" cy="165" r="7" stroke="none" />
        <circle cx="100" cy="182" r="7" stroke="none" />
        <circle cx="155" cy="165" r="7" stroke="none" />
      </g>
    </svg>
  );
}
