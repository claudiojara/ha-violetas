# Violetas (resumen en español)

Violetas que caen en todos los paneles de Home Assistant, para todos los usuarios, con un solo
interruptor. Este es un resumen; la documentación completa está en inglés en el [README](README.md).

## Requisitos

Home Assistant 2026.2 o posterior. El icono propio de la integración se ve desde Home Assistant 2026.3.

## Instalación

1. HACS (*Marketplace* en versiones recientes de Home Assistant) → ⋮ → **Repositorios personalizados**.
2. Añade `https://github.com/claudiojara/ha-violetas` con la categoría **Integración**.
3. Instala **Violetas** y reinicia Home Assistant si lo pide.
4. **Ajustes → Dispositivos y servicios → Añadir integración → Violetas**.

No hace falta YAML, ni ayudantes, ni recursos del panel. El interruptor `switch.violetas` empieza
**encendido**; recarga una vez las pestañas abiertas. Instalación manual: ver
[Manual](README.md#manual).

## Uso

- `switch.violetas`: encendido, caen violetas en todos los paneles; apagado, nada. Mantiene su estado
  tras reiniciar. Se puede cambiar su ID de entidad sin perder el efecto.
- **Configurar** (en la integración): cantidad de violetas (1–80), velocidad (lenta, normal, rápida) y
  opacidad (0,1–1). Los cambios se ven de inmediato, sin reiniciar. Ver [Options](README.md#options).
- Temporada de violetas en Chile (15 de octubre – 30 de noviembre): ver la
  [automatización de ejemplo](README.md#seasonal-automation).
- Solo en una vista: la tarjeta `custom:violet-fall-card`, con las mismas opciones y colores propios.
  Mientras el interruptor está encendido no dibuja nada, así que nunca hay flores dobles. Ver
  [Only in one view](README.md#only-in-one-view-optional).

## Accesibilidad y rendimiento

Con «reducir movimiento» activado en el dispositivo no se dibuja nada. Las animaciones se pausan
con la pestaña en segundo plano y la capa nunca bloquea toques ni clics. En tabletas antiguas,
conviene bajar la cantidad de violetas. Ver
[Accessibility and performance](README.md#accessibility-and-performance).

## Desinstalación

Elimina la integración en **Dispositivos y servicios** (las violetas desaparecen de inmediato), quita el
repositorio en HACS y reinicia Home Assistant. Ver [Uninstall](README.md#uninstall).
