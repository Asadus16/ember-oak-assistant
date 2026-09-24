// Citation markers in model output. The model writes [S1], [S1][S2] and also [S1, S2] (several ids in one
// bracket), so every place that reads or hides markers must understand all three. No Node imports here, so
// the browser can use it too.
export const MARKER_PATTERN = "\\[(S\\d{1,2}(?:\\s*,\\s*S\\d{1,2})*)\\]";

export const markerRegex = () => new RegExp(`\\s*${MARKER_PATTERN}`, "g");

export const stripMarkers = (text: string) => text.replace(markerRegex(), "");
